import type { AdaptiveLimit } from "./StreamingLimit.js";

const NOOP_UNSUBSCRIBE = () => {};

/**
 * Non-dynamic limit with a fixed value.
 */
export class FixedLimit implements AdaptiveLimit {
  private _limit: number;

  constructor(limit: number) {
    this._limit = limit;
  }

  addSample(
    _startTime: number,
    _rtt: number,
    _inflight: number,
    _didDrop: boolean,
    _operationName?: string,
  ): void {
  }

  get currentLimit(): number {
    return this._limit;
  }

  subscribe(
    _consumer: (newLimit: number) => void,
    _options: { signal?: AbortSignal } = {},
  ): () => void {
    // Listeners would never be called -- limit is fixed -- so we return a no-op
    // function.
    return NOOP_UNSUBSCRIBE;
  }

  toString(): string {
    return `FixedLimit [limit=${this.currentLimit}]`;
  }
}
