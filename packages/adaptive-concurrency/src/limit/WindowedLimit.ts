import type { AdaptiveLimit } from "./StreamingLimit.js";
import { makeAverageSampleWindow } from "./window/AverageSampleWindow.js";
import type { SampleWindow } from "./window/SampleWindow.js";

/** Minimum observed samples to filter out windows with insufficient data */
const DEFAULT_WINDOW_SIZE = 10;

const DEFAULT_MIN_WINDOW_TIME = 1_000; // 1 second in ms
const DEFAULT_MAX_WINDOW_TIME = 1_000; // 1 second in ms
const DEFAULT_MIN_RTT_THRESHOLD = 0.1; // 100 microseconds in ms

export interface WindowedLimitOptions {
  /**
   * Minimum window duration for sampling a new minRtt, in milliseconds.
   * Must be >= 100. Default: 1000
   */
  minWindowTimeMs?: number;

  /**
   * Maximum window duration for sampling a new minRtt, in milliseconds.
   * Must be >= 100. Default: 1000
   */
  maxWindowTimeMs?: number;

  /**
   * Minimum sampling window size for finding a new minimum rtt.
   * Must be >= 10. Default: 10
   */
  windowSize?: number;

  /** Minimum RTT threshold in milliseconds. Default: 0.1 (100 microseconds) */
  minRttThresholdMs?: number;

  /** Returns a fresh sample window. Default: {@link makeAverageSampleWindow}. */
  sampleWindowFactory?: () => SampleWindow;
}

/**
 * Limit decorator that buffers samples into time-based windows before
 * forwarding aggregated results to a delegate StreamingLimit. This reduces
 * noise from individual samples and ensures the delegate only sees
 * representative data.
 *
 * **Important:** Because a window aggregates samples across many requests,
 * the `operationName` received in each `addSample` call is intentionally
 * **not** forwarded to the delegate. This means `WindowedLimit` is
 * incompatible with delegates that rely on per-sample operation names
 * (e.g. `GroupAwareLimit`). Wrapping a `GroupAwareLimit` in a
 * `WindowedLimit` will silently disable all group-aware behavior.
 */
export class WindowedLimit implements AdaptiveLimit {
  private readonly delegate: AdaptiveLimit;

  /** End time for the sampling window at which point the limit should be updated */
  private nextUpdateTime = 0;

  private readonly minWindowTime: number;
  private readonly maxWindowTime: number;
  private readonly windowSize: number;
  private readonly minRttThreshold: number;
  private readonly sampleWindowFactory: () => SampleWindow;

  /** Object tracking stats for the current sample window */
  private sample: SampleWindow;

  /**
   * Set when `applyProbeFromZero` fires so the very next `addSample` bypasses
   * windowing and is forwarded directly to the delegate. Without this, a
   * single dropped probe sample never reaches the delegate (the window
   * requires `windowSize` samples to become ready), so the delegate stays at
   * limit 1 and the exponential backoff never re-arms.
   */
  private probeActive = false;

  // Forward recovery-probe support to the delegate when supported. Both
  // methods are provided iff the delegate provides them, so the limiter's
  // "both methods present" check works correctly.
  readonly probeFromZeroInterval?: (failedProbes: number) => number;
  readonly applyProbeFromZero?: () => void;

  constructor(delegate: AdaptiveLimit, options: WindowedLimitOptions = {}) {
    this.delegate = delegate;
    const { probeFromZeroInterval, applyProbeFromZero } = delegate;

    if (
      typeof probeFromZeroInterval === "function" &&
      typeof applyProbeFromZero === "function"
    ) {
      this.probeFromZeroInterval = probeFromZeroInterval.bind(delegate);
      this.applyProbeFromZero = () => {
        this.probeActive = true;
        applyProbeFromZero.call(delegate);
      };
    }

    this.minWindowTime = options.minWindowTimeMs ?? DEFAULT_MIN_WINDOW_TIME;
    this.maxWindowTime = options.maxWindowTimeMs ?? DEFAULT_MAX_WINDOW_TIME;
    this.windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.minRttThreshold =
      options.minRttThresholdMs ?? DEFAULT_MIN_RTT_THRESHOLD;
    this.sampleWindowFactory =
      options.sampleWindowFactory ?? makeAverageSampleWindow;

    if (this.minWindowTime < 100) {
      throw new RangeError("minWindowTime must be >= 100 ms");
    }
    if (this.maxWindowTime < 100) {
      throw new RangeError("maxWindowTime must be >= 100 ms");
    }
    if (this.windowSize < 10) {
      throw new RangeError("Window size must be >= 10");
    }

    this.sample = this.sampleWindowFactory();
  }

  addSample(
    startTime: number,
    rtt: number,
    inflight: number,
    didDrop: boolean,
    operationName?: string,
  ): void {
    if (this.probeActive) {
      this.probeActive = false;
      this.delegate.addSample(startTime, rtt, inflight, didDrop);
      return;
    }

    const endTime = startTime + rtt;

    if (rtt < this.minRttThreshold) {
      return;
    }

    this.sample = this.sample.addSample(rtt, inflight, didDrop);

    if (endTime <= this.nextUpdateTime) {
      return;
    }

    const current = this.sample;
    this.sample = this.sampleWindowFactory();
    this.nextUpdateTime =
      endTime +
      Math.min(
        Math.max(current.candidateRttMs * 2, this.minWindowTime),
        this.maxWindowTime,
      );

    const isWindowReady =
      current.candidateRttMs < Infinity &&
      current.sampleCount >= this.windowSize;

    // The window has a mix of operations, so we can't provide a single
    // operation name to the delegate.
    if (isWindowReady) {
      this.delegate.addSample(
        startTime,
        current.trackedRttMs,
        current.maxInFlight,
        current.dropped,
      );
    }
  }

  get currentLimit(): number {
    return this.delegate.currentLimit;
  }

  subscribe(
    consumer: (newLimit: number) => void,
    options?: { signal?: AbortSignal },
  ): () => void {
    return this.delegate.subscribe(consumer, options);
  }
}
