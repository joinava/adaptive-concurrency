import { GradientLimit } from "./limit/GradientLimit.js";
import type { AdaptiveLimit } from "./limit/StreamingLimit.js";
import type { LimitAllotment } from "./LimitAllotment.js";
import { SemaphoreStrategy } from "./limiter/acquire-strategies/SemaphoreStrategy.js";
import type { Counter, MetricRegistry } from "./MetricRegistry.js";
import { MetricIds, NoopMetricRegistry } from "./MetricRegistry.js";
import {
  isAdaptiveTimeoutError,
  isRunResult,
  QuotaNotAvailable,
  type RunResult,
} from "./RunResult.js";

export type MaybePromise<T> = T | Promise<T>;

/**
 * Acquire is async-only.
 */
export type AcquireResult = Promise<LimitAllotment | undefined>;

export interface AcquireOptions<ContextT = void> {
  context?: ContextT;
  signal?: AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// Strategy interfaces
// ---------------------------------------------------------------------------

/**
 * Read-only view of the limiter's current state, provided to strategies so
 * they can make gating decisions without coupling to the Limiter class.
 */
export interface LimiterState {
  readonly limit: number;
  readonly inflight: number;
}

/**
 * Decides whether a non-bypassed caller may take a concurrency allotment and
 * updates strategy bookkeeping when they may (e.g. permits counter or
 * per-partition tracking).
 */
export interface AcquireStrategy<ContextT> {
  /**
   * Tries to acquire an allotment for this request under the strategy's rules.
   * When `true`, the strategy has reserved capacity for one inflight unit; when
   * `false`, an allotment was not available.
   */
  tryAcquireAllotment(
    context: ContextT,
    state: LimiterState,
  ): MaybePromise<boolean>;

  /**
   * Called when an acquired allotment completes (success, ignore, or drop).
   * Perform any cleanup (e.g. increment permits, release a partition slot).
   */
  onAllotmentReleased(context: ContextT): MaybePromise<void>;

  /**
   * Called when the adaptive limit changes. The strategy can react
   * (e.g. adjust available permits by the delta, update partition sub-limits).
   */
  onLimitChanged?(oldLimit: number, newLimit: number): void;
}

/**
 * Determines what happens when a request is rejected by the
 * {@link AcquireStrategy} (e.g. queue the caller, reject immediately, or block
 * until a slot is available). Implementations must return an
 * {@link AcquireResult}, which is always a `Promise`.
 */
export interface AllotmentUnavailableStrategy<ContextT> {
  /**
   * Called when the acquire strategy cannot allocate an allotment for a
   * request.
   *
   * @param context The request context.
   * @param retry Callback to re-attempt acquisition. The rejection strategy can
   *   call this after a waiter is woken to try again. The retry runs
   *   {@link AcquireStrategy.tryAcquireAllotment} and, if successful, returns a
   *   ready-to-use allotment with all required wrapping.
   * @param signal Optional abort signal from the caller.
   */
  onAllotmentUnavailable(
    context: ContextT,
    retry: (context: ContextT) => AcquireResult,
    signal?: AbortSignal,
  ): AcquireResult;

  /**
   * Called whenever any allotment is released (success, ignore, or drop).
   * Blocking strategies use this to wake queued waiters.
   */
  onAllotmentReleased(): MaybePromise<void>;

  /**
   * Called when the adaptive limit changes. Blocking/rejection strategies can
   * use this to proactively react to newly available capacity (e.g. drain
   * backlog).
   */
  onLimitChanged?(oldLimit: number, newLimit: number): MaybePromise<void>;
}

// ---------------------------------------------------------------------------
// Limiter options
// ---------------------------------------------------------------------------
const NOOP_ALLOTMENT: LimitAllotment = {
  async releaseAndRecordSuccess() {},
  async releaseAndIgnore() {},
  async releaseAndRecordDropped() {},
};

let idCounter = 0;

export interface LimiterOptions<ContextT> {
  limit?: AdaptiveLimit;

  /**
   * Clock function returning the current time in fractional milliseconds
   * (like performance.now()). Default: performance.now
   */
  clock?: () => number;

  name?: string;
  metricRegistry?: MetricRegistry;

  /**
   * Predicate that, when returning true for a context, causes the request to
   * bypass the limiter entirely. The request won't affect inflight count or
   * the limit algorithm.
   */
  bypassResolver?: (context: ContextT) => boolean;

  /**
   * Strategy that decides whether a request gets a concurrency slot.
   * Default: SemaphoreStrategy.
   */
  acquireStrategy?: AcquireStrategy<ContextT>;

  /**
   * Strategy that decides what happens when the acquire strategy rejects a
   * request. When omitted, rejected requests immediately receive `undefined`.
   */
  allotmentUnavailableStrategy?: AllotmentUnavailableStrategy<ContextT>;
}

/**
 * Concurrency limiter with pluggable strategies for gating decisions and
 * rejection handling.
 *
 * @typeParam ContextT Request context type (e.g. partition key).
 */
export class Limiter<Context = void> {
  private _inflight = 0;
  private _limit: number;
  private readonly clock: () => number;
  private readonly limitAlgorithm: AdaptiveLimit;
  private readonly acquireStrategy: AcquireStrategy<Context>;
  private readonly rejectionStrategy:
    | AllotmentUnavailableStrategy<Context>
    | undefined;
  private readonly bypassResolver: ((context: Context) => boolean) | undefined;

  private readonly successCounter: Counter;
  private readonly droppedCounter: Counter;
  private readonly ignoredCounter: Counter;
  private readonly rejectedCounter: Counter;
  private readonly bypassCounter: Counter;

  static makeDefaultLimit(): AdaptiveLimit {
    return new GradientLimit();
  }

  constructor(options: LimiterOptions<Context> = {}) {
    this.clock = options.clock ?? (() => performance.now());
    this.limitAlgorithm = options.limit ?? Limiter.makeDefaultLimit();
    this._limit = this.limitAlgorithm.currentLimit;
    this.bypassResolver = options.bypassResolver;

    this.acquireStrategy =
      options.acquireStrategy ?? new SemaphoreStrategy(this._limit);
    this.rejectionStrategy = options.allotmentUnavailableStrategy;

    this.limitAlgorithm.subscribe((newLimit) => {
      const oldLimit = this._limit;
      this._limit = newLimit;
      this.acquireStrategy.onLimitChanged?.(oldLimit, newLimit);
      void this.rejectionStrategy?.onLimitChanged?.(oldLimit, newLimit);
    });

    const registry = options.metricRegistry ?? NoopMetricRegistry;
    const limiterName = options.name ?? `unnamed-${++idCounter}`;

    registry.gauge(MetricIds.LIMIT_NAME, () => this._limit);
    this.successCounter = registry.counter(MetricIds.CALL_NAME, {
      id: limiterName,
      status: "success",
    });
    this.droppedCounter = registry.counter(MetricIds.CALL_NAME, {
      id: limiterName,
      status: "dropped",
    });
    this.ignoredCounter = registry.counter(MetricIds.CALL_NAME, {
      id: limiterName,
      status: "ignored",
    });
    this.rejectedCounter = registry.counter(MetricIds.CALL_NAME, {
      id: limiterName,
      status: "rejected",
    });
    this.bypassCounter = registry.counter(MetricIds.CALL_NAME, {
      id: limiterName,
      status: "bypassed",
    });
  }

  async acquire(options?: AcquireOptions<Context>): AcquireResult {
    if (options?.signal?.aborted) return undefined;
    const ctx = (options?.context ?? undefined) as Context;

    if (this.bypassResolver?.(ctx)) {
      this.bypassCounter.increment();
      return NOOP_ALLOTMENT;
    }

    const state: LimiterState = {
      limit: this._limit,
      inflight: this._inflight,
    };

    if (!(await this.acquireStrategy.tryAcquireAllotment(ctx, state))) {
      this.rejectedCounter.increment();
      if (!this.rejectionStrategy) {
        return undefined;
      }

      // if signal aborted here, nothing to cleanup, as we didn't acquire anything.
      if (options?.signal?.aborted) {
        return undefined;
      }

      return this.rejectionStrategy.onAllotmentUnavailable(
        ctx,
        (retryCtx) => this.tryAcquireCore(retryCtx),
        options?.signal,
      );
    }

    const allotment = this.createAllotment(ctx);

    if (options?.signal?.aborted) {
      // here, we did acquire, so we need to try to cleanup.
      await allotment.releaseAndIgnore();
      return undefined;
    }

    return allotment;
  }

  private async tryAcquireCore(ctx: Context): AcquireResult {
    const state: LimiterState = {
      limit: this._limit,
      inflight: this._inflight,
    };
    if (!(await this.acquireStrategy.tryAcquireAllotment(ctx, state))) {
      return undefined;
    }

    return this.createAllotment(ctx);
  }

  private createAllotment(ctx: Context): LimitAllotment {
    const startTime = this.clock();
    const currentInflight = ++this._inflight;

    // Make sure an allotment can only be released once; future calls become a
    // no-op. This simplifies a lot of cleanup handling etc that'd otherwise be
    // much racier/more complicated. It could hide subtle correctness issue, but
    // should be more valuable as defense-in-depth.
    let released = false;

    return {
      releaseAndRecordSuccess: async () => {
        if (released) return;
        released = true;

        const endTime = this.clock();
        const rtt = endTime - startTime;
        this._inflight--;
        await this.acquireStrategy.onAllotmentReleased(ctx);
        this.successCounter.increment();
        this.limitAlgorithm.addSample(startTime, rtt, currentInflight, false);
        await this.rejectionStrategy?.onAllotmentReleased();
      },
      releaseAndIgnore: async () => {
        if (released) return;
        released = true;

        this._inflight--;
        await this.acquireStrategy.onAllotmentReleased(ctx);
        this.ignoredCounter.increment();
        await this.rejectionStrategy?.onAllotmentReleased();
      },
      releaseAndRecordDropped: async () => {
        if (released) return;
        released = true;

        const endTime = this.clock();
        const rtt = endTime - startTime;
        this._inflight--;
        await this.acquireStrategy.onAllotmentReleased(ctx);
        this.droppedCounter.increment();
        this.limitAlgorithm.addSample(startTime, rtt, currentInflight, true);
        await this.rejectionStrategy?.onAllotmentReleased();
      },
    };
  }

  getLimit(): number {
    return this._limit;
  }

  getInflight(): number {
    return this._inflight;
  }
}

export type RunCallbackArgs<ContextT> = {
  context: ContextT | undefined;
  signal: AbortSignal | undefined;
};
export interface LimitedFunction<ContextT> {
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
}

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
      fn({ context: options?.context, signal: options?.signal }),
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
