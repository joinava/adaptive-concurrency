import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Limiter, withLimiter } from "../Limiter.js";
import { FixedLimit } from "../limit/FixedLimit.js";
import { SettableLimit } from "../limit/SettableLimit.js";
import {
  AdaptiveTimeoutError,
  QuotaNotAvailable,
  dropped,
  ignore,
  isAdaptiveTimeoutError,
  success,
} from "../RunResult.js";

describe("Limiter (default SemaphoreStrategy)", () => {
  it("should use limiter capacity until total limit is reached", () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(10),
    });

    for (let i = 0; i < 10; i++) {
      const listener = limiter.acquire({ context: "test" });
      assert.ok(listener, `Should acquire token ${i}`);
    }

    const rejected = limiter.acquire({ context: "test" });
    assert.equal(rejected, undefined, "Should reject when at limit");
  });

  it("should release limit when allotment completes", () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
    });

    const listener1 = limiter.acquire({ context: "test" });
    assert.ok(listener1);

    assert.equal(limiter.acquire({ context: "test" }), undefined);

    listener1.reportSuccess();
    const listener2 = limiter.acquire({ context: "test" });
    assert.ok(listener2, "Should be able to acquire after release");
  });

  it("should bypass limit when bypass resolver returns true", () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
      bypassResolver: (ctx) => ctx === "admin",
    });

    const listener1 = limiter.acquire({ context: "normal" });
    assert.ok(listener1);
    assert.equal(limiter.acquire({ context: "normal" }), undefined);

    const bypass = limiter.acquire({ context: "admin" });
    assert.ok(bypass, "Admin should bypass the limit");
  });

  it("should bypass when any bypass resolver matches", () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
      bypassResolver: (ctx) => ctx.startsWith("internal-") || ctx === "admin",
    });

    const listener1 = limiter.acquire({ context: "normal" });
    assert.ok(listener1);
    assert.equal(limiter.acquire({ context: "normal" }), undefined);

    assert.ok(limiter.acquire({ context: "internal-health" }), "Internal request should bypass");
    assert.ok(limiter.acquire({ context: "admin" }), "Admin should bypass");
  });

  it("should not bypass when no resolver is configured", () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
    });

    const listener1 = limiter.acquire({ context: "admin" });
    assert.ok(listener1);

    assert.equal(limiter.acquire({ context: "admin" }), undefined);
  });

  it("should track inflight count correctly", () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(10),
    });

    assert.equal(limiter.getInflight(), 0);

    const listener = limiter.acquire({ context: "test" })!;
    assert.equal(limiter.getInflight(), 1);

    listener.reportSuccess();
    assert.equal(limiter.getInflight(), 0);
  });

  it("should adjust permits when limit changes", () => {
    const limit = new SettableLimit(5);
    const limiter = new Limiter<string>({ limit });

    for (let i = 0; i < 5; i++) {
      limiter.acquire({ context: "test" });
    }
    assert.equal(limiter.acquire({ context: "test" }), undefined);

    limit.setLimit(10);

    const extra = limiter.acquire({ context: "test" });
    assert.ok(extra, "Should acquire after limit increase");
  });

  it("should release permits on ignore", () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
    });

    const listener = limiter.acquire({ context: "test" })!;
    listener.reportIgnore();

    const next = limiter.acquire({ context: "test" });
    assert.ok(next, "Should acquire after reportIgnore release");
  });

  it("should release permits on dropped", () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
    });

    const listener = limiter.acquire({ context: "test" })!;
    listener.reportDropped();

    const next = limiter.acquire({ context: "test" });
    assert.ok(next, "Should acquire after reportDropped release");
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

    it("returns QuotaNotAvailable when no allotment and does not run fn", async () => {
      const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
      const limited = withLimiter(limiter);
      limiter.acquire({ context: "a" });

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

      const next = limiter.acquire({ context: "a" });
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

      assert.ok(limiter.acquire({ context: "a" }));
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

      assert.ok(limiter.acquire({ context: "a" }));
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

      assert.ok(limiter.acquire({ context: "a" }));
    });

    it("passes acquire options (context)", async () => {
      const limiter = new Limiter<string>({
        limit: new FixedLimit(1),
        bypassResolver: (c) => c === "vip",
      });
      const limited = withLimiter(limiter);

      limiter.acquire({ context: "norm" });
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
