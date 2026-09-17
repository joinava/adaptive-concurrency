import { sumBy } from "es-toolkit";
import lruPkg from "lru_map";
const { LRUMap } = lruPkg;

import { ListenerSet } from "../ListenerSet.js";
import type { Gauge, MetricRegistry } from "../MetricRegistry.js";
import { MetricIds, NoopMetricRegistry } from "../MetricRegistry.js";
import { DecayingHistogram } from "../statistics/DecayingHistogram.js";
import { ChangeEpoch } from "../utils/ChangeEpoch.js";
import {
  makeMultiplicativeDecrease,
  type MultiplicativeDecreaseOptions,
} from "../utils/multiplicativeDecrease.js";
import {
  resolveMinUtilizationToGrow,
  type AppLimitedOptions,
} from "./appLimited.js";
import type { AdaptiveLimit } from "./StreamingLimit.js";

/**
 * Per-group tracking state. Fixed memory regardless of sample volume.
 */
class GroupState {
  /**
   * Long-lived, time-decayed histogram: the group's baseline RTT
   * distribution.
   */
  readonly baseline: DecayingHistogram;

  /**
   * Count-decayed histogram over roughly the last `recentRttWindow` samples:
   * the group's current RTT distribution. Count decay, not time decay, so
   * the estimate responds in a fixed number of samples whatever the rate.
   */
  readonly recent: DecayingHistogram;

  /**
   * Decaying counter of recent samples, used for weight and warmup.
   * Decays with its own (shorter) half-life.
   */
  private _activityCount = 0;
  private _lastActivityDecayTime: number | undefined;
  private readonly activityLambda: number;

  constructor(options: {
    baselineHalfLife: number;
    activityHalfLife: number;
    recentRttWindow: number;
    binsPerDecade: number;
  }) {
    this.baseline = new DecayingHistogram({
      halfLife: options.baselineHalfLife,
      binsPerDecade: options.binsPerDecade,
    });
    this.recent = new DecayingHistogram({
      sampleWindow: options.recentRttWindow,
      binsPerDecade: options.binsPerDecade,
    });
    this.activityLambda = Math.LN2 / options.activityHalfLife;
  }

  recordSample(rtt: number, now: number): void {
    this.baseline.addSample(rtt, now);
    this.recent.addSample(rtt, now);
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
 * Each sample is associated with an operation group via `operationName`. Per
 * group, two histograms track the same percentile (`percentile`, default the
 * median) of RTT: a long-lived, time-decayed *baseline* and a count-decayed
 * *recent* distribution over roughly the last `recentRttWindow` samples. The
 * group's RTT ratio is `recent / baseline`. Comparing the same percentile on
 * both sides makes the ratio 1.0 at baseline for any latency distribution;
 * a skewed distribution (p90 well above p10) does not read as congestion the
 * way a mean-versus-low-percentile comparison would. Congestion shifts the
 * whole distribution, so the ratio still rises under load.
 *
 * The congestion signal is the weighted average of the ratio across
 * warmed-up groups, where weight is `sqrt(decayedSampleCount)`. The limit
 * grows by one when the signal is below `rttRatioThresholds.increaseBelow`
 * and the client is using the limit (see `minUtilizationToGrow`), and
 * shrinks multiplicatively when the signal is
 * above `rttRatioThresholds.decreaseAbove` or a drop occurs. Before any group
 * is warmed up, the limit only responds to drops.
 *
 * Both kinds of change are gated to one per flight of requests (see
 * {@link ChangeEpoch}): a change only affects requests admitted after it, so
 * samples from requests that started before it do not drive another one.
 * Without this, a burst of drops or inflated RTTs from one episode would
 * apply the decrease once per in-flight request and collapse the limit to
 * `minLimit`, and a fast downstream would grow the limit far past capacity
 * before any RTT could reflect the growth.
 *
 * Thresholds and resolution: histogram percentiles are quantized to bin
 * midpoints, so at the default 20 bins per decade the per-group ratio moves
 * in steps of 10^(1/20) ≈ 1.122. The default thresholds sit between steps
 * (1.06 is between 1.0 and 1.122; 1.5 is between 1.413 and 1.585) so that
 * quantization alone can never flap a decision. If you change
 * `binsPerDecade`, place the thresholds against the new step.
 *
 * Samples without an `operationName` do not contribute to any group's state.
 * They still participate in limit decisions: drops trigger a decrease, and
 * non-drop samples can trigger an increase or decrease based on the current
 * congestion signal from warmed-up groups. Unnamed operations thus free-ride
 * on the congestion detection provided by named groups without polluting
 * group baselines.
 *
 * This design is immune to operation mix shifts: a transition from fast to
 * slow operations does not cause a spurious RTT spike because each group is
 * measured against its own baseline.
 */
export class GroupAwareLimit implements AdaptiveLimit {
  private _limit: number;
  private readonly limitListeners = new ListenerSet<(n: number) => void>();
  private readonly groups: InstanceType<typeof LRUMap<string, GroupState>>;

  private readonly minLimit: number;
  private readonly maxLimit: number;
  private readonly percentile: number;
  private readonly increaseBelow: number;
  private readonly decreaseAbove: number;
  private readonly decrease: (limit: number) => number;
  private readonly binsPerDecade: number;
  private readonly baselineHalfLife: number;
  private readonly activityHalfLife: number;
  private readonly recentRttWindow: number;
  private readonly minGroupSamples: number;
  private readonly minUtilizationToGrow: number;
  private readonly recoveryProbeBaseMs: number;

  /**
   * End time of the latest sample, on the samples' own clock. All time
   * comes from samples; this is the "now" for the one reader that has no
   * sample of its own, {@link probeFromZeroInterval}. `-Infinity` until the
   * first sample, when there are no groups to read either.
   */
  private lastSampleEnd = -Infinity;

  private readonly increaseEpoch = new ChangeEpoch();
  private readonly decreaseEpoch = new ChangeEpoch();

  private readonly registry: MetricRegistry;
  private readonly congestionSignalGauge: Gauge;
  private readonly warmedGroupsCountGauge: Gauge;
  private readonly groupRttRatioGauge: Gauge;

  constructor(
    options?: AppLimitedOptions & {
      /** Default: 20. */
      initialLimit?: number;
      /** Default: 10. */
      minLimit?: number;
      /** Default: 200. */
      maxLimit?: number;
      /** Most groups tracked at once (least recently seen evicted). Default: 50. */
      maxGroups?: number;

      /**
       * Percentile of RTT compared between a group's recent and baseline
       * distributions, in (0, 1). The median responds fastest to congestion:
       * it moves once half the recent window is congested samples. A lower
       * percentile resists baseline pollution under long congestion a little
       * better, at the cost of slower detection. Default: 0.5.
       */
      percentile?: number;

      /**
       * Thresholds on the congestion signal, the weighted mean over warmed
       * groups of `recent percentile / baseline percentile`. See the class doc
       * for how they relate to histogram resolution.
       */
      rttRatioThresholds?: {
        /** Grow the limit when the signal is below this. Default: 1.06. */
        increaseBelow?: number;
        /** Shrink the limit when the signal is above this. Default: 1.5. */
        decreaseAbove?: number;
      };

      /**
       * Multiplicative decrease applied on congestion and on drops. Default:
       * ratio 0.9 with jitter 0.02.
       */
      decrease?: MultiplicativeDecreaseOptions;

      /**
       * Histogram resolution for both per-group histograms. Default: 20. If
       * you change it, re-place `rttRatioThresholds` against the new step of
       * `10^(1/binsPerDecade)`.
       */
      binsPerDecade?: number;

      /** Time decay of the baseline histogram, in milliseconds. Default: 600_000. */
      baselineHalfLife?: number;
      /** Time decay of the per-group activity counter, in milliseconds. Default: 30_000. */
      activityHalfLife?: number;
      /** Count decay window of the recent histogram, in samples. Default: 100. */
      recentRttWindow?: number;
      /** Decayed sample count a group needs before it counts. Default: 20. */
      minGroupSamples?: number;

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
    },
  ) {
    this.minLimit = options?.minLimit ?? 10;
    this.maxLimit = options?.maxLimit ?? 200;
    this._limit = this.clamp(options?.initialLimit ?? 20);
    this.groups = new LRUMap(options?.maxGroups ?? 50);
    this.percentile = options?.percentile ?? 0.5;
    this.increaseBelow = options?.rttRatioThresholds?.increaseBelow ?? 1.06;
    this.decreaseAbove = options?.rttRatioThresholds?.decreaseAbove ?? 1.5;
    this.decrease = makeMultiplicativeDecrease(options?.decrease);
    this.binsPerDecade = options?.binsPerDecade ?? 20;
    this.baselineHalfLife = options?.baselineHalfLife ?? 600_000;
    this.activityHalfLife = options?.activityHalfLife ?? 30_000;
    this.recentRttWindow = options?.recentRttWindow ?? 100;
    this.minGroupSamples = options?.minGroupSamples ?? 20;
    this.minUtilizationToGrow = resolveMinUtilizationToGrow(options);
    this.recoveryProbeBaseMs = options?.recoveryProbe?.baseMs ?? 1000;

    if (!(this.percentile > 0 && this.percentile < 1)) {
      throw new RangeError("percentile must be in (0, 1)");
    }
    if (!(this.increaseBelow > 0)) {
      throw new RangeError("rttRatioThresholds.increaseBelow must be > 0");
    }
    if (!(this.decreaseAbove > this.increaseBelow)) {
      throw new RangeError(
        "rttRatioThresholds.decreaseAbove must be > increaseBelow",
      );
    }
    if (!(this.recentRttWindow >= 1)) {
      throw new RangeError("recentRttWindow must be >= 1");
    }
    if (!(this.recoveryProbeBaseMs > 0)) {
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
    startTime: number,
    rtt: number,
    inflight: number,
    didDrop: boolean,
    operationName?: string,
  ): void {
    // The sample's own end time, on the same clock as `startTime`. This class
    // has no clock of its own: decay, the epoch gates, and the sample
    // timestamps all run on the samples' time base. Samples can complete out
    // of order, so keep the latest end time rather than the last one seen.
    const now = startTime + rtt;
    this.lastSampleEnd = Math.max(this.lastSampleEnd, now);

    // Drops are handled before group state updates so that dropped RTTs never
    // pollute baselines or recent-RTT tracking. A dropped request's timing
    // reflects when the drop was detected (e.g. a timeout firing), not how
    // long the operation actually takes to complete.
    if (didDrop) {
      this.tryDecrease(startTime, now);
      return;
    }

    if (operationName !== undefined) {
      let group = this.groups.get(operationName);
      if (!group) {
        group = new GroupState({
          baselineHalfLife: this.baselineHalfLife,
          activityHalfLife: this.activityHalfLife,
          recentRttWindow: this.recentRttWindow,
          binsPerDecade: this.binsPerDecade,
        });
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

    if (signal > this.decreaseAbove) {
      this.tryDecrease(startTime, now);
    } else if (
      signal < this.increaseBelow &&
      inflight >= this.minUtilizationToGrow * this._limit
    ) {
      if (this.increaseEpoch.tryChange(startTime, now)) {
        this.applyNewLimit(this.clamp(this._limit + 1));
      }
    }
  }

  get currentLimit(): number {
    return this._limit;
  }

  /**
   * See {@link AdaptiveLimit.probeFromZeroInterval}.
   *
   * The limiter only asks for this when the limit is 0 and nothing is in
   * flight, so no sample can arrive and time is read as of the last sample.
   * Group activity therefore does not decay while the limit sits at 0: a
   * group that was warm at the last sample stays warm, and the base interval
   * is 5× the recent RTT it last observed. That RTT is usually the congested
   * one, which errs toward a longer wait; the `recoveryProbe.baseMs` fallback
   * only applies when no group had warmed up. Once samples resume, the first
   * one applies the whole elapsed decay, so a group that was idle through the
   * outage re-warms from scratch as before.
   */
  probeFromZeroInterval(failedProbes: number): number {
    const now = this.lastSampleEnd;
    const entries = [
      ...(this.groups.entries() satisfies Iterator<
        [string, GroupState]
      > as unknown as Iterable<[string, GroupState]>),
    ];

    const warmedGroupInfos = entries.flatMap(([, groupState]) => {
      const activity = groupState.activityCount(now);

      const recentRtt = groupState.recent.percentile(this.percentile, now);
      const validRecentRtt = Number.isFinite(recentRtt) && recentRtt > 0;

      return validRecentRtt && activity >= this.minGroupSamples
        ? [{ recentRtt, weight: Math.sqrt(activity) }]
        : [];
    });

    const totalWeight = sumBy(warmedGroupInfos, ({ weight }) => weight);
    const weightedRttSum = sumBy(
      warmedGroupInfos,
      ({ weight, recentRtt }) => weight * recentRtt,
    );

    const base =
      totalWeight > 0
        ? (weightedRttSum / totalWeight) * 5
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

  private tryDecrease(startTime: number, now: number): void {
    if (this.decreaseEpoch.tryChange(startTime, now)) {
      this.applyNewLimit(this.clamp(this.decrease(this._limit)));
    }
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

        const baseline = groupState.baseline.percentile(this.percentile, now);
        if (!Number.isFinite(baseline) || baseline <= 0) return undefined;

        const recent = groupState.recent.percentile(this.percentile, now);
        if (!Number.isFinite(recent) || recent <= 0) return undefined;

        const ratio = recent / baseline;
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
