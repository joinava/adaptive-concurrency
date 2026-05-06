/**
 * A histogram with log-spaced bins and continuous exponential time decay.
 *
 * Each bin stores a decayed count that is incremented when a sample falls
 * within its range. All counts decay toward zero over time using an
 * exponential half-life, so older observations naturally lose influence.
 *
 * Provides approximate percentile queries in O(numBins) time and fixed memory
 * (~25 floats), independent of sample volume.
 */
export class DecayingHistogram {
  /** Lower boundary (inclusive) of each bin. The last bin extends to +Infinity. */
  private readonly binEdges: Float64Array;
  private readonly binCounts: Float64Array;
  private readonly numBins: number;
  private readonly minValue: number;
  private readonly maxValue: number;
  private readonly logWarning: ((message: string) => void) | undefined;

  /** Precomputed decay constant: ln(2) / halfLife */
  private readonly lambda: number;

  /** Timestamp of the last decay application, or undefined before the first sample. */
  private lastDecayTime: number | undefined;

  /** Accumulated decayed total (sum of all bin counts after last decay). */
  private _totalCount = 0;

  constructor(options: {
    /** Half-life for exponential decay, in milliseconds. */
    halfLife: number;
    minValue?: number;
    maxValue?: number;
    binsPerDecade?: number;
    logWarning?: (message: string) => void;
  }) {
    const {
      halfLife,
      minValue = 0.1,
      maxValue = 100_000,
      binsPerDecade = 5,
      logWarning,
    } = options;
    if (halfLife <= 0) {
      throw new RangeError("halfLife must be positive");
    }
    if (minValue <= 0 || maxValue <= minValue) {
      throw new RangeError("Must have 0 < minValue < maxValue");
    }

    this.lambda = Math.LN2 / halfLife;
    this.minValue = minValue;
    this.maxValue = maxValue;
    this.logWarning = logWarning;

    const logMin = Math.log10(minValue);
    const logMax = Math.log10(maxValue);
    const decades = logMax - logMin;
    this.numBins = Math.max(2, Math.ceil(decades * binsPerDecade) + 1);

    this.binEdges = new Float64Array(this.numBins);
    for (let i = 0; i < this.numBins; i++) {
      this.binEdges[i] = Math.pow(10, logMin + (i * decades) / (this.numBins - 1));
    }

    this.binCounts = new Float64Array(this.numBins);
  }

  /**
   * Record a sample value at the given time.
   */
  addSample(value: number, now: number): void {
    if (this.logWarning) {
      if (value < this.minValue) {
        this.logWarning(
          `DecayingHistogram: sample ${value} is below minValue ${this.minValue}; ` +
            `it will be clamped to the lowest bin. Consider lowering minValue.`,
        );
      } else if (value > this.maxValue) {
        this.logWarning(
          `DecayingHistogram: sample ${value} is above maxValue ${this.maxValue}; ` +
            `it will be clamped to the highest bin. Consider raising maxValue.`,
        );
      }
    }

    this.applyDecay(now);

    const bin = this.findBin(value);
    this.binCounts[bin]!++;
    this._totalCount += 1;
  }

  /**
   * Query an approximate percentile from the decayed histogram.
   *
   * Returns the geometric midpoint of the bin containing the target
   * percentile, which reduces quantization bias from log-spaced bin edges.
   *
   * @param p Percentile in (0, 1), e.g. 0.1 for p10.
   * @param now Current time for decay application.
   * @returns The approximate value at the requested percentile, or NaN if
   *          the histogram is empty.
   */
  percentile(p: number, now: number): number {
    if (p <= 0 || p >= 1) {
      throw new RangeError(`p must be in (0, 1), got ${p}`);
    }

    this.applyDecay(now);

    if (this._totalCount <= 0) {
      return NaN;
    }

    const target = p * this._totalCount;
    let cumulative = 0;
    for (let i = 0; i < this.numBins; i++) {
      cumulative += this.binCounts[i]!;
      if (cumulative >= target) {
        const lo = this.binEdges[i]!;
        const hi =
          i + 1 < this.numBins ? this.binEdges[i + 1]! : lo * 2;
        return Math.sqrt(lo * hi);
      }
    }

    const lastEdge = this.binEdges[this.numBins - 1]!;
    return Math.sqrt(lastEdge * lastEdge * 2);
  }

  /**
   * The total decayed sample count across all bins.
   */
  get totalCount(): number {
    return this._totalCount;
  }

  /**
   * Apply time-based decay to all bins. Idempotent if called multiple times
   * at the same timestamp.
   */
  private applyDecay(now: number): void {
    if (this.lastDecayTime === undefined) {
      this.lastDecayTime = now;
      return;
    }

    const elapsed = now - this.lastDecayTime;
    if (elapsed <= 0) {
      return;
    }

    const factor = Math.exp(-this.lambda * elapsed);
    let total = 0;
    for (let i = 0; i < this.numBins; i++) {
      const decayed = this.binCounts[i]! * factor;
      this.binCounts[i] = decayed;
      total += decayed;
    }
    this._totalCount = total;
    this.lastDecayTime = now;
  }

  /**
   * Find the bin index for a value using binary search.
   */
  private findBin(value: number): number {
    let lo = 0;
    let hi = this.numBins - 1;

    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (value >= this.binEdges[mid]!) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }

    return lo;
  }
}
