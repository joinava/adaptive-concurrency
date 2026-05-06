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
   * @param operationName Optional name identifying the type of operation,
   *   used by group-aware limits to distinguish heterogeneous workloads.
   */
  addSample(
    startTime: number,
    rtt: number,
    inflight: number,
    didDrop: boolean,
    operationName?: string,
  ): void;

  /**
   * Returns the recommended interval, in milliseconds, between recovery
   * probes when the limit has fallen to 0 and there are no inflight requests
   * left to produce samples. The {@link Limiter} uses this to schedule a
   * probe that bumps the limit back to 1 so a single request can flow and
   * generate a fresh sample.
   *
   * @param failedProbes The number of consecutive probes that have already
   *   fired without producing a non-drop sample since the limit last
   *   recovered. Implementations typically use this to grow the interval
   *   exponentially (e.g. `base * 2^failedProbes`).
   *
   * Strategies that cannot reach a limit of 0 (e.g. {@link VegasLimit}) or
   * are intentionally inert (e.g. {@link FixedLimit}) may omit this method;
   * the limiter will then skip recovery probing for them.
   */
  probeFromZeroInterval?(failedProbes: number): number;

  /**
   * Atomically raises the limit to (at least) 1 so a single request can get
   * through, allowing the sample to be used to probe recovery. Called by the
   * limiter when its probe timer fires while the limit is at 0.
   *
   * Must be implemented if and only if {@link probeFromZeroInterval} is.
   */
  applyProbeFromZero?(): void;
}
