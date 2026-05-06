import type { Limiter } from "./Limiter.js";
import {
  isAdaptiveTimeoutError,
  isRunResult,
  QuotaNotAvailable,
  type RunResult,
} from "./RunResult.js";
import type { AcquireOptions } from "./types/Strategy.js";

export type RunCallbackArgs<ContextT> = {
  context: ContextT | undefined;
  signal: AbortSignal | undefined;
};

export type LimitedFunction<ContextT> = {
  <T, E extends Error = Error>(
    fn: (
      args: RunCallbackArgs<ContextT>,
    ) => T | RunResult<T, E> | Promise<T | RunResult<T, E>>,
  ): Promise<T | typeof QuotaNotAvailable>;

  <T, E extends Error = Error>(
    options: AcquireOptions<ContextT>,
    fn: (
      args: RunCallbackArgs<ContextT>,
    ) => T | RunResult<T, E> | Promise<T | RunResult<T, E>>,
  ): Promise<T | typeof QuotaNotAvailable>;
};

/**
 * Creates a helper that runs callbacks under acquired limiter allotments.
 *
 * - If {@link Limiter.acquire} yields no allotment, returns
 *   {@link QuotaNotAvailable} without invoking `fn`.
 * - On {@link RunResult} `success` / `ignore`, returns the carried value after
 *   recording success/ignore to the allotment.
 * - On `dropped`, records drop and throws the carried error.
 * - If callback returns a non-{@link RunResult} value, it is treated as
 *   implicit success and returned as-is.
 * - On uncaught exceptions from `fn`, records ignore and rethrows, except for
 *   {@link AdaptiveTimeoutError}, which records drop and rethrows.
 * - Callback receives `{ context, signal }` from acquire options.
 */
export function withLimiter<ContextT>(
  limiter: Limiter<ContextT>,
): LimitedFunction<ContextT> {
  type LimitedFn<T, E extends Error = Error> = (
    args: RunCallbackArgs<ContextT>,
  ) => T | RunResult<T, E> | Promise<T | RunResult<T, E>>;

  async function limited<T, E extends Error = Error>(
    fn: LimitedFn<T, E>,
  ): Promise<T | typeof QuotaNotAvailable>;
  async function limited<T, E extends Error = Error>(
    options: AcquireOptions<ContextT>,
    fn: LimitedFn<T, E>,
  ): Promise<T | typeof QuotaNotAvailable>;
  async function limited<T, E extends Error = Error>(
    optionsOrFn: AcquireOptions<ContextT> | LimitedFn<T, E>,
    maybeFn?: LimitedFn<T, E>,
  ): Promise<T | typeof QuotaNotAvailable> {
    const [options, fn] =
      typeof optionsOrFn === "function"
        ? [undefined, optionsOrFn]
        : [optionsOrFn, maybeFn];

    if (!fn) {
      throw new Error("No function provided");
    }

    const allotment = await limiter.acquire(options);
    if (!allotment) {
      return QuotaNotAvailable;
    }

    const [result] = await Promise.allSettled([
      Promise.resolve().then(() =>
        fn({ context: options?.context, signal: options?.signal }),
      ),
    ]);

    if (result.status === "rejected") {
      if (isAdaptiveTimeoutError(result.reason)) {
        await allotment.releaseAndRecordDropped();
      } else {
        await allotment.releaseAndIgnore();
      }
      throw result.reason;
    }

    const outcome = result.value;
    if (!isRunResult(outcome)) {
      await allotment.releaseAndRecordSuccess();
      return outcome;
    }

    const outcomeCast = outcome satisfies
      | Awaited<T>
      | RunResult<T, E> as RunResult<T, E>;

    switch (outcomeCast.kind) {
      case "success":
        await allotment.releaseAndRecordSuccess();
        return outcomeCast.value;
      case "ignore":
        await allotment.releaseAndIgnore();
        return outcomeCast.value;
      case "dropped":
        await allotment.releaseAndRecordDropped();
        throw outcomeCast.error;
    }
  }

  return limited;
}
