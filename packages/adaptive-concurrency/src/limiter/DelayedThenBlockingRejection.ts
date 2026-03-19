import type { LimitAllotment } from "../LimitAllotment.js";
import type {
  AllotmentUnavailableStrategy,
  AsyncAcquireResult,
  SyncAcquireResult,
} from "../Limiter.js";
import type { DelayedRejectStrategy } from "./DelayedRejectStrategy.js";

/**
 * Composes "delay then reject" backoff with blocking behavior. On rejection:
 * first applies delayed-reject semantics, then delegates to a blocking strategy
 * (FIFO/LIFO) to await capacity.
 */
export class DelayedThenBlockingRejection<
  ContextT,
> implements AllotmentUnavailableStrategy<ContextT, AsyncAcquireResult> {
  private readonly delayStrategy: DelayedRejectStrategy<ContextT>;
  private readonly blockingStrategy: AllotmentUnavailableStrategy<
    ContextT,
    AsyncAcquireResult
  >;

  constructor(options: {
    delayStrategy: DelayedRejectStrategy<ContextT>;
    blockingStrategy: AllotmentUnavailableStrategy<
      ContextT,
      AsyncAcquireResult
    >;
  }) {
    this.delayStrategy = options.delayStrategy;
    this.blockingStrategy = options.blockingStrategy;
  }

  async onAllotmentUnavailable(
    context: ContextT,
    retry: (context: ContextT) => SyncAcquireResult,
    signal?: AbortSignal,
  ): Promise<LimitAllotment | undefined> {
    await this.delayStrategy.onAllotmentUnavailable(context, retry, signal);
    if (signal?.aborted) {
      return undefined;
    }
    const allotment = retry(context);
    return (
      allotment ??
      this.blockingStrategy.onAllotmentUnavailable(context, retry, signal)
    );
  }

  onAllotmentReleased(): void {
    this.delayStrategy.onAllotmentReleased();
    this.blockingStrategy.onAllotmentReleased();
  }
}
