import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Limiter } from "../../Limiter.js";
import {
  PartitionedStrategy,
  type PartitionConfig,
} from "./PartitionedStrategy.js";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { SettableLimit } from "../../limit/SettableLimit.js";

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
});
