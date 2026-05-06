import type { LimitAllotment } from "../../LimitAllotment.js";
import type {
  AllotmentUnavailableStrategy,
  AcquireResult,
} from "../../Limiter.js";

export interface DelayedRejectStrategyOptions<ContextT> {
  /**
   * Milliseconds to wait before resolving with no allotment. Return 0 to reject
   * immediately. With `PartitionedStrategy`, usually mirror `partitionResolver`
   * here and look up delay from your own per-partition config.
   */
  delayMsForContext: (context: ContextT) => number;

  /**
   * Maximum number of acquire attempts that may be waiting on a delay at once.
   * When exceeded, new rejections skip the delay (immediate `undefined`).
   */
  maxConcurrentDelays?: number | undefined;
}

/**
 * When the acquire strategy rejects, waits up to `delayMsForContext(context)`,
 * then still returns no allotment. This adds a form of backpressure. Does not
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

  onAllotmentUnavailable(
    context: ContextT,
    _retry: (context: ContextT) => AcquireResult,
    signal?: AbortSignal,
  ): Promise<LimitAllotment | undefined> {
    return this.run(context, signal);
  }

  onAllotmentReleased(): void {
    // No waiters (unlike FIFO/LIFO blocking).
  }

  private async run(
    context: ContextT,
    signal?: AbortSignal,
  ): Promise<LimitAllotment | undefined> {
    if (signal?.aborted) {
      return undefined;
    }

    const ms = this.delayMsForContext(context);
    if (ms <= 0) {
      return undefined;
    }

    if (this.concurrentDelays >= this.maxConcurrentDelays) {
      return undefined;
    }

    this.concurrentDelays++;
    try {
      await sleep(ms, signal);
    } finally {
      this.concurrentDelays--;
    }

    return undefined;
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
