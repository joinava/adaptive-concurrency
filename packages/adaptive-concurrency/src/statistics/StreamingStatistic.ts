/**
 * Stateful summary of a numeric sample stream (e.g. minimum, last value, EMA).
 */
export interface StreamingStatistic {
  /**
   * Add a single sample and update the internal state.
   * @param sample The sample value to add
   * @returns The updated statistic value
   */
  addSample(sample: number): number;

  /** Current statistic value. */
  get currentValue(): number;

  /**
   * Reset the internal state as if no samples were ever added.
   */
  reset(): void;

  /**
   * Apply a transformation to the current value. 
   *
   * The callback's return value may not be always be used as-is, specifically
   * if doing so would violate the semantics of the statistic. (E.g., if the
   * statistic is a minimum, and the callback returns a value greater than the
   * current minimum, the statistic will not be updated.) For example, if the
   * statistic is a minimum, and the callback returns a value greater than the
   * current minimum, the statistic will not be updated.
   */
  update(operation: (current: number) => number): void;
}
