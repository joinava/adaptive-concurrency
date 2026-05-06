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
   *   up to `ceil(limitAtGlobalSaturation * maxBurstMultiplier)`.
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
 * Named partitions get a configured percentage of the global limit. Each
 * percentage is converted to a per-partition **limitAtGlobalSaturation** used
 * only when the limiter is globally saturated: `limitAtGlobalSaturation =
 * max(1, ceil(globalLimit * percent))`.
 *
 * Admission policy:
 * - If `globalInflight < globalLimit`, admission is controlled by partition
 *   burst policy:
 *   - `unbounded` (default): always admit while global slack exists.
 *   - `capped`: admit up to
 *     `ceil(limitAtGlobalSaturation * maxBurstMultiplier)`.
 *   - `none`: admit only up to `limitAtGlobalSaturation`.
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
 * - Sum of limitsAtGlobalSaturation can exceed global limit due to rounding,
 *   and total concurrent acquires can substantially exceed global limit due to
 *   bursting. This is usually temporary as RTT rises and excess work is shed by
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

    this.knownPartitions = new Map(
      partitionEntries.map(([name, cfg]) => [
        name,
        new Partition({
          name,
          percent: cfg.percent,
          burstMode: cfg.burstMode ?? { kind: "unbounded" },
          initialLimitAtGlobalSaturation:
            partitionLimitAtGlobalSaturationForGlobal(
              initialLimit,
              cfg.percent,
            ),
          registry,
        }),
      ]),
    );

    this.unknownPartition = new Partition({
      name: "unknown",
      percent: 0,
      burstMode: { kind: "unbounded" },
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
    for (const [, partition] of this.knownPartitions) {
      partition.updateLimitAtGlobalSaturation(newLimit);
    }
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

function partitionLimitAtGlobalSaturationForGlobal(
  totalGlobalLimit: number,
  percent: number,
): number {
  return Math.max(1, Math.ceil(totalGlobalLimit * percent));
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

  constructor(init: {
    name: PartitionName;
    percent: number;
    burstMode:
      | { kind: "unbounded" }
      | { kind: "capped"; maxBurstMultiplier: number }
      | { kind: "none" };
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
   * Recompute this partition's limitAtGlobalSaturation from global limit.
   * Rounds up
   * and ensures at least 1 for non-zero **percent**; sums across partitions may
   * exceed the global limit.
   */
  updateLimitAtGlobalSaturation(totalGlobalLimit: number): void {
    this._limitAtGlobalSaturation = partitionLimitAtGlobalSaturationForGlobal(
      totalGlobalLimit,
      this.percent,
    );
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

    if (this.burstMode.kind === "none") {
      return this._limitAtGlobalSaturation;
    }

    return Math.max(
      this._limitAtGlobalSaturation,
      Math.ceil(
        this._limitAtGlobalSaturation * this.burstMode.maxBurstMultiplier,
      ),
    );
  }

  toString(): string {
    return `Partition [pct=${this.percent}, limitAtGlobalSaturation=${this._limitAtGlobalSaturation}, inflight=${this._inflight}, reserved=${this._reserved}]`;
  }
}
