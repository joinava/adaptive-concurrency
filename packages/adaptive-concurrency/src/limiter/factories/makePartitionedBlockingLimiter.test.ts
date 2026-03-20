import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { makePartitionedBlockingLimiter } from "./makePartitionedBlockingLimiter.js";

describe("makePartitionedBlockingLimiter", () => {
  it("acquires immediately when under limit", async () => {
    const limiter = makePartitionedBlockingLimiter<string>({
      timeout: 5_000,
      limiter: { limit: new FixedLimit(2) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });
    assert.ok(await limiter.acquire({ context: "a" }));
  });

  it("waits for capacity", async () => {
    const limiter = makePartitionedBlockingLimiter<string>({
      timeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);

    const waiting = limiter.acquire({ context: "a" });
    setTimeout(() => first!.releaseAndRecordSuccess(), 25);

    const second = await waiting;
    assert.ok(second);
    await second!.releaseAndRecordSuccess();
  });

  it("returns undefined on timeout", async () => {
    const limiter = makePartitionedBlockingLimiter<string>({
      timeout: 100,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);

    const start = performance.now();
    const second = await limiter.acquire({ context: "a" });
    const elapsed = performance.now() - start;
    assert.equal(second, undefined);
    assert.ok(elapsed >= 50);
  });

  it("throws when timeout exceeds max timeout", () => {
    assert.throws(
      () =>
        makePartitionedBlockingLimiter<string>({
          timeout: 60 * 60 * 1000 + 1,
          limiter: { limit: new FixedLimit(1) },
          partitionResolver: (ctx) => ctx,
          partitions: { a: { percent: 1, delayMs: 0 } },
        }),
      /Timeout cannot be greater than/,
    );
  });

  it("unblocks multiple waiters on release", async () => {
    const limiter = makePartitionedBlockingLimiter<string>({
      timeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);

    const waiters = [
      limiter.acquire({ context: "a" }),
      limiter.acquire({ context: "a" }),
      limiter.acquire({ context: "a" }),
    ];
    await first!.releaseAndRecordSuccess();
    assert.ok(await waiters[0]);
  });

  it("applies delay before blocking", async () => {
    const limiter = makePartitionedBlockingLimiter<string>({
      timeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 40 } },
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);

    const waiting = limiter.acquire({ context: "a" });
    setTimeout(() => first!.releaseAndRecordSuccess(), 10);

    const start = performance.now();
    const second = await waiting;
    const elapsed = performance.now() - start;

    assert.ok(second);
    assert.ok(elapsed >= 30, `expected at least partition delay, got ${elapsed}ms`);
    await second!.releaseAndRecordSuccess();
  });

  it("returns undefined when aborted while waiting", async () => {
    const limiter = makePartitionedBlockingLimiter<string>({
      timeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });
    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);

    const ac = new AbortController();
    const waiting = limiter.acquire({ context: "a", signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    assert.equal(await waiting, undefined);
  });
});
