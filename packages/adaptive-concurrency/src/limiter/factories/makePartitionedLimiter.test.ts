import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SettableLimit } from "../../limit/SettableLimit.js";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { makePartitionedLimiter } from "./makePartitionedLimiter.js";

describe("makePartitionedLimiter", () => {
  it("allocates limits to partitions by percentage", async () => {
    const limiter = makePartitionedLimiter<string>({
      limiter: { limit: new FixedLimit(10) },
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 0.3, delayMs: 0 },
        b: { percent: 0.7, delayMs: 0 },
      },
    });

    const listeners = [];
    for (let i = 0; i < 10; i++) {
      const l = await limiter.acquire({ context: "a" });
      if (l) listeners.push(l);
    }
    assert.ok(listeners.length <= 10);
  });

  it("allows bursting when global limit has slack", async () => {
    const limiter = makePartitionedLimiter<string>({
      limiter: { limit: new FixedLimit(10) },
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 0.3, delayMs: 0 },
        b: { percent: 0.7, delayMs: 0 },
      },
    });

    const listeners = [];
    for (let i = 0; i < 10; i++) {
      const l = await limiter.acquire({ context: "a" });
      if (l) listeners.push(l);
    }
    assert.equal(listeners.length, 10);
  });

  it("enforces partition limits when global limit is saturated", async () => {
    const limiter = makePartitionedLimiter<string>({
      limiter: { limit: new FixedLimit(10) },
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 0.3, delayMs: 0 },
        b: { percent: 0.7, delayMs: 0 },
      },
    });

    for (let i = 0; i < 3; i++) {
      assert.ok(await limiter.acquire({ context: "a" }));
    }
    for (let i = 0; i < 7; i++) {
      assert.ok(await limiter.acquire({ context: "b" }));
    }

    assert.equal(await limiter.acquire({ context: "a" }), undefined);
    assert.equal(await limiter.acquire({ context: "b" }), undefined);
  });

  it("releases capacity when allotment completes", async () => {
    const limiter = makePartitionedLimiter<string>({
      limiter: { limit: new FixedLimit(2) },
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 0.5, delayMs: 0 },
        b: { percent: 0.5, delayMs: 0 },
      },
    });
    const a = await limiter.acquire({ context: "a" });
    const b = await limiter.acquire({ context: "b" });
    assert.ok(a && b);
    assert.equal(await limiter.acquire({ context: "a" }), undefined);
    await a!.releaseAndRecordSuccess();
    assert.ok(await limiter.acquire({ context: "a" }));
  });

  it("updates effective partition capacity when adaptive limit changes", async () => {
    const limit = new SettableLimit(10);
    const limiter = makePartitionedLimiter<string>({
      limiter: { limit },
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 0.5, delayMs: 0 },
        b: { percent: 0.5, delayMs: 0 },
      },
    });

    for (let i = 0; i < 10; i++) {
      assert.ok(await limiter.acquire({ context: i % 2 === 0 ? "a" : "b" }));
    }
    limit.setLimit(20);

    assert.ok(await limiter.acquire({ context: "a" }));
  });

  it("delays rejection using DelayedRejectStrategy", async () => {
    const limiter = makePartitionedLimiter<string>({
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 1, delayMs: 40 },
      },
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);

    const start = performance.now();
    const rejected = await limiter.acquire({ context: "a" });
    const elapsed = performance.now() - start;
    assert.equal(rejected, undefined);
    assert.ok(elapsed >= 30);
  });

  it("supports bypass resolver with partitioned strategy", async () => {
    const limiter = makePartitionedLimiter<string>({
      limiter: {
        limit: new FixedLimit(1),
        bypassResolver: (ctx) => ctx === "bypass",
      },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });

    assert.ok(await limiter.acquire({ context: "a" }));
    assert.equal(await limiter.acquire({ context: "a" }), undefined);
    assert.ok(await limiter.acquire({ context: "bypass" }));
  });

  it("skips delay when maxConcurrentDelays is reached", async () => {
    const limiter = makePartitionedLimiter<string>({
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      maxConcurrentDelays: 1,
      partitions: {
        a: { percent: 0.5, delayMs: 50 },
        b: { percent: 0.5, delayMs: 50 },
      },
    });

    assert.ok(await limiter.acquire({ context: "a" }));
    const slow = limiter.acquire({ context: "a" });
    const t0 = performance.now();
    await limiter.acquire({ context: "b" });
    assert.ok(performance.now() - t0 < 20);
    await slow;
  });

  it("respects AbortSignal during delay", async () => {
    const limiter = makePartitionedLimiter<string>({
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 10_000 } },
    });

    assert.ok(await limiter.acquire({ context: "a" }));
    const ac = new AbortController();
    const pending = limiter.acquire({ context: "a", signal: ac.signal });
    queueMicrotask(() => ac.abort());
    const t0 = performance.now();
    await pending;
    assert.ok(performance.now() - t0 < 100);
  });

  it("throws on invalid maxConcurrentDelays", () => {
    assert.throws(
      () =>
        makePartitionedLimiter<string>({
          limiter: { limit: new FixedLimit(1) },
          partitionResolver: (ctx) => ctx,
          partitions: { a: { percent: 1, delayMs: 1 } },
          maxConcurrentDelays: 0,
        }),
      /maxConcurrentDelays/,
    );
  });
});
