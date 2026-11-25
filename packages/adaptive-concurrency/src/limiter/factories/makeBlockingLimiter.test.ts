import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { makeBlockingLimiter } from "./makeBlockingLimiter.js";
import { isAllotmentUnavailableError } from "../../errors.js";
import type {
  AcquireOptions,
  AcquireResult,
  LimitAllotment,
} from "../../types/Strategy.js";

describe("makeBlockingLimiter (Netflix BlockingLimiter semantics)", () => {
  it("acquires immediately when under limit", async () => {
    const limiter = makeBlockingLimiter<void>({
      limiter: { limit: new FixedLimit(10) },
    });

    const allotment = await acquireOk(limiter, {});
    assert.ok(allotment);
    await allotment!.releaseAndRecordSuccess();
  });

  it("blocks and then acquires when a token is released", async () => {
    const limiter = makeBlockingLimiter<void>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
    });

    const first = await acquireOk(limiter, {});
    assert.ok(first);

    const waiting = limiter.acquire({});
    setTimeout(() => first!.releaseAndRecordSuccess(), 50);

    const second = await waiting;
    assert.ok(second.ok);
    await second.value.releaseAndRecordSuccess();
  });

  it("resolves { ok: false } on backlog timeout", async () => {
    const limiter = makeBlockingLimiter<void>({
      backlogTimeout: 100,
      limiter: { limit: new FixedLimit(1) },
    });

    const first = await acquireOk(limiter, {});
    assert.ok(first);

    const start = performance.now();
    await assertUnavailable(limiter.acquire({}));
    const elapsed = performance.now() - start;

    assert.ok(elapsed >= 50);
  });

  it("throws when backlogTimeout exceeds max timeout", () => {
    assert.throws(
      () =>
        makeBlockingLimiter<void>({
          backlogTimeout: 60 * 60 * 1000 + 1,
          limiter: { limit: new FixedLimit(1) },
        }),
      /Timeout cannot be greater than/,
    );
  });

  it("allows a waiting caller to acquire after release", async () => {
    const limiter = makeBlockingLimiter<void>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
    });

    const first = await acquireOk(limiter, {});
    assert.ok(first);

    const ac = new AbortController();
    const waiters = [
      limiter.acquire({ signal: ac.signal }),
      limiter.acquire({ signal: ac.signal }),
      limiter.acquire({ signal: ac.signal }),
    ];
    await first!.releaseAndRecordSuccess();

    const second = await waiters[0];
    assert.ok(second?.ok);

    // The other waiters never get an allotment. Abort them, so that they
    // settle now instead of at the backlog timeout.
    ac.abort();
    await Promise.allSettled(waiters);
  });

  it("rejects with the abort reason when aborted while waiting", async () => {
    const limiter = makeBlockingLimiter<void>({
      backlogTimeout: 5_000,
      limiter: { limit: new FixedLimit(1) },
    });

    const first = await acquireOk(limiter, {});
    assert.ok(first);

    const ac = new AbortController();
    const waiting = limiter.acquire({ signal: ac.signal });
    setTimeout(() => ac.abort(), 20);

    await assert.rejects(waiting, { name: "AbortError" });
    await first!.releaseAndRecordSuccess();
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
