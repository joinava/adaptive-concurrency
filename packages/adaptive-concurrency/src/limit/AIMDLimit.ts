import { ListenerSet } from "../ListenerSet.js";
import type { AdaptiveLimit } from "./StreamingLimit.js";

/**
 * Loss based dynamic Limit that does an additive increment as long as
 * there are no errors and a multiplicative decrement when there is an error.
 */
export interface AIMDLimitOptions {
  initialLimit?: number;
  minLimit?: number;
  maxLimit?: number;

  /**
   * Ratio by which to reduce the limit on a drop. Must be in [0.5, 1.0).
   * Default: 0.9
   */
  backoffRatio?: number;

  /**
   * Timeout threshold in milliseconds that when exceeded equates to a drop.
   * Default: 5000
   */
  timeout?: number;

  /**
   * Absolute amount to use as a +/- jitter band around `backoffRatio` for
   * each multiplicative decrease. Breaks lockstep oscillation when multiple
   * independent clients share the same configuration.
   *
   * For example, with `backoffRatio: 0.9` and `backoffJitter: 0.02`, each
   * decrease multiplies by a uniformly random value in [0.88, 0.92].
   * Must be in [0, 0.05]. Default: 0.02.
   */
  backoffJitter?: number;

  /**
   * Configuration for the limiter's recovery probe when the limit reaches 0.
   * See {@link AdaptiveLimit.probeFromZeroInterval}.
   */
  recoveryProbe?: {
    /**
     * Base interval in milliseconds between probes. The probe interval grows
     * as `baseMs * 2^failedProbes`, then is jittered and capped by the
     * limiter. Default: the configured `timeout`.
     */
    baseMs?: number;
  };
}

export class AIMDLimit implements AdaptiveLimit {
  private _limit: number;
  private readonly limitListeners = new ListenerSet();

  private readonly backoffRatio: number;
  private readonly timeout: number;
  private readonly minLimit: number;
  private readonly maxLimit: number;
  private readonly backoffJitter: number;
  private readonly recoveryProbeBaseMs: number;

  constructor(options: AIMDLimitOptions = {}) {
    const initialLimit = options.initialLimit ?? 20;
    this._limit = initialLimit;

    this.backoffRatio = options.backoffRatio ?? 0.9;
    this.timeout = options.timeout ?? 5_000;
    this.minLimit = options.minLimit ?? 20;
    this.maxLimit = options.maxLimit ?? 200;
    this.backoffJitter = options.backoffJitter ?? 0.02;
    this.recoveryProbeBaseMs = options.recoveryProbe?.baseMs ?? this.timeout;

    if (this.backoffRatio >= 1.0 || this.backoffRatio < 0.5) {
      throw new RangeError("Backoff ratio must be in the range [0.5, 1.0)");
    }
    if (this.timeout <= 0) {
      throw new RangeError("Timeout must be positive");
    }
    if (this.backoffJitter < 0 || this.backoffJitter > 0.05) {
      throw new RangeError("backoffJitter must be in the range [0, 0.05]");
    }
    if (this.backoffRatio + this.backoffJitter >= 1.0) {
      throw new RangeError(
        "backoffRatio + backoffJitter must be < 1.0 to guarantee the limit decreases on drop",
      );
    }
    if (this.recoveryProbeBaseMs <= 0) {
      throw new RangeError("recoveryProbe.baseMs must be > 0");
    }
  }

  probeFromZeroInterval(failedProbes: number): number {
    return this.recoveryProbeBaseMs * Math.pow(2, failedProbes);
  }

  applyProbeFromZero(): void {
    this.applyNewLimit(1);
  }

  addSample(
    _startTime: number,
    rtt: number,
    inflight: number,
    didDrop: boolean,
    _operationName?: string,
  ): void {
    let currentLimit = this._limit;

    if (didDrop || rtt > this.timeout) {
      const jitteredRatio = Math.max(
        0.5,
        Math.min(
          1 - Number.EPSILON,
          this.backoffRatio + (Math.random() * 2 - 1) * this.backoffJitter,
        ),
      );
      currentLimit = Math.floor(currentLimit * jitteredRatio);
    } else if (inflight >= 0.5 * currentLimit) {
      currentLimit = currentLimit + 1;
    }

    const newLimit = Math.min(
      this.maxLimit,
      Math.max(this.minLimit, currentLimit),
    );
    this.applyNewLimit(newLimit);
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

  toString(): string {
    return `AIMDLimit [limit=${this.currentLimit}]`;
  }
}
