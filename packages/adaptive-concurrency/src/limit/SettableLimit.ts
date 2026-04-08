import { ListenerSet } from "../ListenerSet.js";
import type { AdaptiveLimit } from "./StreamingLimit.js";

/**
 * Limit to be used mostly for testing where the limit can be manually
 * adjusted.
 */
export class SettableLimit implements AdaptiveLimit {
  private _limit: number;
  private readonly limitListeners = new ListenerSet<(newLimit: number) => void>();

  constructor(limit: number) {
    this._limit = limit;
  }

  get currentLimit(): number {
    return this._limit;
  }

  addSample(
    _startTime: number,
    _rtt: number,
    _inflight: number,
    _didDrop: boolean,
    _operationName?: string,
  ): void {
    // No-op
  }

  setLimit(limit: number): void {
    if (limit !== this._limit) {
      this._limit = limit;
      this.limitListeners.notify(limit);
    }
  }

  subscribe(
    consumer: (newLimit: number) => void,
    options: { signal?: AbortSignal } = {},
  ): () => void {
    return this.limitListeners.subscribe(consumer, options);
  }

  toString(): string {
    return `SettableLimit [limit=${this.currentLimit}]`;
  }
}
