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
 * **Scoping the bucket to some contexts (`appliesTo`).** By default the bucket
 * governs every context. Pass `appliesTo` to narrow it: a context the predicate
 * rejects keeps the inner strategy's protections (per-process adaptive limit,
 * partition fairness) but skips the bucket entirely, so no token is taken and
 * none has to be refunded. An exempt context is still bounded locally, because
 * it still goes through the inner strategy.
 *
 * The safe shape is a sub-budget. Nest this strategy inside an outer one whose
 * bucket still governs every context, and let the inner bucket meter one class
 * of traffic. Exempting a class from the *only* bucket in a chain is a
 * different thing: it converts a hard fleet-wide ceiling into a per-process
 * soft bound for that class, because the inner strategy cannot see the other
 * processes.
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
 * - **Inner `cancel()` throws while the bucket denies.** Here the strategy is
 *   rejecting, so it returns `undefined` and the caller never receives a
 *   reservation. It cannot learn that the inner leaked a permit, and throwing
 *   instead would turn a bucket denial into a thrown `acquire()`. So the error
 *   is swallowed and reported through {@link
 *   RedisTokenBucketStrategyOptions.onReservationError}, which exists for
 *   exactly this case: a fault the caller has no other way to observe.
 *
 * - **A reservation this strategy returned later throws** from `commit()` or
 *   `cancel()`. The caller invoked that transition and can catch it, so the
 *   error simply propagates; there is no hook and nothing is swallowed. The
 *   bucket token is settled either way — refunded on a commit failure and on
 *   every cancel — before the error escapes. The inner's reservation may be
 *   leaked, which is the inner's contract to describe, not this strategy's.
 *
 * That split is the whole rule: the hook covers the reservation the caller
 * never got, and everything else is ordinary error propagation.
 *
 * Limit change and release events are forwarded to the inner strategy.
 */
/**
 * Information passed to {@link RedisTokenBucketStrategyOptions.onReservationError}
 * when the inner's `reservation.cancel()` throws as the bucket denies.
 */
export type ReservationErrorInfo<ContextT> = {
  context: ContextT;
  error: unknown;
};

export class RedisTokenBucketStrategy<ContextT> {
  readonly #bucket: RedisTokenBucket;
  readonly #keyResolver: (context: ContextT) => string;
  readonly #appliesTo: (context: ContextT) => boolean;
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
     * Which contexts this bucket governs. Defaults to every context. Return
     * `false` to exempt one: the inner strategy still reserves and bounds it,
     * but the bucket is skipped entirely, so no token is taken and none has to
     * be refunded.
     *
     * Exempting a class of traffic from the only bucket in a chain gives up the
     * fleet-wide ceiling for that class, leaving it bounded only per process.
     * To meter a class without giving up the ceiling, nest this strategy inside
     * an outer one whose bucket still governs every context.
     */
    appliesTo?: (context: ContextT) => boolean;
    /**
     * Invoked when the inner's `reservation.cancel()` throws as the bucket
     * denies. The error is swallowed so the denial stays a denial, and the
     * inner's reservation is leaked, so this hook is the only way to learn
     * that it happened. Wire up logging or a metric here.
     *
     * It does not fire for a reservation this strategy already returned.
     * Errors from that reservation's `commit()` or `cancel()` propagate to
     * whoever called them.
     */
    onReservationError?: (info: ReservationErrorInfo<ContextT>) => void;
  }) {
    this.#bucket = options.bucket;
    this.#inner = options.inner;
    this.#keyResolver = options.keyResolver ?? defaultKeyResolver;
    this.#appliesTo = options.appliesTo ?? appliesToEveryContext;
    this.#onReservationError = options.onReservationError;
  }

  async tryReserveAllotment(
    context: ContextT,
    state: LimiterState,
  ): Promise<AllotmentReservation | undefined> {
    // Both callbacks run before the inner reserves. Reserving first and then
    // asking whether the bucket applies would strand the inner reservation if
    // the predicate threw, and a context the bucket does not govern has no
    // reason to resolve a bucket key at all. `undefined` reads as "not
    // governed" unambiguously, because `keyResolver` returns a string.
    const key = this.#appliesTo(context)
      ? this.#keyResolver(context)
      : undefined;

    const reservation = await this.#inner.tryReserveAllotment(context, state);
    if (!reservation) {
      return undefined;
    }

    // A context this bucket does not govern keeps the inner reservation and
    // skips the bucket entirely (no token consumed, nothing to refund).
    if (key === undefined) {
      return reservation;
    }

    const result = await this.#bucket.tryAcquire(key);
    if (!result.acquired) {
      try {
        await reservation.cancel();
      } catch (error) {
        await this.#fireReservationError({ context, error });
      }
      return undefined;
    }

    // Both gates granted. Return a reservation that settles the bucket token
    // and otherwise gets out of the way: the caller owns these transitions, so
    // an error from the inner propagates to whoever called commit or cancel.
    return new AllotmentReservation(
      async () => {
        try {
          await reservation.commit();
        } catch (error) {
          // The inner is in an indeterminate state per the
          // AllotmentReservation contract, but the bucket token is purely ours
          // and refunding is always safe (the bucket is rate-based, not
          // absolute), so give it back before the error escapes.
          // `#refundQuietly` never throws, so it cannot shadow `error`.
          await this.#refundQuietly(key);
          throw error;
        }
      },
      async () => {
        // `finally`, not a catch: the token is refunded whether or not the
        // inner cancels cleanly, and a cancel failure still reaches the
        // caller. Safe against shadowing because `#refundQuietly` never
        // throws.
        try {
          await reservation.cancel();
        } finally {
          await this.#refundQuietly(key);
        }
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

function appliesToEveryContext(): boolean {
  return true;
}

function defaultKeyResolver(): string {
  return "default";
}
