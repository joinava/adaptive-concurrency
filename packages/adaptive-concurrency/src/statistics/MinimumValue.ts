import type { StreamingStatistic } from "./StreamingStatistic.js";

/**
 * Tracks the minimum value seen across all samples.
 */
export class MinimumValue implements StreamingStatistic {
  private value = Infinity;

  addSample(sample: number): number {
    if (sample < this.value) {
      this.value = sample;
    }
    return this.value;
  }

  get currentValue(): number {
    return this.value;
  }

  reset(): void {
    this.value = Infinity;
  }

  update(operation: (current: number) => number): void {
    const current = this.value;
    this.value = Math.min(current, operation(current));
  }
}
