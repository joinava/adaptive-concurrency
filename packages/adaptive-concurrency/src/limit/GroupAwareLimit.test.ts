import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MetricRegistry } from "../MetricRegistry.js";
import { GroupAwareLimit } from "./GroupAwareLimit.js";
import { VegasLimit } from "./VegasLimit.js";

function spyRegistry() {
  const distributions = new Map<
    string,
    { samples: number[]; attrs?: Record<string, string> }
  >();
  const gauges = new Map<
    string,
    { values: number[]; attrs?: Record<string, string> }
  >();
  const counters = new Map<
    string,
    { count: number; attrs?: Record<string, string> }
  >();

  // Compose registration-time and per-call attributes when bucketing, so each
  // unique tag combination ends up in its own series — mirroring how a real
  // dimensional-metrics registry (OpenTelemetry, Prometheus, etc.) demuxes.
  // Buckets are created lazily on first record to keep empty series out of
  // the maps.
  function bucketKey(
    id: string,
    regAttrs: Record<string, string> | undefined,
    recordAttrs: Record<string, string> | undefined,
  ): { key: string; merged: Record<string, string> | undefined } {
    const merged = { ...(regAttrs ?? {}), ...(recordAttrs ?? {}) };
    if (Object.keys(merged).length === 0) {
      return { key: id, merged: undefined };
    }
    return { key: `${id}:${JSON.stringify(merged)}`, merged };
  }

  const registry: MetricRegistry = {
    distribution(id, regAttrs) {
      return {
        addSample(v: number) {
          const { key, merged } = bucketKey(id, regAttrs, undefined);
          if (!distributions.has(key))
            distributions.set(key, { samples: [], attrs: merged });
          distributions.get(key)!.samples.push(v);
        },
      };
    },
    gauge(id, regAttrs) {
      return {
        record(v: number, recordAttrs?: Record<string, string>) {
          const { key, merged } = bucketKey(id, regAttrs, recordAttrs);
          if (!gauges.has(key)) gauges.set(key, { values: [], attrs: merged });
          gauges.get(key)!.values.push(v);
        },
      };
    },
    counter(id, regAttrs) {
      return {
        add(value: number, recordAttrs?: Record<string, string>) {
          const { key, merged } = bucketKey(id, regAttrs, recordAttrs);
          if (!counters.has(key))
            counters.set(key, { count: 0, attrs: merged });
          counters.get(key)!.count += value;
        },
      };
    },
  };

  return { registry, distributions, gauges, counters };
}

describe("GroupAwareLimit", () => {
  // -----------------------------------------------------------------------
  // Cold start / drop-only mode
  // -----------------------------------------------------------------------

  it("drops reduce the limit before any group warms up", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 100,
      minLimit: 1,
    });

    limit.addSample(0, 10, 50, true, "a");

    assert.ok(
      limit.currentLimit < 100,
      `Limit should decrease on drop, got ${limit.currentLimit}`,
    );
  });

  it("non-drop samples hold the limit when no group is warmed up", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minGroupSamples: 100,
    });

    for (let i = 0; i < 10; i++) {
      limit.addSample(i, 10, 40, false, "a");
    }

    assert.equal(limit.currentLimit, 50, "Limit should hold in drop-only mode");
  });

  // -----------------------------------------------------------------------
  // Single group behavior
  // -----------------------------------------------------------------------

  it("increases the limit when congestion signal is low and inflight is high", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 20,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
    });

    for (let i = 0; i < 100; i++) {
      limit.addSample(
        i,
        10,
        Math.floor(limit.currentLimit * 0.8),
        false,
        "reads",
      );
    }

    assert.ok(
      limit.currentLimit > 20,
      `Limit should have increased, got ${limit.currentLimit}`,
    );
  });

  it("decreases the limit when congestion signal is high", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      recentRttWindow: 10,
    });

    for (let i = 0; i < 100; i++) {
      limit.addSample(i, 10, 40, false, "reads");
    }

    const limitBefore = limit.currentLimit;

    for (let i = 0; i < 30; i++) {
      limit.addSample(1000 + i, 100, 40, false, "reads");
    }

    assert.ok(
      limit.currentLimit < limitBefore,
      `Limit should decrease on RTT spike, was ${limitBefore}, now ${limit.currentLimit}`,
    );
  });

  // -----------------------------------------------------------------------
  // Mix shift resilience
  // -----------------------------------------------------------------------

  it("limit stays stable when traffic shifts from fast to slow group", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 20,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
    });

    for (let i = 0; i < 300; i++) {
      limit.addSample(
        i * 2,
        5,
        Math.floor(limit.currentLimit * 0.8),
        false,
        "fast",
      );
      limit.addSample(
        i * 2 + 1,
        50,
        Math.floor(limit.currentLimit * 0.8),
        false,
        "slow",
      );
    }

    const limitAfterMixed = limit.currentLimit;

    for (let i = 0; i < 300; i++) {
      limit.addSample(
        100000 + i,
        50,
        Math.floor(limit.currentLimit * 0.8),
        false,
        "slow",
      );
    }

    const limitAfterShift = limit.currentLimit;

    assert.ok(
      limitAfterShift >= limitAfterMixed * 0.7,
      `Limit dropped from ${limitAfterMixed} to ${limitAfterShift} after mix shift (should stay within 30%)`,
    );
  });

  // -----------------------------------------------------------------------
  // Real congestion detection
  // -----------------------------------------------------------------------

  it("detects real congestion even with mixed operation types", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 20,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      recentRttWindow: 20,
    });

    for (let i = 0; i < 200; i++) {
      limit.addSample(
        i * 2,
        5,
        Math.floor(limit.currentLimit * 0.8),
        false,
        "fast",
      );
      limit.addSample(
        i * 2 + 1,
        50,
        Math.floor(limit.currentLimit * 0.8),
        false,
        "slow",
      );
    }

    const limitBefore = limit.currentLimit;

    for (let i = 0; i < 100; i++) {
      limit.addSample(
        10000 + i * 2,
        10,
        Math.floor(limit.currentLimit * 0.8),
        false,
        "fast",
      );
      limit.addSample(
        10000 + i * 2 + 1,
        100,
        Math.floor(limit.currentLimit * 0.8),
        false,
        "slow",
      );
    }

    assert.ok(
      limit.currentLimit < limitBefore,
      `Limit should decrease on real congestion, was ${limitBefore}, now ${limit.currentLimit}`,
    );
  });

  // -----------------------------------------------------------------------
  // Sparse groups excluded
  // -----------------------------------------------------------------------

  it("sparse groups do not influence the congestion signal", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 30,
      activityHalfLife: 600_000,
    });

    for (let i = 0; i < 100; i++) {
      limit.addSample(i, 10, 40, false, "popular");
    }

    const limitBefore = limit.currentLimit;

    for (let i = 0; i < 5; i++) {
      limit.addSample(5000 + i, 1000, 40, false, "rare");
    }

    assert.ok(
      limit.currentLimit >= limitBefore,
      `Limit should not decrease from sparse group, was ${limitBefore}, now ${limit.currentLimit}`,
    );
  });

  // -----------------------------------------------------------------------
  // Group staleness
  // -----------------------------------------------------------------------

  it("a group that goes quiet loses warmed-up status", () => {
    const activityHalfLife = 1000;
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 10,
      activityHalfLife,
    });

    for (let i = 0; i < 50; i++) {
      limit.addSample(i, 10, 40, false, "active");
    }

    // Activity decays on the sample's own time (`startTime + rtt`), so a
    // sample ten half-lives after the last one finds the group gone quiet.
    const limitBefore = limit.currentLimit;
    limit.addSample(10 * activityHalfLife, 10, 40, false, "active");

    assert.equal(
      limit.currentLimit,
      limitBefore,
      "Limit should hold when stale group is below warmup threshold",
    );
  });

  // -----------------------------------------------------------------------
  // Inflight guard
  // -----------------------------------------------------------------------

  it("does not increase when inflight is well below limit/2", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 100,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
    });

    for (let i = 0; i < 100; i++) {
      limit.addSample(i, 10, 5, false, "reads");
    }

    assert.equal(
      limit.currentLimit,
      100,
      "Limit should not increase when app-limited",
    );
  });

  it("minUtilizationToGrow sets the inflight fraction needed to grow", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 100,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      minUtilizationToGrow: 0.9,
    });

    for (let i = 0; i < 50; i++) {
      limit.addSample(i * 10, 10, 89, false, "reads");
    }
    assert.equal(limit.currentLimit, 100, "89 of 100 in flight: app-limited");

    // The threshold moves with the limit (0.9 × 101 after the first step),
    // so keep inflight clear of it for all five steps.
    for (let i = 0; i < 5; i++) {
      limit.addSample(1000 + i * 10, 10, 95, false, "reads");
    }
    assert.equal(limit.currentLimit, 105, "95 of 100 in flight: grow");

    assert.throws(
      () => new GroupAwareLimit({ minUtilizationToGrow: 0 }),
      /minUtilizationToGrow must be in \(0, 1\]/,
    );
  });

  // -----------------------------------------------------------------------
  // Bounds
  // -----------------------------------------------------------------------

  it("respects minLimit", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 20,
      minLimit: 10,
      maxLimit: 200,
    });

    for (let i = 0; i < 50; i++) {
      limit.addSample(i, 10, 15, true, "a");
    }

    assert.ok(
      limit.currentLimit >= 10,
      `Limit ${limit.currentLimit} should not be below minLimit 10`,
    );
  });

  it("respects maxLimit", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 20,
      minLimit: 1,
      maxLimit: 50,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
    });

    for (let i = 0; i < 500; i++) {
      limit.addSample(
        i,
        10,
        Math.floor(limit.currentLimit * 0.8),
        false,
        "reads",
      );
    }

    assert.ok(
      limit.currentLimit <= 50,
      `Limit ${limit.currentLimit} should not exceed maxLimit 50`,
    );
  });

  // -----------------------------------------------------------------------
  // Drop always decreases
  // -----------------------------------------------------------------------

  it("drop decreases regardless of group warmup state", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 100,
      minLimit: 1,
    });

    limit.addSample(0, 10, 50, true);
    assert.ok(limit.currentLimit < 100);
  });

  // -----------------------------------------------------------------------
  // Drop RTTs excluded from group state
  //
  // A dropped request's RTT reflects when the drop was detected (e.g. a
  // timeout), not the true operation latency. Including it would corrupt the
  // baseline and recent-RTT tracking that drive the congestion signal.
  // -----------------------------------------------------------------------

  it("dropped samples do not affect a group's baseline or recent RTT", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      recentRttWindow: 10,
    });

    // Warm up the "reads" group with a stable 10 ms RTT.
    for (let i = 0; i < 50; i++) {
      limit.addSample(i, 10, 40, false, "reads");
    }

    // Send a single drop with an extreme RTT (5000 ms) tagged to the same
    // group. This will decrease the limit (that's expected), but if the
    // drop's RTT leaked into the group's histogram or EMA, subsequent
    // healthy samples would see a corrupted congestion signal.
    limit.addSample(1000, 5000, 40, true, "reads");

    const limitAfterDrop = limit.currentLimit;

    // Now send healthy non-drop samples. If the group state is clean, the
    // congestion signal stays low (recentRtt / p10 ≈ 10/10 = 1.0) and the
    // limit should increase. If the 5000 ms RTT had leaked in, the signal
    // would be sky-high and the limit would decrease instead.
    for (let i = 0; i < 100; i++) {
      limit.addSample(
        2000 + i,
        10,
        Math.floor(limit.currentLimit * 0.8),
        false,
        "reads",
      );
    }

    assert.ok(
      limit.currentLimit > limitAfterDrop,
      `Limit should increase after drop (drop RTTs must not corrupt group state). ` +
        `Was ${limitAfterDrop} after drop, now ${limit.currentLimit}`,
    );
  });

  // -----------------------------------------------------------------------
  // Subscribe / currentLimit delegation
  // -----------------------------------------------------------------------

  it("notifies subscribers on limit changes", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 100,
      minLimit: 1,
    });

    const observed: number[] = [];
    limit.subscribe((n) => observed.push(n));

    limit.addSample(0, 10, 50, true, "a");

    assert.ok(observed.length > 0, "Should have notified subscriber");
    assert.equal(observed[0], limit.currentLimit);
  });

  // -----------------------------------------------------------------------
  // Decrease options
  // -----------------------------------------------------------------------

  it("applies the configured multiplicative decrease on drops and on congestion", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 100,
      minLimit: 1,
      minGroupSamples: 5,
      recentRttWindow: 10,
      decrease: { ratio: 0.5, jitter: 0 },
    });

    limit.addSample(0, 10, 50, true, "a");
    assert.equal(limit.currentLimit, 50, "drop: 100 * 0.5");

    for (let i = 0; i < 50; i++) {
      limit.addSample(100 + i, 10, 1, false, "a");
    }
    assert.equal(limit.currentLimit, 50, "healthy samples, app-limited: hold");

    for (let i = 0; i < 20; i++) {
      limit.addSample(1000 + i, 100, 40, false, "a");
    }
    assert.equal(limit.currentLimit, 25, "congestion: 50 * 0.5, once");
  });

  it("validates decrease, percentile, and threshold options", () => {
    assert.throws(
      () => new GroupAwareLimit({ decrease: { ratio: 1 } }),
      /decrease\.ratio/,
    );
    assert.throws(
      () => new GroupAwareLimit({ percentile: 1 }),
      /percentile must be in \(0, 1\)/,
    );
    assert.throws(
      () =>
        new GroupAwareLimit({
          rttRatioThresholds: { increaseBelow: 1.5, decreaseAbove: 1.2 },
        }),
      /decreaseAbove must be > increaseBelow/,
    );
  });

  // -----------------------------------------------------------------------
  // End-to-end comparison vs raw Vegas
  // -----------------------------------------------------------------------

  it("maintains a higher minimum limit than raw VegasLimit during a mix shift", () => {
    const FAST_RTT = 5;
    const SLOW_RTT = 50;

    function runGroupAware(): { before: number; min: number } {
      const limit = new GroupAwareLimit({
        initialLimit: 20,
        minLimit: 1,
        maxLimit: 200,
        minGroupSamples: 5,
        activityHalfLife: 600_000,
      });

      for (let i = 0; i < 500; i++) {
        limit.addSample(
          i * 2,
          FAST_RTT,
          Math.floor(limit.currentLimit * 0.8),
          false,
          "fast",
        );
        limit.addSample(
          i * 2 + 1,
          SLOW_RTT,
          Math.floor(limit.currentLimit * 0.8),
          false,
          "slow",
        );
      }

      const before = limit.currentLimit;
      let minLimit = limit.currentLimit;
      for (let i = 0; i < 200; i++) {
        limit.addSample(
          100000 + i,
          SLOW_RTT,
          Math.floor(limit.currentLimit * 0.8),
          false,
          "slow",
        );
        minLimit = Math.min(minLimit, limit.currentLimit);
      }

      return { before, min: minLimit };
    }

    function runVegas(): { before: number; min: number } {
      const limit = new VegasLimit({
        initialLimit: 20,
        maxConcurrency: 200,
        smoothing: 1.0,
      });

      for (let i = 0; i < 500; i++) {
        limit.addSample(
          i * 2,
          FAST_RTT,
          Math.floor(limit.currentLimit * 0.8),
          false,
        );
        limit.addSample(
          i * 2 + 1,
          SLOW_RTT,
          Math.floor(limit.currentLimit * 0.8),
          false,
        );
      }

      const before = limit.currentLimit;
      let minLimit = limit.currentLimit;
      for (let i = 0; i < 200; i++) {
        limit.addSample(
          100000 + i,
          SLOW_RTT,
          Math.floor(limit.currentLimit * 0.8),
          false,
        );
        minLimit = Math.min(minLimit, limit.currentLimit);
      }

      return { before, min: minLimit };
    }

    // Compare what each algorithm keeps of its own pre-shift limit: the
    // shift is a spurious RTT rise, so the right answer is to keep all of it.
    const trials = 10;
    let vegasRetained = 0;
    let groupAwareRetained = 0;
    for (let t = 0; t < trials; t++) {
      const vegas = runVegas();
      const groupAware = runGroupAware();
      vegasRetained += vegas.min / vegas.before;
      groupAwareRetained += groupAware.min / groupAware.before;
    }

    const vegasAvg = vegasRetained / trials;
    const groupAwareAvg = groupAwareRetained / trials;

    assert.ok(
      groupAwareAvg > vegasAvg,
      `GroupAwareLimit retained ${(groupAwareAvg * 100).toFixed(0)}% of its limit through the mix shift; Vegas retained ${(vegasAvg * 100).toFixed(0)}%`,
    );
  });

  // -----------------------------------------------------------------------
  // Samples without operationName
  //
  // Unnamed samples do not contribute to any group's state (no histogram
  // or activity counter update), but still participate in limit
  // decisions: drops decrease, and non-drops react to the existing
  // congestion signal from warmed-up groups.
  // -----------------------------------------------------------------------

  it("unnamed samples do not create groups or affect group state", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minGroupSamples: 5,
    });

    for (let i = 0; i < 100; i++) {
      limit.addSample(i, 10, 40, false);
    }

    assert.equal(
      limit.currentLimit,
      50,
      "Ungrouped samples should not trigger increase (no warmed-up groups)",
    );
  });

  it("unnamed drops still decrease the limit", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 100,
      minLimit: 1,
    });

    limit.addSample(0, 10, 50, true);

    assert.ok(
      limit.currentLimit < 100,
      `Unnamed drop should decrease limit, got ${limit.currentLimit}`,
    );
  });

  it("unnamed non-drop samples can trigger increase from existing group signal", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 20,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
    });

    // Warm up a named group with healthy RTTs.
    for (let i = 0; i < 50; i++) {
      limit.addSample(
        i,
        10,
        Math.floor(limit.currentLimit * 0.8),
        false,
        "reads",
      );
    }

    const limitBefore = limit.currentLimit;

    // Send unnamed samples with high inflight. The congestion signal from
    // the warmed-up "reads" group is healthy, so the limit should increase.
    for (let i = 0; i < 50; i++) {
      limit.addSample(
        1000 + i,
        10,
        Math.floor(limit.currentLimit * 0.8),
        false,
      );
    }

    assert.ok(
      limit.currentLimit > limitBefore,
      `Unnamed non-drop should increase limit when signal is healthy, was ${limitBefore}, now ${limit.currentLimit}`,
    );
  });

  it("unnamed non-drop samples can trigger decrease from existing group signal", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      recentRttWindow: 10,
    });

    // Warm up a named group with healthy RTTs.
    for (let i = 0; i < 100; i++) {
      limit.addSample(i, 10, 40, false, "reads");
    }

    // Spike the named group's RTT to make the congestion signal high: the
    // recent window is all spike, the baseline median is still healthy.
    for (let i = 0; i < 30; i++) {
      limit.addSample(500 + i, 100, 40, false, "reads");
    }

    const limitBefore = limit.currentLimit;

    // Now send an unnamed sample. The congestion signal from "reads" is
    // high, so this unnamed sample should trigger a decrease.
    limit.addSample(9999, 10, 40, false);

    assert.ok(
      limit.currentLimit <= limitBefore,
      `Unnamed non-drop should decrease limit when signal is congested, was ${limitBefore}, now ${limit.currentLimit}`,
    );
  });

  // -----------------------------------------------------------------------
  // toString
  // -----------------------------------------------------------------------

  it("toString includes limit and group count", () => {
    const limit = new GroupAwareLimit({
      initialLimit: 25,
    });

    limit.addSample(0, 10, 5, false, "a");
    const str = limit.toString();
    assert.ok(str.includes("GroupAwareLimit"));
    assert.ok(str.includes("groups=1"));
  });

  // -----------------------------------------------------------------------
  // Metrics
  // -----------------------------------------------------------------------

  it("emits warmed_groups_count=0 before any group warms up", () => {
    const { registry, gauges } = spyRegistry();
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minGroupSamples: 100,
      metricRegistry: registry,
    });

    limit.addSample(0, 10, 40, false, "a");

    const warmed = gauges.get("warmed_groups_count");
    assert.ok(warmed, "warmed_groups_count gauge should exist");
    assert.deepEqual(warmed.values, [0]);
  });

  it("emits congestion_signal and warmed_groups_count once groups warm up", () => {
    const { registry, gauges } = spyRegistry();
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      metricRegistry: registry,
    });

    for (let i = 0; i < 20; i++) {
      limit.addSample(i, 10, 40, false, "reads");
    }

    const signal = gauges.get("congestion_signal");
    assert.ok(signal, "congestion_signal gauge should exist");
    assert.ok(signal.values.length > 0, "should have recorded signal values");
    assert.ok(
      signal.values.every((s) => s > 0),
      "signal should be positive",
    );

    const warmed = gauges.get("warmed_groups_count");
    assert.ok(warmed, "warmed_groups_count gauge should exist");
    const nonZero = warmed.values.filter((v) => v > 0);
    assert.ok(nonZero.length > 0, "should have recorded warmed groups > 0");
    assert.ok(
      nonZero.every((v) => v === 1),
      "should be exactly 1 warmed group",
    );
  });

  it("emits per-group RTT ratio tagged by group name", () => {
    const { registry, gauges } = spyRegistry();
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      metricRegistry: registry,
    });

    for (let i = 0; i < 20; i++) {
      limit.addSample(i, 10, 40, false, "fast");
      limit.addSample(i, 50, 40, false, "slow");
    }

    const fastKey = `group_rtt_ratio:${JSON.stringify({ group: "fast" })}`;
    const slowKey = `group_rtt_ratio:${JSON.stringify({ group: "slow" })}`;

    const fast = gauges.get(fastKey);
    const slow = gauges.get(slowKey);
    assert.ok(fast, "should emit group_rtt_ratio for 'fast'");
    assert.ok(slow, "should emit group_rtt_ratio for 'slow'");
    assert.ok(fast.values.length > 0);
    assert.ok(slow.values.length > 0);
  });

  it("emits warmed_groups_count reflecting multiple warmed groups", () => {
    const { registry, gauges } = spyRegistry();
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      metricRegistry: registry,
    });

    for (let i = 0; i < 20; i++) {
      limit.addSample(i, 10, 40, false, "a");
      limit.addSample(i, 50, 40, false, "b");
      limit.addSample(i, 25, 40, false, "c");
    }

    const warmed = gauges.get("warmed_groups_count");
    assert.ok(warmed);
    const last = warmed.values[warmed.values.length - 1];
    assert.equal(last, 3, "all three groups should be warmed");
  });

  it("does not emit congestion_signal on drop samples", () => {
    const { registry, gauges } = spyRegistry();
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minLimit: 1,
      metricRegistry: registry,
    });

    limit.addSample(0, 10, 40, true, "a");

    const signal = gauges.get("congestion_signal");
    assert.equal(
      signal?.values.length ?? 0,
      0,
      "drops should not emit congestion_signal values",
    );
  });

  // -----------------------------------------------------------------------
  // One change per flight
  // -----------------------------------------------------------------------

  describe("one change per flight", () => {
    it("a burst of drops from one flight decreases the limit once", () => {
      const limit = new GroupAwareLimit({
        initialLimit: 100,
        minLimit: 1,
        decrease: { ratio: 0.9, jitter: 0 },
      });

      // Twenty requests, all started at t=0, all dropped: one episode.
      for (let i = 0; i < 20; i++) {
        limit.addSample(0, 50, 100, true, "a");
      }
      assert.equal(limit.currentLimit, 90);

      // A drop from a request admitted after the decrease is a new episode.
      limit.addSample(60, 50, 90, true, "a");
      assert.equal(limit.currentLimit, 81);
    });

    it("a burst of inflated RTTs from one flight decreases the limit once", () => {
      const limit = new GroupAwareLimit({
        initialLimit: 100,
        minLimit: 1,
        minGroupSamples: 5,
        recentRttWindow: 10,
        decrease: { ratio: 0.9, jitter: 0 },
      });

      for (let i = 0; i < 50; i++) {
        limit.addSample(i, 10, 1, false, "a");
      }
      assert.equal(limit.currentLimit, 100);

      // 150 requests started at t=1000 all observed at 10x the RTT: the
      // shape of a client-side stall, or one overload episode.
      for (let i = 0; i < 150; i++) {
        limit.addSample(1000, 100, 100, false, "a");
      }
      assert.equal(limit.currentLimit, 90);
    });

    it("successes from one flight increase the limit once", () => {
      const limit = new GroupAwareLimit({
        initialLimit: 20,
        minGroupSamples: 5,
      });

      for (let i = 0; i < 10; i++) {
        limit.addSample(i, 10, 1, false, "a");
      }
      assert.equal(limit.currentLimit, 20, "app-limited warmup: hold");

      for (let i = 0; i < 50; i++) {
        limit.addSample(1000, 10, 20, false, "a");
      }
      assert.equal(limit.currentLimit, 21);

      limit.addSample(1010, 10, 21, false, "a");
      assert.equal(limit.currentLimit, 22);
    });
  });

  // -----------------------------------------------------------------------
  // Estimator shape and resolution
  // -----------------------------------------------------------------------

  describe("congestion signal", () => {
    /** Log-normal RTT around `base`; sigma 0.3 gives p90/p10 of about 2.2. */
    function lognormal(base: number, sigma: number): number {
      const u = Math.random();
      const v = Math.random();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      return base * Math.exp(sigma * z);
    }

    it("reads a wide but stable latency distribution as uncongested", () => {
      const limit = new GroupAwareLimit({
        initialLimit: 20,
        maxLimit: 60,
        decrease: { jitter: 0 },
      });

      // One increase per flight of `limit` samples: climbing from 20 to 60
      // takes about 1,650 samples. 5,000 leaves room for any decrease to
      // show up as a limit below the max.
      let now = 0;
      for (let i = 0; i < 5000; i++) {
        const rtt = lognormal(300, 0.3);
        limit.addSample(now, rtt, limit.currentLimit, false, "a");
        now += rtt / limit.currentLimit;
      }

      assert.equal(limit.currentLimit, 60);
    });

    it("grows to the max whatever the base RTT's position within a histogram bin", () => {
      // Sweep base RTTs across a decade. A percentile that returned a bin
      // midpoint on one side and a mean on the other would read some of
      // these as congested and never grow.
      for (let k = 0; k < 20; k++) {
        const base = 100 * 10 ** (k / 20);
        const limit = new GroupAwareLimit({
          initialLimit: 20,
          maxLimit: 60,
          decrease: { jitter: 0 },
        });
        let now = 0;
        for (let i = 0; i < 4000; i++) {
          const rtt = base * (1 + (Math.random() - 0.5) * 0.1);
          limit.addSample(now, rtt, limit.currentLimit, false, "a");
          now += rtt / limit.currentLimit;
        }
        assert.equal(limit.currentLimit, 60, `base RTT ${base.toFixed(1)}`);
      }
    });

    it("still detects a real shift of the whole distribution", () => {
      const limit = new GroupAwareLimit({
        initialLimit: 100,
        minLimit: 1,
        decrease: { ratio: 0.9, jitter: 0 },
      });

      let now = 0;
      for (let i = 0; i < 2000; i++) {
        const rtt = lognormal(300, 0.3);
        limit.addSample(now, rtt, 1, false, "a");
        now += 1;
      }
      const before = limit.currentLimit;

      for (let i = 0; i < 200; i++) {
        const rtt = lognormal(600, 0.3);
        limit.addSample(now, rtt, 100, false, "a");
        now += 1;
      }

      assert.ok(
        limit.currentLimit < before,
        `2x shift should decrease the limit, was ${before}, now ${limit.currentLimit}`,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Recovery probe
  // -----------------------------------------------------------------------

  describe("recovery probe", () => {
    it("falls back to recoveryProbe.baseMs when no group is warmed", () => {
      const limit = new GroupAwareLimit({
        recoveryProbe: { baseMs: 750 },
      });
      assert.equal(limit.probeFromZeroInterval(0), 750);
      assert.equal(limit.probeFromZeroInterval(2), 3_000);
    });

    it("derives the base from weighted-mean recent RTT once groups are warm", () => {
      const limit = new GroupAwareLimit({
        initialLimit: 50,
        minGroupSamples: 5,
        activityHalfLife: 600_000,
      });

      // Warm up two groups with very different recent RTTs (10 vs 50).
      // Equal sample counts mean equal weights, so the weighted-mean recent
      // RTT will be midway between them.
      for (let i = 0; i < 30; i++) {
        limit.addSample(i, 10, 40, false, "fast");
        limit.addSample(i, 50, 40, false, "slow");
      }

      const interval = limit.probeFromZeroInterval(0);
      // Expect 5 * mean(10, 50) = 150 ms, within the histogram's ±6% bin
      // resolution on each RTT.
      assert.ok(
        interval > 150 * 0.94 && interval < 150 * 1.06,
        `expected ~150 ms, got ${interval}`,
      );
      assert.equal(
        limit.probeFromZeroInterval(3),
        limit.probeFromZeroInterval(0) * 8,
      );
    });

    it("reads group activity as of the last sample, so warm groups stay warm at limit 0", () => {
      const limit = new GroupAwareLimit({
        initialLimit: 50,
        minGroupSamples: 5,
        activityHalfLife: 1_000,
        recoveryProbe: { baseMs: 750 },
      });

      // Warm one group with a 20 ms RTT. The last sample ends at t = 29 + 20.
      for (let i = 0; i < 30; i++) {
        limit.addSample(i, 20, 40, false, "a");
      }

      // No sample arrives while the limit sits at 0, so no wall time passes
      // for the group: the base stays 5× its recent RTT, not the fallback,
      // however many half-lives elapse on the wall clock.
      const interval = limit.probeFromZeroInterval(0);
      assert.ok(
        interval > 100 * 0.94 && interval < 100 * 1.06,
        `expected ~100 ms, got ${interval}`,
      );

      // The next sample carries the elapsed time: 100 half-lives later the
      // group is cold, and the probe falls back to recoveryProbe.baseMs.
      limit.addSample(100_000, 20, 40, false, "a");
      assert.equal(limit.probeFromZeroInterval(0), 750);
    });

    it("applyProbeFromZero raises the limit to 1 even when minLimit is 0", () => {
      const limit = new GroupAwareLimit({
        initialLimit: 0,
        minLimit: 0,
      });
      const seen: number[] = [];
      limit.subscribe((n) => seen.push(n));

      limit.applyProbeFromZero();

      assert.equal(limit.currentLimit, 1);
      assert.deepEqual(seen, [1]);
    });

    it("rejects non-positive recoveryProbe.baseMs", () => {
      assert.throws(
        () => new GroupAwareLimit({ recoveryProbe: { baseMs: 0 } }),
        /recoveryProbe\.baseMs must be > 0/,
      );
    });
  });
});
