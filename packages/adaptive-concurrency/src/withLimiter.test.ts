import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FixedLimit } from "./limit/FixedLimit.js";
import { Limiter } from "./Limiter.js";
import {
  AdaptiveTimeoutError,
  QuotaNotAvailable,
  dropped,
  ignore,
  success,
} from "./RunResult.js";
import { withLimiter } from "./withLimiter.js";

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

  it("reports ignore and releases on synchronous callback throw", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const limited = withLimiter(limiter);
    const boom = new Error("boom");

    await assert.rejects(
      limited({ context: "a" }, () => {
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

    const out = await limited(
      { context: "tenant-a", signal },
      ({ context, signal: cbSignal }) => {
        assert.equal(context, "tenant-a");
        assert.equal(cbSignal, signal);
        return success("ok");
      },
    );

    assert.equal(out, "ok");
  });
});
