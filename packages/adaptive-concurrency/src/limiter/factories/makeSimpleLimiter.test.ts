import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { SettableLimit } from "../../limit/SettableLimit.js";
import { makeSimpleLimiter } from "./makeSimpleLimiter.js";
import { isAllotmentUnavailableError } from "../../errors.js";

describe("makeSimpleLimiter", () => {
  it("uses limiter capacity until total limit is reached", async () => {
    const limiter = makeSimpleLimiter<string>({
      limit: new FixedLimit(2),
    });

    const a = await limiter.acquire({ context: "a" });
    const b = await limiter.acquire({ context: "b" });

    assert.ok(a);
    assert.ok(b);
    await assert.rejects(
      limiter.acquire({ context: "c" }),
      isAllotmentUnavailableError,
    );
  });

  it("releases limit when allotment completes", async () => {
    const limiter = makeSimpleLimiter<string>({
      limit: new FixedLimit(1),
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);
    await assert.rejects(
      limiter.acquire({ context: "a" }),
      isAllotmentUnavailableError,
    );

    await first.releaseAndRecordSuccess();
    assert.ok(await limiter.acquire({ context: "a" }));
  });

  it("supports bypass resolver", async () => {
    const limiter = makeSimpleLimiter<string>({
      limit: new FixedLimit(1),
      bypassResolver: (ctx) => ctx === "vip",
    });

    assert.ok(await limiter.acquire({ context: "normal" }));
    await assert.rejects(
      limiter.acquire({ context: "normal" }),
      isAllotmentUnavailableError,
    );
    assert.ok(await limiter.acquire({ context: "vip" }));
  });

  it("tracks inflight count", async () => {
    const limiter = makeSimpleLimiter<string>({ limit: new FixedLimit(2) });
    assert.equal(limiter.getInflight(), 0);
    const allotment = await limiter.acquire({ context: "x" });
    assert.equal(limiter.getInflight(), 1);
    await allotment.releaseAndRecordSuccess();
    assert.equal(limiter.getInflight(), 0);
  });

  it("adjusts permits when adaptive limit changes", async () => {
    const limit = new SettableLimit(1);
    const limiter = makeSimpleLimiter<string>({ limit });

    assert.ok(await limiter.acquire({ context: "x" }));
    await assert.rejects(
      limiter.acquire({ context: "x" }),
      isAllotmentUnavailableError,
    );

    limit.setLimit(2);
    assert.ok(await limiter.acquire({ context: "x" }));
  });

  it("releases on ignore and dropped", async () => {
    const limiter = makeSimpleLimiter<string>({ limit: new FixedLimit(1) });
    const a = await limiter.acquire({ context: "x" });
    await a.releaseAndIgnore();
    const afterIgnore = await limiter.acquire({ context: "x" });
    assert.ok(afterIgnore);
    await afterIgnore.releaseAndRecordSuccess();

    const b = await limiter.acquire({ context: "x" });
    await b.releaseAndRecordDropped();
    assert.ok(await limiter.acquire({ context: "x" }));
  });
});
