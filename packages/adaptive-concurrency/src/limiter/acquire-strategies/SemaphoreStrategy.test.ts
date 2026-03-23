import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Limiter } from "../../Limiter.js";
import { SettableLimit } from "../../limit/SettableLimit.js";
import { SemaphoreStrategy } from "./SemaphoreStrategy.js";

describe("SemaphoreStrategy", () => {
  it("should use permits until exhausted", () => {
    const strategy = new SemaphoreStrategy(2);

    assert.equal(strategy.tryAcquireAllotment(), true);
    assert.equal(strategy.tryAcquireAllotment(), true);
    assert.equal(strategy.tryAcquireAllotment(), false);
  });

  it("should restore permits when allotments are released", () => {
    const strategy = new SemaphoreStrategy(1);

    assert.equal(strategy.tryAcquireAllotment(), true);
    assert.equal(strategy.tryAcquireAllotment(), false);

    strategy.onAllotmentReleased();
    assert.equal(strategy.tryAcquireAllotment(), true);
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
