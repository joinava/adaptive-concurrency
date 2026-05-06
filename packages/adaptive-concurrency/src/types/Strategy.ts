import type { AllotmentReservation } from "../AllotmentReservation.js";
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
   */
  releaseAndRecordSuccess(): Promise<void>;

  /**
   * The operation failed before any meaningful RTT measurement could be made
   * and should be ignored so it does not introduce an artificially low RTT.
   */
  releaseAndIgnore(): Promise<void>;

  /**
   * The request failed and was dropped due to being rejected by an external
   * limit or hitting a timeout. Loss based StreamingLimit implementations will
   * likely do an aggressive reduction in limit when this happens.
   */
  releaseAndRecordDropped(): Promise<void>;
};

export type AcquireOptions<ContextT = void> = {
  context?: ContextT;
  signal?: AbortSignal | undefined;
};

export type AcquireResult = Promise<LimitAllotment | undefined>;

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
   *   required wrapping.
   * @param signal Optional abort signal from the caller.
   */
  onAllotmentUnavailable(
    context: ContextT,
    retry: (context: ContextT) => AcquireResult,
    signal?: AbortSignal,
  ): AcquireResult;

  /**
   * Called whenever any allotment is released (success, ignore, or drop).
   * Blocking strategies use this to wake queued waiters.
   */
  onAllotmentReleased(): MaybePromise<void>;

  /**
   * Called when the adaptive limit changes. Blocking/rejection strategies can
   * use this to proactively react to newly available capacity (e.g. drain
   * backlog).
   */
  onLimitChanged?(oldLimit: number, newLimit: number): MaybePromise<void>;
};
