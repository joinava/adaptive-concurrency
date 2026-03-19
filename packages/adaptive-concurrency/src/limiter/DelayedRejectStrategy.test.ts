import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AsyncAcquireResult } from "../Limiter.js";
import { Limiter } from "../Limiter.js";
import { FixedLimit } from "../limit/FixedLimit.js";
import { DelayedRejectStrategy } from "./DelayedRejectStrategy.js";

describe("DelayedRejectStrategy", () => {
  it("returns undefined immediately when delay is 0", () => {
    const limiter = new Limiter<string, AsyncAcquireResult>({
      limit: new FixedLimit(1),
      allotmentUnavailableStrategy: new DelayedRejectStrategy({
        delayMsForContext: () => 0,
      }),
    });

    limiter.acquire({ context: "a" });
    const p = limiter.acquire({ context: "b" });
    assert.ok(p instanceof Promise);
    return p.then((a) => assert.equal(a, undefined));
  });

  it("waits delay ms before resolving undefined", async () => {
    const delayMs = 30;
    const limiter = new Limiter<string, AsyncAcquireResult>({
      limit: new FixedLimit(1),
      allotmentUnavailableStrategy: new DelayedRejectStrategy({
        delayMsForContext: () => delayMs,
      }),
    });

    limiter.acquire({ context: "a" });
    const start = performance.now();
    const p = limiter.acquire({ context: "b" });
    assert.ok(p instanceof Promise);
    const result = await p;
    assert.equal(result, undefined);
    assert.ok(performance.now() - start >= delayMs - 5);
  });

  it("skips delay when concurrent delay cap is reached", async () => {
    const limiter = new Limiter<string, AsyncAcquireResult>({
      limit: new FixedLimit(1),
      allotmentUnavailableStrategy: new DelayedRejectStrategy({
        delayMsForContext: () => 50,
        maxConcurrentDelays: 1,
      }),
    });

    limiter.acquire({ context: "a" });
    const slow = limiter.acquire({ context: "b" });
    const fast = limiter.acquire({ context: "c" });

    const t0 = performance.now();
    await fast;
    assert.ok(
      performance.now() - t0 < 20,
      "third acquire should not wait 50ms",
    );
    await slow;
  });

  it("respects AbortSignal during delay", async () => {
    const limiter = new Limiter<string, AsyncAcquireResult>({
      limit: new FixedLimit(1),
      allotmentUnavailableStrategy: new DelayedRejectStrategy({
        delayMsForContext: () => 10_000,
      }),
    });

    limiter.acquire({ context: "a" });
    const ac = new AbortController();
    const p = limiter.acquire({ context: "b", signal: ac.signal });
    queueMicrotask(() => ac.abort());
    const t0 = performance.now();
    await p;
    assert.ok(performance.now() - t0 < 100);
  });

  it("throws on invalid maxConcurrentDelays", () => {
    assert.throws(
      () =>
        new DelayedRejectStrategy({
          delayMsForContext: () => 1,
          maxConcurrentDelays: 0,
        }),
      /maxConcurrentDelays/,
    );
  });
});
