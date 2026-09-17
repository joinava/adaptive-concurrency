import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AIMDLimit } from "./AIMDLimit.js";

/**
 * Feeds `count` samples from consecutive flights: each sample starts after
 * the previous one ended, so the epoch gate admits every one of them.
 */
function feedFlights(
  limit: AIMDLimit,
  count: number,
  rtt: number,
  inflightFor: () => number,
  didDrop: boolean,
) {
  for (let i = 0; i < count; i++) {
    limit.addSample(i * rtt, rtt, inflightFor(), didDrop);
  }
}

describe("AIMDLimit", () => {
  it("should decrease limit on drop", () => {
    const limit = new AIMDLimit({
      initialLimit: 100,
      decrease: { ratio: 0.9, jitter: 0 },
    });

    limit.addSample(0, 1, 100, true);
    assert.equal(limit.currentLimit, 90);
  });

  it("should decrease limit when RTT exceeds timeout", () => {
    const limit = new AIMDLimit({
      initialLimit: 100,
      decrease: { ratio: 0.9, jitter: 0 },
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
        decrease: { ratio: 0.9, jitter: 0.05 },
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

  it("minUtilizationToGrow sets the inflight fraction needed to grow", () => {
    const limit = new AIMDLimit({ initialLimit: 20, minUtilizationToGrow: 1 });

    limit.addSample(0, 1, 19, false);
    assert.equal(limit.currentLimit, 20, "19 of 20 in flight: app-limited");

    limit.addSample(10, 1, 20, false);
    assert.equal(limit.currentLimit, 21, "20 of 20 in flight: grow");

    assert.throws(
      () => new AIMDLimit({ minUtilizationToGrow: 0 }),
      /minUtilizationToGrow must be in \(0, 1\]/,
    );
    assert.throws(
      () => new AIMDLimit({ minUtilizationToGrow: 1.1 }),
      /minUtilizationToGrow must be in \(0, 1\]/,
    );
  });

  it("should respect minLimit", () => {
    const limit = new AIMDLimit({
      initialLimit: 20,
      minLimit: 10,
      decrease: { ratio: 0.5, jitter: 0 },
    });

    feedFlights(limit, 20, 1, () => limit.currentLimit, true);
    assert.equal(limit.currentLimit, 10);
  });

  it("should respect maxLimit", () => {
    const limit = new AIMDLimit({
      initialLimit: 20,
      maxLimit: 30,
    });

    feedFlights(limit, 100, 1, () => limit.currentLimit, false);
    assert.equal(limit.currentLimit, 30);
  });

  describe("one change per flight", () => {
    it("a burst of drops from one flight decreases the limit once", () => {
      const limit = new AIMDLimit({
        initialLimit: 100,
        minLimit: 1,
        decrease: { ratio: 0.9, jitter: 0 },
      });

      // Twenty requests all started at t=0 and all dropped: one episode.
      for (let i = 0; i < 20; i++) {
        limit.addSample(0, 50, 100, true);
      }
      assert.equal(limit.currentLimit, 90);

      // A drop from a request started after the decrease is a new episode.
      limit.addSample(60, 50, 90, true);
      assert.equal(limit.currentLimit, 81);
    });

    it("successes from one flight increase the limit once", () => {
      const limit = new AIMDLimit({ initialLimit: 20, maxLimit: 200 });

      for (let i = 0; i < 20; i++) {
        limit.addSample(0, 50, 20, false);
      }
      assert.equal(limit.currentLimit, 21);

      limit.addSample(60, 50, 21, false);
      assert.equal(limit.currentLimit, 22);
    });

    it("gates increases and decreases independently", () => {
      const limit = new AIMDLimit({
        initialLimit: 100,
        minLimit: 1,
        maxLimit: 200,
        decrease: { ratio: 0.9, jitter: 0 },
      });

      limit.addSample(0, 10, 100, false); // increase -> 101
      // A drop from the same flight is not blocked by the increase.
      limit.addSample(0, 10, 101, true); // decrease -> 90
      assert.equal(limit.currentLimit, 90);
    });
  });

  it("should throw on invalid decrease options", () => {
    assert.throws(
      () => new AIMDLimit({ decrease: { ratio: 1.0 } }),
      /decrease\.ratio must be in the range/,
    );
    assert.throws(
      () => new AIMDLimit({ decrease: { ratio: 0.4 } }),
      /decrease\.ratio must be in the range/,
    );
    assert.throws(
      () => new AIMDLimit({ decrease: { jitter: -0.01 } }),
      /decrease\.jitter must be in the range/,
    );
    assert.throws(
      () => new AIMDLimit({ decrease: { jitter: 0.06 } }),
      /decrease\.jitter must be in the range/,
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
