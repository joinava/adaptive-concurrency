import type { CallWithLimiter } from "./withLimiter.js";

const ADAPTIVE_TIMEOUT_ERROR_CODE = "ADAPTIVE_TIMEOUT" as const;
const ADAPTIVE_REJECTION_ERROR_CODE = "ADAPTIVE_REJECTION" as const;

/**
 * Returned when a {@link CallWithLimiter} cannot obtain an allotment to even
 * attempt to run the user's callback.
 */
export const QuotaNotAvailable = Symbol("QuotaNotAvailable");

/**
 * Error type that signals the operation timeed out. When thrown by the callback
 * given to a {@link CallWithLimiter}, the result is treated as a drop (calls
 * `releaseAndRecordDropped`) and then rethrown.
 */
export class AdaptiveTimeoutError extends Error {
  readonly code = ADAPTIVE_TIMEOUT_ERROR_CODE;

  constructor(message?: string) {
    super(message ?? "Operation timed out");
    this.name = "AdaptiveTimeoutError";
  }
}

/**
 * Error type that signals the operation was rejected due to load shedding/rate
 * limiting. When thrown by the callback given to a {@link CallWithLimiter}, the
 * result is treated as a drop (calls `releaseAndRecordDropped`) and then
 * rethrown.
 */
export class AdaptiveRejectionError extends Error {
  readonly code = ADAPTIVE_REJECTION_ERROR_CODE;

  constructor(message?: string) {
    super(message ?? "Operation rejected");
    this.name = "AdaptiveRejectionError";
  }
}

export function isAdaptiveTimeoutError(
  error: unknown,
): error is AdaptiveTimeoutError {
  return (
    error instanceof AdaptiveTimeoutError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === ADAPTIVE_TIMEOUT_ERROR_CODE)
  );
}

export function isAdaptiveDropError(
  error: unknown,
): error is AdaptiveTimeoutError | AdaptiveRejectionError {
  return (
    error instanceof AdaptiveTimeoutError ||
    error instanceof AdaptiveRejectionError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ((error as { code?: unknown }).code === ADAPTIVE_TIMEOUT_ERROR_CODE ||
        (error as { code?: unknown }).code === ADAPTIVE_REJECTION_ERROR_CODE))
  );
}

const isRunResultTag = Symbol("isRunResult");

export type RunSuccess<
  _T extends unknown,
  U extends Awaited<_T> = Awaited<_T>,
> = {
  readonly kind: "success";
  readonly [isRunResultTag]: true;
  readonly value: U;
};

export type RunIgnore<
  _T extends unknown,
  U extends Awaited<_T> = Awaited<_T>,
> = {
  readonly kind: "ignore";
  readonly [isRunResultTag]: true;
  readonly value: U;
};

export type RunDropped<E extends Error = Error> = {
  readonly kind: "dropped";
  readonly [isRunResultTag]: true;
  readonly error: E;
};

export type RunResult<T, E extends Error = Error> =
  | RunSuccess<T>
  | RunIgnore<T>
  | RunDropped<E>;

export function isRunResult<T extends unknown>(
  value: T,
): value is T & RunResult<unknown, Error> {
  return (
    typeof value === "object" &&
    value !== null &&
    isRunResultTag in value &&
    value[isRunResultTag] === true
  );
}

export function success<T>(value: Awaited<T>): RunSuccess<T, Awaited<T>> {
  return { kind: "success", [isRunResultTag]: true, value: value };
}

export function ignore<T>(value: Awaited<T>): RunIgnore<T, Awaited<T>> {
  return { kind: "ignore", [isRunResultTag]: true, value: value };
}

export function dropped<E extends Error>(error: E): RunDropped<E> {
  return { kind: "dropped", [isRunResultTag]: true, error };
}
