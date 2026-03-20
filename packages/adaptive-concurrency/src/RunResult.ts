import type { Limiter } from "./Limiter.js";

const ADAPTIVE_TIMEOUT_ERROR_CODE = "ADAPTIVE_TIMEOUT" as const;

/**
 * Returned when {@link Limiter.run} cannot obtain an allotment (sync reject or
 * async wait exhausted / aborted). Distinct from {@link runDropped}, which
 * represents work that ran and then reported a drop.
 */
export const QuotaNotAvailable = Symbol("QuotaNotAvailable");

/**
 * Error type that signals the operation was dropped due to timeout or external
 * load shedding. When thrown from {@link Limiter.run}'s callback, run treats
 * it as dropped (calls `releaseAndRecordDropped`) and then rethrows it.
 */
export class AdaptiveTimeoutError extends Error {
  readonly code = ADAPTIVE_TIMEOUT_ERROR_CODE;

  constructor(message?: string) {
    super(message ?? "Operation timed out");
    this.name = "AdaptiveTimeoutError";
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

const isRunResultTag = Symbol("isRunResult");

export type RunSuccess<T> = {
  readonly kind: "success";
  readonly [isRunResultTag]: true;
  readonly value: T;
};

export type RunIgnore<T> = {
  readonly kind: "ignore";
  readonly [isRunResultTag]: true;
  readonly value: T;
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

export function success<T>(value: T): RunSuccess<T> {
  return { kind: "success", [isRunResultTag]: true, value };
}

export function ignore<T>(value: T): RunIgnore<T> {
  return { kind: "ignore", [isRunResultTag]: true, value };
}

export function dropped<E extends Error>(error: E): RunDropped<E> {
  return { kind: "dropped", [isRunResultTag]: true, error };
}
