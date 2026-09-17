/**
 * Options for a jittered multiplicative decrease, shared by the limits that
 * back off multiplicatively ({@link AIMDLimit}, {@link GroupAwareLimit}).
 */
export type MultiplicativeDecreaseOptions = {
  /**
   * Ratio by which to multiply the limit on each decrease. Must be in
   * [0.5, 1.0). Default: 0.9.
   */
  ratio?: number;

  /**
   * Absolute +/- jitter band around `ratio` for each decrease. Breaks
   * lockstep oscillation when multiple independent clients share one
   * downstream and the same configuration. For example, `ratio: 0.9` and
   * `jitter: 0.02` multiply by a uniformly random value in [0.88, 0.92].
   * Must be in [0, 0.05], and `ratio + jitter` must stay below 1.0 so every
   * decrease actually decreases. Default: 0.02.
   */
  jitter?: number;
};

/**
 * Builds the decrease function for {@link MultiplicativeDecreaseOptions}.
 * Validates the options and throws a `RangeError` on invalid ones.
 */
export function makeMultiplicativeDecrease(
  options: MultiplicativeDecreaseOptions | undefined,
): (limit: number) => number {
  const ratio = options?.ratio ?? 0.9;
  const jitter = options?.jitter ?? 0.02;

  if (!(ratio >= 0.5 && ratio < 1.0)) {
    throw new RangeError("decrease.ratio must be in the range [0.5, 1.0)");
  }
  if (!(jitter >= 0 && jitter <= 0.05)) {
    throw new RangeError("decrease.jitter must be in the range [0, 0.05]");
  }
  if (ratio + jitter >= 1.0) {
    throw new RangeError(
      "decrease.ratio + decrease.jitter must be < 1.0 to guarantee the limit decreases",
    );
  }

  return (limit) => {
    const jitteredRatio = Math.max(
      0.5,
      Math.min(1 - Number.EPSILON, ratio + (Math.random() * 2 - 1) * jitter),
    );
    return Math.floor(limit * jitteredRatio);
  };
}
