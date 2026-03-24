import type { LimitAllotment } from "../../LimitAllotment.js";
import type {
  AcquireResult,
  AllotmentUnavailableStrategy,
} from "../../Limiter.js";
import type { WaiterHandle } from "../../utils/LinkedWaiterQueue.js";

type Waiter<ContextT> = {
  context: ContextT;
  retry: (context: ContextT) => AcquireResult;
  handle: WaiterHandle;
  resolve: (allotment: LimitAllotment | undefined) => void;
};

export const MAX_TIMEOUT = 60 * 60 * 1000; // 1 hour

export type BlockingBacklogRejectionOptions<ContextT> = {
  backlogSize: number;
  backlogTimeout: number | ((context: ContextT) => number);
  queue: WaiterQueue<Waiter<ContextT>>;
};

export type WaiterQueue<WaiterT extends Waiter<any>> = {
  enqueue: (waiter: Omit<WaiterT, "handle">) => WaiterT;
  peekHead: () => WaiterT | undefined;
  removeByHandle: (handle: WaiterHandle) => boolean;
  size: () => number;
};

export class BlockingBacklogRejection<
  ContextT,
> implements AllotmentUnavailableStrategy<ContextT> {
  private readonly backlogSize: number;
  private readonly getBacklogTimeout: (context: ContextT) => number;
  private readonly queue: WaiterQueue<Waiter<ContextT>>;
  private drainInProgress = false;

  constructor(options: BlockingBacklogRejectionOptions<ContextT>) {
    const backlogSize = options.backlogSize;
    if (
      backlogSize !== Number.POSITIVE_INFINITY &&
      (!Number.isFinite(backlogSize) || backlogSize < 0)
    ) {
      throw new RangeError(
        "BlockingBacklogRejection: backlogSize must be a finite number greater than or equal to 0, or Infinity",
      );
    }

    this.backlogSize = backlogSize;
    this.queue = options.queue;

    const backlogTimeout = options.backlogTimeout;

    if (typeof backlogTimeout === "number") {
      this.assertTimeoutWithinBounds(backlogTimeout);
      this.getBacklogTimeout = () => backlogTimeout;
      return;
    }

    this.getBacklogTimeout = (context) => {
      const contextTimeout = backlogTimeout(context);
      this.assertTimeoutWithinBounds(contextTimeout);
      return contextTimeout;
    };
  }

  onAllotmentUnavailable(
    context: ContextT,
    retry: (context: ContextT) => AcquireResult,
    signal?: AbortSignal,
  ): Promise<LimitAllotment | undefined> {
    if (signal?.aborted) {
      return Promise.resolve(undefined);
    }

    if (this.queue.size() >= this.backlogSize) {
      return Promise.resolve(undefined);
    }

    return this.waitInBacklog(context, retry, signal);
  }

  async onAllotmentReleased(): Promise<void> {
    if (this.drainInProgress || this.queue.size() === 0) {
      return;
    }

    this.drainInProgress = true;
    try {
      while (this.queue.size() > 0) {
        const waiter = this.queue.peekHead();
        if (!waiter) {
          return;
        }

        const allotment = await waiter.retry(waiter.context);
        if (!allotment) {
          return;
        }

        if (!this.queue.removeByHandle(waiter.handle)) {
          // Waiter expired while retry was in-flight. Release the acquired slot
          // so future retries can serve active queued waiters.
          await allotment.releaseAndIgnore();
          continue;
        }

        waiter.resolve(allotment);
      }
    } finally {
      this.drainInProgress = false;
    }
  }

  onLimitChanged(oldLimit: number, newLimit: number): void {
    if (newLimit > oldLimit) {
      queueMicrotask(() => {
        void this.onAllotmentReleased();
      });
    }
  }

  private waitInBacklog(
    context: ContextT,
    retry: (context: ContextT) => AcquireResult,
    signal?: AbortSignal,
  ): Promise<LimitAllotment | undefined> {
    const timeout = this.getBacklogTimeout(context);
    return new Promise<LimitAllotment | undefined>((resolve) => {
      let settled = false;
      const settle = (allotment: LimitAllotment | undefined): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(allotment);
      };

      const waiter = this.queue.enqueue({
        context,
        retry,
        resolve: (allotment) => settle(allotment),
      });

      const timer = setTimeout(
        () => settle(undefined),
        timeout,
      );
      const onAbort = (): void => settle(undefined);
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.queue.removeByHandle(waiter.handle);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private assertTimeoutWithinBounds(timeout: number): void {
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw new RangeError(
        "Timeout must be a finite number greater than or equal to 0",
      );
    }
    if (timeout > MAX_TIMEOUT) {
      throw new RangeError(`Timeout cannot be greater than ${MAX_TIMEOUT} ms`);
    }
  }
}
