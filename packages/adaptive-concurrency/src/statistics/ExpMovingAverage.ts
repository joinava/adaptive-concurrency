import type { StreamingStatistic } from "./StreamingStatistic.js";

/**
 * Exponential moving average over a sample stream. During the warmup
 * phase (the first {@link warmupWindow} samples) a simple arithmetic mean is
 * used. After warmup, samples are blended using an exponential decay factor
 * derived from the configured window size.
 */
export class ExpMovingAverage implements StreamingStatistic {
  private value = 0;
  private sum = 0;
  private count = 0;
  private readonly window: number;
  private readonly warmupWindow: number;

  constructor(window: number, warmupWindow: number) {
    this.window = window;
    this.warmupWindow = warmupWindow;
  }

  addSample(sample: number): number {
    if (this.count < this.warmupWindow) {
      this.count++;
      this.sum += sample;
      this.value = this.sum / this.count;
    } else {
      const factor = ExpMovingAverage.factor(this.window);
      this.value = this.value * (1 - factor) + sample * factor;
    }
    return this.value;
  }

  private static factor(n: number): number {
    return 2.0 / (n + 1);
  }

  get currentValue(): number {
    return this.value;
  }

  reset(): void {
    this.value = 0;
    this.count = 0;
    this.sum = 0;
  }

  update(operation: (current: number) => number): void {
    this.value = operation(this.value);
  }
}
