import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Limiter } from "../../Limiter.js";
import {
  apportionGlobalLimit,
  PartitionedStrategy,
  type PartitionConfig,
} from "./PartitionedStrategy.js";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { SettableLimit } from "../../limit/SettableLimit.js";
import {
  MetricIds,
  type Counter,
  type DistributionMetric,
  type Gauge,
  type MetricRegistry,
} from "../../MetricRegistry.js";
import { isAllotmentUnavailableError } from "../../errors.js";
import type {
  AcquireOptions,
  AcquireResult,
  LimitAllotment,
} from "../../types/Strategy.js";

function makeRecordingRegistry(): {
  registry: MetricRegistry;
  inflightSamplesByPartition: Map<string, number[]>;
} {
  const inflightSamplesByPartition = new Map<string, number[]>();
  const registry: MetricRegistry = {
    distribution(id, attributes): DistributionMetric {
      if (id === MetricIds.INFLIGHT_NAME) {
        const partition = attributes?.["partition"] ?? "<unknown>";
        const samples = inflightSamplesByPartition.get(partition) ?? [];
        inflightSamplesByPartition.set(partition, samples);
        return { addSample: (value: number) => samples.push(value) };
      }
      return { addSample() {} };
    },
    gauge(): Gauge {
      return { record() {} };
    },
    counter(): Counter {
      return { add() {} };
    },
  };
  return { registry, inflightSamplesByPartition };
}

function makePartitionedLimiter<
  ContextT,
  PartitionName extends string = string,
>(options: {
  limit: FixedLimit | SettableLimit;
  partitionResolver: (ctx: ContextT) => PartitionName | undefined;
  partitions: Record<PartitionName, PartitionConfig>;
  bypassResolver?: (ctx: ContextT) => boolean;
}) {
  const limitAlgo = options.limit;
  return new Limiter<ContextT>({
    limit: limitAlgo,
    bypassResolver: options.bypassResolver,
    acquireStrategy: new PartitionedStrategy<ContextT, PartitionName>({
      partitionResolver: options.partitionResolver,
      partitions: options.partitions,
      initialLimit: limitAlgo.currentLimit,
    }),
  });
}

/**
 * Acquires an allotment, or returns `undefined` when the limiter gives none.
 * For tests that count how many acquires a limiter admits.
 */
async function acquireOrUndefined<ContextT>(
  limiter: Limiter<ContextT>,
  options: AcquireOptions<ContextT>,
): Promise<LimitAllotment | undefined> {
  const result = await limiter.acquire(options);
  if (result.ok) return result.value;
  assert.ok(isAllotmentUnavailableError(result.error));
  return undefined;
}

describe("PartitionedStrategy", () => {
  it("should allocate limits to partitions based on percentage", async () => {
    const limiter = makePartitionedLimiter<string>({
      limit: new FixedLimit(10),
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 0.3 },
        b: { percent: 0.7 },
      },
    });

    const listeners = [];
    for (let i = 0; i < 10; i++) {
      const l = await acquireOrUndefined(limiter, { context: "a" });
      if (l) listeners.push(l);
    }

    assert.ok(listeners.length <= 10);
  });

  it("should allow excess capacity to be used by any partition (bursting)", async () => {
    const limiter = makePartitionedLimiter<string>({
      limit: new FixedLimit(10),
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 0.3 },
        b: { percent: 0.7 },
      },
    });

    const listeners = [];
    for (let i = 0; i < 10; i++) {
      const l = await acquireOrUndefined(limiter, { context: "a" });
      if (l) listeners.push(l);
    }

    assert.equal(
      listeners.length,
      10,
      "Should use full global limit when partition is alone",
    );
  });

  it("should cap burst when burstMode is capped", async () => {
    const limiter = makePartitionedLimiter<string>({
      limit: new FixedLimit(10),
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: {
          percent: 0.3,
          burstMode: { kind: "capped", maxBurstMultiplier: 2.0 },
        },
        b: { percent: 0.7 },
      },
    });

    const listeners = [];
    for (let i = 0; i < 10; i++) {
      const l = await acquireOrUndefined(limiter, { context: "a" });
      if (l) listeners.push(l);
    }

    // limitAtGlobalSaturation(a)=3, capped burst=ceil(10*0.3*2)=6
    assert.equal(
      listeners.length,
      6,
      "Burst should be capped by maxBurstMultiplier",
    );
  });

  it("should disallow burst when burstMode is none", async () => {
    const limiter = makePartitionedLimiter<string>({
      limit: new FixedLimit(10),
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 0.3, burstMode: { kind: "none" } },
        b: { percent: 0.7 },
      },
    });

    const listeners = [];
    for (let i = 0; i < 10; i++) {
      const l = await acquireOrUndefined(limiter, { context: "a" });
      if (l) listeners.push(l);
    }

    // limitAtGlobalSaturation(a)=3 and no extra burst.
    assert.equal(
      listeners.length,
      3,
      "No-burst mode should limit to guaranteed share even with global slack",
    );
  });

  it("should enforce partition limits when global limit is exceeded", async () => {
    const limiter = makePartitionedLimiter<string>({
      limit: new FixedLimit(10),
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 0.3 },
        b: { percent: 0.7 },
      },
    });

    const listeners = [];
    for (let i = 0; i < 3; i++) {
      const l = await acquireOk(limiter, { context: "a" });
      assert.ok(l, `Should acquire a[${i}]`);
      listeners.push(l!);
    }
    for (let i = 0; i < 7; i++) {
      const l = await acquireOk(limiter, { context: "b" });
      assert.ok(l, `Should acquire b[${i}]`);
      listeners.push(l!);
    }

    await assertUnavailable(
      limiter.acquire({ context: "a" }),
      "Should reject a when its partition limit is reached",
    );

    await assertUnavailable(
      limiter.acquire({ context: "b" }),
      "Should reject b when its partition limit is reached",
    );
  });

  it("should release capacity when allotment completes", async () => {
    const limiter = makePartitionedLimiter<string>({
      limit: new FixedLimit(2),
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 0.5 },
        b: { percent: 0.5 },
      },
    });

    const l1 = await acquireOk(limiter, { context: "a" });
    const l2 = await acquireOk(limiter, { context: "b" });
    assert.ok(l1 && l2);

    await assertUnavailable(limiter.acquire({ context: "a" }));

    await l1.releaseAndRecordSuccess();

    const l3 = await acquireOk(limiter, { context: "a" });
    assert.ok(l3, "Should acquire after release");
  });

  it("should update partition limits when total limit changes", async () => {
    const limit = new SettableLimit(10);
    const limiter = makePartitionedLimiter<string>({
      limit,
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 0.5 },
        b: { percent: 0.5 },
      },
    });

    const listeners = [];
    for (let i = 0; i < 10; i++) {
      const l = await acquireOrUndefined(limiter, {
        context: i % 2 === 0 ? "a" : "b",
      });
      if (l) listeners.push(l);
    }
    assert.equal(listeners.length, 10);

    limit.setLimit(20);

    const extra = await acquireOk(limiter, { context: "a" });
    assert.ok(extra, "Should acquire after limit increase");
  });

  it("should support bypass with partitioned limiter", async () => {
    const limiter = makePartitionedLimiter<string>({
      limit: new FixedLimit(1),
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 1.0 },
      },
      bypassResolver: (ctx) => ctx === "bypass",
    });

    const l1 = await acquireOk(limiter, { context: "a" });
    assert.ok(l1);

    await assertUnavailable(limiter.acquire({ context: "a" }));

    const bypass = await acquireOk(limiter, { context: "bypass" });
    assert.ok(bypass, "Bypass should work when limit exceeded");
  });

  it("should expose partition state via the strategy", () => {
    const strategy = new PartitionedStrategy<string>({
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: {
          percent: 1.0,
          burstMode: { kind: "capped", maxBurstMultiplier: 3 },
        },
      },
      initialLimit: 2,
    });

    new Limiter<string>({
      limit: new FixedLimit(2),
      acquireStrategy: strategy,
    });

    const partition = strategy.getPartition("a");
    assert.equal(partition?.name, "a");
    assert.deepEqual(partition?.burstMode, {
      kind: "capped",
      maxBurstMultiplier: 3,
    });
  });

  describe("apportionGlobalLimit", () => {
    it("splits the limit by largest remainder, ties to the earlier partition", () => {
      const percents = [0.6, 0.2, 0.2];
      assert.deepEqual(apportionGlobalLimit(0, percents), [0, 0, 0]);
      assert.deepEqual(apportionGlobalLimit(1, percents), [1, 0, 0]);
      assert.deepEqual(apportionGlobalLimit(2, percents), [1, 1, 0]);
      assert.deepEqual(apportionGlobalLimit(3, percents), [2, 1, 0]);
      assert.deepEqual(apportionGlobalLimit(5, percents), [3, 1, 1]);
      assert.deepEqual(apportionGlobalLimit(10, percents), [6, 2, 2]);
    });

    it("does not lose or gain a slot to floating-point error", () => {
      assert.deepEqual(apportionGlobalLimit(10, [0.3, 0.7]), [3, 7]);
      assert.deepEqual(apportionGlobalLimit(10, [0.1, 0.2]), [1, 2]);
      assert.deepEqual(apportionGlobalLimit(3, [0.1, 0.1, 0.1]), [0, 0, 0]);
    });

    it("gives a tie to the lower index when remainders differ only by float error", () => {
      // 4 * 0.6 - 2 is 0.3999999999999999 and 4 * 0.1 is 0.4, but the
      // remainders are equal, so the first partition wins the tie.
      assert.deepEqual(apportionGlobalLimit(4, [0.6, 0.3, 0.1]), [3, 1, 0]);
      assert.deepEqual(apportionGlobalLimit(4, [0.1, 0.3, 0.6]), [1, 1, 2]);
    });

    it("leaves unassigned the part of the limit that no partition claims", () => {
      assert.deepEqual(apportionGlobalLimit(10, [0.25, 0.25]), [3, 2]);
      assert.deepEqual(apportionGlobalLimit(1, [0.3, 0.3]), [0, 0]);
    });

    it("never sums above the limit and keeps each share within 1 of its quota", () => {
      const percentSets = [
        [0.6, 0.2, 0.2],
        [0.5, 0.5],
        [1 / 3, 1 / 3, 1 / 3],
        [0.9, 0.05, 0.05],
        [0.45, 0.3, 0.15],
        [0, 1],
      ];
      for (const percents of percentSets) {
        for (let limit = 0; limit <= 200; limit++) {
          const shares = apportionGlobalLimit(limit, percents);
          const total = shares.reduce((sum, share) => sum + share, 0);
          const claimed = percents.reduce((sum, percent) => sum + percent, 0);
          assert.ok(total <= limit, `limit ${limit}, ${percents}: ${shares}`);
          assert.equal(
            total,
            Math.floor(limit * claimed + 1e-9),
            `limit ${limit}, ${percents}: ${shares}`,
          );
          shares.forEach((share, i) => {
            assert.ok(
              Math.abs(share - limit * percents[i]!) < 1 + 1e-9,
              `limit ${limit}, ${percents}: ${shares}`,
            );
          });
        }
      }
    });
  });

  describe("small global limits", () => {
    const priorityPartitions = {
      interactive: { percent: 0.6 },
      background: {
        percent: 0.2,
        burstMode: { kind: "capped", maxBurstMultiplier: 3 },
      },
      bulk: {
        percent: 0.2,
        burstMode: { kind: "capped", maxBurstMultiplier: 3 },
      },
    } satisfies Record<string, PartitionConfig>;

    it("admits nothing once the global limit drops to 0", async () => {
      const limit = new SettableLimit(10);
      const limiter = makePartitionedLimiter<string>({
        limit,
        partitionResolver: (ctx) => ctx,
        partitions: priorityPartitions,
      });

      limit.setLimit(0);

      for (const context of ["interactive", "background", "bulk", "other"]) {
        assert.equal(
          await acquireOrUndefined(limiter, { context }),
          undefined,
          `${context} must be rejected at a global limit of 0`,
        );
      }
    });

    it("keeps the saturation slot of a limit of 1 for the first partition", async () => {
      const limiter = makePartitionedLimiter<string>({
        limit: new FixedLimit(1),
        partitionResolver: (ctx) => ctx,
        partitions: priorityPartitions,
      });

      // An idle limiter lets a low-priority partition use the one slack slot.
      const bulk = await acquireOrUndefined(limiter, { context: "bulk" });
      assert.ok(bulk, "bulk may use the slack slot, though its share is 0");

      // At saturation, only a partition with a nonzero share is admitted.
      const interactive = await acquireOrUndefined(limiter, {
        context: "interactive",
      });
      assert.ok(
        interactive,
        "interactive's share of 1 admits it at saturation",
      );
      assert.equal(
        await acquireOrUndefined(limiter, { context: "background" }),
        undefined,
      );
      assert.equal(
        await acquireOrUndefined(limiter, { context: "bulk" }),
        undefined,
      );
    });

    it("gives a share-0 partition one slot of slack in every burst mode", async () => {
      for (const burstMode of [
        { kind: "none" },
        { kind: "capped", maxBurstMultiplier: 1 },
      ] satisfies PartitionConfig["burstMode"][]) {
        const limiter = makePartitionedLimiter<string>({
          limit: new FixedLimit(2),
          partitionResolver: (ctx) => ctx,
          partitions: {
            main: { percent: 0.9 },
            minor: { percent: 0.1, burstMode },
          },
        });

        const first = await acquireOrUndefined(limiter, { context: "minor" });
        assert.ok(first, `${burstMode.kind}: minor gets one slack slot`);
        assert.equal(
          await acquireOrUndefined(limiter, { context: "minor" }),
          undefined,
          `${burstMode.kind}: minor gets only one slack slot`,
        );
      }
    });

    it("breaks ties in the enumeration order of partitions, not their declaration order", async () => {
      // JavaScript enumerates integer-like keys first, in ascending order, so
      // "1" comes before "2" although "2" is declared first.
      const strategy = new PartitionedStrategy<string>({
        initialLimit: 1,
        partitionResolver: (ctx) => ctx,
        partitions: { "2": { percent: 0.5 }, "1": { percent: 0.5 } },
      });

      assert.equal(strategy.getPartition("1")?.limitAtGlobalSaturation, 1);
      assert.equal(strategy.getPartition("2")?.limitAtGlobalSaturation, 0);
    });

    it("caps a capped burst from the unrounded share", async () => {
      const limiter = makePartitionedLimiter<string>({
        limit: new FixedLimit(10),
        partitionResolver: (ctx) => ctx,
        partitions: {
          main: { percent: 0.85 },
          minor: {
            percent: 0.15,
            burstMode: { kind: "capped", maxBurstMultiplier: 2 },
          },
        },
      });

      const acquired = [];
      for (let i = 0; i < 10; i++) {
        const allotment = await acquireOrUndefined(limiter, {
          context: "minor",
        });
        if (allotment) acquired.push(allotment);
      }

      // share(minor) = 1 or 2 depending on rounding; the cap is
      // ceil(10 * 0.15 * 2) = 3 either way.
      assert.equal(acquired.length, 3);
    });
  });

  describe("two-phase reservation API", () => {
    it("does not emit an inflight distribution sample on cancelled reservations", async () => {
      const { registry, inflightSamplesByPartition } = makeRecordingRegistry();
      const strategy = new PartitionedStrategy<string>({
        initialLimit: 4,
        partitionResolver: (ctx) => ctx,
        partitions: { a: { percent: 1.0 } },
        metricRegistry: registry,
      });

      const fakeState = { limit: 4, inflight: 0 };
      const reservation = strategy.tryReserveAllotment("a", fakeState);
      assert.ok(reservation, "reservation should be granted");
      assert.equal(
        strategy.getPartition("a")?.inFlight,
        0,
        "reserved-but-not-committed must not advance committed inflight",
      );
      assert.equal(strategy.getPartition("a")?.reserved, 1);

      await reservation.cancel();
      assert.equal(strategy.getPartition("a")?.reserved, 0);
      assert.equal(strategy.getPartition("a")?.inFlight, 0);
      assert.deepEqual(
        inflightSamplesByPartition.get("a") ?? [],
        [],
        "cancelled reservation must not emit any inflight distribution sample",
      );
    });

    it("emits exactly one inflight distribution sample on a committed reservation", async () => {
      const { registry, inflightSamplesByPartition } = makeRecordingRegistry();
      const strategy = new PartitionedStrategy<string>({
        initialLimit: 4,
        partitionResolver: (ctx) => ctx,
        partitions: { a: { percent: 1.0 } },
        metricRegistry: registry,
      });

      const fakeState = { limit: 4, inflight: 0 };
      const reservation = strategy.tryReserveAllotment("a", fakeState);
      assert.ok(reservation);
      await reservation.commit();

      assert.equal(strategy.getPartition("a")?.inFlight, 1);
      assert.equal(strategy.getPartition("a")?.reserved, 0);
      assert.deepEqual(inflightSamplesByPartition.get("a"), [1]);
    });

    it("counts reserved slots against admission so reservations cannot over-admit", async () => {
      const strategy = new PartitionedStrategy<string>({
        initialLimit: 2,
        partitionResolver: (ctx) => ctx,
        partitions: { a: { percent: 1.0, burstMode: { kind: "none" } } },
      });
      const saturatedState = { limit: 2, inflight: 2 };

      const r1 = strategy.tryReserveAllotment("a", saturatedState);
      const r2 = strategy.tryReserveAllotment("a", saturatedState);
      assert.ok(r1);
      assert.ok(r2);
      assert.equal(
        strategy.tryReserveAllotment("a", saturatedState),
        undefined,
        "third concurrent reservation must be rejected — reserved slots count against limit-at-saturation",
      );

      await r1.cancel();
      assert.ok(
        strategy.tryReserveAllotment("a", saturatedState),
        "after a cancel, the freed slot is available again",
      );
    });

    it("treats a cancelled reservation as a no-op for subsequent acquires", async () => {
      const strategy = new PartitionedStrategy<string>({
        initialLimit: 1,
        partitionResolver: (ctx) => ctx,
        partitions: { a: { percent: 1.0, burstMode: { kind: "none" } } },
      });
      const saturatedState = { limit: 1, inflight: 1 };

      const reservation = strategy.tryReserveAllotment("a", saturatedState);
      assert.ok(reservation);
      await reservation.cancel();

      assert.equal(strategy.getPartition("a")?.inFlight, 0);
      assert.equal(strategy.getPartition("a")?.reserved, 0);
      assert.ok(
        strategy.tryReserveAllotment("a", saturatedState),
        "freed slot is available to a fresh reservation",
      );
    });

    it("makes commit/cancel idempotent on a single reservation", async () => {
      const { registry, inflightSamplesByPartition } = makeRecordingRegistry();
      const strategy = new PartitionedStrategy<string>({
        initialLimit: 4,
        partitionResolver: (ctx) => ctx,
        partitions: { a: { percent: 1.0 } },
        metricRegistry: registry,
      });

      const fakeState = { limit: 4, inflight: 0 };
      const reservation = strategy.tryReserveAllotment("a", fakeState);
      assert.ok(reservation);

      await reservation.commit();
      await reservation.commit();
      await reservation.cancel();

      assert.equal(strategy.getPartition("a")?.inFlight, 1);
      assert.equal(strategy.getPartition("a")?.reserved, 0);
      assert.deepEqual(
        inflightSamplesByPartition.get("a"),
        [1],
        "duplicate commit/cancel calls must not emit additional samples or corrupt counts",
      );
    });
  });
});

async function acquireOk<C>(
  limiter: { acquire(options?: AcquireOptions<C>): AcquireResult },
  options?: AcquireOptions<C>,
): Promise<LimitAllotment> {
  const result = await limiter.acquire(options);
  assert.ok(result.ok, "expected an allotment");
  return result.value;
}

async function assertUnavailable(
  acquired: AcquireResult,
  message?: string,
): Promise<void> {
  const result = await acquired;
  assert.equal(result.ok, false, message);
  assert.ok(isAllotmentUnavailableError(result.error));
}
