import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { SettableLimit } from "../../limit/SettableLimit.js";
import { makeSimpleLimiter } from "./makeSimpleLimiter.js";

describe("makeSimpleLimiter", () => {
  it("uses limiter capacity until total limit is reached", async () => {
    const limiter = makeSimpleLimiter<string>({
      limit: new FixedLimit(2),
    });

    const a = await limiter.acquire({ context: "a" });
    const b = await limiter.acquire({ context: "b" });
    const c = await limiter.acquire({ context: "c" });

    assert.ok(a);
    assert.ok(b);
    assert.equal(c, undefined);
  });

  it("releases limit when allotment completes", async () => {
    const limiter = makeSimpleLimiter<string>({
      limit: new FixedLimit(1),
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first);
    assert.equal(await limiter.acquire({ context: "a" }), undefined);

    await first.releaseAndRecordSuccess();
    assert.ok(await limiter.acquire({ context: "a" }));
  });

  it("supports bypass resolver", async () => {
    const limiter = makeSimpleLimiter<string>({
      limit: new FixedLimit(1),
      bypassResolver: (ctx) => ctx === "vip",
    });

    assert.ok(await limiter.acquire({ context: "normal" }));
    assert.equal(await limiter.acquire({ context: "normal" }), undefined);
    assert.ok(await limiter.acquire({ context: "vip" }));
  });

  it("tracks inflight count", async () => {
    const limiter = makeSimpleLimiter<string>({ limit: new FixedLimit(2) });
    assert.equal(limiter.getInflight(), 0);
    const allotment = (await limiter.acquire({ context: "x" }))!;
    assert.equal(limiter.getInflight(), 1);
    await allotment.releaseAndRecordSuccess();
    assert.equal(limiter.getInflight(), 0);
  });

  it("adjusts permits when adaptive limit changes", async () => {
    const limit = new SettableLimit(1);
    const limiter = makeSimpleLimiter<string>({ limit });

    assert.ok(await limiter.acquire({ context: "x" }));
    assert.equal(await limiter.acquire({ context: "x" }), undefined);

    limit.setLimit(2);
    assert.ok(await limiter.acquire({ context: "x" }));
  });

  it("releases on ignore and dropped", async () => {
    const limiter = makeSimpleLimiter<string>({ limit: new FixedLimit(1) });
    const a = (await limiter.acquire({ context: "x" }))!;
    await a.releaseAndIgnore();
    const afterIgnore = await limiter.acquire({ context: "x" });
    assert.ok(afterIgnore);
    await afterIgnore.releaseAndRecordSuccess();

    const b = (await limiter.acquire({ context: "x" }))!;
    await b.releaseAndRecordDropped();
    assert.ok(await limiter.acquire({ context: "x" }));
  });
});
