import type {
  AcquireResult,
  AllotmentUnavailableStrategy,
  LimitAllotment,
} from "../../types/Strategy.js";
import type { DelayedRejectStrategy } from "./DelayedRejectStrategy.js";

/**
 * Composes "delay then reject" backoff with blocking behavior. On rejection:
 * first applies delayed-reject semantics, then delegates to a blocking strategy
 * (FIFO/LIFO) to await capacity.
 */
export class DelayedThenBlockingRejection<
  ContextT,
> implements AllotmentUnavailableStrategy<ContextT> {
  private readonly delayStrategy: DelayedRejectStrategy<ContextT>;
  private readonly blockingStrategy: AllotmentUnavailableStrategy<ContextT>;

  constructor(options: {
    delayStrategy: DelayedRejectStrategy<ContextT>;
    blockingStrategy: AllotmentUnavailableStrategy<ContextT>;
  }) {
    this.delayStrategy = options.delayStrategy;
    this.blockingStrategy = options.blockingStrategy;
  }

  async onAllotmentUnavailable(
    context: ContextT,
    retry: (context: ContextT) => AcquireResult,
    signal?: AbortSignal,
  ): Promise<LimitAllotment | undefined> {
    await this.delayStrategy.onAllotmentUnavailable(context, retry, signal);
    if (signal?.aborted) {
      return undefined;
    }
    const allotment = await retry(context);

    if (allotment) {
      return allotment;
    }

    if (signal?.aborted) {
      return undefined;
    }

    return this.blockingStrategy.onAllotmentUnavailable(context, retry, signal);
  }

  async onAllotmentReleased(): Promise<void> {
    await this.delayStrategy.onAllotmentReleased();
    await this.blockingStrategy.onAllotmentReleased();
  }

  onLimitChanged(oldLimit: number, newLimit: number): void {
    this.blockingStrategy.onLimitChanged?.(oldLimit, newLimit);
  }
}
