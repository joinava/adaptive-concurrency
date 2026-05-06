import { GradientLimit } from "./limit/GradientLimit.js";
import type { AdaptiveLimit } from "./limit/StreamingLimit.js";
import { SemaphoreStrategy } from "./limiter/acquire-strategies/SemaphoreStrategy.js";
import type {
  Counter,
  DistributionMetric,
  Gauge,
  MetricRegistry,
} from "./MetricRegistry.js";
import { MetricIds, NoopMetricRegistry } from "./MetricRegistry.js";
import type { MaybePromise } from "./types/MaybePromise.js";
import type {
  AcquireOptions,
  AcquireResult,
  AcquireStrategy,
  AllotmentUnavailableStrategy,
  LimitAllotment,
} from "./types/Strategy.js";

export type { MaybePromise } from "./types/MaybePromise.js";
export type {
  AcquireOptions,
  AcquireResult,
  AcquireStrategy,
  AllotmentUnavailableStrategy,
  LimitAllotment,
  LimiterState,
} from "./types/Strategy.js";
export {
  withLimiter,
  type LimitedFunction,
  type RunCallbackArgs,
} from "./withLimiter.js";

// ---------------------------------------------------------------------------
// Limiter options
// ---------------------------------------------------------------------------
let idCounter = 0;

type AnyTimerHandle = NodeJS.Timeout | number;

export interface LimiterOptions<
  ContextT,
  TimerHandle extends AnyTimerHandle = AnyTimerHandle,
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
  allotmentUnavailableStrategy?: AllotmentUnavailableStrategy<ContextT>;

  /**
   * Derives an operation name from the request context, passed to the limit
   * algorithm's `addSample` so group-aware limits can distinguish
   * heterogeneous workloads. When omitted, no operation name is provided.
   */
  operationNameFor?: (context: ContextT) => string | undefined;

  /**
   * Configuration for the recovery probe used to nudge the limit back above
   * 0 when the underlying strategy has fallen there and there are no
   * inflight requests left to produce samples.
   *
   * The limiter relies on the strategy itself to declare a base interval
   * (via {@link AdaptiveLimit.probeFromZeroInterval}) which is grown
   * exponentially across consecutive failed probes; the options here cap
   * and jitter that interval. Strategies that do not implement the probe
   * methods (e.g. {@link FixedLimit}, {@link VegasLimit}) get no recovery
   * probing regardless of these options.
   */
  recoveryProbe?: {
    /**
     * Soft ceiling on a single probe's unjittered wait time, in
     * milliseconds. The strategy-derived base interval is clamped to this
     * value, then symmetric jitter is applied — so realized waits stay
     * symmetric around `min(base, maxMs)` rather than being biased downward
     * near the cap. Realized waits can therefore exceed `maxMs` by up to
     * `jitter` (e.g. 20% with the default jitter). Default: 30_000.
     */
    maxMs?: number;

    /**
     * Symmetric jitter fraction applied to each probe interval (e.g. 0.2
     * means `interval * uniform(0.8, 1.2)`). Must be in [0, 0.5).
     * Default: 0.2.
     */
    jitter?: number;
  };

  /**
   * Timer functions used to schedule recovery probes. Defaults to the
   * environment's global `setTimeout` / `clearTimeout`. Tests can supply a
   * fake to drive the probe state machine deterministically.
   */
  timer?: {
    setTimeout(fn: () => void, ms: number): TimerHandle;
    clearTimeout(handle: TimerHandle): void;
  };
}

/**
 * Concurrency limiter with pluggable strategies for gating decisions and
 * rejection handling.
 *
 * @typeParam ContextT Request context type (e.g. partition key).
 */
export class Limiter<
  Context = void,
  TimerHandle extends AnyTimerHandle = AnyTimerHandle,
> implements Disposable {
  private _inflight = 0;
  private _limit: number;
  private readonly clock: () => number;
  private readonly limitAlgorithm: AdaptiveLimit;
  private readonly acquireStrategy: AcquireStrategy<Context>;
  private readonly rejectionStrategy:
    | AllotmentUnavailableStrategy<Context>
    | undefined;

  private readonly bypassResolver: ((context: Context) => boolean) | undefined;
  private readonly operationNameFor:
    | ((context: Context) => string | undefined)
    | undefined;

  private readonly recoveryProbeMaxMs: number;
  private readonly recoveryProbeJitter: number;
  private readonly timer: {
    setTimeout(fn: () => void, ms: number): AnyTimerHandle;
    clearTimeout(handle: AnyTimerHandle): void;
  };
  /**
   * Number of consecutive recovery-probe *fires* since the last confirming
   * success sample. Read by {@link maybeArmRecoveryProbe} to compute the
   * exponentially-growing wait between probes:
   *
   *   `interval(n) = limitAlgorithm.probeFromZeroInterval(n)`
   *
   * Incremented inside the probe-timer callback (right after
   * `applyProbeFromZero` runs), and reset only on a successful (non-drop,
   * non-ignored) sample in `releaseAndRecordSuccess`.
   *
   * Note: this is "consecutive probe fires without a confirming success",
   * **not** "consecutive failed probes". A probe firing successfully raises
   * the limit to 1, but until traffic actually flows through and produces
   * a non-drop sample, we have no evidence the system is healthy. Resetting
   * on the limit-rise alone would cause the failure ladder to collapse to
   * the base interval forever in a flapping-downstream scenario (probe →
   * raise → drop → 0 → probe → ...), defeating the purpose of the
   * exponential backoff.
   *
   * The downside is a benign quirk: after a probe successfully raises the
   * limit, if no traffic arrives for a long time and then the limit later
   * drops to 0 again, the next probe waits at `interval(N+1)` instead of
   * `interval(0)`. This errs on the side of caution and is acceptable.
   */
  private probeFailures = 0;
  private probeTimerHandle: AnyTimerHandle | undefined;
  private disposed = false;
  private readonly unsubscribeFromLimit: () => void;

  private readonly successCounter: Counter;
  private readonly droppedCounter: Counter;
  private readonly ignoredCounter: Counter;

  private readonly acquireSucceededCounter: Counter;
  private readonly acquireFailedCounter: Counter;
  private readonly acquireBypassedCounter: Counter;

  private readonly limitGauge: Gauge;
  private readonly acquireTimeOnSuccessDistribution: DistributionMetric;
  private readonly acquireTimeOnUnavailableDistribution: DistributionMetric;

  static makeDefaultLimit(): AdaptiveLimit {
    return new GradientLimit();
  }

  constructor(options: LimiterOptions<Context, TimerHandle> = {}) {
    this.clock = options.clock ?? (() => performance.now());
    this.limitAlgorithm = options.limit ?? Limiter.makeDefaultLimit();
    this._limit = this.limitAlgorithm.currentLimit;
    this.bypassResolver = options.bypassResolver;
    this.operationNameFor = options.operationNameFor;

    this.acquireStrategy =
      options.acquireStrategy ?? new SemaphoreStrategy(this._limit);
    this.rejectionStrategy = options.allotmentUnavailableStrategy;

    this.recoveryProbeMaxMs = options.recoveryProbe?.maxMs ?? 30_000;
    this.recoveryProbeJitter = options.recoveryProbe?.jitter ?? 0.2;
    if (
      !Number.isFinite(this.recoveryProbeMaxMs) ||
      this.recoveryProbeMaxMs <= 0
    ) {
      // Reject NaN / ±Infinity along with non-positive values so a misconfigured
      // probe interval can't silently degrade into a near-busy-loop (Node coerces
      // NaN to ~1ms in `setTimeout(fn, NaN)`) or a non-finite wait.
      throw new RangeError("recoveryProbe.maxMs must be a finite number > 0");
    }
    if (
      !Number.isFinite(this.recoveryProbeJitter) ||
      this.recoveryProbeJitter < 0 ||
      this.recoveryProbeJitter >= 0.5
    ) {
      throw new RangeError(
        "recoveryProbe.jitter must be a finite number in [0, 0.5)",
      );
    }

    this.timer = options.timer ?? {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (handle) => globalThis.clearTimeout(handle),
    };

    this.unsubscribeFromLimit = this.limitAlgorithm.subscribe((newLimit) => {
      const oldLimit = this._limit;

      // Notify the acquire strategy FIRST. If it throws atomically (i.e.
      // refuses without mutating its own state), we want `_limit`, the
      // gauge, the rejection strategy, and the recovery probe to all stay
      // pinned to the old value — there's no partial-commit to clean up.
      //
      // If the strategy throws after partially mutating its state, the
      // limiter and strategy are inconsistent either way; we still don't
      // commit `_limit` here, since we'd just be guessing at the strategy's
      // post-throw state. The error propagates to whatever drove the limit
      // change (caller-visible from `setLimit`, swallowed by the release-
      // path `try { addSample }` wrapper from `releaseAndRecord*`).
      this.acquireStrategy.onLimitChanged?.(oldLimit, newLimit);

      this._limit = newLimit;
      try {
        this.limitGauge.record(newLimit);
      } catch {
        // Best-effort metric recording; a misbehaving registry must not
        // prevent recovery probe arming below.
      }

      // `onLimitChanged` may return a rejecting Promise; using `void` would
      // surface it as an unhandled rejection (process-terminating in modern
      // Node by default). Wrap in `fireAndForget` so any rejection is
      // swallowed consistently with the release-path try/catch idiom.
      void fireAndForget(() =>
        this.rejectionStrategy?.onLimitChanged?.(oldLimit, newLimit),
      );

      if (newLimit === 0) {
        this.maybeArmRecoveryProbe();
      } else {
        this.cancelProbe();
      }
    });

    const registry = options.metricRegistry ?? NoopMetricRegistry;
    const limiterName = options.name ?? `unnamed-${++idCounter}`;

    this.limitGauge = registry.gauge(MetricIds.LIMIT_NAME, {
      id: limiterName,
    });
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

    this.acquireSucceededCounter = registry.counter(
      MetricIds.ACQUIRE_ATTEMPT_NAME,
      { id: limiterName, status: "succeeded" },
    );
    this.acquireFailedCounter = registry.counter(
      MetricIds.ACQUIRE_ATTEMPT_NAME,
      { id: limiterName, status: "failed" },
    );
    this.acquireBypassedCounter = registry.counter(
      MetricIds.ACQUIRE_ATTEMPT_NAME,
      { id: limiterName, status: "bypassed" },
    );

    this.acquireTimeOnSuccessDistribution = registry.distribution(
      MetricIds.ACQUIRE_TIME_NAME,
      { id: limiterName, status: "success" },
    );
    this.acquireTimeOnUnavailableDistribution = registry.distribution(
      MetricIds.ACQUIRE_TIME_NAME,
      { id: limiterName, status: "unavailable" },
    );

    // Emit metric for initial limit.
    this.limitGauge.record(this._limit);

    // If the underlying strategy starts at 0 (e.g.
    // `new AIMDLimit({ initialLimit: 0, minLimit: 0 })` or a deserialized
    // snapshot), the limiter is born starved-for-samples. The subscription
    // and release-path hooks only fire on transitions, so without this we'd
    // be stuck at 0 forever — no acquires can land while limit is 0, and no
    // samples can arrive without acquires.
    this.maybeArmRecoveryProbe();
  }

  async acquire(options?: AcquireOptions<Context>): AcquireResult {
    if (options?.signal?.aborted) return undefined;
    const ctx = (options?.context ?? undefined) as Context;

    if (this.bypassResolver?.(ctx)) {
      void fireAndForget(() => {
        this.acquireBypassedCounter.add(1);
      });
      return this.createBypassedAllotment(ctx);
    }

    const acquireStart = this.clock();
    const allotment = await this.tryAcquireCore(ctx, acquireStart);

    // Called when this method is retunring undefined; not called for each
    // individual acquire attempt that may be triggered by the rejection
    // strategy.
    const recordFinalAcquireFailed = () => {
      void fireAndForget(() => {
        const now = this.clock();
        this.acquireTimeOnUnavailableDistribution.addSample(now - acquireStart);
      });
    };

    if (!allotment) {
      if (!this.rejectionStrategy) {
        void recordFinalAcquireFailed();
        return undefined;
      }

      // if signal aborted here, nothing to cleanup, as we didn't acquire
      // anything. Also, don't try to record the acquire time, as we aborted
      // mid-way (didn't invoke the rejection strategy).
      if (options?.signal?.aborted) {
        return undefined;
      }

      const result = await this.rejectionStrategy.onAllotmentUnavailable(
        ctx,
        async (retryCtx) => {
          if (options?.signal?.aborted) {
            return undefined;
          }
          return this.tryAcquireCore(retryCtx, acquireStart);
        },
        options?.signal,
      );

      // If we still don't have an allotment, record the acquire time as unavailable.
      if (!result) {
        void recordFinalAcquireFailed();
        return undefined;
      }

      // If the rejection strategy acquired via retry just before the signal
      // aborted, return the caller's capacity to the limiter.
      if (options?.signal?.aborted) {
        await result.releaseAndIgnore();
        return undefined;
      }

      return result;
    }

    // same idea as above: here, we did acquire, so we need to try to cleanup.
    if (options?.signal?.aborted) {
      await allotment.releaseAndIgnore();
      return undefined;
    }

    return allotment;
  }

  private async tryAcquireCore(
    ctx: Context,
    acquireStart: number,
  ): AcquireResult {
    const reservation = await this.acquireStrategy.tryReserveAllotment(ctx, {
      limit: this._limit,
      inflight: this._inflight,
    });

    if (!reservation) {
      void fireAndForget(() => {
        this.acquireFailedCounter.add(1);
      });
      return undefined;
    }

    // Capture quantities derived from user-supplied callbacks BEFORE committing
    // the reservation. If `clock()` or `operationNameFor()` throws we cancel
    // the reservation cleanly: cancellation is contractually side-effect free
    // beyond admission bookkeeping, so composers like
    // `RedisTokenBucketStrategy` get a chance to refund resources they consumed
    // during reserve (e.g. the bucket token) — something `onAllotmentReleased`
    // couldn't do because that hook is semantically "completed allotment", not
    // "abandoned reservation".
    let operationStartTime: number;
    let operationName: string | undefined;
    try {
      operationStartTime = this.clock();
      operationName = this.operationNameFor?.(ctx);
    } catch (err) {
      await fireAndForget(() => reservation.cancel());
      throw err;
    }

    // Commit only after the throwable user-supplied work above has succeeded.
    // If `commit()` itself throws, the reservation is in an indeterminate state
    // per the AllotmentReservation contract; we propagate the error without
    // touching `_inflight` or building an allotment, leaving the strategy
    // responsible for its own cleanup.
    await reservation.commit();

    void fireAndForget(() => this.acquireSucceededCounter.add(1));
    void fireAndForget(() => {
      if (operationStartTime !== undefined) {
        this.acquireTimeOnSuccessDistribution.addSample(
          operationStartTime - acquireStart,
        );
      }
    });

    const currentInflight = ++this._inflight;
    const incrementTags = operationName
      ? { [MetricIds.OPERATION_NAME_TAG]: operationName }
      : {};

    // Make sure an allotment can only be released once; future calls become a
    // no-op. This simplifies a lot of cleanup handling etc that'd otherwise be
    // much racier/more complicated. It could hide subtle correctness issue, but
    // should be more valuable as defense-in-depth.
    let releaseStarted = false;

    return {
      releaseAndRecordSuccess: async () => {
        if (releaseStarted) return;
        releaseStarted = true;
        const endTime = this.safeReadClockWithFallback(undefined);

        // Every interaction with user-supplied code (metrics, clock, the
        // limit algorithm, the strategies) is wrapped in try/catch so that
        // a single misbehaving collaborator can't leave the strategy with
        // a leaked permit or stall queued waiters in a blocking rejection
        // strategy. This release method must never throw or reject (per
        // `LimitAllotment` contract).
        this._inflight--;
        void fireAndForget(() => {
          this.successCounter.add(1, incrementTags);
        });

        // A successful sample is our signal that requests are flowing
        // again: clear any pending probe and reset the failure ladder.
        // (See the docstring on `probeFailures` for why neither is reset
        // on the limit-rise from `applyProbeFromZero` itself.)
        this.probeFailures = 0;
        this.cancelProbe();

        // If one onAllotmentReleased call fails, hard to know what to do here.
        // We're in some kind of inconsistent state, but we probably have to
        // soldier on.
        try {
          await this.acquireStrategy.onAllotmentReleased(ctx);
        } catch {}
        try {
          // if clock threw, preventing us from getting an rtt, we don't add a sample.
          if (endTime !== undefined) {
            const rtt = endTime - operationStartTime;
            this.limitAlgorithm.addSample(
              operationStartTime,
              rtt,
              currentInflight,
              false,
              operationName,
            );
          }
        } catch {}
        try {
          await this.rejectionStrategy?.onAllotmentReleased();
        } catch {}

        // Needed because some limit implementations could keep the limit at 0
        // even after a successful sample (e.g., a GradientLimit where the
        // successful sample's RTT was slow), so we need to re-arm the probe in
        // that case (and won't get a limit subscription callback).
        this.maybeArmRecoveryProbe();
      },
      releaseAndIgnore: async () => {
        if (releaseStarted) return;
        releaseStarted = true;

        this._inflight--;
        void fireAndForget(() => {
          this.ignoredCounter.add(1, incrementTags);
        });

        // Decrementing inflight above, possibly to 0, means we might need to
        // arm the probe now.
        this.maybeArmRecoveryProbe();

        // If one onAllotmentReleased call fails, hard to know what to do here.
        // We're in some kind of inconsistent state, but we probably have to
        // soldier on.
        try {
          await this.acquireStrategy.onAllotmentReleased(ctx);
        } catch {}
        try {
          await this.rejectionStrategy?.onAllotmentReleased();
        } catch {}
      },
      releaseAndRecordDropped: async () => {
        if (releaseStarted) return;
        releaseStarted = true;

        const endTime = this.safeReadClockWithFallback(operationStartTime);
        const rtt = endTime - operationStartTime;
        this._inflight--;
        void fireAndForget(() => {
          this.droppedCounter.add(1, incrementTags);
        });

        // Needed after the inflight decrement like in releaseAndIgnore.
        this.maybeArmRecoveryProbe();

        // If one onAllotmentReleased call fails, hard to know what to do here.
        // We're in some kind of inconsistent state, but we probably have to
        // soldier on.
        try {
          await this.acquireStrategy.onAllotmentReleased(ctx);
        } catch {}
        try {
          this.limitAlgorithm.addSample(
            operationStartTime,
            rtt,
            currentInflight,
            true,
            operationName,
          );
        } catch {}
        try {
          await this.rejectionStrategy?.onAllotmentReleased();
        } catch {}
      },
    };
  }

  private safeReadClockWithFallback<T extends number | undefined>(
    fallback: T,
  ): T | number {
    try {
      return this.clock();
    } catch {
      return fallback;
    }
  }

  /**
   * Builds a per-acquire allotment for a bypassed request. Mirrors the
   * one-shot `releaseStarted` semantics of {@link tryAcquireCore} so that
   * bypassed and non-bypassed allotments behave consistently when callers
   * accidentally invoke a release method more than once.
   *
   * Bypassed acquires deliberately do not affect `_inflight` or the limit
   * algorithm — `addSample` is never called — but they still emit the
   * standard CALL_NAME counter, tagged with `operationNameFor` so per-
   * operation dashboards include bypassed traffic.
   */
  private createBypassedAllotment(ctx: Context): LimitAllotment {
    let operationName: string | undefined;
    try {
      operationName = this.operationNameFor?.(ctx);
    } catch {
      // A misbehaving `operationNameFor` shouldn't break the bypass path;
      // just emit untagged metrics in that case.
    }
    const incrementTags = operationName
      ? { [MetricIds.OPERATION_NAME_TAG]: operationName }
      : {};

    let releaseStarted = false;
    return {
      releaseAndRecordSuccess: async () => {
        if (releaseStarted) return;
        releaseStarted = true;
        void fireAndForget(() => {
          this.successCounter.add(1, incrementTags);
        });
      },
      releaseAndIgnore: async () => {
        if (releaseStarted) return;
        releaseStarted = true;
        void fireAndForget(() => {
          this.ignoredCounter.add(1, incrementTags);
        });
      },
      releaseAndRecordDropped: async () => {
        if (releaseStarted) return;
        releaseStarted = true;
        void fireAndForget(() => {
          this.droppedCounter.add(1, incrementTags);
        });
      },
    };
  }

  getLimit(): number {
    return this._limit;
  }

  getInflight(): number {
    return this._inflight;
  }

  /**
   * Cancels any pending recovery-probe timer and unsubscribes from the
   * underlying limit algorithm. Useful for clean shutdown in long-lived
   * processes, especially when the underlying `AdaptiveLimit` outlives
   * (or is shared across) limiters. Safe to call multiple times.
   *
   * Also exposed via `Symbol.dispose`, so a `Limiter` can be used with the
   * `using` declaration:
   * ```ts
   * using limiter = new Limiter({ ... });
   * ```
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelProbe();
    this.unsubscribeFromLimit();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  /**
   * True when the limit has collapsed to 0 and there are no inflight
   * requests left to produce samples. In this state, no future
   * `addSample` call will ever arrive on its own, so the limiter has no
   * way to climb back without an external nudge — i.e. a recovery probe.
   */
  private isStarvedForSamples(): boolean {
    return this._limit === 0 && this._inflight === 0;
  }

  private shouldArmRecoveryProbe(this: Limiter<Context>) {
    return (
      !this.disposed &&
      this.probeTimerHandle === undefined &&
      this.isStarvedForSamples() &&
      typeof this.limitAlgorithm.probeFromZeroInterval === "function" &&
      typeof this.limitAlgorithm.applyProbeFromZero === "function"
    );
  }

  /**
   * Schedules a recovery probe if (and only if) the limiter is starved for
   * samples (see {@link isStarvedForSamples}), the strategy supports
   * probing, and no probe is already armed.
   *
   * Never throws. Errors from the limit algorithm's
   * {@link AdaptiveLimit.probeFromZeroInterval}, the timer, or
   * {@link AdaptiveLimit.applyProbeFromZero} are swallowed so callers in
   * the release path / subscribe callback / constructor don't have to
   * wrap each invocation. A failed probe arming simply means recovery
   * may take longer; the next limit transition to 0 will re-attempt
   * through the normal hooks.
   */
  private maybeArmRecoveryProbe(): void {
    try {
      if (!this.shouldArmRecoveryProbe()) {
        return;
      }

      // not-null assertion is safe because of the shouldArmRecoveryProbe()
      // guard, but hard to prove to TS.
      const raw = this.limitAlgorithm.probeFromZeroInterval!(
        this.probeFailures,
      );

      // Cap before the finite check so that an exponential backoff that
      // overflows to Infinity is clamped to recoveryProbeMaxMs instead of
      // silently disabling recovery probing.
      const capped = Math.min(this.recoveryProbeMaxMs, raw);

      if (!Number.isFinite(capped) || capped <= 0) return;
      const jitterFactor =
        1 + (Math.random() * 2 - 1) * this.recoveryProbeJitter;
      const ms = capped * jitterFactor;

      this.probeTimerHandle = this.timer.setTimeout(() => {
        this.probeTimerHandle = undefined;
        if (this.disposed) return;
        if (this._limit !== 0) {
          // For the strategies in this package the limit should be unable to
          // climb back from 0 without a sample, and samples can't arrive while
          // we're starved, so this branch *seems* unreachable. It isn't,
          // though: a custom `AdaptiveLimit` (or `WindowedLimit` wrapping one)
          // could mutate its limit from a timer of its own or via an external
          // `setLimit`-style hook; tests / harnesses can call `addSample`
          // directly; and a maintainer could add a non-completing path that
          // injects samples. None of those should crash the process, so we
          // simply abandon the probe — the next limit transition to 0 will
          // re-arm it through the normal hooks.
          return;
        }

        try {
          // not-null assertion is safe because of the shouldArmRecoveryProbe()
          // guard, but hard to prove to TS.
          this.limitAlgorithm.applyProbeFromZero!();
          // Increment *after* the apply (and the synchronous subscription it
          // triggers): see the docstring on `probeFailures`. Notably we do NOT
          // reset on the limit-rise caused by `applyProbeFromZero`, because
          // the rise alone doesn't confirm any traffic actually flowed
          // through. A confirming success sample in `releaseAndRecordSuccess`
          // is what eventually clears this.
          this.probeFailures++;
        } catch {
          // Ignore — see the method docstring. Future samples will re-trigger
          // probe arming through the normal hooks.
        }
      }, ms);
    } catch {
      // Ignore — see the method docstring.
    }
  }

  /**
   * Cancels the currently-armed recovery probe, if any. Idempotent and
   * never throws (errors from the timer's `clearTimeout` are swallowed so
   * callers don't have to wrap each invocation).
   */
  private cancelProbe(): void {
    if (this.probeTimerHandle === undefined) return;
    const handle = this.probeTimerHandle;
    this.probeTimerHandle = undefined;
    void fireAndForget(() => {
      this.timer.clearTimeout(handle);
    });
  }
}

async function fireAndForget(fn: () => MaybePromise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // Ignore errors
  }
}
