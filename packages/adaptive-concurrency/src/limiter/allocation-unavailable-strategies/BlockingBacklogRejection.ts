import { allotmentUnavailableError } from "../../errors.js";
import type {
  AcquireResult,
  AllotmentUnavailableStrategy,
  LimitAllotment,
  Result,
  RetryAcquire,
} from "../../types/Strategy.js";
import type { EnqueueOptions } from "../../utils/LinkedWaiterQueue.js";

export type Waiter<ContextT> = {
  context: ContextT;
  retry: RetryAcquire<ContextT>;
  resolve: (allotment: LimitAllotment) => void;
};

/**
 * The result when the backlog is full. Made once, because refusals are
 * common under load, and a new error would capture a stack trace for each
 * one. So its stack points at module load, and every refusal from this site
 * shares the error: do not mutate it. A site that needs a per-call fact,
 * such as a `retryAfter`, makes its own error instead.
 */
const BACKLOG_FULL = Object.freeze({
  ok: false,
  error: allotmentUnavailableError({
    message: "No allotment is available, and the backlog is full",
  }),
} as const);

/**
 * The result when a request waits in the backlog for its whole timeout. Made
 * once, because refusals are common under load, and a new error would
 * capture a stack trace for each one. So its stack points at module load,
 * and every refusal from this site shares the error: do not mutate it. A
 * site that needs a per-call fact, such as a `retryAfter`, makes its own
 * error instead.
 */
const BACKLOG_TIMEOUT = Object.freeze({
  ok: false,
  error: allotmentUnavailableError({
    message: "No allotment became available within the backlog timeout",
  }),
} as const);

export const MAX_TIMEOUT = 60 * 60 * 1000; // 1 hour

export type BlockingBacklogRejectionOptions<
  ContextT,
  Handle,
  EnqueueOptionsT = EnqueueOptions,
> = {
  backlogSize: number;
  backlogTimeout: number | ((context: ContextT) => number);
  queue: WaiterQueue<ContextT, Handle, EnqueueOptionsT>;
  enqueueOptions: EnqueueOptionsT | ((context: ContextT) => EnqueueOptionsT);
};

export type WaiterQueue<ContextT, Handle, EnqueueOptionsT = EnqueueOptions> = {
  enqueue: (
    waiter: Waiter<ContextT>,
    options: EnqueueOptionsT,
  ) => { value: Waiter<ContextT>; handle: Handle };
  peekHead: () => { value: Waiter<ContextT>; handle: Handle } | undefined;
  removeByHandle: (handle: Handle) => boolean;
  size: () => number;
};

export class BlockingBacklogRejection<
  ContextT,
  Handle,
  EnqueueOptionsT = EnqueueOptions,
> implements AllotmentUnavailableStrategy<ContextT> {
  private readonly backlogSize: number;
  private readonly getBacklogTimeout: (context: ContextT) => number;
  private readonly getEnqueueOptions: (context: ContextT) => EnqueueOptionsT;
  private readonly queue: WaiterQueue<ContextT, Handle, EnqueueOptionsT>;
  private drainInProgress = false;
  private drainScheduled = false;
  private releaseDuringDrain = false;

  constructor(
    options: BlockingBacklogRejectionOptions<ContextT, Handle, EnqueueOptionsT>,
  ) {
    const backlogSize = options.backlogSize;
    if (Number.isNaN(backlogSize) || backlogSize < 0) {
      throw new RangeError("backlogSize must be greater than or equal to 0");
    }

    this.backlogSize = backlogSize;
    this.queue = options.queue;
    const backlogTimeout = options.backlogTimeout;
    const enqueueOptions = options.enqueueOptions;

    this.getBacklogTimeout = (() => {
      if (typeof backlogTimeout === "number") {
        this.assertTimeoutWithinBounds(backlogTimeout);
        return () => backlogTimeout;
      }
      return (context) => {
        const contextTimeout = backlogTimeout(context);
        this.assertTimeoutWithinBounds(contextTimeout);
        return contextTimeout;
      };
    })();

    if (typeof enqueueOptions === "function") {
      this.getEnqueueOptions = enqueueOptions as (
        context: ContextT,
      ) => EnqueueOptionsT;
    } else {
      this.getEnqueueOptions = () => enqueueOptions;
    }
  }

  /**
   * Waits in the backlog until a retry gets an allotment. Resolves with
   * `{ ok: false, error }` when the backlog is full, or when the wait
   * reaches the backlog timeout. Rejects with the signal's reason when the
   * signal aborts.
   */
  onAllotmentUnavailable(
    context: ContextT,
    retry: RetryAcquire<ContextT>,
    signal?: AbortSignal,
  ): AcquireResult {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }

    if (this.queue.size() >= this.backlogSize) {
      return Promise.resolve(BACKLOG_FULL);
    }

    return this.waitInBacklog(context, retry, signal);
  }

  async onAllotmentReleased(): Promise<void> {
    if (this.drainInProgress) {
      this.releaseDuringDrain = true;
      return;
    }

    await this.drainBacklog();
  }

  private async drainBacklog(): Promise<void> {
    if (this.drainInProgress) {
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

  private scheduleDrain(): void {
    if (this.drainScheduled) {
      return;
    }

    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      void this.drainBacklog();
    });
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
    retry: RetryAcquire<ContextT>,
    signal?: AbortSignal,
  ): AcquireResult {
    const timeout = this.getBacklogTimeout(context);
    return new Promise((resolve, reject) => {
      let settled = false;
      // `undefined` is an abort, which rejects with the signal's reason.
      const settle = (result: Result<LimitAllotment> | undefined): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (result) resolve(result);
        else reject(signal?.reason);
      };

      const waiter: Waiter<ContextT> = {
        context,
        retry,
        resolve: (allotment) => settle({ ok: true, value: allotment }),
      };

      const enqueueOptions = this.getEnqueueOptions(context);
      const { handle } = this.queue.enqueue(waiter, enqueueOptions);
      this.scheduleDrain();

      const timer = setTimeout(() => settle(BACKLOG_TIMEOUT), timeout);
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
