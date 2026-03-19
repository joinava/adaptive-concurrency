import type { AdaptiveLimit } from "./limit/StreamingLimit.js";
import { GradientLimit } from "./limit/GradientLimit.js";
import type { LimitAllotment } from "./LimitAllotment.js";
import type { Counter, MetricRegistry } from "./MetricRegistry.js";
import { MetricIds, NoopMetricRegistry } from "./MetricRegistry.js";
import {
  isAdaptiveTimeoutError,
  QuotaNotAvailable,
  type RunResult,
} from "./RunResult.js";

export type SyncAcquireResult = LimitAllotment | undefined;
export type AsyncAcquireResult = Promise<LimitAllotment | undefined>;

/**
 * Union of all possible acquire return types. Useful for code that must handle
 * both sync and async limiters generically.
 */
export type AcquireResult = SyncAcquireResult | AsyncAcquireResult;

export interface AcquireOptions<ContextT = void> {
  context?: ContextT;
  signal?: AbortSignal;
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
  tryAcquireAllotment(context: ContextT, state: LimiterState): boolean;

  /**
   * Called when an acquired allotment completes (success, ignore, or drop).
   * Perform any cleanup (e.g. increment permits, release a partition slot).
   */
  onAllotmentReleased(context: ContextT): void;

  /**
   * Called when the adaptive limit changes. The strategy can react
   * (e.g. adjust available permits by the delta, update partition sub-limits).
   */
  onLimitChanged?(oldLimit: number, newLimit: number): void;
}

/**
 * Determines what happens when a request is rejected by the
 * {@link AcquireStrategy}. The type parameter `ResultT` flows through to
 * {@link Limiter.acquire}'s return type, enabling the type system to
 * distinguish sync limiters (no promise) from async/blocking ones.
 */
export interface AllotmentUnavailableStrategy<
  ContextT,
  ResultT extends SyncAcquireResult | AsyncAcquireResult,
> {
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
    retry: (context: ContextT) => SyncAcquireResult,
    signal?: AbortSignal,
  ): ResultT;

  /**
   * Called whenever any allotment is released (success, ignore, or drop).
   * Blocking strategies use this to wake queued waiters.
   */
  onAllotmentReleased(): void;
}

// ---------------------------------------------------------------------------
// Limiter options
// ---------------------------------------------------------------------------
const NOOP_ALLOTMENT: LimitAllotment = {
  reportSuccess() {},
  reportIgnore() {},
  reportDropped() {},
};

let idCounter = 0;

export interface LimiterOptions<
  ContextT,
  RejResultT extends SyncAcquireResult | AsyncAcquireResult = SyncAcquireResult,
> {
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
  allotmentUnavailableStrategy?: AllotmentUnavailableStrategy<
    ContextT,
    RejResultT
  >;
}

/**
 * Concurrency limiter with pluggable strategies for gating decisions and
 * rejection handling.
 *
 * When no rejection strategy is provided, `acquire()` returns synchronously
 * (`LimitAllotment | undefined`). When a blocking rejection strategy is
 * configured, `acquire()` may also return a `Promise`.
 *
 * @typeParam ContextT Request context type (e.g. partition key).
 * @typeParam RejResultT The result type produced by the rejection strategy.
 */
export class Limiter<
  Context = void,
  AcquireResult extends SyncAcquireResult | AsyncAcquireResult =
    SyncAcquireResult,
> {
  private _inflight = 0;
  private _limit: number;
  private readonly clock: () => number;
  private readonly limitAlgorithm: AdaptiveLimit;
  private readonly acquireStrategy: AcquireStrategy<Context>;
  private readonly rejectionStrategy:
    | AllotmentUnavailableStrategy<Context, AcquireResult>
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

  constructor(options: LimiterOptions<Context, AcquireResult> = {}) {
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

  acquire(
    options?: AcquireOptions<Context>,
  ): SyncAcquireResult | AcquireResult {
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

    if (!this.acquireStrategy.tryAcquireAllotment(ctx, state)) {
      this.rejectedCounter.increment();
      if (this.rejectionStrategy) {
        return this.rejectionStrategy.onAllotmentUnavailable(
          ctx,
          (retryCtx) => this.tryAcquireCore(retryCtx),
          options?.signal,
        );
      }
      return undefined;
    }

    return this.createAllotment(ctx);
  }

  private tryAcquireCore(ctx: Context): SyncAcquireResult {
    const state: LimiterState = {
      limit: this._limit,
      inflight: this._inflight,
    };
    if (!this.acquireStrategy.tryAcquireAllotment(ctx, state)) {
      return undefined;
    }
    return this.createAllotment(ctx);
  }

  private createAllotment(ctx: Context): LimitAllotment {
    const startTime = this.clock();
    const currentInflight = ++this._inflight;

    return {
      reportSuccess: () => {
        this._inflight--;
        this.acquireStrategy.onAllotmentReleased(ctx);
        this.successCounter.increment();
        this.limitAlgorithm.addSample(
          startTime,
          this.clock() - startTime,
          currentInflight,
          false,
        );
        this.rejectionStrategy?.onAllotmentReleased();
      },
      reportIgnore: () => {
        this._inflight--;
        this.acquireStrategy.onAllotmentReleased(ctx);
        this.ignoredCounter.increment();
        this.rejectionStrategy?.onAllotmentReleased();
      },
      reportDropped: () => {
        this._inflight--;
        this.acquireStrategy.onAllotmentReleased(ctx);
        this.droppedCounter.increment();
        this.limitAlgorithm.addSample(
          startTime,
          this.clock() - startTime,
          currentInflight,
          true,
        );
        this.rejectionStrategy?.onAllotmentReleased();
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

// ---------------------------------------------------------------------------
// Built-in acquire strategy: Semaphore
// ---------------------------------------------------------------------------

/**
 * Simple semaphore-based acquire strategy. Tracks a permits counter that is
 * decremented when an allotment is taken and incremented on release. When
 * permits reach zero, {@link tryAcquireAllotment} returns false.
 */
export class SemaphoreStrategy {
  private permits: number;

  constructor(initialLimit: number) {
    this.permits = initialLimit;
  }

  tryAcquireAllotment(): boolean {
    if (this.permits <= 0) return false;
    this.permits--;
    return true;
  }

  onAllotmentReleased(): void {
    this.permits++;
  }

  onLimitChanged(oldLimit: number, newLimit: number): void {
    this.permits += newLimit - oldLimit;
  }
}

// ---------------------------------------------------------------------------
// Helper: whenAcquireSettled
// ---------------------------------------------------------------------------

/**
 * Run a callback when an acquire result is ready. If the result is a Promise,
 * waits asynchronously; otherwise invokes the callback synchronously.
 */
export function whenAcquireSettled(
  result: AcquireResult,
  callback: (allotment: LimitAllotment | undefined) => void,
): void {
  if (
    result !== null &&
    typeof result === "object" &&
    "then" in result &&
    typeof (result as PromiseLike<LimitAllotment | undefined>).then ===
      "function"
  ) {
    void (result as Promise<LimitAllotment | undefined>).then(callback);
  } else {
    callback(result as LimitAllotment | undefined);
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
    ) => RunResult<T, E> | Promise<RunResult<T, E>>,
  ): Promise<T | typeof QuotaNotAvailable>;

  <T, E extends Error = Error>(
    options: AcquireOptions<ContextT>,
    fn: (
      args: RunCallbackArgs<ContextT>,
    ) => RunResult<T, E> | Promise<RunResult<T, E>>,
  ): Promise<T | typeof QuotaNotAvailable>;
}

/**
 * Creates a helper that runs callbacks under acquired limiter allotments.
 *
 * - If {@link Limiter.acquire} yields no allotment, returns
 *   {@link QuotaNotAvailable} without invoking `fn`.
 * - On {@link RunResult} `success` / `ignore`, returns the carried value after
 *   reporting to the allotment.
 * - On `dropped`, reports drop and throws the carried error.
 * - On uncaught exceptions from `fn`, reports ignore and rethrows, except for
 *   {@link AdaptiveTimeoutError}, which reports drop and rethrows.
 * - Callback receives `{ context, signal }` from acquire options.
 */
export function withLimiter<
  ContextT,
  RejResultT extends SyncAcquireResult | AsyncAcquireResult,
>(limiter: Limiter<ContextT, RejResultT>): LimitedFunction<ContextT> {
  async function limited<T, E extends Error = Error>(
    optionsOrFn:
      | AcquireOptions<ContextT>
      | ((
          args: RunCallbackArgs<ContextT>,
        ) => RunResult<T, E> | Promise<RunResult<T, E>>),
    maybeFn?: (
      args: RunCallbackArgs<ContextT>,
    ) => RunResult<T, E> | Promise<RunResult<T, E>>,
  ): Promise<T | typeof QuotaNotAvailable> {
    const hasOptions = maybeFn !== undefined;
    const options = hasOptions
      ? (optionsOrFn as AcquireOptions<ContextT>)
      : undefined;
    const fn = hasOptions
      ? maybeFn!
      : (optionsOrFn as (
          args: RunCallbackArgs<ContextT>,
        ) => RunResult<T, E> | Promise<RunResult<T, E>>);

    const allotment = await Promise.resolve(limiter.acquire(options));
    if (!allotment) {
      return QuotaNotAvailable;
    }

    const [result] = await Promise.allSettled([
      fn({
        context: options?.context,
        signal: options?.signal,
      }),
    ]);

    if (result.status === "rejected") {
      if (isAdaptiveTimeoutError(result.reason)) {
        allotment.reportDropped();
      } else {
        allotment.reportIgnore();
      }
      throw result.reason;
    }

    const outcome = result.value;

    switch (outcome.kind) {
      case "success":
        allotment.reportSuccess();
        return outcome.value;
      case "ignore":
        allotment.reportIgnore();
        return outcome.value;
      case "dropped":
        allotment.reportDropped();
        throw outcome.error;
    }
  }

  return limited;
}

/**
 * Synchronous try-acquire interface. A `Limiter<Ctx>` (with default sync
 * rejection) is structurally compatible with this interface.
 */
export interface SyncLimiter<ContextT = void> {
  acquire(options?: AcquireOptions<ContextT>): LimitAllotment | undefined;
}
