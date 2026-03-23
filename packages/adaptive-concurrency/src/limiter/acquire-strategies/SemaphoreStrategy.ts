/**
 * Simple semaphore-based acquire strategy. Tracks a permits counter that is
 * decremented when an allotment is taken and incremented on release. When
 * permits reach zero, `tryAcquireAllotment` returns false.
 */
export class SemaphoreStrategy {
  private permits: number;

  constructor(initialLimit: number) {
    this.permits = initialLimit;
  }

  tryAcquireAllotment(): boolean {
    if (this.permits <= 0) return false;
    this.permits--;
    return true;
  }

  onAllotmentReleased(): void {
    this.permits++;
  }

  onLimitChanged(oldLimit: number, newLimit: number): void {
    this.permits += newLimit - oldLimit;
  }
}
