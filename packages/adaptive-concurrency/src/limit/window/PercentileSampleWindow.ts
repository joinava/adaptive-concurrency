import type { SampleWindow } from "./SampleWindow.js";

/**
 * SampleWindow that uses a configurable percentile of observed RTTs as the
 * tracked RTT and the minimum RTT as the candidate RTT. Samples beyond the
 * window size are discarded.
 */
class ImmutablePercentileSampleWindow implements SampleWindow {
  private readonly minRtt: number;
  private readonly _maxInflight: number;
  private readonly hasSeenDrop: boolean;
  private readonly observedRtts: number[];
  private readonly _sampleCount: number;
  private readonly percentile: number;
  private readonly windowSize: number;

  constructor(opts: {
    percentile: number,
    windowSize: number,

    // ONLY MEANT TO BE CALLED BY INTERNAL CALLERS; not settable through public factory.
    minRtt?: number,
    maxInflight?: number,
    dropped?: boolean,
    sampleCount?: number,
    observedRtts?: number[],
  }) {
    const { minRtt, maxInflight, dropped, observedRtts, sampleCount, percentile, windowSize } = opts;
    this.minRtt = minRtt ?? Infinity;
    this._maxInflight = maxInflight ?? 0;
    this.hasSeenDrop = dropped ?? false;
    this.observedRtts = observedRtts ?? new Array<number>(windowSize).fill(0);
    this._sampleCount = sampleCount ?? 0;
    this.percentile = percentile;
    this.windowSize = windowSize;
  }

  addSample(rtt: number, inflight: number, didDrop: boolean) {
    if (this._sampleCount >= this.windowSize) {
      return this;
    }

    // Share the backing array between windows (safe because we only ever
    // write to indices that haven't been written to yet in a given window
    // lifecycle, and the array is never modified after the window is closed).
    this.observedRtts[this._sampleCount] = rtt;

    return new ImmutablePercentileSampleWindow(
      {
        minRtt: Math.min(this.minRtt, rtt),
        maxInflight: Math.max(inflight, this._maxInflight),
        dropped: this.hasSeenDrop || didDrop,
        observedRtts: this.observedRtts,
        sampleCount: this._sampleCount + 1,
        percentile: this.percentile,
        windowSize: this.windowSize,
      }
    );
  }

  get candidateRttMs(): number {
    return this.minRtt;
  }

  get trackedRttMs(): number {
    if (this._sampleCount === 0) {
      return 0;
    }
    const k = Math.round(this._sampleCount * this.percentile) - 1;
    // Slice first so quickselect's in-place mutations don't affect
    // other window instances that share the same backing array.
    const copy = this.observedRtts.slice(0, this._sampleCount);
    return quickselect(copy, k, 0, this._sampleCount - 1);
  }

  get maxInFlight(): number {
    return this._maxInflight;
  }

  get sampleCount(): number {
    return this._sampleCount;
  }

  get dropped(): boolean {
    return this.hasSeenDrop;
  }

  toString(): string {
    return (
      `ImmutablePercentileSampleWindow [` +
      `minRtt=${this.minRtt.toFixed(3)}` +
      `, p${this.percentile} rtt=${this.trackedRttMs.toFixed(3)}` +
      `, maxInFlight=${this._maxInflight}` +
      `, sampleCount=${this._sampleCount}` +
      `, didDrop=${this.hasSeenDrop}]`
    );
  }
}

/**
 * @param percentile Percentile to track, in the range (0, 1)
 * @param windowSize Maximum number of samples per window
 */
export function createPercentileSampleWindow(
  percentile: number,
  windowSize: number,
): ImmutablePercentileSampleWindow {
  if (percentile <= 0 || percentile >= 1) {
    throw new RangeError("Percentile should belong to (0, 1.0)");
  }

  return new ImmutablePercentileSampleWindow({ percentile, windowSize });
}

/**
 * In-place Hoare-partition quickselect. Returns the k-th smallest element
 * (0-indexed) within arr[lo..hi]. Mutates the array, but only within
 * the [lo, hi] range.
 */
function quickselect(
  arr: number[],
  k: number,
  lo: number,
  hi: number,
): number {
  while (lo < hi) {
    const pivot = arr[lo + ((hi - lo) >> 1)]!;
    let i = lo;
    let j = hi;

    while (i <= j) {
      while (arr[i]! < pivot) i++;
      while (arr[j]! > pivot) j--;
      if (i <= j) {
        const tmp = arr[i]!;
        arr[i] = arr[j]!;
        arr[j] = tmp;
        i++;
        j--;
      }
    }

    if (k <= j) {
      hi = j;
    } else if (k >= i) {
      lo = i;
    } else {
      break;
    }
  }

  return arr[k]!;
}
