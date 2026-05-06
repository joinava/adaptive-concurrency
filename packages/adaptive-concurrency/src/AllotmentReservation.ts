import type { MaybePromise } from "./types/MaybePromise.js";

/**
 * Receipt for a successful {@link AcquireStrategy.tryReserveAllotment} call.
 * The caller MUST invoke exactly one of {@link commit} or {@link cancel}.
 * Holding a reservation means the strategy is counting it toward its
 * admission caps; leaking one (never resolving it) effectively reduces
 * capacity by one until the strategy is reset.
 *
 * Both methods are idempotent: only the first call to either runs its
 * registered callback; subsequent calls (to the same method or the other
 * one) are no-ops. This factors the "settled exactly once" bookkeeping out
 * of every strategy implementation.
 */
export class AllotmentReservation {
  #settled = false;
  readonly #onCommit: () => MaybePromise<void>;
  readonly #onCancel: () => MaybePromise<void>;

  /**
   * @param onCommit Invoked at most once when {@link commit} is first
   *   called. The reservation is marked settled before the callback runs,
   *   so a callback that re-enters `commit`/`cancel` on the same instance
   *   sees a no-op.
   * @param onCancel Invoked at most once when {@link cancel} is first
   *   called. Same settling semantics as `onCommit`.
   */
  constructor(
    onCommit: () => MaybePromise<void>,
    onCancel: () => MaybePromise<void>,
  ) {
    this.#onCommit = onCommit;
    this.#onCancel = onCancel;
  }

  /**
   * Finalizes the reservation: the slot transitions from "reserved" to
   * "inflight" and any side effects deferred during reservation (metric
   * samples, waiter notifications, etc.) fire now via `onCommit`. After
   * commit, exactly one matching `onAllotmentReleased` call is expected
   * when the allotment completes.
   */
  commit(): MaybePromise<void> {
    if (this.#settled) return;
    this.#settled = true;
    return this.#onCommit();
  }

  /**
   * Undoes the reservation when the outer admission decision rejected the
   * request. `onCancel` returns the strategy to the state it was in before
   * `tryReserveAllotment` was called, with no observable side effects from
   * the reservation. After cancel, no `onAllotmentReleased` is expected.
   */
  cancel(): MaybePromise<void> {
    if (this.#settled) return;
    this.#settled = true;
    return this.#onCancel();
  }
}
