import type { AdaptiveLimit } from "./StreamingLimit.js";

/**
 * Limit decorator that logs each sample to the console at debug level
 * before forwarding to the delegate.
 */
export class TracingLimitDecorator implements AdaptiveLimit {
  private readonly delegate: AdaptiveLimit;

  static wrap(delegate: AdaptiveLimit): TracingLimitDecorator {
    return new TracingLimitDecorator(delegate);
  }

  constructor(delegate: AdaptiveLimit) {
    this.delegate = delegate;
  }

  get currentLimit(): number {
    return this.delegate.currentLimit;
  }

  addSample(startTime: number, rtt: number, inflight: number, didDrop: boolean): void {
    console.debug(`maxInFlight=${inflight} rtt=${rtt.toFixed(3)} ms`);
    this.delegate.addSample(startTime, rtt, inflight, didDrop);
  }

  subscribe(
    consumer: (newLimit: number) => void,
    options?: { signal?: AbortSignal },
  ): () => void {
    return this.delegate.subscribe(consumer, options);
  }
}
