import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AIMDLimit } from "./AIMDLimit.js";

describe("AIMDLimit", () => {
  it("should decrease limit on drop", () => {
    const limit = new AIMDLimit({
      initialLimit: 100,
      backoffRatio: 0.9,
      backoffJitter: 0,
    });

    limit.addSample(0, 1, 100, true);
    assert.equal(limit.currentLimit, 90);
  });

  it("should decrease limit when RTT exceeds timeout", () => {
    const limit = new AIMDLimit({
      initialLimit: 100,
      backoffRatio: 0.9,
      backoffJitter: 0,
      timeout: 1000,
    });

    limit.addSample(0, 2000, 100, false);
    assert.equal(limit.currentLimit, 90);
  });

  it("should apply jitter to the backoff ratio", () => {
    const observed = new Set<number>();
    for (let trial = 0; trial < 50; trial++) {
      const limit = new AIMDLimit({
        initialLimit: 1000,
        backoffRatio: 0.9,
        backoffJitter: 0.05,
        minLimit: 1,
        maxLimit: 2000,
      });

      limit.addSample(0, 1, 1000, true);
      observed.add(limit.currentLimit);
    }

    assert.ok(
      observed.size > 1,
      `Expected jitter to produce varying limits, but all 50 trials gave the same value`,
    );
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
      backoffJitter: 0,
    });

    for (let i = 0; i < 20; i++) {
      limit.addSample(0, 1, limit.currentLimit, true);
    }
    assert.ok(
      limit.currentLimit >= 10,
      `Limit ${limit.currentLimit} should not be below minLimit 10`,
    );
  });

  it("should respect maxLimit", () => {
    const limit = new AIMDLimit({
      initialLimit: 20,
      maxLimit: 30,
    });

    for (let i = 0; i < 100; i++) {
      limit.addSample(0, 1, limit.currentLimit, false);
    }
    assert.ok(
      limit.currentLimit <= 30,
      `Limit ${limit.currentLimit} should not exceed maxLimit 30`,
    );
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

  it("should throw on invalid backoffJitter", () => {
    assert.throws(
      () => new AIMDLimit({ backoffJitter: -0.01 }),
      /backoffJitter must be in the range/,
    );
    assert.throws(
      () => new AIMDLimit({ backoffJitter: 0.06 }),
      /backoffJitter must be in the range/,
    );
  });

  it("should have a working toString", () => {
    const limit = new AIMDLimit({ initialLimit: 25 });
    assert.ok(limit.toString().includes("AIMDLimit"));
    assert.ok(limit.toString().includes("25"));
  });

  describe("recovery probe", () => {
    it("defaults probeFromZeroInterval base to the configured timeout + applies exponential backoff", () => {
      const limit = new AIMDLimit({ timeout: 2_500 });
      assert.equal(limit.probeFromZeroInterval(0), 2_500);
      assert.equal(limit.probeFromZeroInterval(1), 5_000);
      assert.equal(limit.probeFromZeroInterval(3), 20_000);
    });

    it("uses the explicit recoveryProbe.baseMs when provided", () => {
      const limit = new AIMDLimit({
        timeout: 5_000,
        recoveryProbe: { baseMs: 250 },
      });
      assert.equal(limit.probeFromZeroInterval(0), 250);
      assert.equal(limit.probeFromZeroInterval(2), 1_000);
    });

    it("applyProbeFromZero raises the limit to 1 and notifies subscribers", () => {
      const limit = new AIMDLimit({
        initialLimit: 0,
        minLimit: 0,
        maxLimit: 100,
      });
      const seen: number[] = [];
      limit.subscribe((n) => seen.push(n));

      limit.applyProbeFromZero();

      assert.equal(limit.currentLimit, 1);
      assert.deepEqual(seen, [1]);
    });

    it("rejects non-positive recoveryProbe.baseMs", () => {
      assert.throws(
        () => new AIMDLimit({ recoveryProbe: { baseMs: 0 } }),
        /recoveryProbe\.baseMs must be > 0/,
      );
    });
  });
});
