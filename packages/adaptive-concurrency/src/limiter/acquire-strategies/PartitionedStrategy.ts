import type { AcquireStrategy, LimiterState } from "../../Limiter.js";
import type {
  DistributionMetric,
  GaugeMetric,
  MetricRegistry,
} from "../../MetricRegistry.js";
import { MetricIds, NoopMetricRegistry } from "../../MetricRegistry.js";

const PARTITION_TAG_NAME = "partition";

export type PartitionConfig = {
  /**
   * Percentage of the total limit guaranteed to this partition. Must be in
   * [0.0, 1.0].
   */
  percent: number;
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
 * - If `globalInflight < globalLimit`, the request is admitted regardless of
 *   its partition's current limitAtGlobalSaturation usage (bursting while slack
 *   exists).
 *
 * - If `globalInflight >= globalLimit`, admission is checked against the
 *   resolved partition's limitAtGlobalSaturation only (`tryAcquire` on that
 *   partition).
 *
 * Requests resolving to no configured partition use an internal `unknown`
 * partition. Unknown requests can use slack below global saturation, but are
 * always rejected at saturation.
 *
 * Examples (global limit = 10, A=50%, B=50% => limitsAtGlobalSaturation: A=5,
 * B=5):
 * - **Bursting:** A can reach inflight 10 while B is 0 (below-saturation
 *   admissions do not enforce per-partition limits at global saturation).
 *
 * - **Limit-at-global-saturation catch-up at saturation:** if A=10 and B=0,
 *   then B requests can still be admitted up to B=5 via `tryAcquire`, so global
 *   inflight can temporarily reach 15.
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
 */
export class PartitionedStrategy<
  ContextT,
  PartitionName extends string = string,
> implements AcquireStrategy<ContextT> {
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
      throw new Error("Sum of partition percentages must be <= 1.0");
    }

    this.partitionResolver = options.partitionResolver;

    this.knownPartitions = new Map(
      partitionEntries.map(([name, cfg]) => [
        name,
        new Partition({
          name,
          percent: cfg.percent,
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
      // Java never calls updateLimit on unknown; limitAtGlobalSaturation stays
      // 0 so
      // tryAcquire always fails at global cap.
      initialLimitAtGlobalSaturation: 0,
      registry,
    });
  }

  tryAcquireAllotment(context: ContextT, state: LimiterState): boolean {
    const partition = this.resolvePartition(context);

    if (state.inflight >= state.limit) {
      return partition.tryAcquire();
    }
    partition.acquire();
    return true;
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
      limitAtGlobalSaturation: partition.limitAtGlobalSaturation,
      inFlight: partition.inFlight,
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
  public readonly inflightDistribution: DistributionMetric;
  public readonly limitAtGlobalSaturationGauge: GaugeMetric;

  private _inflight = 0;
  private _limitAtGlobalSaturation: number;

  constructor(init: {
    name: PartitionName;
    percent: number;
    /** Per-partition slot cap when the global limit is saturated. */
    initialLimitAtGlobalSaturation: number;
    registry: MetricRegistry;
  }) {
    if (init.percent < 0 || init.percent > 1) {
      throw new Error("Partition percentage must be in the range [0.0, 1.0]");
    }
    this.name = init.name;
    this.percent = init.percent;
    this._limitAtGlobalSaturation = init.initialLimitAtGlobalSaturation;

    const registry = init.registry;
    this.inflightDistribution = registry.distribution(
      MetricIds.INFLIGHT_NAME,
      PARTITION_TAG_NAME,
      this.name,
    );
    this.limitAtGlobalSaturationGauge = registry.gauge(
      MetricIds.PARTITION_LIMIT_NAME,
      () => this._limitAtGlobalSaturation,
      PARTITION_TAG_NAME,
      this.name,
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
  }

  get limitAtGlobalSaturation(): number {
    return this._limitAtGlobalSaturation;
  }

  get isLimitAtGlobalSaturationExceeded(): boolean {
    return this._inflight >= this._limitAtGlobalSaturation;
  }

  acquire(): void {
    this._inflight++;
    this.inflightDistribution.addSample(this._inflight);
  }

  tryAcquire(): boolean {
    if (this._inflight < this._limitAtGlobalSaturation) {
      this._inflight++;
      this.inflightDistribution.addSample(this._inflight);
      return true;
    }
    return false;
  }

  release(): void {
    this._inflight--;
  }

  get inFlight(): number {
    return this._inflight;
  }

  toString(): string {
    return `Partition [pct=${this.percent}, limitAtGlobalSaturation=${this._limitAtGlobalSaturation}, inflight=${this._inflight}]`;
  }
}
