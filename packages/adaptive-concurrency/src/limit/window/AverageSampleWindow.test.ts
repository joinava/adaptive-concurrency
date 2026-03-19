import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeAverageSampleWindow } from "./AverageSampleWindow.js";

describe("ImmutableAverageSampleWindow", () => {
  it("should track minimum RTT as candidate", () => {
    let window = makeAverageSampleWindow();
    window = window.addSample(50, 5, false);
    window = window.addSample(30, 8, false);
    window = window.addSample(70, 3, false);

    assert.equal(window.candidateRttMs, 30);
  });

  it("should track average RTT as tracked RTT", () => {
    let window = makeAverageSampleWindow();
    window = window.addSample(10, 1, false);
    window = window.addSample(20, 2, false);
    window = window.addSample(30, 3, false);

    assert.equal(window.trackedRttMs, 20); // (10+20+30)/3
  });

  it("should track max inflight", () => {
    let window = makeAverageSampleWindow();
    window = window.addSample(10, 5, false);
    window = window.addSample(10, 10, false);
    window = window.addSample(10, 3, false);

    assert.equal(window.maxInFlight, 10);
  });

  it("should track sample count", () => {
    let window = makeAverageSampleWindow();
    assert.equal(window.sampleCount, 0);

    window = window.addSample(10, 1, false);
    assert.equal(window.sampleCount, 1);

    window = window.addSample(20, 2, false);
    assert.equal(window.sampleCount, 2);
  });

  it("should track if any sample was dropped", () => {
    let window = makeAverageSampleWindow();
    assert.equal(window.dropped, false);

    window = window.addSample(10, 1, false);
    assert.equal(window.dropped, false);

    window = window.addSample(10, 1, true);
    assert.equal(window.dropped, true);

    // Once dropped, stays dropped
    window = window.addSample(10, 1, false);
    assert.equal(window.dropped, true);
  });

  it("should return 0 for tracked RTT with no samples", () => {
    const window = makeAverageSampleWindow();
    assert.equal(window.trackedRttMs, 0);
  });

  it("should return Infinity for candidate RTT with no samples", () => {
    const window = makeAverageSampleWindow();
    assert.equal(window.candidateRttMs, Infinity);
  });
});
