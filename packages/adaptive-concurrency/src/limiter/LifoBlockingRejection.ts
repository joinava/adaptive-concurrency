import type { LimitAllotment } from "../LimitAllotment.js";
import type {
  AllotmentUnavailableStrategy,
  AsyncAcquireResult,
  SyncAcquireResult,
} from "../Limiter.js";

interface Waiter<ContextT> {
  context: ContextT;
  resolve: (allotment: LimitAllotment | undefined) => void;
}

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
> implements AllotmentUnavailableStrategy<ContextT, AsyncAcquireResult> {
  private readonly backlogSize: number;
  private readonly getBacklogTimeout: (context: ContextT) => number;
  private readonly backlog: Array<Waiter<ContextT>> = [];

  private retry: ((context: ContextT) => SyncAcquireResult) | undefined;

  constructor(options: LifoBlockingRejectionOptions<ContextT> = {}) {
    this.backlogSize = options.backlogSize ?? 100;

    const timeout = options.backlogTimeout ?? 1_000;
    this.getBacklogTimeout =
      typeof timeout === "number" ? () => timeout : timeout;
  }

  onAllotmentUnavailable(
    context: ContextT,
    retry: (context: ContextT) => SyncAcquireResult,
    signal?: AbortSignal,
  ): Promise<LimitAllotment | undefined> {
    this.retry = retry;

    if (this.backlog.length >= this.backlogSize) {
      return Promise.resolve(undefined);
    }

    return this.waitForBacklog(context, signal);
  }

  onAllotmentReleased(): void {
    if (this.backlog.length === 0 || !this.retry) return;

    const waiter = this.backlog[0]!;
    const allotment = this.retry(waiter.context);
    if (allotment) {
      this.backlog.shift();
      waiter.resolve(allotment);
    }
  }

  private waitForBacklog(
    context: ContextT,
    signal?: AbortSignal,
  ): Promise<LimitAllotment | undefined> {
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
        resolve: (allotment) => settle(allotment),
      };
      this.backlog.unshift(waiter);

      const timer = setTimeout(
        () => settle(undefined),
        this.getBacklogTimeout(context),
      );
      const onAbort = (): void => settle(undefined);

      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);

        const idx = this.backlog.indexOf(waiter);
        if (idx !== -1) {
          this.backlog.splice(idx, 1);
        }
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
