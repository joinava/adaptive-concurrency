import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Limiter, withLimiter } from "./Limiter.js";
import type { AcquireStrategy } from "./Limiter.js";
import type { AdaptiveLimit } from "./limit/StreamingLimit.js";
import { FixedLimit } from "./limit/FixedLimit.js";
import { SettableLimit } from "./limit/SettableLimit.js";
import {
  AdaptiveTimeoutError,
  QuotaNotAvailable,
  dropped,
  ignore,
  isAdaptiveTimeoutError,
  success,
} from "./RunResult.js";

describe("Limiter (default SemaphoreStrategy)", () => {
  it("should use limiter capacity until total limit is reached", async () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(10),
    });

    for (let i = 0; i < 10; i++) {
      const listener = await limiter.acquire({ context: "test" });
      assert.ok(listener, `Should acquire token ${i}`);
    }

    const rejected = await limiter.acquire({ context: "test" });
    assert.equal(rejected, undefined, "Should reject when at limit");
  });

  it("should release limit when allotment completes", async () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
    });

    const listener1 = await limiter.acquire({ context: "test" });
    assert.ok(listener1);

    assert.equal(await limiter.acquire({ context: "test" }), undefined);

    await listener1.releaseAndRecordSuccess();
    const listener2 = await limiter.acquire({ context: "test" });
    assert.ok(listener2, "Should be able to acquire after release");
  });

  it("should bypass limit when bypass resolver returns true", async () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
      bypassResolver: (ctx) => ctx === "admin",
    });

    const listener1 = await limiter.acquire({ context: "normal" });
    assert.ok(listener1);
    assert.equal(await limiter.acquire({ context: "normal" }), undefined);

    const bypass = await limiter.acquire({ context: "admin" });
    assert.ok(bypass, "Admin should bypass the limit");
  });

  it("should bypass when any bypass resolver matches", async () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
      bypassResolver: (ctx) => ctx.startsWith("internal-") || ctx === "admin",
    });

    const listener1 = await limiter.acquire({ context: "normal" });
    assert.ok(listener1);
    assert.equal(await limiter.acquire({ context: "normal" }), undefined);

    assert.ok(
      await limiter.acquire({ context: "internal-health" }),
      "Internal request should bypass",
    );
    assert.ok(await limiter.acquire({ context: "admin" }), "Admin should bypass");
  });

  it("should not bypass when no resolver is configured", async () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
    });

    const listener1 = await limiter.acquire({ context: "admin" });
    assert.ok(listener1);

    assert.equal(await limiter.acquire({ context: "admin" }), undefined);
  });

  it("should track inflight count correctly", async () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(10),
    });

    assert.equal(limiter.getInflight(), 0);

    const listener = (await limiter.acquire({ context: "test" }))!;
    assert.equal(limiter.getInflight(), 1);

    await listener.releaseAndRecordSuccess();
    assert.equal(limiter.getInflight(), 0);
  });

  it("should adjust permits when limit changes", async () => {
    const limit = new SettableLimit(5);
    const limiter = new Limiter<string>({ limit });

    for (let i = 0; i < 5; i++) {
      await limiter.acquire({ context: "test" });
    }
    assert.equal(await limiter.acquire({ context: "test" }), undefined);

    limit.setLimit(10);

    const extra = await limiter.acquire({ context: "test" });
    assert.ok(extra, "Should acquire after limit increase");
  });

  it("should release permits on ignore", async () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
    });

    const listener = (await limiter.acquire({ context: "test" }))!;
    await listener.releaseAndIgnore();

    const next = await limiter.acquire({ context: "test" });
    assert.ok(next, "Should acquire after releaseAndIgnore release");
  });

  it("should release permits on dropped", async () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
    });

    const listener = (await limiter.acquire({ context: "test" }))!;
    await listener.releaseAndRecordDropped();

    const next = await limiter.acquire({ context: "test" });
    assert.ok(next, "Should acquire after releaseAndRecordDropped release");
  });

  it("should measure RTT before awaiting onAllotmentReleased", async () => {
    let now = 100;
    const samples: Array<{
      startTime: number;
      rtt: number;
      inflight: number;
      didDrop: boolean;
    }> = [];

    const limit: AdaptiveLimit = {
      get currentLimit() {
        return 1;
      },
      subscribe() {
        return () => {};
      },
      addSample(startTime, rtt, inflight, didDrop) {
        samples.push({ startTime, rtt, inflight, didDrop });
      },
    };

    let resolveRelease: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const acquireStrategy: AcquireStrategy<string> = {
      tryAcquireAllotment() {
        return true;
      },
      async onAllotmentReleased() {
        await releaseGate;
      },
      onLimitChanged() {},
    };

    const limiter = new Limiter<string>({
      limit,
      acquireStrategy,
      clock: () => now,
    });

    const allotment = await limiter.acquire({ context: "test" });
    assert.ok(allotment);

    now = 130;
    const releasePromise = allotment.releaseAndRecordSuccess();

    // Advance time while strategy cleanup is still pending; this should not
    // affect the RTT sample.
    now = 1000;
    resolveRelease?.();
    await releasePromise;

    assert.equal(samples.length, 1);
    assert.deepEqual(samples[0], {
      startTime: 100,
      rtt: 30,
      inflight: 1,
      didDrop: false,
    });
  });

  describe("withLimiter", () => {
    it("returns value on success and releases slot", async () => {
      const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
      const limited = withLimiter(limiter);

      const v = await limited({ context: "a" }, async () => success(42));
      assert.equal(v, 42);

      const again = await limited({ context: "a" }, () => success("ok"));
      assert.equal(again, "ok");
    });

    it("treats plain callback returns as implicit success", async () => {
      const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
      const limited = withLimiter(limiter);

      const v = await limited({ context: "a" }, () => 42);
      assert.equal(v, 42);

      // Verify slot was released as success.
      const again = await limiter.acquire({ context: "a" });
      assert.ok(again);
    });

    it("treats malformed run-result-like objects as implicit success", async () => {
      const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
      const limited = withLimiter(limiter);

      const malformed = { kind: "success" } as const;
      const v = await limited({ context: "a" }, () => malformed);
      assert.equal(v, malformed);

      // Verify slot was released as success.
      const again = await limiter.acquire({ context: "a" });
      assert.ok(again);
    });

    it("returns QuotaNotAvailable when no allotment and does not run fn", async () => {
      const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
      const limited = withLimiter(limiter);
      await limiter.acquire({ context: "a" });

      let ran = false;
      const out = await limited({ context: "a" }, async () => {
        ran = true;
        return success(null);
      });

      assert.equal(out, QuotaNotAvailable);
      assert.equal(ran, false);
    });

    it("releases on ignore", async () => {
      const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
      const limited = withLimiter(limiter);

      const v = await limited({ context: "a" }, () => ignore(7));
      assert.equal(v, 7);

      const next = await limiter.acquire({ context: "a" });
      assert.ok(next);
    });

    it("throws on dropped after reporting drop", async () => {
      const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
      const limited = withLimiter(limiter);
      const err = new Error("overload");

      await assert.rejects(
        limited({ context: "a" }, () => dropped(err)),
        (e: unknown) => e === err,
      );

      assert.ok(await limiter.acquire({ context: "a" }));
    });

    it("reports ignore and rethrows on unknown callback throw", async () => {
      const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
      const limited = withLimiter(limiter);
      const boom = new Error("boom");

      await assert.rejects(
        limited({ context: "a" }, async () => {
          throw boom;
        }),
        (e: unknown) => e === boom,
      );

      assert.ok(await limiter.acquire({ context: "a" }));
    });

    it("reports drop and rethrows on AdaptiveTimeoutError throw", async () => {
      const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
      const limited = withLimiter(limiter);
      const timeout = new AdaptiveTimeoutError("timed out");

      await assert.rejects(
        limited({ context: "a" }, async () => {
          throw timeout;
        }),
        (e: unknown) => e === timeout,
      );

      assert.ok(await limiter.acquire({ context: "a" }));
    });

    it("passes acquire options (context)", async () => {
      const limiter = new Limiter<string>({
        limit: new FixedLimit(1),
        bypassResolver: (c) => c === "vip",
      });
      const limited = withLimiter(limiter);

      await limiter.acquire({ context: "norm" });
      const q = await limited({ context: "norm" }, () => success(1));
      assert.equal(q, QuotaNotAvailable);

      const v = await limited({ context: "vip" }, () => success(2));
      assert.equal(v, 2);
    });

    it("passes { context, signal } into callback", async () => {
      const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
      const limited = withLimiter(limiter);
      const signal = new AbortController().signal;

      const out = await limited({ context: "tenant-a", signal }, ({ context, signal: cbSignal }) => {
        assert.equal(context, "tenant-a");
        assert.equal(cbSignal, signal);
        return success("ok");
      });

      assert.equal(out, "ok");
    });
  });

  describe("AdaptiveTimeoutError", () => {
    it("provides an error type guard", () => {
      assert.equal(isAdaptiveTimeoutError(new AdaptiveTimeoutError("x")), true);
      assert.equal(isAdaptiveTimeoutError({ code: "ADAPTIVE_TIMEOUT" }), true);
      assert.equal(isAdaptiveTimeoutError(new Error("x")), false);
    });
  });
});
