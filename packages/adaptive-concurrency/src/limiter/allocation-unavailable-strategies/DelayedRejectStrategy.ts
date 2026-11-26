import { allotmentUnavailableError } from "../../errors.js";
import type {
  AcquireResult,
  AllotmentUnavailableStrategy,
  RetryAcquire,
} from "../../types/Strategy.js";

/**
 * The result after the delay before refusal. Made once, because refusals are
 * common under load, and a new error would capture a stack trace for each
 * one. So its stack points at module load, and every refusal from this site
 * shares the error: do not mutate it. A site that needs a per-call fact,
 * such as a `retryAfter`, makes its own error instead.
 */
const DELAYED_REFUSAL = Object.freeze({
  ok: false,
  error: allotmentUnavailableError({
    message: "No allotment is available, and the delay before refusal ended",
  }),
} as const);

export interface DelayedRejectStrategyOptions<ContextT> {
  /**
   * Milliseconds to wait before resolving with no allotment. Return 0 to
   * refuse immediately. With `PartitionedStrategy`, usually mirror `partitionResolver`
   * here and look up delay from your own per-partition config.
   */
  delayMsForContext: (context: ContextT) => number;

  /**
   * Maximum number of acquire attempts that may be waiting on a delay at once.
   * When exceeded, new refusals skip the delay.
   */
  maxConcurrentDelays?: number | undefined;
}

/**
 * When the acquire strategy rejects, waits up to `delayMsForContext(context)`,
 * then still resolves with no allotment (`{ ok: false, error }`). This adds a form of backpressure. Does not
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
   * Waits for the context's delay, then resolves with `{ ok: false, error }`.
   * Rejects with the signal's reason when the signal aborts.
   */
  async onAllotmentUnavailable(
    context: ContextT,
    _retry: RetryAcquire<ContextT>,
    signal?: AbortSignal,
  ): AcquireResult {
    await this.delay(context, signal);
    return DELAYED_REFUSAL;
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
