import type {
  AcquireResult,
  AllotmentUnavailableStrategy,
} from "../../Limiter.js";
import {
  LinkedWaiterQueue,
  BlockingBacklogRejection,
} from "./BlockingBacklogRejection.js";

export interface LifoBlockingRejectionOptions<ContextT> {
  /**
   * Maximum number of blocked callers in the backlog. Default: 100
   */
  backlogSize?: number | undefined;

  /**
   * Maximum timeout for callers blocked on the limiter, in milliseconds.
   * Can be a fixed number or a function that derives the timeout from the
   * request context (e.g. from a deadline). Default: 1000
   */
  backlogTimeout?: number | ((context: ContextT) => number) | undefined;
}

/**
 * Rejection strategy that blocks the caller in a LIFO queue when the limit
 * has been reached. This strategy favors availability over latency by
 * processing the most recently blocked request first, keeping success
 * latencies low and minimizing timeouts.
 */
export class LifoBlockingRejection<
  ContextT,
> implements AllotmentUnavailableStrategy<ContextT> {
  private readonly delegate: BlockingBacklogRejection<ContextT>;

  constructor(options: LifoBlockingRejectionOptions<ContextT> = {}) {
    this.delegate = new BlockingBacklogRejection<ContextT>({
      backlogSize: options.backlogSize ?? 100,
      backlogTimeout: options.backlogTimeout ?? 1_000,
      queue: new LinkedWaiterQueue("front"),
    });
  }

  onAllotmentUnavailable(
    context: ContextT,
    retry: (context: ContextT) => AcquireResult,
    signal?: AbortSignal,
  ) {
    return this.delegate.onAllotmentUnavailable(context, retry, signal);
  }

  onAllotmentReleased() {
    return this.delegate.onAllotmentReleased();
  }

  onLimitChanged(oldLimit: number, newLimit: number): void {
    this.delegate.onLimitChanged(oldLimit, newLimit);
  }
}
