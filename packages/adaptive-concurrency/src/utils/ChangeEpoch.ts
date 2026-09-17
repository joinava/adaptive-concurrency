/**
 * Gates limit changes to one per flight of requests.
 *
 * A limit change only takes effect for requests admitted after it. Samples
 * from requests that started before the change were admitted under the old
 * limit, so they say nothing about the new one, and reacting to them again
 * compounds the change once per in-flight request (a burst of 429s from one
 * overload episode would apply the multiplicative decrease twenty times; a
 * fast downstream would grow the limit by hundreds per second before any RTT
 * could reflect the growth). This is TCP's "one reduction per window of data"
 * rule (RFC 5681 §3.2), applied to increases as well.
 *
 * The gate uses the sample's own `startTime`, which the {@link AdaptiveLimit}
 * contract already supplies, so it needs no RTT estimate and no clock of its
 * own. A stretched RTT under overload automatically stretches the epoch.
 */
export class ChangeEpoch {
  private epochStart = -Infinity;

  /**
   * Returns true when a change is allowed for a sample that started at
   * `startTime`, and records `now` as the start of the new epoch. Returns
   * false, recording nothing, when the sample started before the last change.
   */
  tryChange(startTime: number, now: number): boolean {
    if (startTime < this.epochStart) return false;
    this.epochStart = now;
    return true;
  }
}
