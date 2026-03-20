/**
 * Handle returned when a concurrency slot is acquired. The caller must invoke
 * exactly one of the release-and-xxx methods when the operation completes.
 */
export interface LimitAllotment {
  /**
   * The operation succeeded and internally measured latency should be used as
   * an RTT sample.
   */
  releaseAndRecordSuccess(): Promise<void>;

  /**
   * The operation failed before any meaningful RTT measurement could be made
   * and should be ignored so it does not introduce an artificially low RTT.
   */
  releaseAndIgnore(): Promise<void>;

  /**
   * The request failed and was dropped due to being rejected by an external
   * limit or hitting a timeout. Loss based StreamingLimit implementations will
   * likely do an aggressive reduction in limit when this happens.
   */
  releaseAndRecordDropped(): Promise<void>;
}
