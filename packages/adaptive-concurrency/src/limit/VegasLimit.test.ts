import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VegasLimit } from "./VegasLimit.js";

describe("VegasLimit", () => {
  it("should increase the limit when inflight is high and RTT is low", () => {
    const limit = new VegasLimit({
      initialLimit: 10,
      smoothing: 1.0,
    });

    limit.addSample(0, 10, 10, false);
    assert.ok(limit.currentLimit >= 10, "Limit should not decrease");

    limit.addSample(0, 10, 10, false);
    assert.ok(limit.currentLimit >= 10, "Limit should stay the same or increase");
  });

  it("should decrease the limit on drop", () => {
    const limit = new VegasLimit({
      initialLimit: 100,
      smoothing: 1.0,
    });

    // First establish a baseline RTT
    limit.addSample(0, 10, 1, false);
    const limitBefore = limit.currentLimit;

    // Now simulate a drop with higher inflight
    limit.addSample(0, 10, 50, true);
    assert.ok(limit.currentLimit <= limitBefore, "Limit should decrease on drop");
  });

  it("should not change if within thresholds", () => {
    const limit = new VegasLimit({
      initialLimit: 10,
      smoothing: 1.0,
    });

    // When inflight is well below the limit, no change should happen
    limit.addSample(0, 10, 1, false);
    const afterSample = limit.currentLimit;
    limit.addSample(0, 10, 1, false);
    assert.equal(limit.currentLimit, afterSample);
  });

  it("should apply smoothing when configured", () => {
    const limit = new VegasLimit({
      initialLimit: 100,
      smoothing: 0.5,
    });

    // Establish baseline RTT
    limit.addSample(0, 10, 1, false);
    const limitBefore = limit.currentLimit;

    // Drop with high inflight
    limit.addSample(0, 50, 80, true);
    const limitAfter = limit.currentLimit;

    // With smoothing=0.5, the decrease should be dampened compared to
    // what it would be with smoothing=1.0
    assert.ok(limitAfter < limitBefore, "Limit should decrease on drop");
    assert.ok(limitAfter > limitBefore * 0.5, "Smoothing should dampen the decrease");
  });

  it("should throw on non-positive RTT", () => {
    const limit = new VegasLimit();

    assert.throws(
      () => limit.addSample(0, 0, 1, false),
      /rtt must be >0/,
    );

    assert.throws(
      () => limit.addSample(0, -1, 1, false),
      /rtt must be >0/,
    );
  });

  it("should respect maxConcurrency", () => {
    const limit = new VegasLimit({
      initialLimit: 10,
      maxConcurrency: 20,
      smoothing: 1.0,
    });

    // Pump many samples to drive the limit up
    for (let i = 0; i < 200; i++) {
      limit.addSample(0, 10, limit.currentLimit, false);
    }

    assert.ok(limit.currentLimit <= 20, `Limit ${limit.currentLimit} should not exceed maxConcurrency 20`);
  });

  it("should have a working toString", () => {
    const limit = new VegasLimit({ initialLimit: 10 });
    const str = limit.toString();
    assert.ok(str.includes("VegasLimit"));
    assert.ok(str.includes("limit=10"));
  });
});
