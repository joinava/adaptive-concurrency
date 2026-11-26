import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { makePartitionedLifoBlockingLimiter } from "./makePartitionedLifoBlockingLimiter.js";
import { isAllotmentUnavailableError } from "../../errors.js";
import type {
  AcquireOptions,
  AcquireResult,
  LimitAllotment,
} from "../../types/Strategy.js";

describe("makePartitionedLifoBlockingLimiter", () => {
  it("acquires immediately when under limit", async () => {
    const limiter = makePartitionedLifoBlockingLimiter<string>({
      limiter: { limit: new FixedLimit(2) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });
    await acquireOk(limiter, { context: "a" });
  });

  it("uses LIFO wake-up", async () => {
    const limiter = makePartitionedLifoBlockingLimiter<string>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 20 } },
    });

    const first = await acquireOk(limiter, { context: "a" });
    assert.ok(first);

    const order: string[] = [];
    const oldWaiter = limiter.acquire({ context: "a" }).then(async (a) => {
      if (a.ok) {
        order.push("old");
        await a.value.releaseAndRecordSuccess();
      }
    });
    const newWaiter = limiter.acquire({ context: "a" }).then(async (a) => {
      if (a.ok) {
        order.push("new");
        await a.value.releaseAndRecordSuccess();
      }
    });

    setTimeout(() => first!.releaseAndRecordSuccess(), 60);
    await Promise.all([oldWaiter, newWaiter]);

    assert.deepEqual(order, ["new", "old"]);
  });

  it("resolves { ok: false } when backlog timeout is reached", async () => {
    const limiter = makePartitionedLifoBlockingLimiter<string>({
      backlogTimeout: 50,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });

    await acquireOk(limiter, { context: "a" });
    const start = performance.now();
    await assertUnavailable(limiter.acquire({ context: "a" }));
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 35);
  });

  it("resolves { ok: false } when backlog size is exceeded", async () => {
    const limiter = makePartitionedLifoBlockingLimiter<string>({
      backlogSize: 1,
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });

    const first = await acquireOk(limiter, { context: "a" });
    assert.ok(first);

    const inBacklog = limiter.acquire({ context: "a" });
    await assertUnavailable(limiter.acquire({ context: "a" }));

    await first!.releaseAndRecordSuccess();
    assert.ok((await inBacklog).ok);
  });

  it("rejects with the abort reason when aborted while waiting", async () => {
    const limiter = makePartitionedLifoBlockingLimiter<string>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });

    await acquireOk(limiter, { context: "a" });
    const ac = new AbortController();
    const waiting = limiter.acquire({ context: "a", signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(waiting, { name: "AbortError" });
  });

  it("applies partition delay before entering blocking queue", async () => {
    const limiter = makePartitionedLifoBlockingLimiter<string>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 35 } },
    });

    const first = await acquireOk(limiter, { context: "a" });
    assert.ok(first);

    const waiting = limiter.acquire({ context: "a" });
    setTimeout(() => first!.releaseAndRecordSuccess(), 10);

    const start = performance.now();
    const second = await waiting;
    const elapsed = performance.now() - start;
    assert.ok(second.ok);
    assert.ok(elapsed >= 25);
  });

  it("throws when backlogTimeout exceeds max timeout", () => {
    assert.throws(
      () =>
        makePartitionedLifoBlockingLimiter<string>({
          backlogTimeout: 60 * 60 * 1000 + 1,
          limiter: { limit: new FixedLimit(1) },
          partitionResolver: (ctx) => ctx,
          partitions: { a: { percent: 1, delayMs: 0 } },
        }),
      /Timeout cannot be greater than/,
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
