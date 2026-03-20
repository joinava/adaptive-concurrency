import type { LimitAllotment } from "../../LimitAllotment.js";
import type {
  AllotmentUnavailableStrategy,
  AcquireResult,
} from "../../Limiter.js";

type Waiter = () => void;

const MAX_TIMEOUT = 60 * 60 * 1000; // 1 hour

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
  private readonly timeout: number;
  private readonly waiters: Array<Waiter> = [];

  constructor(
    options: {
      /**
       * Maximum time in milliseconds to wait for a slot to become available.
       * Default: 3_600_000 (1 hour).
       */
      timeout?: number | undefined;
    } = {},
  ) {
    const t = options.timeout ?? MAX_TIMEOUT;
    if (t > MAX_TIMEOUT) {
      throw new Error(`Timeout cannot be greater than ${MAX_TIMEOUT} ms`);
    }
    this.timeout = t;
  }

  onAllotmentUnavailable(
    _context: ContextT,
    retry: (context: ContextT) => AcquireResult,
    signal?: AbortSignal,
  ): Promise<LimitAllotment | undefined> {
    return this.acquireAsync(_context, retry, signal);
  }

  onAllotmentReleased(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private async acquireAsync(
    context: ContextT,
    retry: (context: ContextT) => AcquireResult,
    signal?: AbortSignal,
  ): Promise<LimitAllotment | undefined> {
    const deadline = performance.now() + this.timeout;

    while (true) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        return undefined;
      }

      if (signal?.aborted) {
        return undefined;
      }

      const allotment = await retry(context);
      if (allotment) {
        return allotment;
      }

      const acquired = await this.waitForRelease(remaining, signal);
      if (!acquired) {
        return undefined;
      }
    }
  }

  private waitForRelease(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (acquired: boolean): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(acquired);
      };

      const waiter: Waiter = () => settle(true);
      this.waiters.push(waiter);

      const timer = setTimeout(() => settle(false), timeoutMs);
      const onAbort = (): void => settle(false);

      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);

        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
        }
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
