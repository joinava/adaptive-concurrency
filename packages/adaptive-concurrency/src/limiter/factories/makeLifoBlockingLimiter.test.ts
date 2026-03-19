import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { makeLifoBlockingLimiter } from "./makeLifoBlockingLimiter.js";

describe("makeLifoBlockingLimiter (Netflix LifoBlockingLimiter semantics)", () => {
  it("acquires immediately when under limit", async () => {
    const limiter = makeLifoBlockingLimiter<string>({
      limiter: { limit: new FixedLimit(2) },
    });
    const allotment = await limiter.acquire({ context: "a" });
    assert.ok(allotment);
    allotment!.reportSuccess();
  });

  it("serves most recently queued request first", async () => {
    const limiter = makeLifoBlockingLimiter<string>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
    });

    const first = await limiter.acquire({ context: "inflight" });
    assert.ok(first);

    const order: string[] = [];
    const w1 = limiter.acquire({ context: "oldest" }).then((a) => {
      if (a) {
        order.push("oldest");
        a.reportSuccess();
      }
    });
    const w2 = limiter.acquire({ context: "newest" }).then((a) => {
      if (a) {
        order.push("newest");
        a.reportSuccess();
      }
    });

    first!.reportSuccess();
    await Promise.all([w1, w2]);

    assert.deepEqual(order, ["newest", "oldest"]);
  });

  it("returns undefined when backlog timeout is reached", async () => {
    const limiter = makeLifoBlockingLimiter<string>({
      backlogTimeout: 50,
      limiter: { limit: new FixedLimit(1) },
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);

    const start = performance.now();
    const out = await limiter.acquire({ context: "b" });
    const elapsed = performance.now() - start;
    assert.equal(out, undefined);
    assert.ok(elapsed >= 35);
  });

  it("returns undefined when backlog size is exceeded", async () => {
    const limiter = makeLifoBlockingLimiter<string>({
      backlogSize: 1,
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);

    const inBacklog = limiter.acquire({ context: "b" });
    const overflow = await limiter.acquire({ context: "c" });
    assert.equal(overflow, undefined);

    first!.reportSuccess();
    assert.ok(await inBacklog);
  });

  it("returns undefined when aborted while waiting", async () => {
    const limiter = makeLifoBlockingLimiter<string>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);

    const ac = new AbortController();
    const waiting = limiter.acquire({ context: "b", signal: ac.signal });
    setTimeout(() => ac.abort(), 20);

    assert.equal(await waiting, undefined);
  });
});
