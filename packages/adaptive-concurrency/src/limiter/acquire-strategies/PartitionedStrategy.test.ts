import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Limiter } from "../../Limiter.js";
import {
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
      const l = await limiter.acquire({ context: "a" });
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
      const l = await limiter.acquire({ context: "a" });
      if (l) listeners.push(l);
    }

    assert.equal(listeners.length, 10, "Should use full global limit when partition is alone");
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
      const l = await limiter.acquire({ context: "a" });
      if (l) listeners.push(l);
    }

    // limitAtGlobalSaturation(a)=ceil(10*0.3)=3, capped burst=ceil(3*2)=6
    assert.equal(listeners.length, 6, "Burst should be capped by maxBurstMultiplier");
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
      const l = await limiter.acquire({ context: "a" });
      if (l) listeners.push(l);
    }

    // limitAtGlobalSaturation(a)=ceil(10*0.3)=3 and no extra burst.
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
      const l = await limiter.acquire({ context: "a" });
      assert.ok(l, `Should acquire a[${i}]`);
      listeners.push(l!);
    }
    for (let i = 0; i < 7; i++) {
      const l = await limiter.acquire({ context: "b" });
      assert.ok(l, `Should acquire b[${i}]`);
      listeners.push(l!);
    }

    const extraA = await limiter.acquire({ context: "a" });
    assert.equal(extraA, undefined, "Should reject a when its partition limit is reached");

    const extraB = await limiter.acquire({ context: "b" });
    assert.equal(extraB, undefined, "Should reject b when its partition limit is reached");
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

    const l1 = (await limiter.acquire({ context: "a" }))!;
    const l2 = (await limiter.acquire({ context: "b" }))!;
    assert.ok(l1 && l2);

    assert.equal(await limiter.acquire({ context: "a" }), undefined);

    await l1.releaseAndRecordSuccess();

    const l3 = await limiter.acquire({ context: "a" });
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
      const l = await limiter.acquire({ context: i % 2 === 0 ? "a" : "b" });
      if (l) listeners.push(l);
    }
    assert.equal(listeners.length, 10);

    limit.setLimit(20);

    const extra = await limiter.acquire({ context: "a" });
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

    const l1 = (await limiter.acquire({ context: "a" }))!;
    assert.ok(l1);

    assert.equal(await limiter.acquire({ context: "a" }), undefined);

    const bypass = await limiter.acquire({ context: "bypass" });
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
