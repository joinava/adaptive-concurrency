import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExpMovingAverage } from "./ExpMovingAverage.js";

describe("ExpMovingAverage", () => {
  it("should compute arithmetic mean during warmup", () => {
    const m = new ExpMovingAverage(100, 10);

    m.addSample(10);
    assert.equal(m.currentValue, 10);

    m.addSample(20);
    assert.equal(m.currentValue, 15);

    m.addSample(30);
    assert.equal(m.currentValue, 20);
  });

  it("should switch to exponential average after warmup", () => {
    const m = new ExpMovingAverage(10, 3);

    // Warmup phase (3 samples)
    m.addSample(100);
    m.addSample(100);
    m.addSample(100);
    assert.equal(m.currentValue, 100);

    // Now in EMA mode; adding a different value should shift the average
    const result = m.addSample(200);
    assert.ok(result > 100 && result < 200);
  });

  it("should reset to initial state", () => {
    const m = new ExpMovingAverage(10, 3);

    m.addSample(100);
    m.addSample(200);
    assert.notEqual(m.currentValue, 0);

    m.reset();
    assert.equal(m.currentValue, 0);
  });

  it("should support update operation", () => {
    const m = new ExpMovingAverage(10, 3);
    m.addSample(100);

    m.update((v) => v * 0.5);
    assert.equal(m.currentValue, 50);
  });
});
