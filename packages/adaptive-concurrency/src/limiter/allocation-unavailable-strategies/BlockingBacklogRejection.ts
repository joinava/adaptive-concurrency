import type { LimitAllotment } from "../../LimitAllotment.js";
import type {
  AcquireResult,
  AllotmentUnavailableStrategy,
} from "../../Limiter.js";

export type Waiter<ContextT> = {
  context: ContextT;
  retry: (context: ContextT) => AcquireResult;
  resolve: (allotment: LimitAllotment | undefined) => void;
};

export const MAX_TIMEOUT = 60 * 60 * 1000; // 1 hour

export type BlockingBacklogRejectionOptions<ContextT, Handle> = {
  backlogSize: number;
  backlogTimeout: number | ((context: ContextT) => number);
  queue: WaiterQueue<ContextT, Handle>;
};

export type WaiterQueue<ContextT, Handle> = {
  enqueue: (waiter: Waiter<ContextT>) => {
    value: Waiter<ContextT>;
    handle: Handle;
  };
  peekHead: () => { value: Waiter<ContextT>; handle: Handle } | undefined;
  removeByHandle: (handle: Handle) => boolean;
  size: () => number;
};

export class BlockingBacklogRejection<
  ContextT,
  Handle,
> implements AllotmentUnavailableStrategy<ContextT> {
  private readonly backlogSize: number;
  private readonly getBacklogTimeout: (context: ContextT) => number;
  private readonly queue: WaiterQueue<ContextT, Handle>;
  private drainInProgress = false;
  private releaseDuringDrain = false;

  constructor(options: BlockingBacklogRejectionOptions<ContextT, Handle>) {
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
    if (this.drainInProgress) {
      this.releaseDuringDrain = true;
      return;
    }

    if (this.queue.size() === 0) {
      return;
    }

    this.drainInProgress = true;
    try {
      while (this.queue.size() > 0) {
        const queuedWaiter = this.queue.peekHead();
        if (!queuedWaiter) {
          return;
        }
        const waiter = queuedWaiter.value;

        this.releaseDuringDrain = false;
        const allotment = await waiter.retry(waiter.context);
        if (!allotment) {
          if (this.releaseDuringDrain) {
            // A slot was released while retry was in-flight but the
            // notification was suppressed by drainInProgress. Retry the
            // loop so the freed capacity isn't lost.
            continue;
          }
          return;
        }

        if (!this.queue.removeByHandle(queuedWaiter.handle)) {
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

      const waiter: Waiter<ContextT> = {
        context,
        retry,
        resolve: (allotment) => settle(allotment),
      };
      const { handle } = this.queue.enqueue(waiter);

      const timer = setTimeout(() => settle(undefined), timeout);
      const onAbort = (): void => settle(undefined);
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.queue.removeByHandle(handle);
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
