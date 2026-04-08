import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DecayingHistogram } from "./DecayingHistogram.js";

describe("DecayingHistogram", () => {
  it("returns NaN for percentile of empty histogram", () => {
    const h = new DecayingHistogram({ halfLife: 60_000 });
    assert.ok(Number.isNaN(h.percentile(0.1, 0)));
    assert.equal(h.totalCount, 0);
  });

  it("returns the single bin edge for a single sample", () => {
    const h = new DecayingHistogram({ halfLife: 60_000 });
    h.addSample(10, 0);
    const p10 = h.percentile(0.1, 0);
    assert.ok(Number.isFinite(p10));
    assert.ok(p10 > 0);
    assert.equal(h.totalCount, 1);
  });

  it("p10 of uniform samples is approximately the 10th percentile", () => {
    const h = new DecayingHistogram({ halfLife: 600_000 });

    for (let i = 0; i < 1000; i++) {
      const value = 1 + (99 * i) / 999;
      h.addSample(value, 0);
    }

    const p10 = h.percentile(0.1, 0);

    assert.ok(
      p10 >= 5 && p10 <= 20,
      `p10 = ${p10.toFixed(2)}, expected roughly 10 (within bin resolution)`,
    );
  });

  it("p50 of uniform samples is approximately the median", () => {
    const h = new DecayingHistogram({ halfLife: 600_000 });

    for (let i = 0; i < 1000; i++) {
      const value = 1 + (99 * i) / 999;
      h.addSample(value, 0);
    }

    const p50 = h.percentile(0.5, 0);

    assert.ok(
      p50 >= 30 && p50 <= 80,
      `p50 = ${p50.toFixed(2)}, expected roughly 50 (within bin resolution)`,
    );
  });

  it("p10 is robust to congestion spikes in the upper percentiles", () => {
    const h = new DecayingHistogram({ halfLife: 600_000 });

    for (let i = 0; i < 500; i++) {
      h.addSample(10 + Math.random() * 2, 0);
    }

    const p10Before = h.percentile(0.1, 0);

    for (let i = 0; i < 200; i++) {
      h.addSample(100, 0);
    }

    const p10After = h.percentile(0.1, 0);

    assert.ok(
      Math.abs(p10After - p10Before) / p10Before < 0.5,
      `p10 shifted from ${p10Before.toFixed(2)} to ${p10After.toFixed(2)} after congestion spike`,
    );
  });

  it("old samples decay and p10 shifts toward recent data", () => {
    const halfLife = 10_000;
    const h = new DecayingHistogram({ halfLife });

    for (let i = 0; i < 500; i++) {
      h.addSample(10, 0);
    }

    assert.ok(h.percentile(0.1, 0) <= 15);

    const laterTime = 5 * halfLife;
    for (let i = 0; i < 500; i++) {
      h.addSample(50, laterTime);
    }

    const p10 = h.percentile(0.1, laterTime);

    assert.ok(
      p10 >= 30,
      `After 5 half-lives, p10 (${p10.toFixed(2)}) should be near 50ms, not 10ms`,
    );
  });

  it("totalCount decays over time", () => {
    const halfLife = 1000;
    const h = new DecayingHistogram({ halfLife });

    for (let i = 0; i < 100; i++) {
      h.addSample(10, 0);
    }

    assert.equal(h.totalCount, 100);

    h.percentile(0.5, halfLife);
    assert.ok(
      h.totalCount > 45 && h.totalCount < 55,
      `After 1 half-life, totalCount (${h.totalCount.toFixed(1)}) should be ~50`,
    );
  });

  it("calls logWarning for samples below the minimum bin edge", () => {
    const warnings: string[] = [];
    const h = new DecayingHistogram({
      halfLife: 60_000,
      minValue: 1.0,
      maxValue: 1000,
      logWarning: (msg) => warnings.push(msg),
    });

    h.addSample(0.001, 0);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes("below minValue"));

    h.addSample(0.002, 0);
    assert.equal(warnings.length, 2);

    const p = h.percentile(0.5, 0);
    assert.ok(Number.isFinite(p));
  });

  it("calls logWarning for samples above the maximum bin edge", () => {
    const warnings: string[] = [];
    const h = new DecayingHistogram({
      halfLife: 60_000,
      minValue: 0.1,
      maxValue: 100,
      logWarning: (msg) => warnings.push(msg),
    });

    h.addSample(99999, 0);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes("above maxValue"));

    const p = h.percentile(0.5, 0);
    assert.ok(Number.isFinite(p));
  });

  it("all samples in one bin produces a single-valued percentile", () => {
    const h = new DecayingHistogram({ halfLife: 60_000 });

    for (let i = 0; i < 100; i++) {
      h.addSample(10, 0);
    }

    const p10 = h.percentile(0.1, 0);
    const p90 = h.percentile(0.9, 0);

    assert.equal(p10, p90);
  });

  it("throws on invalid halfLife", () => {
    assert.throws(
      () => new DecayingHistogram({ halfLife: 0 }),
      /halfLife must be positive/,
    );
    assert.throws(
      () => new DecayingHistogram({ halfLife: -1 }),
      /halfLife must be positive/,
    );
  });

  it("throws on invalid min/max range", () => {
    assert.throws(
      () =>
        new DecayingHistogram({ halfLife: 1000, minValue: 0, maxValue: 100 }),
      /0 < minValue < maxValue/,
    );
    assert.throws(
      () =>
        new DecayingHistogram({ halfLife: 1000, minValue: 100, maxValue: 50 }),
      /0 < minValue < maxValue/,
    );
  });
});
