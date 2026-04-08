import { ListenerSet } from "../ListenerSet.js";
import type { DistributionMetric, MetricRegistry } from "../MetricRegistry.js";
import { MetricIds, NoopMetricRegistry } from "../MetricRegistry.js";
import type { AdaptiveLimit } from "./StreamingLimit.js";

import { log10Scale } from "../utils/index.js";

/**
 * Limiter based on TCP Vegas where the limit increases by alpha if the
 * queue_use is small (< alpha) and decreases by alpha if the queue_use is
 * large (> beta).
 *
 * Queue size is calculated using the formula:
 *   queue_use = limit - BWE * RTTnoLoad = limit * (1 - RTTnoLoad / RTTactual)
 *
 * For traditional TCP Vegas alpha is typically 2-3 and beta is typically 4-6.
 * To allow for better growth and stability at higher limits we set
 *   alpha = max(3, 10% of the current limit)
 * and
 *   beta = max(6, 20% of the current limit)
 */
export interface VegasLimitOptions {
  initialLimit?: number;
  maxConcurrency?: number;
  smoothing?: number;

  /**
   * Optional strategy hooks that control threshold and growth/decay behavior.
   */
  policy?: {
    /**
     * Function to compute the alpha threshold as a function of the current
     * estimated limit. Alpha is the lower threshold for the estimated queue
     * size; below it the limit is increased aggressively.
     */
    alpha?(limit: number): number;

    /**
     * Function to compute the beta threshold as a function of the current
     * estimated limit. Beta is the upper threshold; above it the limit is
     * decreased.
     */
    beta?(limit: number): number;

    /**
     * Threshold below which the limit is increased by beta (aggressive).
     */
    threshold?(limit: number): number;

    /**
     * Compute the new limit when increasing.
     */
    increase?(limit: number): number;

    /**
     * Compute the new limit when decreasing. If didDrop is true, decrease() is
     * being called because of a drop.
     */
    decrease?(limit: number, didDrop: boolean): number;
  };

  /**
   * The limiter will probe for a new noload RTT every
   * probeMultiplier * current_limit iterations. Default value is 30.
   */
  probeMultiplier?: number;

  metricRegistry?: MetricRegistry;
}

export type VegasLimitPolicy = Required<
  NonNullable<VegasLimitOptions["policy"]>
>;

export class VegasLimit implements AdaptiveLimit {
  private _limit: number;
  private readonly limitListeners = new ListenerSet();

  /** Estimated concurrency limit based on our algorithm */
  private estimatedLimit: number;

  private rttNoload = 0;

  /** Maximum allowed limit providing an upper bound failsafe */
  private readonly maxLimit: number;

  private readonly smoothing: number;
  private readonly policy: VegasLimitPolicy;
  private readonly rttSampleListener: DistributionMetric;

  private probeCount = 0;
  private probeJitter: number;
  private readonly probeMultiplier: number;

  constructor(options: VegasLimitOptions = {}) {
    const initialLimit = options.initialLimit ?? 20;
    this._limit = initialLimit;

    this.estimatedLimit = initialLimit;
    this.maxLimit = options.maxConcurrency ?? 1000;
    this.smoothing = options.smoothing ?? 1.0;
    this.probeMultiplier = options.probeMultiplier ?? 30;

    this.policy = {
      alpha: options.policy?.alpha ?? ((limit) => 3 * log10Scale(limit)),
      beta: options.policy?.beta ?? ((limit) => 6 * log10Scale(limit)),
      threshold: options.policy?.threshold ?? log10Scale,
      increase:
        options.policy?.increase ?? ((limit) => limit + log10Scale(limit)),
      decrease:
        options.policy?.decrease ?? ((limit) => limit - log10Scale(limit)),
    };

    this.probeJitter = this.resetProbeJitter();

    const registry = options.metricRegistry ?? NoopMetricRegistry;
    this.rttSampleListener = registry.distribution(MetricIds.MIN_RTT_NAME);
  }

  private resetProbeJitter(): number {
    this.probeJitter = 0.5 + Math.random() * 0.5;
    return this.probeJitter;
  }

  private shouldProbe(): boolean {
    return (
      this.probeJitter * this.probeMultiplier * this.estimatedLimit <=
      this.probeCount
    );
  }

  addSample(
    startTime: number,
    rtt: number,
    inflight: number,
    didDrop: boolean,
    _operationName?: string,
  ): void {
    this.applyNewLimit(
      this.computeNextLimit(startTime, rtt, inflight, didDrop),
    );
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

  private computeNextLimit(
    _startTime: number,
    rtt: number,
    inflight: number,
    didDrop: boolean,
  ): number {
    if (rtt <= 0) {
      throw new Error(`rtt must be >0 but got ${rtt}`);
    }

    this.probeCount++;
    if (this.shouldProbe()) {
      this.resetProbeJitter();
      this.probeCount = 0;
      this.rttNoload = rtt;
      this.rttSampleListener.addSample(rtt);
      return Math.floor(this.estimatedLimit);
    }

    const rttNoload = this.rttNoload;
    if (rttNoload === 0 || rtt < rttNoload) {
      this.rttNoload = rtt;
      this.rttSampleListener.addSample(rtt);
      return Math.floor(this.estimatedLimit);
    }

    this.rttSampleListener.addSample(rttNoload);

    return this.updateEstimatedLimit(rtt, rttNoload, inflight, didDrop);
  }

  private updateEstimatedLimit(
    rtt: number,
    rttNoload: number,
    inflight: number,
    didDrop: boolean,
  ): number {
    let estimatedLimit = this.estimatedLimit;
    const queueSize = Math.ceil(estimatedLimit * (1 - rttNoload / rtt));

    let newLimit: number;
    // Treat any drop (i.e timeout) as needing to reduce the limit
    if (didDrop) {
      newLimit = this.policy.decrease(estimatedLimit, didDrop);
      // Prevent upward drift if not close to the limit
    } else if (inflight * 2 < estimatedLimit) {
      return Math.floor(estimatedLimit);
    } else {
      const alpha = this.policy.alpha(Math.floor(estimatedLimit));
      const beta = this.policy.beta(Math.floor(estimatedLimit));
      const threshold = this.policy.threshold(Math.floor(estimatedLimit));

      // Aggressive increase when no queuing
      if (queueSize <= threshold) {
        newLimit = estimatedLimit + beta;
        // Increase the limit if queue is still manageable
      } else if (queueSize < alpha) {
        newLimit = this.policy.increase(estimatedLimit);
        // Detecting latency so decrease
      } else if (queueSize > beta) {
        newLimit = this.policy.decrease(estimatedLimit, didDrop);
        // We're within the sweet spot so nothing to do
      } else {
        return Math.floor(estimatedLimit);
      }
    }

    newLimit = Math.max(1, Math.min(this.maxLimit, newLimit));
    newLimit =
      (1 - this.smoothing) * estimatedLimit + this.smoothing * newLimit;
    this.estimatedLimit = newLimit;
    return Math.floor(newLimit);
  }

  toString(): string {
    return `VegasLimit [limit=${this.currentLimit}, rtt_noload=${this.rttNoload.toFixed(3)} ms]`;
  }
}
