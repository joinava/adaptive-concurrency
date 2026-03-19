/**
 * Utility function used by limiters to calculate thresholds using the square
 * root of the current limit. Values up to 1000 are pre-computed because the
 * square root operation can be slow.
 */
const sqrtLookup: number[] = Array.from({ length: 1000 }, (_, i) =>
  Math.max(1, Math.floor(Math.sqrt(i))),
);

/**
 * Only expects integer inputs. Always floors the result to an int.
 * Always returns >= 1. So, squareRoot(0) = 1.
 */
export function squareRoot(n: number): number {
  return n < 1000 ? sqrtLookup[n]! : Math.floor(Math.sqrt(n));
}

/**
 * Create a function that returns: max(baseline, squareRoot(n))
 */
export function squareRootWithBaseline(baseline: number): (n: number) => number {
  return (n) => Math.max(baseline, squareRoot(n));
}
