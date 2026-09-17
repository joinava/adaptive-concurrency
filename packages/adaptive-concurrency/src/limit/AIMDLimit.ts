import { ListenerSet } from "../ListenerSet.js";
import { ChangeEpoch } from "../utils/ChangeEpoch.js";
import {
  makeMultiplicativeDecrease,
  type MultiplicativeDecreaseOptions,
} from "../utils/multiplicativeDecrease.js";
import {
  resolveMinUtilizationToGrow,
  type AppLimitedOptions,
} from "./appLimited.js";
import type { AdaptiveLimit } from "./StreamingLimit.js";

/**
 * Loss based dynamic Limit that does an additive increment as long as
 * there are no errors and a multiplicative decrement when there is an error.
 *
 * Both kinds of change are gated to one per flight of requests (see
 * {@link ChangeEpoch}): a change only affects requests admitted after it, so
 * samples from requests that started before it do not drive another one.
 * Without this, one overload episode's burst of drops would apply the
 * decrease once per in-flight request, and a fast downstream would grow the
 * limit by one per sample, hundreds per second, before any drop could
 * reflect the growth; the limit would then swing between the floor and far
 * above capacity instead of settling just under it.
 */
export interface AIMDLimitOptions extends AppLimitedOptions {
  initialLimit?: number;
  minLimit?: number;
  maxLimit?: number;

  /**
   * Multiplicative decrease applied on a drop or a timeout. Default: ratio
   * 0.9 with jitter 0.02.
   */
  decrease?: MultiplicativeDecreaseOptions;

  /**
   * Timeout threshold in milliseconds that when exceeded equates to a drop.
   * Default: 5000
   */
  timeout?: number;

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

  private readonly decrease: (limit: number) => number;
  private readonly timeout: number;
  private readonly minLimit: number;
  private readonly maxLimit: number;
  private readonly recoveryProbeBaseMs: number;
  private readonly minUtilizationToGrow: number;

  private readonly increaseEpoch = new ChangeEpoch();
  private readonly decreaseEpoch = new ChangeEpoch();

  constructor(options: AIMDLimitOptions = {}) {
    const initialLimit = options.initialLimit ?? 20;
    this._limit = initialLimit;

    this.decrease = makeMultiplicativeDecrease(options.decrease);
    this.timeout = options.timeout ?? 5_000;
    this.minLimit = options.minLimit ?? 20;
    this.maxLimit = options.maxLimit ?? 200;
    this.recoveryProbeBaseMs = options.recoveryProbe?.baseMs ?? this.timeout;
    this.minUtilizationToGrow = resolveMinUtilizationToGrow(options);

    if (this.timeout <= 0) {
      throw new RangeError("Timeout must be positive");
    }
    if (!(this.recoveryProbeBaseMs > 0)) {
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
    startTime: number,
    rtt: number,
    inflight: number,
    didDrop: boolean,
    _operationName?: string,
  ): void {
    const now = startTime + rtt;
    const currentLimit = this._limit;

    if (didDrop || rtt > this.timeout) {
      if (!this.decreaseEpoch.tryChange(startTime, now)) return;
      this.applyNewLimit(this.clamp(this.decrease(currentLimit)));
    } else if (inflight >= this.minUtilizationToGrow * currentLimit) {
      if (!this.increaseEpoch.tryChange(startTime, now)) return;
      this.applyNewLimit(this.clamp(currentLimit + 1));
    }
  }

  get currentLimit(): number {
    return this._limit;
  }

  private clamp(limit: number): number {
    return Math.min(this.maxLimit, Math.max(this.minLimit, limit));
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
