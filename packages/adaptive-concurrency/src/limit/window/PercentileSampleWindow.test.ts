import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPercentileSampleWindow } from "./PercentileSampleWindow.js";

describe("ImmutablePercentileSampleWindow", () => {
  it("should track the p50 RTT", () => {
    let window = createPercentileSampleWindow(0.5, 10);

    for (let i = 1; i <= 10; i++) {
      window = window.addSample(i * 10, i, false);
    }

    // p50 of [10,20,...,100] = 50
    assert.equal(window.trackedRttMs, 50);
  });

  it("should track min RTT as candidate", () => {
    let window = createPercentileSampleWindow(0.5, 10);
    window = window.addSample(50, 1, false);
    window = window.addSample(30, 2, false);
    window = window.addSample(70, 3, false);

    assert.equal(window.candidateRttMs, 30);
  });

  it("should stop accepting samples beyond window size", () => {
    let window = createPercentileSampleWindow(0.5, 3);
    window = window.addSample(10, 1, false);
    window = window.addSample(20, 2, false);
    window = window.addSample(30, 3, false);
    assert.equal(window.sampleCount, 3);

    // Fourth sample should be discarded
    window = window.addSample(5, 4, false);
    assert.equal(window.sampleCount, 3);
    // Min RTT should still be 10, not 5
    assert.equal(window.candidateRttMs, 10);
  });

  it("should throw for invalid percentile", () => {
    assert.throws(
      () => createPercentileSampleWindow(0, 10),
      /Percentile should belong to/,
    );
    assert.throws(
      () => createPercentileSampleWindow(1.0, 10),
      /Percentile should belong to/,
    );
  });

  it("should return 0 for tracked RTT with no samples", () => {
    const window = createPercentileSampleWindow(0.5, 10);
    assert.equal(window.trackedRttMs, 0);
  });
});
