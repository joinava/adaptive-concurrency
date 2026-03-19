import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { makePartitionedLifoBlockingLimiter } from "./makePartitionedLifoBlockingLimiter.js";

describe("makePartitionedLifoBlockingLimiter", () => {
  it("acquires immediately when under limit", async () => {
    const limiter = makePartitionedLifoBlockingLimiter<string>({
      limiter: { limit: new FixedLimit(2) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });
    assert.ok(await limiter.acquire({ context: "a" }));
  });

  it("uses LIFO wake-up", async () => {
    const limiter = makePartitionedLifoBlockingLimiter<string>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 20 } },
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);

    const order: string[] = [];
    const oldWaiter = limiter.acquire({ context: "a" }).then((a) => {
      if (a) {
        order.push("old");
        a.reportSuccess();
      }
    });
    const newWaiter = limiter.acquire({ context: "a" }).then((a) => {
      if (a) {
        order.push("new");
        a.reportSuccess();
      }
    });

    setTimeout(() => first!.reportSuccess(), 60);
    await Promise.all([oldWaiter, newWaiter]);

    assert.deepEqual(order, ["new", "old"]);
  });

  it("returns undefined when backlog timeout is reached", async () => {
    const limiter = makePartitionedLifoBlockingLimiter<string>({
      backlogTimeout: 50,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });

    assert.ok(await limiter.acquire({ context: "a" }));
    const start = performance.now();
    const out = await limiter.acquire({ context: "a" });
    const elapsed = performance.now() - start;
    assert.equal(out, undefined);
    assert.ok(elapsed >= 35);
  });

  it("returns undefined when backlog size is exceeded", async () => {
    const limiter = makePartitionedLifoBlockingLimiter<string>({
      backlogSize: 1,
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);

    const inBacklog = limiter.acquire({ context: "a" });
    const overflow = await limiter.acquire({ context: "a" });
    assert.equal(overflow, undefined);

    first!.reportSuccess();
    assert.ok(await inBacklog);
  });

  it("returns undefined when aborted while waiting", async () => {
    const limiter = makePartitionedLifoBlockingLimiter<string>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 0 } },
    });

    assert.ok(await limiter.acquire({ context: "a" }));
    const ac = new AbortController();
    const waiting = limiter.acquire({ context: "a", signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    assert.equal(await waiting, undefined);
  });

  it("applies partition delay before entering blocking queue", async () => {
    const limiter = makePartitionedLifoBlockingLimiter<string>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
      partitionResolver: (ctx) => ctx,
      partitions: { a: { percent: 1, delayMs: 35 } },
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);

    const waiting = limiter.acquire({ context: "a" });
    setTimeout(() => first!.reportSuccess(), 10);

    const start = performance.now();
    const second = await waiting;
    const elapsed = performance.now() - start;
    assert.ok(second);
    assert.ok(elapsed >= 25);
  });
});
