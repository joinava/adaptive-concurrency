import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FixedLimit } from "../../limit/FixedLimit.js";
import type { AcquireResult } from "../../Limiter.js";
import { Limiter } from "../../Limiter.js";
import { FifoBlockingRejection } from "./FifoBlockingRejection.js";

describe("FifoBlockingRejection", () => {
  it("should acquire immediately when under limit", async () => {
    const limiter = new Limiter<void>({
      limit: new FixedLimit(10),
      allotmentUnavailableStrategy: new FifoBlockingRejection(),
    });

    const listener = await limiter.acquire({});
    assert.ok(listener, "Should acquire immediately");
    await listener!.releaseAndRecordSuccess();
  });

  it("should block and then acquire when a token is released", async () => {
    const limiter = new Limiter<void>({
      limit: new FixedLimit(1),
      allotmentUnavailableStrategy: new FifoBlockingRejection({
        timeout: 5_000,
      }),
    });

    const listener1 = await limiter.acquire({});
    assert.ok(listener1);

    const acquirePromise = limiter.acquire({});

    setTimeout(() => listener1!.releaseAndRecordSuccess(), 50);

    const listener2 = await acquirePromise;
    assert.ok(listener2, "Should acquire after token released");
    await listener2!.releaseAndRecordSuccess();
  });

  it("should return undefined on timeout", async () => {
    const limiter = new Limiter<void>({
      limit: new FixedLimit(1),
      allotmentUnavailableStrategy: new FifoBlockingRejection({ timeout: 100 }),
    });

    const listener1 = await limiter.acquire({});
    assert.ok(listener1);

    const start = performance.now();
    const listener2 = await limiter.acquire({});
    const elapsed = performance.now() - start;

    assert.equal(listener2, undefined, "Should return undefined on timeout");
    assert.ok(
      elapsed >= 50,
      `Should have waited at least 50ms, but waited ${elapsed}ms`,
    );
  });

  it("should throw when timeout exceeds MAX_TIMEOUT", () => {
    assert.throws(
      () => new FifoBlockingRejection({ timeout: 60 * 60 * 1000 + 1 }),
      /Timeout cannot be greater than/,
    );
  });

  it("should unblock multiple waiters on release", async () => {
    const limiter = new Limiter<void>({
      limit: new FixedLimit(1),
      allotmentUnavailableStrategy: new FifoBlockingRejection({
        timeout: 5_000,
      }),
    });

    const listener1 = await limiter.acquire({});
    assert.ok(listener1);

    const results: Array<AcquireResult> = [];
    for (let i = 0; i < 3; i++) {
      results.push(limiter.acquire({}));
    }

    await listener1!.releaseAndRecordSuccess();

    const second = await results[0];
    assert.ok(second, "Second should eventually acquire");
  });

  it("should return undefined when aborted while waiting", async () => {
    const limiter = new Limiter<void>({
      limit: new FixedLimit(1),
      allotmentUnavailableStrategy: new FifoBlockingRejection({
        timeout: 5_000,
      }),
    });

    const listener1 = await limiter.acquire({});
    assert.ok(listener1);

    const abortController = new AbortController();
    const acquirePromise = limiter.acquire({
      signal: abortController.signal,
    });
    setTimeout(() => abortController.abort(), 20);

    const listener2 = await acquirePromise;
    assert.equal(listener2, undefined, "Should return undefined after abort");

    await listener1!.releaseAndRecordSuccess();
  });
});
