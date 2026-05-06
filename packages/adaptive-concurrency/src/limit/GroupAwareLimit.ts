import { sumBy } from "es-toolkit";
import lruPkg from "lru_map";
const { LRUMap } = lruPkg;

import { ListenerSet } from "../ListenerSet.js";
import type { Gauge, MetricRegistry } from "../MetricRegistry.js";
import { MetricIds, NoopMetricRegistry } from "../MetricRegistry.js";
import { DecayingHistogram } from "../statistics/DecayingHistogram.js";
import { ExpMovingAverage } from "../statistics/ExpMovingAverage.js";
import { log10Scale } from "../utils/index.js";
import type { AdaptiveLimit } from "./StreamingLimit.js";

function defaultDecrease(limit: number, didDrop: boolean): number {
  if (didDrop) {
    return Math.floor(limit * 0.9);
  }
  return limit - log10Scale(Math.floor(limit));
}

/**
 * Per-group tracking state. Fixed memory regardless of sample volume.
 */
class GroupState {
  /** Long-lived decaying histogram for the p10 baseline. */
  readonly histogram: DecayingHistogram;

  /** Short EMA tracking the group's current RTT. */
  readonly recentRtt: ExpMovingAverage;

  /**
   * Decaying counter of recent samples, used for weight and warmup.
   * Decays with its own (shorter) half-life.
   */
  private _activityCount = 0;
  private _lastActivityDecayTime: number | undefined;
  private readonly activityLambda: number;

  constructor(
    baselineHalfLife: number,
    activityHalfLife: number,
    recentRttWindow: number,
  ) {
    this.histogram = new DecayingHistogram({ halfLife: baselineHalfLife });
    this.recentRtt = new ExpMovingAverage(recentRttWindow, 5);
    this.activityLambda = Math.LN2 / activityHalfLife;
  }

  recordSample(rtt: number, now: number): void {
    this.histogram.addSample(rtt, now);
    this.recentRtt.addSample(rtt);
    this.applyActivityDecay(now);
    this._activityCount += 1;
  }

  activityCount(now: number): number {
    this.applyActivityDecay(now);
    return this._activityCount;
  }

  private applyActivityDecay(now: number): void {
    if (this._lastActivityDecayTime === undefined) {
      this._lastActivityDecayTime = now;
      return;
    }
    const elapsed = now - this._lastActivityDecayTime;
    if (elapsed <= 0) return;
    this._activityCount *= Math.exp(-this.activityLambda * elapsed);
    this._lastActivityDecayTime = now;
  }
}

/**
 * Mix-agnostic adaptive concurrency limit that detects congestion using
 * per-group RTT ratios weighted by sample density.
 *
 * Each sample is associated with an operation group via `operationName`. Per-group
 * state tracks a long-lived p10 RTT baseline (decaying histogram) and a short
 * EMA of recent RTT. The congestion signal is the weighted average of
 * `recentRtt / p10` across warmed-up groups, where weight is
 * `sqrt(decayedSampleCount)`.
 *
 * The limit increases additively when the congestion signal is low and inflight
 * is near the limit, and decreases via a configurable `decrease` function when
 * the signal is high or a drop occurs. Before any groups are warmed up, the
 * limit only responds to drops.
 *
 * Samples without an `operationName` do not contribute to any group's state
 * (no histogram, EMA, or activity counter update). However, they still
 * participate in limit decisions: drops always trigger a decrease, and
 * non-drop samples can trigger an increase or decrease based on the current
 * congestion signal from warmed-up groups. This means unnamed operations
 * free-ride on the congestion detection provided by named groups without
 * polluting group baselines.
 *
 * This design is immune to operation mix shifts: a transition from fast to slow
 * operations does not cause a spurious RTT spike because each group is measured
 * against its own baseline.
 */
export class GroupAwareLimit implements AdaptiveLimit {
  private _limit: number;
  private readonly limitListeners = new ListenerSet<(n: number) => void>();
  private readonly groups: InstanceType<typeof LRUMap<string, GroupState>>;

  private readonly minLimit: number;
  private readonly maxLimit: number;
  private readonly alpha: number;
  private readonly beta: number;
  private readonly decrease: (limit: number, didDrop: boolean) => number;
  private readonly baselineHalfLife: number;
  private readonly activityHalfLife: number;
  private readonly recentRttWindow: number;
  private readonly minGroupSamples: number;
  private readonly clock: () => number;
  private readonly recoveryProbeBaseMs: number;

  private readonly registry: MetricRegistry;
  private readonly congestionSignalGauge: Gauge;
  private readonly warmedGroupsCountGauge: Gauge;
  private readonly groupRttRatioGauge: Gauge;

  constructor(options?: {
    initialLimit?: number;
    minLimit?: number;
    maxLimit?: number;
    maxGroups?: number;
    alpha?: number;
    beta?: number;
    decrease?: (limit: number, didDrop: boolean) => number;
    baselineHalfLife?: number;
    activityHalfLife?: number;
    recentRttWindow?: number;
    minGroupSamples?: number;
    clock?: () => number;
    metricRegistry?: MetricRegistry;
    /**
     * Configuration for the limiter's recovery probe when the limit reaches
     * 0. See {@link AdaptiveLimit.probeFromZeroInterval}.
     */
    recoveryProbe?: {
      /**
       * Fallback base interval in milliseconds between probes, used when no
       * group is warmed up enough to provide a recent RTT estimate. When
       * warmed groups are available, the probe interval is derived from
       * their weighted-mean recent RTT × 5. Default: 1000.
       */
      baseMs?: number;
    };
  }) {
    this.minLimit = options?.minLimit ?? 10;
    this.maxLimit = options?.maxLimit ?? 200;
    this._limit = this.clamp(options?.initialLimit ?? 20);
    this.groups = new LRUMap(options?.maxGroups ?? 50);
    this.alpha = options?.alpha ?? 1.1;
    this.beta = options?.beta ?? 1.5;
    this.decrease = options?.decrease ?? defaultDecrease;
    this.baselineHalfLife = options?.baselineHalfLife ?? 600_000;
    this.activityHalfLife = options?.activityHalfLife ?? 30_000;
    this.recentRttWindow = options?.recentRttWindow ?? 100;
    this.minGroupSamples = options?.minGroupSamples ?? 20;
    this.clock = options?.clock ?? (() => performance.now());
    this.recoveryProbeBaseMs = options?.recoveryProbe?.baseMs ?? 1000;
    if (this.recoveryProbeBaseMs <= 0) {
      throw new RangeError("recoveryProbe.baseMs must be > 0");
    }

    this.registry = options?.metricRegistry ?? NoopMetricRegistry;
    this.congestionSignalGauge = this.registry.gauge(
      MetricIds.CONGESTION_SIGNAL_NAME,
    );
    this.warmedGroupsCountGauge = this.registry.gauge(
      MetricIds.WARMED_GROUPS_COUNT_NAME,
    );
    this.groupRttRatioGauge = this.registry.gauge(
      MetricIds.GROUP_RTT_RATIO_NAME,
    );
  }

  addSample(
    _startTime: number,
    rtt: number,
    inflight: number,
    didDrop: boolean,
    operationName?: string,
  ): void {
    const now = this.clock();

    // Drops are handled before group state updates so that dropped RTTs never
    // pollute baselines or recent-RTT tracking. A dropped request's timing
    // reflects when the drop was detected (e.g. a timeout firing), not how
    // long the operation actually takes to complete.
    if (didDrop) {
      this.applyNewLimit(this.clamp(this.decrease(this._limit, true)));
      return;
    }

    if (operationName !== undefined) {
      let group = this.groups.get(operationName);
      if (!group) {
        group = new GroupState(
          this.baselineHalfLife,
          this.activityHalfLife,
          this.recentRttWindow,
        );
        this.groups.set(operationName, group);
      }
      group.recordSample(rtt, now);
    }

    const result = this.computeCongestionSignal(now);

    if (result === undefined) {
      // No warmed-up groups; hold (drop-only mode).
      this.warmedGroupsCountGauge.record(0);
      return;
    }

    const { warmedGroupInfos, signal } = result;

    this.warmedGroupsCountGauge.record(warmedGroupInfos.length);
    this.congestionSignalGauge.record(signal);
    for (const { groupName: group, ratio } of warmedGroupInfos) {
      this.groupRttRatioGauge.record(ratio, { group });
    }

    if (signal > this.beta) {
      this.applyNewLimit(this.clamp(this.decrease(this._limit, false)));
    } else if (signal < this.alpha && inflight >= this._limit / 2) {
      this.applyNewLimit(this.clamp(this._limit + 1));
    }
  }

  get currentLimit(): number {
    return this._limit;
  }

  probeFromZeroInterval(failedProbes: number): number {
    const now = this.clock();
    const entries = [
      ...(this.groups.entries() satisfies Iterator<
        [string, GroupState]
      > as unknown as Iterable<[string, GroupState]>),
    ];

    const warmedGroupInfos = entries.flatMap(([, groupState]) => {
      const activity = groupState.activityCount(now);

      const recentRtt = groupState.recentRtt.currentValue;
      const validRecentRtt = Number.isFinite(recentRtt) && recentRtt > 0;

      return validRecentRtt && activity >= this.minGroupSamples
        ? [{ recentRtt, weight: Math.sqrt(activity) }]
        : [];
    });

    const totalWeight = sumBy(warmedGroupInfos, ({ weight }) => weight);
    const weightedRatioSum = sumBy(
      warmedGroupInfos,
      ({ weight, recentRtt }) => weight * recentRtt,
    );

    const base =
      totalWeight > 0
        ? (weightedRatioSum / totalWeight) * 5
        : this.recoveryProbeBaseMs;

    return base * Math.pow(2, failedProbes);
  }

  applyProbeFromZero(): void {
    this.applyNewLimit(1);
  }

  subscribe(
    consumer: (newLimit: number) => void,
    options: { signal?: AbortSignal } = {},
  ): () => void {
    return this.limitListeners.subscribe(consumer, options);
  }

  private computeCongestionSignal(now: number):
    | {
        signal: number;
        warmedGroupInfos: { groupName: string; ratio: number }[];
      }
    | undefined {
    // See https://github.com/rsms/js-lru/pull/42/changes
    const entries = [
      ...(this.groups.entries() satisfies Iterator<
        [string, GroupState]
      > as unknown as Iterable<[string, GroupState]>),
    ];

    const warmedGroupInfos = entries
      .map(([groupName, groupState]) => {
        const activity = groupState.activityCount(now);
        if (activity < this.minGroupSamples) return undefined;

        const p10 = groupState.histogram.percentile(0.1, now);
        if (!Number.isFinite(p10) || p10 <= 0) return undefined;

        const recentRtt = groupState.recentRtt.currentValue;
        if (recentRtt <= 0) return undefined;

        const ratio = recentRtt / p10;
        const weight = Math.sqrt(activity);

        return { groupName, ratio, weight };
      })
      // Remove non-warmed or otherwise-invalid groups
      .filter((it) => it !== undefined);

    const totalWeight = sum(warmedGroupInfos.map(({ weight }) => weight));

    if (totalWeight <= 0) return undefined;

    const weightedRatioSum = sumBy(
      warmedGroupInfos,
      ({ weight, ratio }) => weight * ratio,
    );

    return {
      signal: weightedRatioSum / totalWeight,
      warmedGroupInfos,
    };
  }

  private clamp(limit: number): number {
    return Math.min(this.maxLimit, Math.max(this.minLimit, Math.floor(limit)));
  }

  private applyNewLimit(newLimit: number): void {
    if (newLimit !== this._limit) {
      this._limit = newLimit;
      this.limitListeners.notify(newLimit);
    }
  }

  toString(): string {
    return `GroupAwareLimit [limit=${this._limit}, groups=${this.groups.size}]`;
  }
}

declare global {
  interface Math {
    sumPrecise?: (numbers: Iterable<number>) => number;
  }
}

const sum =
  typeof Math.sumPrecise === "function"
    ? Math.sumPrecise.bind(Math)
    : (numbers: number[]) => numbers.reduce((acc, curr) => acc + curr, 0);
