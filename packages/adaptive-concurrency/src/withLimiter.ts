import type { Limiter } from "./Limiter.js";
import {
  isAdaptiveDropError,
  isRunResult,
  QuotaNotAvailable,
  type AdaptiveRejectionError,
  type AdaptiveTimeoutError,
  type RunIgnore,
  type RunResult,
  type RunSuccess,
} from "./RunResult.js";
import type { AcquireOptions } from "./types/Strategy.js";

export type RunCallbackArgs<ContextT> = {
  context: ContextT | undefined;
  signal: AbortSignal | undefined;
};

type ReturnableRunResult<T> = RunSuccess<T> | RunIgnore<T>;

type FunctionToLimit<ContextT, T> = (
  args: RunCallbackArgs<ContextT>,
) => T | ReturnableRunResult<T> | Promise<T | ReturnableRunResult<T>>;

export type CallWithLimiter<ContextT> = {
  <T>(fn: FunctionToLimit<ContextT, T>): Promise<T | typeof QuotaNotAvailable>;

  <T>(
    options: AcquireOptions<ContextT>,
    fn: FunctionToLimit<ContextT, T>,
  ): Promise<T | typeof QuotaNotAvailable>;
};

/**
 * Creates a helper that runs callbacks under acquired limiter allotments.
 *
 * - If {@link Limiter.acquire} yields no allotment, returns
 *   {@link QuotaNotAvailable} without invoking `fn`.
 * - If callback returns a {@link RunResult} `success` / `ignore`, returns the
 *   carried value after recording success/ignore to the allotment. If the
 *   callback returns a non-{@link RunResult} value, it is treated as implicit
 *   success and returned as-is.  Returning `dropped(error)` is invalid.
 * - When callback throws `dropped(error)`, records drop and throws `error`.
 * - When callback throws `ignore(value)`, records ignore and throws `value`.
 * - On other exceptions from `fn`, records ignore and rethrows, except for
 *   thrown {@link AdaptiveTimeoutError}s / {@link AdaptiveRejectionError}s,
 *   which are treated as drops and then rethrown.
 * - Callback receives `{ context, signal }` from acquire options.
 */
export function withLimiter<ContextT>(
  limiter: Limiter<ContextT>,
): CallWithLimiter<ContextT> {
  async function callWithLimiter<T>(
    fn: FunctionToLimit<ContextT, T>,
  ): Promise<T | typeof QuotaNotAvailable>;
  async function callWithLimiter<T>(
    options: AcquireOptions<ContextT>,
    fn: FunctionToLimit<ContextT, T>,
  ): Promise<T | typeof QuotaNotAvailable>;
  async function callWithLimiter<T>(
    optionsOrFn: AcquireOptions<ContextT> | FunctionToLimit<ContextT, T>,
    maybeFn?: FunctionToLimit<ContextT, T>,
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
      const [finalizeAllotment, toThrow] = (() => {
        if (isRunResult(result.reason)) {
          const reason = result.reason as RunResult<unknown, Error>;
          switch (reason.kind) {
            case "dropped":
              return [allotment.releaseAndRecordDropped, reason.error] as const;
            case "ignore":
              return [allotment.releaseAndIgnore, reason.value] as const;
            case "success":
              throw new Error(
                `Unexpected throw success() value: ${JSON.stringify(reason)}`,
              );
            default:
              assertUnreachable(reason);
          }
        }

        return [
          isAdaptiveDropError(result.reason)
            ? allotment.releaseAndRecordDropped
            : allotment.releaseAndIgnore,
          result.reason,
        ] as const;
      })();

      await finalizeAllotment.call(allotment);
      throw toThrow;
    }

    const outcome = result.value;
    if (!isRunResult(outcome)) {
      await allotment.releaseAndRecordSuccess();
      return outcome;
    }

    const outcomeCast = outcome satisfies
      | Awaited<T>
      | ReturnableRunResult<T> as ReturnableRunResult<T>;

    switch (outcomeCast.kind) {
      case "success":
        await allotment.releaseAndRecordSuccess();
        return outcomeCast.value;
      case "ignore":
        await allotment.releaseAndIgnore();
        return outcomeCast.value;
      default:
        assertUnreachable(outcomeCast);
    }
  }

  return callWithLimiter;
}

export function makeLimitedFunction<ContextT, T>(
  limiter: Limiter<ContextT>,
  fn: FunctionToLimit<ContextT, T>,
): (opts?: AcquireOptions<ContextT>) => Promise<T | typeof QuotaNotAvailable> {
  const callWithLimiter = withLimiter(limiter);
  return (options?: AcquireOptions<ContextT>) =>
    options ? callWithLimiter(options, fn) : callWithLimiter(fn);
}

function assertUnreachable(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
