/**
 * Contract for an algorithm that maintains a concurrency limit from a set of
 * RTT samples.
 */
export interface AdaptiveLimit {
  /** Current estimated concurrency limit. */
  get currentLimit(): number;

  /**
   * Subscribe to limit changes. The callback runs whenever the limit updates.
   *
   * Returns a function to unsubscribe. Optional AbortSignal support is
   * provided for ergonomic cancellation.
   */
  subscribe(
    consumer: (newLimit: number) => void,
    options?: { signal?: AbortSignal },
  ): () => void;

  /**
   * Adjust the estimated limit using a completed request sample.
   * @param startTime Start time in fractional milliseconds (from performance.now())
   * @param rtt Round trip time in fractional milliseconds
   * @param inflight Number of inflight requests at the time the request started
   * @param didDrop Whether the request was dropped (timeout or rejection)
   */
  addSample(startTime: number, rtt: number, inflight: number, didDrop: boolean): void;
}
