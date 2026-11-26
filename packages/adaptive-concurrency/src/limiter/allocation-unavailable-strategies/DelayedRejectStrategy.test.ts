import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllotmentUnavailableError } from "../../errors.js";
import { Limiter } from "../../Limiter.js";
import { FixedLimit } from "../../limit/FixedLimit.js";
import type { Result } from "../../types/Strategy.js";
import { DelayedRejectStrategy } from "./DelayedRejectStrategy.js";

/** Asserts that `promise` resolves with no allotment and an unavailable-allotment error. */
async function assertUnavailable(
  promise: Promise<Result<unknown>>,
): Promise<void> {
  const result = await promise;
  assert.equal(result.ok, false);
  assert.ok(!result.ok && isAllotmentUnavailableError(result.error));
}

describe("DelayedRejectStrategy", () => {
  it("resolves with no allotment immediately when delay is 0", async () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
      allotmentUnavailableStrategy: new DelayedRejectStrategy({
        delayMsForContext: () => 0,
      }),
    });

    void limiter.acquire({ context: "a" });
    const p = limiter.acquire({ context: "b" });
    assert.ok(p instanceof Promise);
    await assertUnavailable(p);
  });

  it("waits delay ms before resolving with no allotment", async () => {
    const delayMs = 30;
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
      allotmentUnavailableStrategy: new DelayedRejectStrategy({
        delayMsForContext: () => delayMs,
      }),
    });

    void limiter.acquire({ context: "a" });
    const start = performance.now();
    const p = limiter.acquire({ context: "b" });
    assert.ok(p instanceof Promise);
    await assertUnavailable(p);
    assert.ok(performance.now() - start >= delayMs - 5);
  });

  it("skips delay when concurrent delay cap is reached", async () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
      allotmentUnavailableStrategy: new DelayedRejectStrategy({
        delayMsForContext: () => 50,
        maxConcurrentDelays: 1,
      }),
    });

    void limiter.acquire({ context: "a" });
    const slow = limiter.acquire({ context: "b" });
    const fast = limiter.acquire({ context: "c" });

    const slowRefused = assertUnavailable(slow);
    const t0 = performance.now();
    await assertUnavailable(fast);
    assert.ok(
      performance.now() - t0 < 20,
      "third acquire should not wait 50ms",
    );
    await slowRefused;
  });

  it("respects AbortSignal during delay", async () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
      allotmentUnavailableStrategy: new DelayedRejectStrategy({
        delayMsForContext: () => 10_000,
      }),
    });

    void limiter.acquire({ context: "a" });
    const ac = new AbortController();
    const p = limiter.acquire({ context: "b", signal: ac.signal });
    const reason = new Error("aborted by test");
    queueMicrotask(() => ac.abort(reason));
    const t0 = performance.now();
    await assert.rejects(p, (error) => error === reason);
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
