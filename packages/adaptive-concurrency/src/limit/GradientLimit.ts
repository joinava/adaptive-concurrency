import { ListenerSet } from "../ListenerSet.js";
import { MetricIds } from "../MetricRegistry.js";
import type { DistributionMetric, MetricRegistry } from "../MetricRegistry.js";
import { NoopMetricRegistry } from "../MetricRegistry.js";
import { ExpMovingAverage } from "../statistics/ExpMovingAverage.js";
import type { StreamingStatistic } from "../statistics/StreamingStatistic.js";
import type { AdaptiveLimit } from "./StreamingLimit.js";

/**
 * Concurrency limit algorithm that adjusts the limit based on the gradient of
 * change of the current average RTT and a long term exponentially smoothed
 * average RTT. Unlike traditional congestion control algorithms we use average
 * instead of minimum since RPC methods can be very bursty due to various
 * factors such as non-homogenous request processing complexity as well as a
 * wide distribution of data size. We have also found that using minimum can
 * result in a bias towards an impractically low base RTT resulting in excessive
 * load shedding. An exponential decay is applied to the base RTT so that the
 * value is kept stable yet is allowed to adapt to long term changes in latency
 * characteristics.
 *
 * The core algorithm re-calculates the limit every sampling window
 * (e.g. 1 second) using the formula:
 *
 *   // Calculate the gradient limiting to the range [0.5, 1.0] to filter outliers
 *   gradient = max(0.5, min(1.0, longtermRtt / currentRtt));
 *
 *   // Calculate the new limit by applying the gradient and allowing for some queuing
 *   newLimit = gradient * currentLimit + queueSize;
 *
 *   // Update the limit using a smoothing factor (default 0.2)
 *   newLimit = currentLimit * (1 - smoothing) + newLimit * smoothing
 *
 * The limit can be in one of three main states:
 *
 * 1. Steady state
 *    The average RTT is very stable and the current measurement whipsaws around
 *    this value, sometimes reducing the limit, sometimes increasing it.
 *
 * 2. Transition from steady state to load
 *    Either the RPS or latency has spiked. The gradient is < 1.0 due to a
 *    growing request queue that cannot be handled by the system. Excessive
 *    requests are rejected due to the low limit. The baseline RTT grows using
 *    exponential decay but lags the current measurement, which keeps the
 *    gradient < 1.0 and limit low.
 *
 * 3. Transition from load to steady state
 *    The system goes back to steady state after a prolonged period of excessive
 *    load. Requests aren't rejected and the sample RTT remains low. During this
 *    state the long term RTT may take some time to go back to normal and could
 *    potentially be several multiples higher than the current RTT.
 */
export interface Gradient2LimitOptions {
  /** Initial limit used by the limiter. Default: 20 */
  initialLimit?: number;

  /**
   * Minimum concurrency limit allowed. The minimum helps prevent the algorithm
   * from adjusting the limit too far down. Note that this limit is not
   * desirable when used as backpressure for batch apps. Default: 20
   */
  minLimit?: number;

  /**
   * Maximum allowable concurrency. Any estimated concurrency will be capped at
   * this value. Default: 200
   */
  maxConcurrency?: number;

  /**
   * Smoothing factor to limit how aggressively the estimated limit can shrink
   * when queuing has been detected. Value of 0.0 to 1.0 where 1.0 means the
   * limit is completely replaced by the new estimate. Default: 0.2
   */
  smoothing?: number;

  /**
   * Fixed amount the estimated limit can grow while latencies remain low.
   * Can be a constant or a function of the current limit. Default: 4
   */
  queueSize?: number | ((concurrency: number) => number);

  /**
   * Tolerance for changes in minimum latency. Value >= 1.0 indicating how
   * much change in minimum latency is acceptable before reducing the limit.
   * For example, a value of 2.0 means that a 2x increase in latency is
   * acceptable. Default: 1.5
   */
  rttTolerance?: number;

  /**
   * Number of samples in the long-term exponential average window.
   * Default: 600
   */
  longWindow?: number;

  /**
   * Configuration for the limiter's recovery probe when the limit reaches 0.
   * See {@link AdaptiveLimit.probeFromZeroInterval}.
   */
  recoveryProbe?: {
    /**
     * Fallback base interval in milliseconds between probes, used when the
     * algorithm has no usable RTT estimate (e.g. before any sample has been
     * recorded). When an RTT estimate is available the probe interval is
     * derived from `longRtt * 5`. Default: 1000.
     */
    baseMs?: number;
  };

  metricRegistry?: MetricRegistry;
}

export class GradientLimit implements AdaptiveLimit {
  private _limit: number;
  private readonly limitListeners = new ListenerSet();

  /** Estimated concurrency limit based on our algorithm */
  private estimatedLimit: number;

  /**
   * Tracks a measurement of the short time, and more volatile, RTT meant to
   * represent the current system latency.
   */
  private lastRtt = 0;

  /**
   * Tracks a measurement of the long term, less volatile, RTT meant to
   * represent the baseline latency. When the system is under load this number
   * is expected to trend higher.
   */
  private readonly longRtt: StreamingStatistic;

  /** Maximum allowed limit providing an upper bound failsafe */
  private readonly maxLimit: number;

  private readonly minLimit: number;
  private readonly queueSize: (concurrency: number) => number;
  private readonly smoothing: number;
  private readonly tolerance: number;
  private readonly recoveryProbeBaseMs: number;

  private readonly longRttSampleListener: DistributionMetric;
  private readonly shortRttSampleListener: DistributionMetric;
  private readonly queueSizeSampleListener: DistributionMetric;

  constructor(options: Gradient2LimitOptions = {}) {
    const initialLimit = options.initialLimit ?? 20;
    this._limit = initialLimit;

    this.estimatedLimit = initialLimit;
    this.maxLimit = options.maxConcurrency ?? 200;
    this.minLimit = options.minLimit ?? 20;
    this.smoothing = options.smoothing ?? 0.2;
    this.tolerance = options.rttTolerance ?? 1.5;
    this.longRtt = new ExpMovingAverage(options.longWindow ?? 600, 10);
    this.recoveryProbeBaseMs = options.recoveryProbe?.baseMs ?? 1000;

    if (options.rttTolerance !== undefined && options.rttTolerance < 1.0) {
      throw new RangeError("Tolerance must be >= 1.0");
    }
    if (this.recoveryProbeBaseMs <= 0) {
      throw new RangeError("recoveryProbe.baseMs must be > 0");
    }

    const qs = options.queueSize ?? 4;
    this.queueSize = typeof qs === "number" ? () => qs : qs;

    const registry = options.metricRegistry ?? NoopMetricRegistry;
    this.longRttSampleListener = registry.distribution(MetricIds.MIN_RTT_NAME);
    this.shortRttSampleListener = registry.distribution(
      MetricIds.WINDOW_MIN_RTT_NAME,
    );
    this.queueSizeSampleListener = registry.distribution(
      MetricIds.WINDOW_QUEUE_SIZE_NAME,
    );
  }

  addSample(
    _startTime: number,
    rtt: number,
    inflight: number,
    _didDrop: boolean,
    _operationName?: string,
  ): void {
    const newLimitNoFloor = this.computeNextLimitUnrounded(rtt, inflight);

    this.estimatedLimit = newLimitNoFloor;

    const newLimit = Math.floor(newLimitNoFloor);
    this.applyNewLimit(newLimit);
  }

  probeFromZeroInterval(failedProbes: number): number {
    const longRtt = this.longRtt.currentValue;
    const base = longRtt > 0 ? longRtt * 5 : this.recoveryProbeBaseMs;
    return base * Math.pow(2, failedProbes);
  }

  applyProbeFromZero(): void {
    this.estimatedLimit = 1;
    this.applyNewLimit(1);
  }

  get currentLimit(): number {
    return this._limit;
  }

  private applyNewLimit(newLimit: number): void {
    if (newLimit !== this._limit) {
      this._limit = newLimit;
      this.limitListeners.notify(newLimit);
    }
  }

  subscribe(
    consumer: (newLimit: number) => void,
    options: { signal?: AbortSignal } = {},
  ): () => void {
    return this.limitListeners.subscribe(consumer, options);
  }

  private computeNextLimitUnrounded(rtt: number, inflight: number): number {
    let estimatedLimit = this.estimatedLimit;
    const queueSize = this.queueSize(Math.floor(estimatedLimit));

    this.lastRtt = rtt;
    const shortRtt = rtt;
    const longRtt = this.longRtt.addSample(rtt);

    this.shortRttSampleListener.addSample(shortRtt);
    this.longRttSampleListener.addSample(longRtt);
    this.queueSizeSampleListener.addSample(queueSize);

    // If the long RTT is substantially larger than the short RTT then reduce
    // the long RTT measurement. This can happen when latency returns to normal
    // after a prolonged period of excessive load. Reducing the long RTT without
    // waiting for the exponential smoothing helps bring the system back to
    // steady state.
    if (longRtt / shortRtt > 2) {
      this.longRtt.update((current: number) => current * 0.95);
    }

    // Don't grow the limit if we are app limited
    if (inflight < estimatedLimit / 2) {
      return estimatedLimit;
    }

    // Rtt could be higher than rtt_noload because of smoothing rtt noload
    // updates so set to 1.0 to indicate no queuing. Otherwise calculate the
    // slope and don't allow it to be reduced by more than half to avoid
    // aggressive load-shedding due to outliers.
    const gradient = Math.max(
      0.5,
      Math.min(1.0, (this.tolerance * longRtt) / shortRtt),
    );
    let newLimit = estimatedLimit * gradient + queueSize;
    newLimit =
      estimatedLimit * (1 - this.smoothing) + newLimit * this.smoothing;
    newLimit = Math.max(this.minLimit, Math.min(this.maxLimit, newLimit));

    return newLimit;
  }

  getLastRtt(): number {
    return this.lastRtt;
  }

  getRttNoLoad(): number {
    return this.longRtt.currentValue;
  }

  toString(): string {
    return `Gradient2Limit [limit=${Math.floor(this.estimatedLimit)}]`;
  }
}
