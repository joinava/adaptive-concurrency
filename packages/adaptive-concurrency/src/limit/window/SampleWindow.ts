/**
 * Immutable sample window used to track request samples over a time window.
 * Each call to addSample returns a new instance with the updated state.
 *
 * @see WindowedLimit
 */
export interface SampleWindow {
  addSample(rtt: number, inflight: number, dropped: boolean): SampleWindow;

  /** 
   * RTT used as a candidate for the minimum (e.g. the minimum observed RTT). 
   */
  readonly candidateRttMs: number;

  /** 
   * RTT used for limit decisions (e.g. average or percentile). 
   */
  readonly trackedRttMs: number;

  /** 
   * Maximum number of inflight requests seen in this window. 
   */
  readonly maxInFlight: number;

  /** 
   * Number of samples collected in this window. 
   */
  readonly sampleCount: number;

  /** 
   * Whether any sample in this window was a drop. 
   */
  readonly dropped: boolean;
}
