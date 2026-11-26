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

  /**
   * Maps a waiter's context to the group of capacity it draws from. Set this
   * when the acquire strategy can refuse one waiter but admit another at the
   * same moment, as `PartitionedStrategy` does when one partition is full and
   * another has room. Return the partition name, for example.
   *
   * Without this option, the backlog drains from the head only: when the head
   * waiter's retry fails, the drain stops. That is right when every waiter
   * draws from the same capacity, as with `SemaphoreStrategy`, but with
   * partitions it lets a waiter from a full partition block waiters behind
   * it that could run.
   *
   * With this option, a failed retry does not stop the drain. The drain
   * skips later waiters in the same group, because they would fail too, and
   * keeps retrying waiters in other groups. So a drain makes at most one
   * failed retry per group, and waiters in one group keep their queue order.
   *
   * The drain calls this function for each waiter it passes, so keep it
   * cheap. Requires a `queue` that implements `peekNext`.
   */
  capacityGroup?: ((context: ContextT) => unknown) | undefined;
};

export type WaiterQueue<ContextT, Handle, EnqueueOptionsT = EnqueueOptions> = {
  enqueue: (
    waiter: Waiter<ContextT>,
    options: EnqueueOptionsT,
  ) => { value: Waiter<ContextT>; handle: Handle };
  peekHead: () => { value: Waiter<ContextT>; handle: Handle } | undefined;
  /**
   * Returns the entry after `handle` in drain order, or `undefined` when
   * `handle` is the last entry. Only needed with the `capacityGroup` option.
   * The drain only calls it with handles that are still in the queue.
   */
  peekNext?: (
    handle: Handle,
  ) => { value: Waiter<ContextT>; handle: Handle } | undefined;
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
  private readonly grouping:
    | {
        capacityGroup: (context: ContextT) => unknown;
        peekNext: (
          handle: Handle,
        ) => { value: Waiter<ContextT>; handle: Handle } | undefined;
      }
    | undefined;
  private drainInProgress = false;
  private drainScheduled = false;
  private releaseDuringDrain = false;
  private queueChangedDuringDrain = false;

  constructor(
    options: BlockingBacklogRejectionOptions<ContextT, Handle, EnqueueOptionsT>,
  ) {
    const backlogSize = options.backlogSize;
    if (Number.isNaN(backlogSize) || backlogSize < 0) {
      throw new RangeError("backlogSize must be greater than or equal to 0");
    }

    this.backlogSize = backlogSize;
    this.queue = options.queue;
    const { capacityGroup } = options;
    if (capacityGroup) {
      const queue = options.queue;
      if (!queue.peekNext) {
        throw new TypeError(
          "The capacityGroup option requires a queue that implements peekNext",
        );
      }
      this.grouping = {
        capacityGroup,
        peekNext: (handle) => queue.peekNext!(handle),
      };
    }
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

  /**
   * Retries queued waiters, in queue order, until no more of them can get an
   * allotment. Only one drain runs at a time. A release or an enqueue while a
   * drain runs sets a flag that the running drain checks after each retry.
   *
   * Without `capacityGroup`, the drain only retries the head, and stops when
   * the head's retry fails. With it, the drain walks the queue and skips the
   * waiters whose group already had a failed retry in this pass.
   */
  private async drainBacklog(): Promise<void> {
    if (this.drainInProgress) {
      return;
    }

    if (this.queue.size() === 0) {
      return;
    }

    const grouping = this.grouping;
    this.drainInProgress = true;
    try {
      // Groups that had a failed retry since the last release. Their later
      // waiters would fail too, so the drain skips them.
      const failedGroups = new Set<unknown>();
      let entry = this.queue.peekHead();
      while (entry) {
        const waiter = entry.value;
        const group = grouping?.capacityGroup(waiter.context);
        if (grouping && failedGroups.has(group)) {
          entry = grouping.peekNext(entry.handle);
          continue;
        }

        this.releaseDuringDrain = false;
        this.queueChangedDuringDrain = false;
        const allotment = await waiter.retry(waiter.context);

        // If no waiter joined or left the queue during the retry, this entry
        // is still queued, so the drain can continue from it. Read the next
        // entry now, before this one is removed.
        const next =
          grouping && !this.queueChangedDuringDrain
            ? grouping.peekNext(entry.handle)
            : undefined;

        if (allotment) {
          if (this.queue.removeByHandle(entry.handle)) {
            waiter.resolve(allotment);
          } else {
            // Waiter expired while retry was in-flight. Release the acquired
            // slot so future retries can serve active queued waiters.
            await allotment.releaseAndIgnore();
          }
        } else if (grouping) {
          failedGroups.add(group);
        } else if (!this.releaseDuringDrain) {
          return;
        }

        if (this.releaseDuringDrain) {
          // A slot was released during the retry, and drainInProgress
          // suppressed its drain. Start again from the head, and retry every
          // group, so the freed capacity isn't lost and goes to the earliest
          // waiter that can use it.
          failedGroups.clear();
          entry = this.queue.peekHead();
        } else if (!grouping || this.queueChangedDuringDrain) {
          // Without groups, the drain only ever retries the head. With
          // groups, a change to the queue may have removed this entry or
          // added one before it, so start again from the head. The waiters
          // there were served, or are in a failed group, so this repeats no
          // retry.
          entry = this.queue.peekHead();
        } else {
          entry = next;
        }
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
      if (this.drainInProgress) {
        this.queueChangedDuringDrain = true;
      }
      this.scheduleDrain();

      const timer = setTimeout(() => settle(BACKLOG_TIMEOUT), timeout);
      const onAbort = (): void => settle(undefined);
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (this.queue.removeByHandle(handle) && this.drainInProgress) {
          this.queueChangedDuringDrain = true;
        }
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
