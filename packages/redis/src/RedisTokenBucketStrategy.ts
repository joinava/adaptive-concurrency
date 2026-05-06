import {
  AllotmentReservation,
  type AcquireStrategy,
  type LimiterState,
} from "adaptive-concurrency";
import type { RedisTokenBucket } from "./RedisTokenBucket.js";

/**
 * Higher-level acquire strategy that layers a distributed Redis token-bucket
 * limit on top of any inner {@link AcquireStrategy} (e.g. `SemaphoreStrategy`,
 * `PartitionedStrategy`). A request is admitted only when **both**:
 *
 * 1. The inner strategy reserves an allotment (its own local rules), and
 * 2. The Redis token bucket grants a token (a fleet-wide rate limit of tokens
 *    per `refillIntervalMs` shared across processes).
 *
 * **Ordering.** The inner runs first. Reservation is contractually
 * side-effect free beyond admission bookkeeping, so a bucket denial cancels
 * the inner reservation cleanly with no observable trace (no metric pollution,
 * no waiter notifications). Reservation is also typically synchronous and
 * cheap, so cheap-rejecting locally before paying the Redis round trip is a
 * win on the rejection path.
 *
 * **Caveats.** Between the inner reserve and the bucket reply the inner
 * strategy is briefly "more full" than it really is. Concurrent acquires can
 * be falsely rejected by the inner during that ~RTT window — most visible at
 * small inner limits. This is inherent to the inner-first ordering.
 *
 * **Failure handling.**
 *
 * - If Redis is unavailable, the underlying {@link RedisTokenBucket} degrades
 *   gracefully (treats `tryAcquire` as granted, silently drops `refund`), so
 *   this strategy effectively falls back to inner-only behavior.
 *
 * - **Inner `cancel()` throws** (after the bucket has denied, or the outer
 *   reservation is later cancelled): the error is swallowed and surfaced via
 *   `onReservationError({ phase: "cancel", ... })`. The strategy still
 *   returns `undefined` (or completes the cancel) — matching `Limiter`'s
 *   defensive release-error handling so a flaky inner can't turn a bucket
 *   denial into a thrown `acquire()`. The inner's reservation is leaked
 *   (decremented permits/inflight that never get restored).
 *
 * - **Inner `commit()` throws** (during the outer reservation's `commit()`):
 *   the bucket token is refunded (always safe — bucket is rate-based), the
 *   error is surfaced via `onReservationError({ phase: "commit", ... })`,
 *   and the error is **re-thrown**. Unlike a cancel-throw, we hadn't yet
 *   decided to reject, so quietly swallowing would hide a genuine
 *   inner-strategy fault; propagation makes it visible to the caller. The
 *   inner's reservation is in an indeterminate state and may be leaked.
 *
 * Limit change and release events are forwarded to the inner strategy.
 */
/**
 * Information passed to {@link RedisTokenBucketStrategyOptions.onReservationError}
 * when the inner's reservation transition fails.
 */
export type ReservationErrorInfo<ContextT> = {
  context: ContextT;
  /**
   * Which transition threw:
   * - `"cancel"`: the inner's `reservation.cancel()` threw while undoing the
   *   speculative reservation (because the bucket denied, or because the
   *   outer reservation was cancelled). The strategy continues; the inner's
   *   reservation is leaked.
   * - `"commit"`: the inner's `reservation.commit()` threw while finalizing
   *   the outer reservation. The bucket token has been refunded; the error
   *   is re-thrown to the caller after this hook returns.
   */
  phase: "cancel" | "commit";
  error: unknown;
};

export class RedisTokenBucketStrategy<ContextT> {
  readonly #bucket: RedisTokenBucket;
  readonly #keyResolver: (context: ContextT) => string;
  readonly #onReservationError:
    | ((info: ReservationErrorInfo<ContextT>) => void)
    | undefined;

  readonly #inner: AcquireStrategy<ContextT>;

  constructor(options: {
    /** Token bucket used as the second gate. */
    bucket: RedisTokenBucket;
    /**
     * Inner acquire strategy. Consulted *before* the bucket: its reservation
     * is committed when the bucket grants and cancelled when the bucket
     * denies. Must be a two-phase {@link AcquireStrategy}.
     */
    inner: AcquireStrategy<ContextT>;
    /**
     * Derives the bucket sub-key from the request context. Use this to maintain
     * separate buckets per tenant, route, etc. When omitted, all acquires share
     * a single `"default"` bucket.
     */
    keyResolver?: (context: ContextT) => string;
    /**
     * Invoked when the inner's `reservation.cancel()` or `reservation.commit()`
     * throws. Lets callers wire up logging/metrics. Behavior per phase:
     *
     * - `"cancel"`: error is swallowed; the strategy continues with its
     *   rejection (the bucket already denied, or the outer cancelled). The
     *   inner's reservation is leaked.
     * - `"commit"`: bucket token is refunded, then the error is re-thrown so
     *   the caller can see the strategy fault.
     */
    onReservationError?: (info: ReservationErrorInfo<ContextT>) => void;
  }) {
    this.#bucket = options.bucket;
    this.#inner = options.inner;
    this.#keyResolver = options.keyResolver ?? defaultKeyResolver;
    this.#onReservationError = options.onReservationError;
  }

  async tryReserveAllotment(
    context: ContextT,
    state: LimiterState,
  ): Promise<AllotmentReservation | undefined> {
    const key = this.#keyResolver(context);

    const reservation = await this.#inner.tryReserveAllotment(context, state);
    if (!reservation) {
      return undefined;
    }

    const result = await this.#bucket.tryAcquire(key);
    if (!result.acquired) {
      try {
        await reservation.cancel();
      } catch (error) {
        await this.#fireReservationError({ context, phase: "cancel", error });
      }
      return undefined;
    }

    // Both gates granted. Return a reservation that, on commit, commits the
    // inner; on cancel, cancels the inner AND refunds the bucket token. The
    // bucket-refund branch matters for nested composition (some outer
    // strategy that wraps this one and may call cancel after both gates have
    // already speculatively granted).
    return new AllotmentReservation(
      async () => {
        try {
          await reservation.commit();
        } catch (error) {
          // Inner is in an indeterminate state per the AllotmentReservation
          // contract. The bucket token is purely ours to manage and refund is
          // always safe (rate-based, not absolute), so refund it. We propagate
          // the error rather than swallowing it because (unlike a cancel-throw
          // on bucket-denied) the strategy genuinely failed to finalize and
          // that's worth surfacing.
          //
          // Both side effects below are best-effort and isolated so a throw
          // from either can't shadow `error` — the inner-commit failure is what
          // the caller asked us to surface and we must guarantee it propagates.
          await this.#refundQuietly(key);
          await this.#fireReservationError({ context, phase: "commit", error });
          throw error;
        }
      },
      async () => {
        try {
          await reservation.cancel();
        } catch (error) {
          await this.#fireReservationError({ context, phase: "cancel", error });
        }
        await this.#refundQuietly(key);
      },
    );
  }

  onAllotmentReleased(
    context: ContextT,
  ): ReturnType<AcquireStrategy<ContextT>["onAllotmentReleased"]> {
    return this.#inner.onAllotmentReleased(context);
  }

  onLimitChanged(oldLimit: number, newLimit: number): void {
    this.#inner.onLimitChanged?.(oldLimit, newLimit);
  }

  /**
   * Fire {@link #onReservationError} without ever throwing. The hook is
   * observability-only; a throw from a misbehaving observer would otherwise
   * shadow the genuinely interesting error (a bucket-denial cancel-throw,
   * or an inner-commit failure that the commit-throw branch is contractually
   * required to re-throw).
   */
  async #fireReservationError(
    info: ReservationErrorInfo<ContextT>,
  ): Promise<void> {
    try {
      // wait in case the callback is async
      await this.#onReservationError?.(info);
    } catch {
      // Swallowed deliberately.
    }
  }

  /**
   * Refund the bucket token without ever throwing. {@link RedisTokenBucket}
   * already degrades gracefully on Redis errors, but we still isolate the
   * call here so neither a future change in the bucket's contract nor an
   * unexpected synchronous throw can leak out of the cancel/commit-failure
   * paths and shadow more important errors.
   */
  async #refundQuietly(key: string): Promise<void> {
    try {
      await this.#bucket.refund(key);
    } catch {
      // The un-refunded token will be restored by the next natural
      // refill, so the long-run rate is preserved.
    }
  }
}

function defaultKeyResolver(): string {
  return "default";
}
