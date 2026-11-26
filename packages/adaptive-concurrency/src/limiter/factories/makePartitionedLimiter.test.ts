import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SettableLimit } from "../../limit/SettableLimit.js";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { makePartitionedLimiter } from "./makePartitionedLimiter.js";
import { isAllotmentUnavailableError } from "../../errors.js";
import type {
  AcquireOptions,
  AcquireResult,
  LimitAllotment,
} from "../../types/Strategy.js";

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
      const l = await acquireOk(limiter, { context: "a" });
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
      const l = await acquireOk(limiter, { context: "a" });
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
      await acquireOk(limiter, { context: "a" });
    }
    for (let i = 0; i < 7; i++) {
      await acquireOk(limiter, { context: "b" });
    }

    await assertUnavailable(limiter.acquire({ context: "a" }));
    await assertUnavailable(limiter.acquire({ context: "b" }));
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
    const a = await acquireOk(limiter, { context: "a" });
    const b = await acquireOk(limiter, { context: "b" });
    assert.ok(a && b);
    await assertUnavailable(limiter.acquire({ context: "a" }));
    await a!.releaseAndRecordSuccess();
    await acquireOk(limiter, { context: "a" });
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
      await acquireOk(limiter, { context: i % 2 === 0 ? "a" : "b" });
    }
    limit.setLimit(20);

    await acquireOk(limiter, { context: "a" });
  });

  it("delays rejection using DelayedRejectStrategy", async () => {
    const limiter = makePartitionedLimiter<string>({
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 1, delayMs: 40 },
      },
    });

    const first = await acquireOk(limiter, { context: "a" });
    assert.ok(first);

    const start = performance.now();
    await assertUnavailable(limiter.acquire({ context: "a" }));
    const elapsed = performance.now() - start;
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

    await acquireOk(limiter, { context: "a" });
    await assertUnavailable(limiter.acquire({ context: "a" }));
    await acquireOk(limiter, { context: "bypass" });
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

    await acquireOk(limiter, { context: "a" });
    const slow = limiter.acquire({ context: "a" });
    // At limit 1 the 50/50 split gives "a" the only slot and "b" a share of
    // 0, so "b" is rejected. The one delay slot is taken by `slow`, so the
    // rejection must skip its 50 ms delay.
    const t0 = performance.now();
    await assertUnavailable(limiter.acquire({ context: "b" }));
    assert.ok(performance.now() - t0 < 20);
    await assertUnavailable(slow);
  });

  it("respects AbortSignal during delay", async () => {
    const limiter = makePartitionedLimiter<string>({
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 10_000 } },
    });

    await acquireOk(limiter, { context: "a" });
    const ac = new AbortController();
    const pending = limiter.acquire({ context: "a", signal: ac.signal });
    queueMicrotask(() => ac.abort());
    const t0 = performance.now();
    await assert.rejects(pending, { name: "AbortError" });
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

async function acquireOk<C>(
  limiter: { acquire(options?: AcquireOptions<C>): AcquireResult },
  options?: AcquireOptions<C>,
): Promise<LimitAllotment> {
  const result = await limiter.acquire(options);
  assert.ok(result.ok, "expected an allotment");
  return result.value;
}

async function assertUnavailable(acquired: AcquireResult): Promise<void> {
  const result = await acquired;
  assert.equal(result.ok, false);
  assert.ok(isAllotmentUnavailableError(result.error));
}
