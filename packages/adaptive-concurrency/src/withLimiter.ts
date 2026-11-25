import type { IsEqual } from "type-fest";
import type { Satisfies } from "type-party";
import type { Limiter } from "./Limiter.js";
import { isAllotmentUnavailableError } from "./errors.js";
import {
  isAdaptiveDropError,
  isRunResult,
  type AdaptiveRejectionError,
  type AdaptiveTimeoutError,
  type RunIgnore,
  type RunResult,
  type RunSuccess,
} from "./RunResult.js";
import type { AcquireOptions, LimitAllotment } from "./types/Strategy.js";

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

/**
 * What a {@link CallWithLimiter} resolves with. `ok: false` means that the
 * limiter gave no allotment, so `fn` never ran. `error` is the
 * `allotmentUnavailableError` that `Limiter.acquire` rejected with. It is a
 * result, not a rejection, because an unavailable allotment is an expected
 * outcome under load, and the caller must decide what to do with it.
 */
export type LimitedCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: Error };

export type CallWithLimiter<ContextT> = {
  <T>(fn: FunctionToLimit<ContextT, T>): Promise<LimitedCallResult<T>>;

  <T>(
    options: AcquireOptions<ContextT>,
    fn: FunctionToLimit<ContextT, T>,
  ): Promise<LimitedCallResult<T>>;
};

/**
 * Creates a helper that runs callbacks under acquired limiter allotments.
 *
 * - If {@link Limiter.acquire} rejects with an `allotmentUnavailableError`,
 *   resolves with `{ ok: false, error }` without invoking `fn`. Any other
 *   rejection of `acquire`, such as the signal's reason after an abort,
 *   rejects the returned promise.
 * - Otherwise resolves with `{ ok: true, value }`, where `value` is the
 *   value described below.
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
  ): Promise<LimitedCallResult<T>>;
  async function callWithLimiter<T>(
    options: AcquireOptions<ContextT>,
    fn: FunctionToLimit<ContextT, T>,
  ): Promise<LimitedCallResult<T>>;
  async function callWithLimiter<T>(
    optionsOrFn: AcquireOptions<ContextT> | FunctionToLimit<ContextT, T>,
    maybeFn?: FunctionToLimit<ContextT, T>,
  ): Promise<LimitedCallResult<T>> {
    const [options, fn] =
      typeof optionsOrFn === "function"
        ? [undefined, optionsOrFn]
        : [optionsOrFn, maybeFn];

    if (!fn) {
      throw new Error("No function provided");
    }

    let allotment: LimitAllotment;
    try {
      allotment = await limiter.acquire(options);
    } catch (error) {
      if (isAllotmentUnavailableError(error)) {
        return { ok: false, error: error as Error };
      }
      throw error;
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
          return { ok: true, value: allotmentOutcome.value };
        case "ignore":
          await allotment.releaseAndIgnore();
          if (allotmentOutcome.kind === "throw") {
            throw allotmentOutcome.value;
          } else {
            return { ok: true, value: allotmentOutcome.value };
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
): (opts?: AcquireOptions<ContextT>) => Promise<LimitedCallResult<T>> {
  const callWithLimiter = withLimiter(limiter);
  return (options?: AcquireOptions<ContextT>) =>
    options ? callWithLimiter(options, fn) : callWithLimiter(fn);
}

function assertUnreachable(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
