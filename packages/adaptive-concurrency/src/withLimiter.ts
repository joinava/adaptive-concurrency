import type { IsEqual } from "type-fest";
import type { Satisfies } from "type-party";
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

type AllotmentOutcome<T> =
  | { kind: "return"; value: T; finalizeMode: "success" | "ignore" }
  | { kind: "throw"; value: unknown; finalizeMode: "ignore" | "drop" };

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

    try {
      const allotmentOutcome = await Promise.resolve()
        .then(async (): Promise<AllotmentOutcome<T>> => {
          const res = await fn({
            context: options?.context,
            signal: options?.signal,
          });

          if (!isRunResult(res)) {
            return { kind: "return", value: res, finalizeMode: "success" };
          }

          const cast = res satisfies
            | Awaited<T>
            | ReturnableRunResult<T> as ReturnableRunResult<T>;

          switch (cast.kind) {
            case "success":
            case "ignore":
              return {
                kind: "return",
                value: cast.value,
                finalizeMode: cast.kind,
              };
            default:
              assertUnreachable(cast);
          }
        })
        .catch(async (reason): Promise<AllotmentOutcome<T>> => {
          if (!isRunResult(reason)) {
            return {
              kind: "throw",
              value: reason,
              finalizeMode: isAdaptiveDropError(reason) ? "drop" : "ignore",
            };
          }

          const runResultReason = reason as RunResult<unknown, Error>;
          switch (runResultReason.kind) {
            case "dropped":
              return {
                kind: "throw",
                value: runResultReason.error,
                finalizeMode: "drop",
              };
            case "ignore":
              return {
                kind: "throw",
                value: runResultReason.value,
                finalizeMode: "ignore",
              };
            case "success":
              throw new Error(
                `Invalid callback throw: do not throw success(value); throw err, dropped(err) or ignore(err) instead.`,
              );
            default:
              assertUnreachable(runResultReason);
          }
        });

      switch (allotmentOutcome.finalizeMode) {
        case "success":
          await allotment.releaseAndRecordSuccess();
          type _ = Satisfies<
            IsEqual<typeof allotmentOutcome.kind, "return">,
            true
          >;
          return allotmentOutcome.value;
        case "ignore":
          await allotment.releaseAndIgnore();
          if (allotmentOutcome.kind === "throw") {
            throw allotmentOutcome.value;
          } else {
            return allotmentOutcome.value;
          }
        case "drop":
          await allotment.releaseAndRecordDropped();
          type _2 = Satisfies<
            IsEqual<typeof allotmentOutcome.kind, "throw">,
            true
          >;
          throw allotmentOutcome.value;
        default:
          assertUnreachable(allotmentOutcome);
      }
    } finally {
      // Catches the throws from unexpected branches above to make sure the
      // allotment is always released.
      await allotment.releaseAndIgnore();
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
