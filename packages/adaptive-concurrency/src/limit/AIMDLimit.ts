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
}

export class AIMDLimit implements AdaptiveLimit {
  private _limit: number;
  private readonly limitListeners = new ListenerSet();

  private readonly backoffRatio: number;
  private readonly timeout: number;
  private readonly minLimit: number;
  private readonly maxLimit: number;

  constructor(options: AIMDLimitOptions = {}) {
    const initialLimit = options.initialLimit ?? 20;
    this._limit = initialLimit;

    this.backoffRatio = options.backoffRatio ?? 0.9;
    this.timeout = options.timeout ?? 5_000;
    this.minLimit = options.minLimit ?? 20;
    this.maxLimit = options.maxLimit ?? 200;

    if (this.backoffRatio >= 1.0 || this.backoffRatio < 0.5) {
      throw new Error("Backoff ratio must be in the range [0.5, 1.0)");
    }
    if (this.timeout <= 0) {
      throw new Error("Timeout must be positive");
    }
  }

  addSample(_startTime: number, rtt: number, inflight: number, didDrop: boolean): void {
    let currentLimit = this._limit;

    if (didDrop || rtt > this.timeout) {
      currentLimit = Math.floor(currentLimit * this.backoffRatio);
    } else if (inflight * 2 >= currentLimit) {
      currentLimit = currentLimit + 1;
    }

    const newLimit = Math.min(this.maxLimit, Math.max(this.minLimit, currentLimit));
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
