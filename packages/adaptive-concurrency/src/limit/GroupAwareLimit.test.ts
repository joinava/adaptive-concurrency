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
          if (!counters.has(key)) counters.set(key, { count: 0, attrs: merged });
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 100,
      minLimit: 1,
      clock: () => t,
    });

    limit.addSample(0, 10, 50, true, "a");

    assert.ok(
      limit.currentLimit < 100,
      `Limit should decrease on drop, got ${limit.currentLimit}`,
    );
  });

  it("non-drop samples hold the limit when no group is warmed up", () => {
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minGroupSamples: 100,
      clock: () => t,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 20,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      clock: () => t,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      recentRttWindow: 10,
      clock: () => t,
    });

    for (let i = 0; i < 50; i++) {
      limit.addSample(i, 10, 40, false, "reads");
    }

    const limitBefore = limit.currentLimit;

    for (let i = 0; i < 50; i++) {
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 20,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      clock: () => t,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 20,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      recentRttWindow: 20,
      clock: () => t,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 30,
      activityHalfLife: 600_000,
      clock: () => t,
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
    let t = 0;
    const activityHalfLife = 1000;
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 10,
      activityHalfLife,
      clock: () => t,
    });

    for (let i = 0; i < 50; i++) {
      limit.addSample(i, 10, 40, false, "active");
    }

    t += 10 * activityHalfLife;

    const limitBefore = limit.currentLimit;
    limit.addSample(9999, 10, 40, false, "active");

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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 100,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      clock: () => t,
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

  // -----------------------------------------------------------------------
  // Bounds
  // -----------------------------------------------------------------------

  it("respects minLimit", () => {
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 20,
      minLimit: 10,
      maxLimit: 200,
      clock: () => t,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 20,
      minLimit: 1,
      maxLimit: 50,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      clock: () => t,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 100,
      minLimit: 1,
      clock: () => t,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      recentRttWindow: 10,
      clock: () => t,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 100,
      minLimit: 1,
      clock: () => t,
    });

    const observed: number[] = [];
    limit.subscribe((n) => observed.push(n));

    limit.addSample(0, 10, 50, true, "a");

    assert.ok(observed.length > 0, "Should have notified subscriber");
    assert.equal(observed[0], limit.currentLimit);
  });

  // -----------------------------------------------------------------------
  // Custom decrease function
  // -----------------------------------------------------------------------

  it("uses a custom decrease function", () => {
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 100,
      minLimit: 1,
      decrease: (lim, didDrop) => (didDrop ? lim - 50 : lim - 5),
      clock: () => t,
    });

    limit.addSample(0, 10, 50, true, "a");

    assert.equal(
      limit.currentLimit,
      50,
      "Custom decrease should subtract 50 on drop",
    );
  });

  // -----------------------------------------------------------------------
  // End-to-end comparison vs raw Vegas
  // -----------------------------------------------------------------------

  it("maintains a higher minimum limit than raw VegasLimit during a mix shift", () => {
    const FAST_RTT = 5;
    const SLOW_RTT = 50;

    function runGroupAware(): { min: number } {
      let t = 0;
      const limit = new GroupAwareLimit({
        initialLimit: 20,
        minLimit: 1,
        maxLimit: 200,
        minGroupSamples: 5,
        activityHalfLife: 600_000,
        clock: () => t,
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

      return { min: minLimit };
    }

    function runVegas(): { min: number } {
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

      return { min: minLimit };
    }

    const trials = 10;
    let vegasMinSum = 0;
    let groupAwareMinSum = 0;
    for (let t = 0; t < trials; t++) {
      vegasMinSum += runVegas().min;
      groupAwareMinSum += runGroupAware().min;
    }

    const vegasAvg = vegasMinSum / trials;
    const groupAwareAvg = groupAwareMinSum / trials;

    assert.ok(
      groupAwareAvg > vegasAvg,
      `GroupAwareLimit avg min (${groupAwareAvg.toFixed(0)}) should be higher than Vegas avg min (${vegasAvg.toFixed(0)}) during mix shift`,
    );
  });

  // -----------------------------------------------------------------------
  // Samples without operationName
  //
  // Unnamed samples do not contribute to any group's state (no histogram,
  // EMA, or activity counter update), but still participate in limit
  // decisions: drops decrease, and non-drops react to the existing
  // congestion signal from warmed-up groups.
  // -----------------------------------------------------------------------

  it("unnamed samples do not create groups or affect group state", () => {
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minGroupSamples: 5,
      clock: () => t,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 100,
      minLimit: 1,
      clock: () => t,
    });

    limit.addSample(0, 10, 50, true);

    assert.ok(
      limit.currentLimit < 100,
      `Unnamed drop should decrease limit, got ${limit.currentLimit}`,
    );
  });

  it("unnamed non-drop samples can trigger increase from existing group signal", () => {
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 20,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      clock: () => t,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minLimit: 1,
      maxLimit: 200,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      recentRttWindow: 10,
      clock: () => t,
    });

    // Warm up a named group with healthy RTTs.
    for (let i = 0; i < 50; i++) {
      limit.addSample(i, 10, 40, false, "reads");
    }

    // Spike the named group's RTT to make the congestion signal high.
    for (let i = 0; i < 50; i++) {
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
      clock: () => 0,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minGroupSamples: 100,
      clock: () => t,
      metricRegistry: registry,
    });

    limit.addSample(0, 10, 40, false, "a");

    const warmed = gauges.get("warmed_groups_count");
    assert.ok(warmed, "warmed_groups_count gauge should exist");
    assert.deepEqual(warmed.values, [0]);
  });

  it("emits congestion_signal and warmed_groups_count once groups warm up", () => {
    const { registry, gauges } = spyRegistry();
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      clock: () => t,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      clock: () => t,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minGroupSamples: 5,
      activityHalfLife: 600_000,
      clock: () => t,
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
    let t = 0;
    const limit = new GroupAwareLimit({
      initialLimit: 50,
      minLimit: 1,
      clock: () => t,
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
  // Recovery probe
  // -----------------------------------------------------------------------

  describe("recovery probe", () => {
    it("falls back to recoveryProbe.baseMs when no group is warmed", () => {
      const limit = new GroupAwareLimit({
        clock: () => 0,
        recoveryProbe: { baseMs: 750 },
      });
      assert.equal(limit.probeFromZeroInterval(0), 750);
      assert.equal(limit.probeFromZeroInterval(2), 3_000);
    });

    it("derives the base from weighted-mean recent RTT once groups are warm", () => {
      let t = 0;
      const limit = new GroupAwareLimit({
        initialLimit: 50,
        minGroupSamples: 5,
        activityHalfLife: 600_000,
        clock: () => t,
      });

      // Warm up two groups with very different recent RTTs (10 vs 50).
      // Equal sample counts mean equal weights, so the weighted-mean recent
      // RTT will be midway between them.
      for (let i = 0; i < 30; i++) {
        limit.addSample(i, 10, 40, false, "fast");
        limit.addSample(i, 50, 40, false, "slow");
      }

      const interval = limit.probeFromZeroInterval(0);
      // Expect 5 * mean(10, 50) = 150 ms
      assert.ok(interval === 150, `expected ~150 ms, got ${interval}`);
      assert.equal(
        limit.probeFromZeroInterval(3),
        limit.probeFromZeroInterval(0) * 8,
      );
    });

    it("applyProbeFromZero raises the limit to 1 even when minLimit is 0", () => {
      const limit = new GroupAwareLimit({
        initialLimit: 0,
        minLimit: 0,
        clock: () => 0,
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
