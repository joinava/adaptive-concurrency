import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GradientLimit } from "./GradientLimit.js";

describe("Gradient2Limit", () => {
  it("should not change when inflight is well below the limit (app limited)", () => {
    const limit = new GradientLimit({ initialLimit: 50 });

    limit.addSample(0, 10, 1, false);
    assert.equal(limit.currentLimit, 50);
  });

  it("should increase the limit when gradient is favorable and inflight is high", () => {
    const limit = new GradientLimit({
      initialLimit: 20,
      minLimit: 1,
      maxConcurrency: 200,
    });

    // Simulate many requests at the limit with consistent RTT
    for (let i = 0; i < 50; i++) {
      limit.addSample(0, 10, 20, false);
    }
    assert.ok(limit.currentLimit >= 20, "Limit should stay or increase");
  });

  it("should decrease the limit when RTT spikes", () => {
    const limit = new GradientLimit({
      initialLimit: 50,
      minLimit: 1,
      maxConcurrency: 200,
      smoothing: 1.0,
    });

    // Establish a baseline with low RTT and inflight at the limit (above
    // estimatedLimit/2 so the algorithm doesn't treat us as app-limited).
    for (let i = 0; i < 100; i++) {
      limit.addSample(0, 10, limit.currentLimit, false);
    }
    const limitBefore = limit.currentLimit;

    // Now spike the RTT significantly (10x) while keeping inflight at the
    // current limit. The gradient (longRtt/shortRtt) becomes < 1 since the
    // long-term average lags behind the current spike.
    for (let i = 0; i < 100; i++) {
      limit.addSample(0, 1000, limit.currentLimit, false);
    }

    assert.ok(
      limit.currentLimit < limitBefore,
      "Limit should decrease when RTT spikes",
    );
  });

  it("should respect minLimit", () => {
    const limit = new GradientLimit({
      initialLimit: 20,
      minLimit: 10,
      maxConcurrency: 200,
    });

    // Drive the limit down with spiking RTT
    for (let i = 0; i < 200; i++) {
      limit.addSample(0, 100 + i * 10, 20, false);
    }

    assert.ok(
      limit.currentLimit >= 10,
      `Limit ${limit.currentLimit} should not be below minLimit 10`,
    );
  });

  it("should respect maxConcurrency", () => {
    const limit = new GradientLimit({
      initialLimit: 20,
      minLimit: 1,
      maxConcurrency: 50,
    });

    // Drive the limit up with consistent low RTT
    for (let i = 0; i < 500; i++) {
      limit.addSample(0, 10, limit.currentLimit, false);
    }

    assert.ok(
      limit.currentLimit <= 50,
      `Limit ${limit.currentLimit} should not exceed maxConcurrency 50`,
    );
  });

  it("should throw on tolerance < 1.0", () => {
    assert.throws(
      () => new GradientLimit({ rttTolerance: 0.5 }),
      /Tolerance must be >= 1.0/,
    );
  });

  it("should have a working toString", () => {
    const limit = new GradientLimit({ initialLimit: 25 });
    assert.ok(limit.toString().includes("Gradient2Limit"));
  });

  describe("recovery probe", () => {
    it("falls back to recoveryProbe.baseMs when no RTT has been observed", () => {
      const limit = new GradientLimit({ recoveryProbe: { baseMs: 750 } });
      assert.equal(limit.probeFromZeroInterval(0), 750);
      assert.equal(limit.probeFromZeroInterval(2), 3_000);
    });

    it("derives the base from longRtt * 5 once samples have been observed", () => {
      const limit = new GradientLimit({
        initialLimit: 20,
        minLimit: 1,
        longWindow: 10,
      });

      // Feed enough samples that longRtt warms up to a stable positive value.
      for (let i = 0; i < 50; i++) limit.addSample(0, 100, 20, false);

      const interval = limit.probeFromZeroInterval(0);
      assert.ok(interval > 0, "interval should be positive");
      // longRtt should be near 100 after enough samples; allow some slack
      // since EMA warmup is approximate.
      assert.ok(
        interval >= 5 * 50 && interval <= 5 * 200,
        `expected ~5*longRtt, got ${interval}`,
      );
      assert.equal(
        limit.probeFromZeroInterval(2),
        limit.probeFromZeroInterval(0) * 4,
      );
    });

    it("applyProbeFromZero raises the limit to 1 from a 0-state", () => {
      const limit = new GradientLimit({
        initialLimit: 0,
        minLimit: 0,
        queueSize: 0,
      });
      const seen: number[] = [];
      limit.subscribe((n) => seen.push(n));

      limit.applyProbeFromZero();

      assert.equal(limit.currentLimit, 1);
      assert.deepEqual(seen, [1]);
    });

    it("rejects non-positive recoveryProbe.baseMs", () => {
      assert.throws(
        () => new GradientLimit({ recoveryProbe: { baseMs: 0 } }),
        /recoveryProbe\.baseMs must be > 0/,
      );
    });
  });
});
