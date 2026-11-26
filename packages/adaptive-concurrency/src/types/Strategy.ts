import type { AllotmentReservation } from "../AllotmentReservation.js";
import type { allotmentUnavailableError } from "../errors.js";
import type { Limiter } from "../Limiter.js";
import type { MaybePromise } from "./MaybePromise.js";

/**
 * Handle returned when a concurrency slot is acquired. The caller must invoke
 * exactly one of the release-and-xxx methods when the operation completes.
 *
 * **Important for implementers:** the release methods below must never throw
 * or produce a rejected promise. If an error occurs internally (e.g. notifying
 * a strategy), the implementation is responsible for catching and handling it.
 * Callers may invoke these methods in a fire-and-forget manner (without
 * awaiting), so any rejection would become an unhandled promise rejection.
 */
export type LimitAllotment = {
  /**
   * The operation succeeded and internally measured latency should be used as
   * an RTT sample.
   *
   * @param weight Optional amount of work that the operation represented,
   *   for example the number of items in a batch call. It is passed to the
   *   limit algorithm's `addSample`.
   */
  releaseAndRecordSuccess(weight?: number): Promise<void>;

  /**
   * The operation failed before any meaningful RTT measurement could be made
   * and should be ignored so it does not introduce an artificially low RTT.
   */
  releaseAndIgnore(): Promise<void>;

  /**
   * The request failed and was dropped due to being rejected by an external
   * limit or hitting a timeout. Loss based StreamingLimit implementations will
   * likely do an aggressive reduction in limit when this happens.
   *
   * @param weight Optional amount of work that the operation represented,
   *   for example the number of items in a batch call. It is passed to the
   *   limit algorithm's `addSample`.
   */
  releaseAndRecordDropped(weight?: number): Promise<void>;
};

export type AcquireOptions<ContextT = void> = {
  context?: ContextT;
  signal?: AbortSignal | undefined;
};

/**
 * An expected outcome that can fail: `{ ok: true, value }`, or
 * `{ ok: false, error }`. The package uses it where a failure is a normal
 * outcome under load, which the caller must handle, not an exception.
 */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * The result of {@link Limiter.acquire}, and of an
 * {@link AllotmentUnavailableStrategy}.
 *
 * - It resolves with `{ ok: true, value }`, where `value` is the allotment.
 * - It resolves with `{ ok: false, error }` when the limiter gives no
 *   allotment. `error` is an {@link allotmentUnavailableError}.
 * - It rejects with the signal's `reason` when the caller's signal aborts
 *   first, and with any error that a strategy, the clock, or another
 *   callback throws.
 */
export type AcquireResult = Promise<Result<LimitAllotment>>;

/**
 * One more attempt to get an allotment, which an
 * {@link AllotmentUnavailableStrategy} calls while it waits. It resolves with
 * `undefined` when the acquire strategy still refuses: that is not a final
 * answer, so the waiting strategy decides what to do next.
 */
export type RetryAcquire<ContextT> = (
  context: ContextT,
) => Promise<LimitAllotment | undefined>;

/**
 * Read-only view of the limiter's current state, provided to strategies so
 * they can make gating decisions without coupling to the Limiter class.
 */
export type LimiterState = {
  readonly limit: number;
  readonly inflight: number;
};

/**
 * Decides whether a non-bypassed caller may take a concurrency allotment and
 * updates strategy bookkeeping when they may (e.g. permits counter or
 * per-partition tracking).
 *
 * Admission is two-phase: {@link tryReserveAllotment} tentatively claims a
 * slot and returns a receipt; the caller resolves the receipt via either
 * `commit()` (finalize) or `cancel()` (undo). Speculative reservations count
 * against admission for concurrent calls, but their fire-and-forget side
 * effects (metric samples, waiter notifications, etc.) are deferred to
 * commit, so a cancelled reservation leaves no observable trace beyond
 * counters that are restored to baseline. This lets composers like
 * Redis-bucket-on-top-of-X gate the inner strategy without polluting its
 * metrics or waking waiters when the outer gate ultimately rejects.
 */
export type AcquireStrategy<ContextT> = {
  /**
   * Tentatively reserves an allotment without firing fire-and-forget side
   * effects (metric samples, waiter notifications, etc.). On success, returns
   * an {@link AllotmentReservation} that the caller must resolve via exactly
   * one call to its `commit()` or `cancel()`. On failure, returns `undefined`
   * and no follow-up is required.
   *
   * Reserved (but not yet committed) capacity SHOULD count against the
   * strategy's admission decisions for concurrent calls, just as committed
   * capacity does, so the strategy never over-admits relative to its
   * configured limit.
   */
  tryReserveAllotment(
    context: ContextT,
    state: LimiterState,
  ): MaybePromise<AllotmentReservation | undefined>;

  /**
   * Called when a committed allotment completes (success, ignore, or drop).
   * Perform any cleanup (e.g. increment permits, release a partition slot).
   * Not called for reservations that were cancelled before committing.
   */
  onAllotmentReleased(context: ContextT): MaybePromise<void>;

  /**
   * Called when the adaptive limit changes. The strategy can react
   * (e.g. adjust available permits by the delta, update partition sub-limits).
   */
  onLimitChanged?(oldLimit: number, newLimit: number): void;
};

/**
 * Determines what happens when a request is rejected by the
 * {@link AcquireStrategy} (e.g. queue the caller, reject immediately, or block
 * until a slot is available). Implementations must return an
 * {@link AcquireResult}, which is always a `Promise`.
 *
 * When the strategy gets an allotment, it resolves with `{ ok: true, value }`.
 * When it gives up, it resolves with `{ ok: false, error }`, where `error` is
 * an {@link allotmentUnavailableError}. The strategy makes the error, so it
 * can state what it knows: a `retryAfter` when it knows when capacity
 * returns, or a different `load`. When the caller's signal aborts, it rejects
 * with the signal's `reason`.
 */
export type AllotmentUnavailableStrategy<ContextT> = {
  /**
   * Called when the acquire strategy cannot allocate an allotment for a
   * request.
   *
   * @param context The request context.
   * @param retry Callback to re-attempt acquisition, which the strategy is
   *   expected to call later if/when a slot might have opened up. The retry
   *   runs {@link AcquireStrategy.tryReserveAllotment} and, if it grants,
   *   commits the reservation and returns a ready-to-use allotment with all
   *   required wrapping. It resolves with `undefined` if the acquire
   *   strategy still refuses.
   * @param signal Optional abort signal from the caller.
   */
  onAllotmentUnavailable(
    context: ContextT,
    retry: RetryAcquire<ContextT>,
    signal?: AbortSignal,
  ): AcquireResult;

  /**
   * Called whenever any allotment is released (success, ignore, or drop).
   * Blocking strategies use this to wake queued waiters.
   *
   * Also called when an acquire attempt ends without an allotment while
   * another attempt failed during it. The first attempt may have held a
   * reservation that it then cancelled, and the other attempt may have
   * failed because of it, so capacity may be free with no release to
   * announce it.
   */
  onAllotmentReleased(): MaybePromise<void>;

  /**
   * Called when the adaptive limit changes. Blocking/rejection strategies can
   * use this to proactively react to newly available capacity (e.g. drain
   * backlog).
   */
  onLimitChanged?(oldLimit: number, newLimit: number): MaybePromise<void>;
};
