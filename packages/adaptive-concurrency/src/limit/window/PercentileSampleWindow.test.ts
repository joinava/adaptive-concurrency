import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPercentileSampleWindow } from "./PercentileSampleWindow.js";

function buildWindow(
  percentile: number,
  windowSize: number,
  rtts: number[],
) {
  let window = createPercentileSampleWindow(percentile, windowSize);
  for (const rtt of rtts) {
    window = window.addSample(rtt, 1, false);
  }
  return window;
}

describe("ImmutablePercentileSampleWindow", () => {
  it("should track the p50 RTT", () => {
    const window = buildWindow(0.5, 10, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
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

  describe("trackedRttMs percentile computation", () => {
    it("should compute p99 correctly", () => {
      const rtts = Array.from({ length: 100 }, (_, i) => i + 1);
      const window = buildWindow(0.99, 100, rtts);
      assert.equal(window.trackedRttMs, 99);
    });

    it("should compute p10 correctly", () => {
      const rtts = Array.from({ length: 100 }, (_, i) => i + 1);
      const window = buildWindow(0.1, 100, rtts);
      assert.equal(window.trackedRttMs, 10);
    });

    it("should handle unsorted input", () => {
      // Sorted would be [5, 10, 20, 30, 50] — p50 = round(5*0.5)-1 = index 2 = 20
      const window = buildWindow(0.5, 5, [50, 10, 30, 5, 20]);
      assert.equal(window.trackedRttMs, 20);
    });

    it("should handle reverse-sorted input", () => {
      const window = buildWindow(0.5, 5, [50, 40, 30, 20, 10]);
      // Sorted: [10,20,30,40,50] — p50 = round(5*0.5)-1 = index 2 = 30
      assert.equal(window.trackedRttMs, 30);
    });

    it("should handle duplicate values", () => {
      const window = buildWindow(0.5, 6, [10, 10, 10, 20, 20, 20]);
      // Sorted: [10,10,10,20,20,20] — p50 = round(6*0.5)-1 = index 2 = 10
      assert.equal(window.trackedRttMs, 10);
    });

    it("should handle all identical values", () => {
      const window = buildWindow(0.99, 5, [42, 42, 42, 42, 42]);
      assert.equal(window.trackedRttMs, 42);
    });

    it("should handle a single sample", () => {
      const window = buildWindow(0.5, 1, [77]);
      assert.equal(window.trackedRttMs, 77);
    });

    it("should handle two samples at various percentiles", () => {
      // Sorted: [10, 20]
      // p50: round(2*0.5)-1 = index 0 = 10
      assert.equal(buildWindow(0.5, 2, [20, 10]).trackedRttMs, 10);
      // p99: round(2*0.99)-1 = round(1.98)-1 = 2-1 = index 1 = 20
      assert.equal(buildWindow(0.99, 2, [20, 10]).trackedRttMs, 20);
    });

    it("should handle a partially-filled window", () => {
      // Window size 10, but only 4 samples added.
      // Sorted: [3, 7, 15, 22] — p50 = round(4*0.5)-1 = index 1 = 7
      const window = buildWindow(0.5, 10, [15, 3, 22, 7]);
      assert.equal(window.sampleCount, 4);
      assert.equal(window.trackedRttMs, 7);
    });

    it("should handle fractional RTT values", () => {
      const window = buildWindow(0.5, 5, [1.5, 2.7, 0.3, 4.1, 3.2]);
      // Sorted: [0.3, 1.5, 2.7, 3.2, 4.1] — p50 = round(5*0.5)-1 = index 2 = 2.7
      assert.equal(window.trackedRttMs, 2.7);
    });

    it("should produce correct results for p75 with 20 samples", () => {
      const rtts = Array.from({ length: 20 }, (_, i) => (i + 1) * 5);
      const window = buildWindow(0.75, 20, rtts);
      // Sorted: [5,10,...,100] — p75 = round(20*0.75)-1 = 15-1 = index 14 = 75
      assert.equal(window.trackedRttMs, 75);
    });

    it("should produce correct results for randomized input", () => {
      const rtts = [83, 17, 55, 91, 3, 42, 67, 29, 74, 38];
      const sorted = [...rtts].sort((a, b) => a - b);
      // sorted: [3, 17, 29, 38, 42, 55, 67, 74, 83, 91]

      for (const p of [0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
        const window = buildWindow(p, 10, rtts);
        const expectedIndex = Math.round(10 * p) - 1;
        assert.equal(
          window.trackedRttMs,
          sorted[expectedIndex],
          `p${p} expected ${sorted[expectedIndex]} at index ${expectedIndex}`,
        );
      }
    });

    it("should not corrupt earlier windows that share the backing array", () => {
      let w1 = createPercentileSampleWindow(0.5, 5);
      w1 = w1.addSample(50, 1, false);
      w1 = w1.addSample(10, 1, false);
      w1 = w1.addSample(30, 1, false);
      // w1 sees [50, 10, 30] — p50 = sorted[round(3*0.5)-1] = sorted[1] = 30

      const w2 = w1.addSample(5, 1, false);
      // w2 sees [50, 10, 30, 5] — p50 = sorted[round(4*0.5)-1] = sorted[1] = 10

      // Read w2 first so its internal selection can potentially mutate the shared array.
      assert.equal(w2.trackedRttMs, 10);
      // w1 must still return the correct value despite sharing the same backing array.
      assert.equal(w1.trackedRttMs, 30);
    });

    it("should return the same value on repeated reads", () => {
      const window = buildWindow(0.5, 5, [50, 10, 30, 5, 20]);
      assert.equal(window.trackedRttMs, 20);
      assert.equal(window.trackedRttMs, 20);
      assert.equal(window.trackedRttMs, 20);
    });
  });
});
