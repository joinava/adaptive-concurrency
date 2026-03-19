import type { StreamingStatistic } from "./StreamingStatistic.js";

/**
 * Holds only the most recent sample value.
 */
export class MostRecentValue implements StreamingStatistic {
  private value: number | null = null;

  addSample(sample: number): number {
    this.value = sample;
    return sample;
  }

  get currentValue(): number {
    return this.value ?? 0;
  }

  reset(): void {
    this.value = null;
  }

  update(operation: (current: number) => number): void {
    if (this.value !== null) {
      this.value = operation(this.value);
    }
  }
}
