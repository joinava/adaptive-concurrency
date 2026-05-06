import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Limiter } from "../../Limiter.js";
import { SettableLimit } from "../../limit/SettableLimit.js";
import { SemaphoreStrategy } from "./SemaphoreStrategy.js";

describe("SemaphoreStrategy", () => {
  it("should use permits until exhausted", () => {
    const strategy = new SemaphoreStrategy(2);

    const r1 = strategy.tryReserveAllotment();
    const r2 = strategy.tryReserveAllotment();
    assert.ok(r1);
    assert.ok(r2);
    r1.commit();
    r2.commit();
    assert.equal(strategy.tryReserveAllotment(), undefined);
  });

  it("should restore permits when allotments are released", () => {
    const strategy = new SemaphoreStrategy(1);

    const r1 = strategy.tryReserveAllotment();
    assert.ok(r1);
    r1.commit();
    assert.equal(strategy.tryReserveAllotment(), undefined);

    strategy.onAllotmentReleased();
    const r2 = strategy.tryReserveAllotment();
    assert.ok(r2);
    r2.commit();
  });

  it("should restore the permit when a reservation is cancelled", () => {
    const strategy = new SemaphoreStrategy(1);

    const r1 = strategy.tryReserveAllotment();
    assert.ok(r1);
    assert.equal(
      strategy.tryReserveAllotment(),
      undefined,
      "speculative reservation counts against the permit",
    );
    r1.cancel();
    const r2 = strategy.tryReserveAllotment();
    assert.ok(r2, "permit returned after cancel");
  });

  it("should adjust permits when limit changes", async () => {
    const limit = new SettableLimit(5);
    const limiter = new Limiter<string>({ limit });

    for (let i = 0; i < 5; i++) {
      await limiter.acquire({ context: "test" });
    }
    assert.equal(await limiter.acquire({ context: "test" }), undefined);

    limit.setLimit(10);

    const extra = await limiter.acquire({ context: "test" });
    assert.ok(extra, "Should acquire after limit increase");
  });
});
