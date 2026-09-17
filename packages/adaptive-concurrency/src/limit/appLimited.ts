/**
 * Option shared by the limits that only grow while the client is actually
 * using the limit ({@link AIMDLimit}, {@link GradientLimit},
 * {@link GroupAwareLimit}).
 */
export type AppLimitedOptions = {
  /**
   * Fraction of the limit that must be in flight, at the moment a request
   * is admitted, for that request's sample to be allowed to grow the limit.
   *
   * A low RTT proves the downstream copes with the load it is receiving,
   * not with the limit. An idle client must not grow the limit on the
   * strength of RTTs measured at a small fraction of it, or the limit drifts
   * up untested and admits a large, never-exercised burst when demand
   * arrives. TCP calls this being "application limited" (RFC 7661).
   *
   * The value sets how far above the current load the limit settles: about
   * `load / minUtilizationToGrow`. That headroom is pre-approved burst
   * capacity, and it is untested capacity, which is the trade-off:
   *
   * - Lower (say 0.25): the limit runs well ahead of demand. A step in
   *   demand flows at once instead of waiting for additive growth at one
   *   per flight, but a downstream whose capacity is near your demand can
   *   receive several times its proven load in one flight before the
   *   decrease loop reacts.
   * - Higher (say 0.9): the limit hugs the load. Little untested headroom
   *   reaches the downstream, but every rise in demand is throttled for the
   *   whole ramp. With a rejecting (non-queueing) acquire strategy, growth
   *   can only start once the limiter is already shedding load, because
   *   inflight reaches the limit only when demand exceeds it.
   *
   * Prefer a higher value for a fragile downstream behind a queueing
   * limiter: there the cost of headroom is throttling by the downstream,
   * and the cost of no headroom is only ramp latency. Must be in (0, 1].
   * Default: 0.5.
   */
  minUtilizationToGrow?: number;
};

/** Validates and defaults {@link AppLimitedOptions.minUtilizationToGrow}. */
export function resolveMinUtilizationToGrow(
  options: AppLimitedOptions | undefined,
): number {
  const value = options?.minUtilizationToGrow ?? 0.5;
  if (!(value > 0 && value <= 1)) {
    throw new RangeError("minUtilizationToGrow must be in (0, 1]");
  }
  return value;
}
