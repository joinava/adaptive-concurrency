import { AllotmentReservation } from "../../AllotmentReservation.js";
import type {
  DistributionMetric,
  Gauge,
  MetricRegistry,
} from "../../MetricRegistry.js";
import { MetricIds, NoopMetricRegistry } from "../../MetricRegistry.js";
import type { LimiterState } from "../../types/Strategy.js";

const PARTITION_TAG_NAME = "partition";

export type PartitionConfig = {
  /**
   * Percentage of the total limit guaranteed to this partition. Must be in
   * [0.0, 1.0].
   */
  percent: number;

  /**
   * Controls whether this partition may exceed its limit-at-global-saturation
   * while global inflight is still below the global limit.
   *
   * - `{ kind: "unbounded" }` (default): current behavior; any partition may
   *   consume all global slack.
   * - `{ kind: "capped", maxBurstMultiplier }`: partition may burst, but only
   *   up to `ceil(globalLimit * percent * maxBurstMultiplier)`.
   * - `{ kind: "none" }`: no bursting; partition cannot exceed its
   *   `limitAtGlobalSaturation`, even when global slack exists.
   */
  burstMode?:
    | { kind: "unbounded" }
    | { kind: "capped"; maxBurstMultiplier: number }
    | { kind: "none" }
    | undefined;
};

/**
 * ## Partitioned acquire strategy (guaranteed share + bursting)
 *
 * Named partitions get a configured percentage of the global limit. The
 * percentages are converted to per-partition **limitAtGlobalSaturation** values,
 * used only when the limiter is globally saturated. The conversion splits
 * `floor(globalLimit * sum(percent))` whole slots among the partitions by the
 * largest-remainder method:
 *
 * 1. Each partition gets `floor(globalLimit * percent)` slots.
 * 2. The slots left over go one each to the partitions with the largest
 *    fractional remainders. A tie goes to the partition declared first in
 *    `partitions`, so declare partitions in priority order.
 *
 * So the limitsAtGlobalSaturation never sum to more than the global limit, and
 * a partition's share can be 0. With 60%/20%/20% partitions, a global limit of
 * 1 gives 1/0/0, a limit of 2 gives 1/1/0, and a limit of 5 gives 3/1/1. At a
 * global limit of 0, every share is 0, so nothing is admitted at saturation.
 *
 * Admission policy:
 * - If `globalInflight < globalLimit`, admission is controlled by partition
 *   burst policy:
 *   - `unbounded` (default): always admit while global slack exists.
 *   - `capped`: admit up to
 *     `max(limitAtGlobalSaturation, ceil(globalLimit * percent * maxBurstMultiplier))`.
 *   - `none`: admit only up to `limitAtGlobalSaturation`.
 *   - For `capped` and `none`, a partition with a nonzero percent may always
 *     use at least one slot of global slack, even when its share rounds to 0.
 *     Otherwise it could never run at a small global limit.
 *
 * - If `globalInflight >= globalLimit`, admission is checked against the
 *   resolved partition's limitAtGlobalSaturation only.
 *
 * Requests resolving to no configured partition use an internal `unknown`
 * partition. Unknown requests can use slack below global saturation, but are
 * always rejected at saturation.
 *
 * Examples (global limit = 10, A=50%, B=50% => limitsAtGlobalSaturation: A=5,
 * B=5):
 * - **Unbounded bursting:** A can reach inflight 10 while B is 0.
 *
 * - **Limit-at-global-saturation catch-up at saturation:** if A=10 and B=0,
 *   then B requests can still be admitted up to B=5, so global inflight can
 *   temporarily reach 15.
 *
 * - **No cross-partition borrowing:** at that same point (with A=10), an
 *   `unknown` request is rejected (it cannot use B's unused
 *   limit-at-global-saturation headroom).
 *
 * Caveats:
 * - Unknown traffic can still dominate while below global saturation.
 *
 * - There is no cross-partition work-stealing at saturation.
 *
 * - Total concurrent acquires can exceed the global limit: a partition below its
 *   share is admitted at saturation even when other partitions burst into the
 *   slack. The excess is at most the sum of the shares, so at most the global
 *   limit. This is usually temporary as RTT rises and excess work is shed by
 *   adaptive limiting over time.
 *
 * Each partition tracks committed inflight and speculative reservations
 * separately: admission decisions count both, but the `inflightDistribution`
 * metric only samples on commit, so composers (e.g. `RedisTokenBucketStrategy`)
 * can speculatively reserve without polluting the partition's inflight
 * distribution if the outer admission decision rejects.
 */
export class PartitionedStrategy<
  ContextT,
  PartitionName extends string = string,
> {
  private readonly knownPartitions: Map<
    PartitionName,
    Partition<PartitionName>
  >;
  /** The known partitions in declaration order, which is the tie-break order. */
  private readonly orderedPartitions: readonly Partition<PartitionName>[];
  private readonly unknownPartition: Partition<"unknown">;
  private readonly partitionResolver: (
    context: ContextT,
  ) => PartitionName | undefined;

  constructor(options: {
    /**
     * The global concurrency limit used to compute initial per-partition
     * limits at global saturation.
     */
    initialLimit: number;

    /**
     * Resolves context to a partition name. If null/undefined or the name is not
     * a configured partition, the "unknown" partition is used. Callers who want
     * ordered fallback (e.g. header then path) should implement that inside this
     * single function.
     */
    partitionResolver: (context: ContextT) => PartitionName | undefined;
    partitions: Record<PartitionName, PartitionConfig>;

    metricRegistry?: MetricRegistry | undefined;
  }) {
    const registry = options.metricRegistry ?? NoopMetricRegistry;
    const initialLimit = options.initialLimit;
    const partitionEntries = Object.entries(options.partitions) satisfies [
      string,
      PartitionConfig,
    ][] as [PartitionName, PartitionConfig][];

    const totalPercent = partitionEntries.reduce(
      (sum, [, cfg]) => sum + cfg.percent,
      0,
    );

    if (partitionEntries.length === 0) {
      throw new Error("No partitions specified");
    }

    if (totalPercent > 1) {
      throw new RangeError("Sum of partition percentages must be <= 1.0");
    }

    this.partitionResolver = options.partitionResolver;

    const initialShares = apportionGlobalLimit(
      initialLimit,
      partitionEntries.map(([, cfg]) => cfg.percent),
    );
    this.orderedPartitions = partitionEntries.map(
      ([name, cfg], i) =>
        new Partition({
          name,
          percent: cfg.percent,
          burstMode: cfg.burstMode ?? { kind: "unbounded" },
          initialGlobalLimit: initialLimit,
          initialLimitAtGlobalSaturation: initialShares[i]!,
          registry,
        }),
    );
    this.knownPartitions = new Map(
      this.orderedPartitions.map((partition) => [partition.name, partition]),
    );

    this.unknownPartition = new Partition({
      name: "unknown",
      percent: 0,
      burstMode: { kind: "unbounded" },
      initialGlobalLimit: initialLimit,
      // Java never calls updateLimit on unknown; limitAtGlobalSaturation stays
      // 0, so reservations always fail at global saturation.
      initialLimitAtGlobalSaturation: 0,
      registry,
    });
  }

  /**
   * Tentatively claim a slot without firing the `inflightDistribution` sample
   * (or any other observable side effect). Returns an
   * {@link AllotmentReservation} on success (caller must resolve it via
   * `commit()` or `cancel()`); returns `undefined` if no slot is available.
   * Reserved slots count against admission for concurrent acquires, so the
   * partition never over-admits during the speculative window.
   */
  tryReserveAllotment(
    context: ContextT,
    state: LimiterState,
  ): AllotmentReservation | undefined {
    const partition = this.resolvePartition(context);

    return state.inflight >= state.limit
      ? partition.tryReserveAtSaturation()
      : partition.tryReserveWithinBurst();
  }

  onAllotmentReleased(context: ContextT): void {
    this.resolvePartition(context).release();
  }

  onLimitChanged(_oldLimit: number, newLimit: number): void {
    const shares = apportionGlobalLimit(
      newLimit,
      this.orderedPartitions.map((partition) => partition.percent),
    );
    this.orderedPartitions.forEach((partition, i) => {
      partition.updateLimitAtGlobalSaturation(newLimit, shares[i]!);
    });
  }

  /**
   * Returns a snapshot of the given partition's current state.
   * Useful for debugging/monitoring/logging.
   */
  getPartition(name: PartitionName) {
    const partition = this.knownPartitions.get(name);
    if (!partition) {
      return undefined;
    }
    return {
      name: partition.name,
      percent: partition.percent,
      burstMode: partition.burstMode,
      limitAtGlobalSaturation: partition.limitAtGlobalSaturation,
      inFlight: partition.inFlight,
      reserved: partition.reserved,
      isLimitAtGlobalSaturationExceeded:
        partition.isLimitAtGlobalSaturationExceeded,
    };
  }

  private resolvePartition(context: ContextT) {
    const name = this.partitionResolver(context);
    if (name != null) {
      const partition = this.knownPartitions.get(name);
      if (partition) {
        return partition;
      }
    }
    return this.unknownPartition;
  }
}

/**
 * Absorbs floating-point error in `limit * percent`, so that (for example)
 * `3 * 0.1` floors to 0 and `10 * 0.3` floors to 3, not to 2.
 */
const QUOTA_EPSILON = 1e-9;

/**
 * Splits `floor(globalLimit * sum(percents))` whole slots among partitions by
 * the largest-remainder method. Each partition gets the floor of its quota,
 * then the leftover slots go one each to the largest fractional remainders.
 * A tie goes to the lower index. The result never sums to more than the
 * global limit.
 */
export function apportionGlobalLimit(
  globalLimit: number,
  percents: readonly number[],
): number[] {
  const limit = Math.max(0, Math.floor(globalLimit));
  const quotas = percents.map((percent) => limit * percent);
  const floors = quotas.map((quota) => Math.floor(quota + QUOTA_EPSILON));
  const total = Math.min(
    limit,
    Math.floor(quotas.reduce((sum, quota) => sum + quota, 0) + QUOTA_EPSILON),
  );
  const leftover = total - floors.reduce((sum, floor) => sum + floor, 0);
  if (leftover <= 0) {
    return floors;
  }

  const winners = new Set(
    quotas
      .map((quota, index) => ({ index, remainder: quota - floors[index]! }))
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
      .slice(0, leftover)
      .map(({ index }) => index),
  );
  return floors.map((floor, index) => (winners.has(index) ? floor + 1 : floor));
}

class Partition<PartitionName extends string = string> {
  public readonly name: PartitionName;
  public readonly percent: number;
  public readonly burstMode:
    | { kind: "unbounded" }
    | { kind: "capped"; maxBurstMultiplier: number }
    | { kind: "none" };
  public readonly inflightDistribution: DistributionMetric;
  public readonly limitAtGlobalSaturationGauge: Gauge;

  private _inflight = 0;
  private _reserved = 0;
  private _limitAtGlobalSaturation: number;
  private _globalLimit: number;

  constructor(init: {
    name: PartitionName;
    percent: number;
    burstMode:
      | { kind: "unbounded" }
      | { kind: "capped"; maxBurstMultiplier: number }
      | { kind: "none" };
    /** The global limit that the initial share was computed from. */
    initialGlobalLimit: number;
    /** Per-partition slot cap when the global limit is saturated. */
    initialLimitAtGlobalSaturation: number;
    registry: MetricRegistry;
  }) {
    if (init.percent < 0 || init.percent > 1) {
      throw new RangeError(
        "Partition percentage must be in the range [0.0, 1.0]",
      );
    }
    this.name = init.name;
    this.percent = init.percent;
    this.burstMode = init.burstMode;
    this._limitAtGlobalSaturation = init.initialLimitAtGlobalSaturation;
    this._globalLimit = init.initialGlobalLimit;

    if (
      this.burstMode.kind === "capped" &&
      this.burstMode.maxBurstMultiplier < 1.0
    ) {
      throw new RangeError("maxBurstMultiplier must be >= 1.0");
    }

    const registry = init.registry;
    this.inflightDistribution = registry.distribution(MetricIds.INFLIGHT_NAME, {
      [PARTITION_TAG_NAME]: this.name,
    });
    this.limitAtGlobalSaturationGauge = registry.gauge(
      MetricIds.PARTITION_LIMIT_NAME,
      { [PARTITION_TAG_NAME]: this.name },
    );
  }

  /**
   * Stores this partition's share of a new global limit. The strategy computes
   * every partition's share together with {@link apportionGlobalLimit}, so the
   * shares never sum to more than the global limit.
   */
  updateLimitAtGlobalSaturation(
    totalGlobalLimit: number,
    limitAtGlobalSaturation: number,
  ): void {
    this._globalLimit = totalGlobalLimit;
    this._limitAtGlobalSaturation = limitAtGlobalSaturation;
    this.limitAtGlobalSaturationGauge.record(this._limitAtGlobalSaturation);
  }

  get limitAtGlobalSaturation(): number {
    return this._limitAtGlobalSaturation;
  }

  get isLimitAtGlobalSaturationExceeded(): boolean {
    return this._inflight >= this._limitAtGlobalSaturation;
  }

  tryReserveWithinBurst(): AllotmentReservation | undefined {
    return this.occupied >= this.burstCapBelowGlobalSaturation()
      ? undefined
      : this.makeReservation();
  }

  tryReserveAtSaturation(): AllotmentReservation | undefined {
    return this.occupied >= this._limitAtGlobalSaturation
      ? undefined
      : this.makeReservation();
  }

  /**
   * Bumps `_reserved` and returns a receipt whose `commit()` / `cancel()`
   * will undo the reservation exactly once. The receipt closes over `this`,
   * so callers don't need to know which partition issued it.
   */
  private makeReservation(): AllotmentReservation {
    this._reserved++;
    return new AllotmentReservation(
      () => {
        this._reserved--;
        this._inflight++;
        this.inflightDistribution.addSample(this._inflight);
      },
      () => {
        this._reserved--;
      },
    );
  }

  release(): void {
    this._inflight--;
  }

  get inFlight(): number {
    return this._inflight;
  }

  get reserved(): number {
    return this._reserved;
  }

  /**
   * Total occupied slots = committed inflight + speculative reservations.
   * Used for admission decisions so the partition never over-admits while
   * speculative reservations are pending.
   */
  private get occupied(): number {
    return this._inflight + this._reserved;
  }

  private burstCapBelowGlobalSaturation(): number {
    if (this.burstMode.kind === "unbounded") {
      return Number.POSITIVE_INFINITY;
    }

    // A partition with a nonzero percent may always use one slot of global
    // slack. Its share can round to 0 at a small global limit, and without
    // this floor a `capped` or `none` partition could then never run.
    const slackFloor = this.percent > 0 ? 1 : 0;

    if (this.burstMode.kind === "none") {
      return Math.max(slackFloor, this._limitAtGlobalSaturation);
    }

    // Uses the unrounded share, so the cap does not jump with share rounding.
    return Math.max(
      slackFloor,
      this._limitAtGlobalSaturation,
      Math.ceil(
        this._globalLimit * this.percent * this.burstMode.maxBurstMultiplier -
          QUOTA_EPSILON,
      ),
    );
  }

  toString(): string {
    return `Partition [pct=${this.percent}, limitAtGlobalSaturation=${this._limitAtGlobalSaturation}, inflight=${this._inflight}, reserved=${this._reserved}]`;
  }
}
