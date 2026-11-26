import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { makePartitionedBlockingLimiter } from "./makePartitionedBlockingLimiter.js";
import { isAllotmentUnavailableError } from "../../errors.js";
import type { AcquireOptions, AcquireResult, LimitAllotment } from "../../types/Strategy.js";

describe("makePartitionedBlockingLimiter", () => {
  it("acquires immediately when under limit", async () => {
    const limiter = makePartitionedBlockingLimiter<string>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(2) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });
    await acquireOk(limiter, { context: "a" });
  });

  it("waits for capacity", async () => {
    const limiter = makePartitionedBlockingLimiter<string>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });

    const first = await acquireOk(limiter, { context: "a" });
    assert.ok(first);

    const waiting = limiter.acquire({ context: "a" });
    setTimeout(() => first!.releaseAndRecordSuccess(), 25);

    const second = await waiting;
    assert.ok(second.ok);
    await second.value.releaseAndRecordSuccess();
  });

  it("resolves { ok: false } on backlog timeout", async () => {
    const limiter = makePartitionedBlockingLimiter<string>({
      backlogTimeout: 100,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });

    const first = await acquireOk(limiter, { context: "a" });
    assert.ok(first);

    const start = performance.now();
    await assertUnavailable(limiter.acquire({ context: "a" }));
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 50);
  });

  it("throws when backlogTimeout exceeds max timeout", () => {
    assert.throws(
      () =>
        makePartitionedBlockingLimiter<string>({
          backlogTimeout: 60 * 60 * 1000 + 1,
          limiter: { limit: new FixedLimit(1) },
          partitionResolver: (ctx) => ctx,
          partitions: { a: { percent: 1, delayMs: 0 } },
        }),
      /Timeout cannot be greater than/,
    );
  });

  it("unblocks multiple waiters on release", async () => {
    const limiter = makePartitionedBlockingLimiter<string>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });

    const first = await acquireOk(limiter, { context: "a" });
    assert.ok(first);

    const waiters = [
      limiter.acquire({ context: "a" }),
      limiter.acquire({ context: "a" }),
      limiter.acquire({ context: "a" }),
    ];
    await first!.releaseAndRecordSuccess();
    assert.ok((await waiters[0])?.ok);
  });

  it("applies delay before blocking", async () => {
    const limiter = makePartitionedBlockingLimiter<string>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 40 } },
    });

    const first = await acquireOk(limiter, { context: "a" });
    assert.ok(first);

    const waiting = limiter.acquire({ context: "a" });
    setTimeout(() => first!.releaseAndRecordSuccess(), 10);

    const start = performance.now();
    const second = await waiting;
    const elapsed = performance.now() - start;

    assert.ok(second.ok);
    assert.ok(elapsed >= 30, `expected at least partition delay, got ${elapsed}ms`);
    await second.value.releaseAndRecordSuccess();
  });

  it("rejects with the abort reason when aborted while waiting", async () => {
    const limiter = makePartitionedBlockingLimiter<string>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });
    const first = await acquireOk(limiter, { context: "a" });
    assert.ok(first);

    const ac = new AbortController();
    const waiting = limiter.acquire({ context: "a", signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(waiting, { name: "AbortError" });
  });

  it("serves a waiter whose partition has room when the head waiter's partition is full", async () => {
    // Each partition may hold 1 allotment (burst "none", 50% of 2).
    const limiter = makePartitionedBlockingLimiter<string>({
      backlogTimeout: 1_000,
      limiter: { limit: new FixedLimit(2) },
      partitionResolver: (ctx) => ctx,
      partitions: {
        a: { percent: 0.5, burstMode: { kind: "none" } },
        b: { percent: 0.5, burstMode: { kind: "none" } },
      },
    });

    const a1 = await acquireOk(limiter, { context: "a" });
    const b1 = await acquireOk(limiter, { context: "b" });

    // FIFO: the waiter for a joins first, so it is at the head of the backlog.
    const a2Waiting = limiter.acquire({ context: "a" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b2Waiting = limiter.acquire({ context: "b" });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Free b's slot. a is still full, so the waiter for a cannot use it,
    // but the waiter for b can.
    const start = performance.now();
    await b1.releaseAndRecordSuccess();
    const b2 = await b2Waiting;
    const elapsed = performance.now() - start;

    assert.ok(b2.ok, "expected the waiter for b to get an allotment");
    assert.ok(elapsed < 200, `expected a prompt allotment, waited ${elapsed}ms`);

    await b2.value.releaseAndRecordSuccess();
    await a1.releaseAndRecordSuccess();
    const a2 = await a2Waiting;
    assert.ok(a2.ok);
    await a2.value.releaseAndRecordSuccess();
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
