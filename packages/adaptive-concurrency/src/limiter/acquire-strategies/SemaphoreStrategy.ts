import { AllotmentReservation } from "../../AllotmentReservation.js";

/**
 * Simple semaphore-based acquire strategy. Tracks a permits counter that is
 * decremented when a reservation is taken and incremented on cancel or
 * release. When permits reach zero, `tryReserveAllotment` returns `undefined`.
 *
 * The two-phase API has nothing to defer for a counter-only strategy, so
 * commit is a no-op: a successful reserve has already decremented `permits`.
 * Cancel (caller chose not to commit) and `onAllotmentReleased` (caller
 * committed and is now done) both restore the permit symmetrically.
 */
export class SemaphoreStrategy {
  private permits: number;

  constructor(initialLimit: number) {
    this.permits = initialLimit;
  }

  tryReserveAllotment(): AllotmentReservation | undefined {
    if (this.permits <= 0) return undefined;
    this.permits--;
    return new AllotmentReservation(
      () => {},
      () => {
        this.permits++;
      },
    );
  }

  onAllotmentReleased(): void {
    this.permits++;
  }

  /**
   * Adjust available permits by the limit delta.
   *
   * On a shrink that drops more permits than are currently available,
   * `permits` deliberately goes negative — `tryReserveAllotment`'s `<= 0`
   * guard then keeps rejecting until enough already-inflight allotments
   * release to bring it positive again. That bleeds the excess inflight
   * off naturally, without forcibly cancelling running work or violating
   * the new limit. The counter therefore models "available headroom
   * relative to the (possibly newly-shrunk) limit", not "permits ever
   * issued".
   */
  onLimitChanged(oldLimit: number, newLimit: number): void {
    this.permits += newLimit - oldLimit;
  }
}
