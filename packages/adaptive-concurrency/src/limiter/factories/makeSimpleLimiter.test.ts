import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { SettableLimit } from "../../limit/SettableLimit.js";
import { makeSimpleLimiter } from "./makeSimpleLimiter.js";
import { isAllotmentUnavailableError } from "../../errors.js";
import type {
  AcquireOptions,
  AcquireResult,
  LimitAllotment,
} from "../../types/Strategy.js";

describe("makeSimpleLimiter", () => {
  it("uses limiter capacity until total limit is reached", async () => {
    const limiter = makeSimpleLimiter<string>({
      limit: new FixedLimit(2),
    });

    const a = await acquireOk(limiter, { context: "a" });
    const b = await acquireOk(limiter, { context: "b" });

    assert.ok(a);
    assert.ok(b);
    await assertUnavailable(limiter.acquire({ context: "c" }));
  });

  it("releases limit when allotment completes", async () => {
    const limiter = makeSimpleLimiter<string>({
      limit: new FixedLimit(1),
    });

    const first = await acquireOk(limiter, { context: "a" });
    assert.ok(first);
    await assertUnavailable(limiter.acquire({ context: "a" }));

    await first.releaseAndRecordSuccess();
    await acquireOk(limiter, { context: "a" });
  });

  it("supports bypass resolver", async () => {
    const limiter = makeSimpleLimiter<string>({
      limit: new FixedLimit(1),
      bypassResolver: (ctx) => ctx === "vip",
    });

    await acquireOk(limiter, { context: "normal" });
    await assertUnavailable(limiter.acquire({ context: "normal" }));
    await acquireOk(limiter, { context: "vip" });
  });

  it("tracks inflight count", async () => {
    const limiter = makeSimpleLimiter<string>({ limit: new FixedLimit(2) });
    assert.equal(limiter.getInflight(), 0);
    const allotment = await acquireOk(limiter, { context: "x" });
    assert.equal(limiter.getInflight(), 1);
    await allotment.releaseAndRecordSuccess();
    assert.equal(limiter.getInflight(), 0);
  });

  it("adjusts permits when adaptive limit changes", async () => {
    const limit = new SettableLimit(1);
    const limiter = makeSimpleLimiter<string>({ limit });

    await acquireOk(limiter, { context: "x" });
    await assertUnavailable(limiter.acquire({ context: "x" }));

    limit.setLimit(2);
    await acquireOk(limiter, { context: "x" });
  });

  it("releases on ignore and dropped", async () => {
    const limiter = makeSimpleLimiter<string>({ limit: new FixedLimit(1) });
    const a = await acquireOk(limiter, { context: "x" });
    await a.releaseAndIgnore();
    const afterIgnore = await acquireOk(limiter, { context: "x" });
    assert.ok(afterIgnore);
    await afterIgnore.releaseAndRecordSuccess();

    const b = await acquireOk(limiter, { context: "x" });
    await b.releaseAndRecordDropped();
    await acquireOk(limiter, { context: "x" });
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
