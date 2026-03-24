import type {
  AcquireResult,
  AllotmentUnavailableStrategy,
} from "../../Limiter.js";
import {
  LinkedWaiterQueue,
  BlockingBacklogRejection,
  MAX_TIMEOUT,
} from "./BlockingBacklogRejection.js";

export type FifoBlockingRejectionOptions<ContextT> = {
  /**
   * Maximum number of blocked callers in the backlog.
   * Default: unbounded
   */
  backlogSize?: number | undefined;

  /**
   * Maximum timeout for callers blocked on the limiter, in milliseconds.
   * Can be a fixed number or a function that derives the timeout from the
   * request context (e.g. from a deadline). Default: 3_600_000 (1 hour).
   */
  backlogTimeout?: number | ((context: ContextT) => number) | undefined;
};

/**
 * Rejection strategy that blocks the caller in a FIFO queue when the limit
 * has been reached, waiting for a slot to open up. This strategy favors
 * fairness: callers are served in the order they arrived.
 *
 * Because JavaScript is single-threaded, "blocking" means awaiting a promise
 * that resolves when a token becomes available.
 */
export class FifoBlockingRejection<
  ContextT,
> implements AllotmentUnavailableStrategy<ContextT> {
  private readonly delegate: BlockingBacklogRejection<ContextT>;

  constructor(options: FifoBlockingRejectionOptions<ContextT> = {}) {
    this.delegate = new BlockingBacklogRejection<ContextT>({
      backlogSize: options.backlogSize ?? Number.POSITIVE_INFINITY,
      backlogTimeout: options.backlogTimeout ?? MAX_TIMEOUT,
      queue: new LinkedWaiterQueue("back"),
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
