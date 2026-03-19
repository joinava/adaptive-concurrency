import type { SampleWindow } from "./SampleWindow.js";

/**
 * SampleWindow that tracks the average RTT as the tracked RTT and the
 * minimum RTT as the candidate RTT.
 */
class ImmutableAverageSampleWindow implements SampleWindow {
  private readonly minRtt: number;
  private readonly sum: number;
  private readonly maxInflightValue: number;
  private readonly _sampleCount: number;
  private readonly droppedValue: boolean;

  constructor(
    minRtt = Infinity,
    sum = 0,
    maxInflight = 0,
    sampleCount = 0,
    dropped = false,
  ) {
    this.minRtt = minRtt;
    this.sum = sum;
    this.maxInflightValue = maxInflight;
    this._sampleCount = sampleCount;
    this.droppedValue = dropped;
  }

  addSample(rtt: number, inflight: number, didDrop: boolean): ImmutableAverageSampleWindow {
    return new ImmutableAverageSampleWindow(
      Math.min(rtt, this.minRtt),
      this.sum + rtt,
      Math.max(inflight, this.maxInflightValue),
      this._sampleCount + 1,
      this.droppedValue || didDrop,
    );
  }

  get candidateRttMs(): number {
    return this.minRtt;
  }

  get trackedRttMs(): number {
    return this._sampleCount === 0 ? 0 : this.sum / this._sampleCount;
  }

  get maxInFlight(): number {
    return this.maxInflightValue;
  }

  get sampleCount(): number {
    return this._sampleCount;
  }

  get dropped(): boolean {
    return this.droppedValue;
  }

  toString(): string {
    return (
      `ImmutableAverageSampleWindow [` +
      `minRtt=${this.minRtt.toFixed(3)}` +
      `, avgRtt=${this.trackedRttMs.toFixed(3)}` +
      `, maxInFlight=${this.maxInflightValue}` +
      `, sampleCount=${this._sampleCount}` +
      `, didDrop=${this.droppedValue}]`
    );
  }
}

/** Default window creator for windowed limits (new empty average window). */
export const makeAverageSampleWindow = (): SampleWindow => new ImmutableAverageSampleWindow();
