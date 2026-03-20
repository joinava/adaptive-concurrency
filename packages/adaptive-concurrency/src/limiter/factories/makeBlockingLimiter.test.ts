import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { makeBlockingLimiter } from "./makeBlockingLimiter.js";

describe("makeBlockingLimiter (Netflix BlockingLimiter semantics)", () => {
  it("acquires immediately when under limit", async () => {
    const limiter = makeBlockingLimiter<void>({
      limiter: { limit: new FixedLimit(10) },
    });

    const allotment = await limiter.acquire({});
    assert.ok(allotment);
    await allotment!.releaseAndRecordSuccess();
  });

  it("blocks and then acquires when a token is released", async () => {
    const limiter = makeBlockingLimiter<void>({
      timeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
    });

    const first = await limiter.acquire({});
    assert.ok(first);

    const waiting = limiter.acquire({});
    setTimeout(() => first!.releaseAndRecordSuccess(), 50);

    const second = await waiting;
    assert.ok(second);
    await second!.releaseAndRecordSuccess();
  });

  it("returns undefined on timeout", async () => {
    const limiter = makeBlockingLimiter<void>({
      timeout: 100,
      limiter: { limit: new FixedLimit(1) },
    });

    const first = await limiter.acquire({});
    assert.ok(first);

    const start = performance.now();
    const second = await limiter.acquire({});
    const elapsed = performance.now() - start;

    assert.equal(second, undefined);
    assert.ok(elapsed >= 50);
  });

  it("throws when timeout exceeds max timeout", () => {
    assert.throws(
      () =>
        makeBlockingLimiter<void>({
          timeout: 60 * 60 * 1000 + 1,
          limiter: { limit: new FixedLimit(1) },
        }),
      /Timeout cannot be greater than/,
    );
  });

  it("allows a waiting caller to acquire after release", async () => {
    const limiter = makeBlockingLimiter<void>({
      timeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
    });

    const first = await limiter.acquire({});
    assert.ok(first);

    const waiters = [limiter.acquire({}), limiter.acquire({}), limiter.acquire({})];
    await first!.releaseAndRecordSuccess();

    const second = await waiters[0];
    assert.ok(second);
  });

  it("returns undefined when aborted while waiting", async () => {
    const limiter = makeBlockingLimiter<void>({
      timeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
    });

    const first = await limiter.acquire({});
    assert.ok(first);

    const ac = new AbortController();
    const waiting = limiter.acquire({ signal: ac.signal });
    setTimeout(() => ac.abort(), 20);

    const second = await waiting;
    assert.equal(second, undefined);
    await first!.releaseAndRecordSuccess();
  });
});
