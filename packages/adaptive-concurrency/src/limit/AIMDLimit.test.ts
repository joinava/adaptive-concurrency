import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AIMDLimit } from "./AIMDLimit.js";

describe("AIMDLimit", () => {
  it("should decrease limit on drop", () => {
    const limit = new AIMDLimit({
      initialLimit: 100,
      backoffRatio: 0.9,
    });

    limit.addSample(0, 1, 100, true);
    assert.equal(limit.currentLimit, 90);
  });

  it("should decrease limit when RTT exceeds timeout", () => {
    const limit = new AIMDLimit({
      initialLimit: 100,
      backoffRatio: 0.9,
      timeout: 1000,
    });

    limit.addSample(0, 2000, 100, false);
    assert.equal(limit.currentLimit, 90);
  });

  it("should increase limit when inflight is at least half the current limit", () => {
    const limit = new AIMDLimit({
      initialLimit: 20,
    });

    limit.addSample(0, 1, 14, false);
    assert.equal(limit.currentLimit, 21);
  });

  it("should not increase limit when inflight is well below half the limit", () => {
    const limit = new AIMDLimit({
      initialLimit: 20,
    });

    limit.addSample(0, 1, 1, false);
    assert.equal(limit.currentLimit, 20);
  });

  it("should respect minLimit", () => {
    const limit = new AIMDLimit({
      initialLimit: 20,
      minLimit: 10,
      backoffRatio: 0.5,
    });

    // Repeated drops should not push below minLimit
    for (let i = 0; i < 20; i++) {
      limit.addSample(0, 1, limit.currentLimit, true);
    }
    assert.ok(limit.currentLimit >= 10, `Limit ${limit.currentLimit} should not be below minLimit 10`);
  });

  it("should respect maxLimit", () => {
    const limit = new AIMDLimit({
      initialLimit: 20,
      maxLimit: 30,
    });

    // Repeated successful samples should not push above maxLimit
    for (let i = 0; i < 100; i++) {
      limit.addSample(0, 1, limit.currentLimit, false);
    }
    assert.ok(limit.currentLimit <= 30, `Limit ${limit.currentLimit} should not exceed maxLimit 30`);
  });

  it("should throw on invalid backoffRatio", () => {
    assert.throws(
      () => new AIMDLimit({ backoffRatio: 1.0 }),
      /Backoff ratio must be in the range/,
    );
    assert.throws(
      () => new AIMDLimit({ backoffRatio: 0.4 }),
      /Backoff ratio must be in the range/,
    );
  });

  it("should throw on non-positive timeout", () => {
    assert.throws(
      () => new AIMDLimit({ timeout: 0 }),
      /Timeout must be positive/,
    );
  });

  it("should have a working toString", () => {
    const limit = new AIMDLimit({ initialLimit: 25 });
    assert.ok(limit.toString().includes("AIMDLimit"));
    assert.ok(limit.toString().includes("25"));
  });
});
