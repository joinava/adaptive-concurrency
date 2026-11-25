import { allotmentUnavailableError } from "../../errors.js";
import type {
  AllotmentUnavailableStrategy,
  LimitAllotment,
  RetryAcquire,
} from "../../types/Strategy.js";

export interface DelayedRejectStrategyOptions<ContextT> {
  /**
   * Milliseconds to wait before rejecting with an `allotmentUnavailableError`.
   * Return 0 to reject immediately. With `PartitionedStrategy`, usually mirror `partitionResolver`
   * here and look up delay from your own per-partition config.
   */
  delayMsForContext: (context: ContextT) => number;

  /**
   * Maximum number of acquire attempts that may be waiting on a delay at once.
   * When exceeded, new rejections skip the delay (immediate rejection).
   */
  maxConcurrentDelays?: number | undefined;
}

/**
 * When the acquire strategy rejects, waits up to `delayMsForContext(context)`,
 * then still rejects with an `allotmentUnavailableError`. This adds a form of backpressure. Does not
 * call `retry` — unlike {@link BlockingBacklogRejection}, this is "delay then
 * reject," not "wait for capacity." Compose with `PartitionedStrategy` via
 * `Limiter.rejectionStrategy`; partition delays are not fields on `PartitionConfig`.
 */
export class DelayedRejectStrategy<
  ContextT,
> implements AllotmentUnavailableStrategy<ContextT> {
  private readonly delayMsForContext: (context: ContextT) => number;
  private readonly maxConcurrentDelays: number;
  private concurrentDelays = 0;

  constructor(options: DelayedRejectStrategyOptions<ContextT>) {
    this.delayMsForContext = options.delayMsForContext;
    const max = options.maxConcurrentDelays ?? 100;
    if (max < 1 || !Number.isFinite(max)) {
      throw new RangeError("maxConcurrentDelays must be a finite number >= 1");
    }
    this.maxConcurrentDelays = max;
  }

  /**
   * Waits for the context's delay, then rejects with an
   * `allotmentUnavailableError`. Rejects with the signal's reason when the
   * signal aborts.
   */
  async onAllotmentUnavailable(
    context: ContextT,
    _retry: RetryAcquire<ContextT>,
    signal?: AbortSignal,
  ): Promise<LimitAllotment> {
    await this.delay(context, signal);
    signal?.throwIfAborted();
    throw allotmentUnavailableError({
      message: "No allotment is available, and the delay before refusal ended",
    });
  }

  onAllotmentReleased(): void {
    // No waiters (unlike FIFO/LIFO blocking).
  }

  /**
   * Waits up to `delayMsForContext(context)`. It resolves at once when the
   * delay is 0 or less, or when `maxConcurrentDelays` delays already run. It
   * rejects with the signal's reason when the signal aborts.
   */
  async delay(context: ContextT, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();

    const ms = this.delayMsForContext(context);
    if (ms <= 0) {
      return;
    }

    if (this.concurrentDelays >= this.maxConcurrentDelays) {
      return;
    }

    this.concurrentDelays++;
    try {
      await sleep(ms, signal);
    } finally {
      this.concurrentDelays--;
    }
    signal?.throwIfAborted();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const t = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
