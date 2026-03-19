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
 * it as dropped (calls `reportDropped`) and then rethrows it.
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

export interface RunSuccess<T> {
  readonly kind: "success";
  readonly value: T;
}

export interface RunIgnore<T> {
  readonly kind: "ignore";
  readonly value: T;
}

export interface RunDropped<E extends Error = Error> {
  readonly kind: "dropped";
  readonly error: E;
}

export type RunResult<T, E extends Error = Error> =
  | RunSuccess<T>
  | RunIgnore<T>
  | RunDropped<E>;

export function success<T>(value: T): RunSuccess<T> {
  return { kind: "success", value };
}

export function ignore<T>(value: T): RunIgnore<T> {
  return { kind: "ignore", value };
}

export function dropped<E extends Error>(error: E): RunDropped<E> {
  return { kind: "dropped", error };
}
