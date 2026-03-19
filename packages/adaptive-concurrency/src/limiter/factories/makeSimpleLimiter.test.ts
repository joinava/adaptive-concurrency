import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { SettableLimit } from "../../limit/SettableLimit.js";
import { makeSimpleLimiter } from "./makeSimpleLimiter.js";

describe("makeSimpleLimiter", () => {
  it("uses limiter capacity until total limit is reached", () => {
    const limiter = makeSimpleLimiter<string>({
      limit: new FixedLimit(2),
    });

    const a = limiter.acquire({ context: "a" });
    const b = limiter.acquire({ context: "b" });
    const c = limiter.acquire({ context: "c" });

    assert.ok(a);
    assert.ok(b);
    assert.equal(c, undefined);
  });

  it("releases limit when allotment completes", () => {
    const limiter = makeSimpleLimiter<string>({
      limit: new FixedLimit(1),
    });

    const first = limiter.acquire({ context: "a" });
    assert.ok(first);
    assert.equal(limiter.acquire({ context: "a" }), undefined);

    first!.reportSuccess();
    assert.ok(limiter.acquire({ context: "a" }));
  });

  it("supports bypass resolver", () => {
    const limiter = makeSimpleLimiter<string>({
      limit: new FixedLimit(1),
      bypassResolver: (ctx) => ctx === "vip",
    });

    assert.ok(limiter.acquire({ context: "normal" }));
    assert.equal(limiter.acquire({ context: "normal" }), undefined);
    assert.ok(limiter.acquire({ context: "vip" }));
  });

  it("tracks inflight count", () => {
    const limiter = makeSimpleLimiter<string>({ limit: new FixedLimit(2) });
    assert.equal(limiter.getInflight(), 0);
    const allotment = limiter.acquire({ context: "x" })!;
    assert.equal(limiter.getInflight(), 1);
    allotment.reportSuccess();
    assert.equal(limiter.getInflight(), 0);
  });

  it("adjusts permits when adaptive limit changes", () => {
    const limit = new SettableLimit(1);
    const limiter = makeSimpleLimiter<string>({ limit });

    assert.ok(limiter.acquire({ context: "x" }));
    assert.equal(limiter.acquire({ context: "x" }), undefined);

    limit.setLimit(2);
    assert.ok(limiter.acquire({ context: "x" }));
  });

  it("releases on ignore and dropped", () => {
    const limiter = makeSimpleLimiter<string>({ limit: new FixedLimit(1) });
    const a = limiter.acquire({ context: "x" })!;
    a.reportIgnore();
    const afterIgnore = limiter.acquire({ context: "x" });
    assert.ok(afterIgnore);
    afterIgnore!.reportSuccess();

    const b = limiter.acquire({ context: "x" })!;
    b.reportDropped();
    assert.ok(limiter.acquire({ context: "x" }));
  });
});
