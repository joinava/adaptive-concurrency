import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllotmentUnavailableError } from "./errors.js";
import { FixedLimit } from "./limit/FixedLimit.js";
import { Limiter } from "./Limiter.js";
import {
  AdaptiveRejectionError,
  AdaptiveTimeoutError,
  dropped,
  ignore,
  success,
} from "./RunResult.js";
import { makeLimitedFunction, withLimiter } from "./withLimiter.js";
import type { AcquireOptions, AcquireResult, LimitAllotment } from "./types/Strategy.js";

describe("withLimiter", () => {
  it("returns value on success and releases slot", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const limited = withLimiter(limiter);

    const v = await limited({ context: "a" }, async () => success(42));
    assert.deepEqual(v, { ok: true, value: 42 });

    const again = await limited({ context: "a" }, () => success("ok"));
    assert.deepEqual(again, { ok: true, value: "ok" });
  });

  it("treats plain callback returns as implicit success", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const limited = withLimiter(limiter);

    const v = await limited({ context: "a" }, () => 42);
    assert.deepEqual(v, { ok: true, value: 42 });

    // Verify slot was released as success.
    const again = await acquireOk(limiter, { context: "a" });
    assert.ok(again);
  });

  it("treats malformed run-result-like objects as implicit success", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const malformed = { kind: "success" } as const;
    const limited = withLimiter(limiter);
    const v = await limited({ context: "a" }, () => malformed);
    assert.deepEqual(v, { ok: true, value: malformed });

    // Verify slot was released as success.
    const again = await acquireOk(limiter, { context: "a" });
    assert.ok(again);
  });

  it("resolves { ok: false } when no allotment and does not run fn", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const limited = withLimiter(limiter);
    await acquireOk(limiter, { context: "a" });

    let ran = false;
    const out = await limited({ context: "a" }, async () => {
      ran = true;
      return success(null);
    });

    assert.equal(out.ok, false);
    assert.ok(!out.ok && isAllotmentUnavailableError(out.error));
    assert.equal(ran, false);
  });

  it("rejects with the abort reason, and does not run fn, when the signal aborted", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const limited = withLimiter(limiter);
    const controller = new AbortController();
    controller.abort();

    let ran = false;
    await assert.rejects(
      limited({ context: "a", signal: controller.signal }, () => {
        ran = true;
        return success(null);
      }),
      (e: unknown) => e === controller.signal.reason,
    );
    assert.equal(ran, false);
  });

  it("releases on ignore", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const limited = withLimiter(limiter);

    const v = await limited({ context: "a" }, () => ignore(7));
    assert.deepEqual(v, { ok: true, value: 7 });

    const next = await acquireOk(limiter, { context: "a" });
    assert.ok(next);
  });

  it("throws on dropped after reporting drop", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const err = new Error("overload");
    const limited = withLimiter(limiter);

    await assert.rejects(
      limited({ context: "a" }, () => {
        throw dropped(err);
      }),
      (e: unknown) => e === err,
    );

    await acquireOk(limiter, { context: "a" });
  });

  it("rejects misuse when callback returns dropped result", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const limited = withLimiter(limiter);

    await assert.rejects(
      (
        limited as unknown as (
          options: { context: string },
          fn: () => unknown,
        ) => Promise<unknown>
      )({ context: "a" }, () => dropped(new Error("overload"))),
      (e: unknown) =>
        e instanceof Error &&
        e.message.includes("Unexpected value") &&
        e.message.includes('"kind":"dropped"'),
    );

    await acquireOk(limiter, { context: "a" });
  });

  it("rejects misuse when callback throws success result and releases slot", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const limited = withLimiter(limiter);

    await assert.rejects(
      (
        limited as unknown as (
          options: { context: string },
          fn: () => unknown,
        ) => Promise<unknown>
      )({ context: "a" }, () => {
        throw success("not-an-error");
      }),
      (e: unknown) =>
        e instanceof Error &&
        e.message.includes("do not throw success(value)"),
    );

    await acquireOk(limiter, { context: "a" });
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

    await acquireOk(limiter, { context: "a" });
  });

  it("reports ignore and unwraps thrown ignore result", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const limited = withLimiter(limiter);
    const boom = new Error("boom");

    await assert.rejects(
      limited({ context: "a" }, () => {
        throw ignore(boom);
      }),
      (e: unknown) => e === boom,
    );

    await acquireOk(limiter, { context: "a" });
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

    await acquireOk(limiter, { context: "a" });
  });

  it("reports drop and rethrows on AdaptiveTimeoutError throw", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const timeout = new AdaptiveTimeoutError("timed out");
    const limited = withLimiter(limiter);

    await assert.rejects(
      limited({ context: "a" }, async () => {
        throw timeout;
      }),
      (e: unknown) => e === timeout,
    );

    await acquireOk(limiter, { context: "a" });
  });

  it("reports drop and rethrows on AdaptiveRejectionError throw", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const rejection = new AdaptiveRejectionError("rejected");
    const limited = withLimiter(limiter);

    await assert.rejects(
      limited({ context: "a" }, async () => {
        throw rejection;
      }),
      (e: unknown) => e === rejection,
    );

    await acquireOk(limiter, { context: "a" });
  });

  it("treats legacy adaptive rejection code throws as drops", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const rejection = { code: "ADAPTIVE_REJECTION" };
    const limited = withLimiter(limiter);

    await assert.rejects(
      limited({ context: "a" }, async () => {
        throw rejection;
      }),
      (e: unknown) => e === rejection,
    );

    await acquireOk(limiter, { context: "a" });
  });

  it("passes acquire options (context)", async () => {
    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
      bypassResolver: (c) => c === "vip",
    });
    const limited = withLimiter(limiter);

    await acquireOk(limiter, { context: "norm" });
    const q = await limited({ context: "norm" }, () => success(1));
    assert.equal(q.ok, false);

    const v = await limited({ context: "vip" }, () => success(2));
    assert.deepEqual(v, { ok: true, value: 2 });
  });

  it("passes { context, signal } into callback", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const signal = new AbortController().signal;
    const limited = withLimiter(limiter);

    const out = await limited(
      { context: "tenant-a", signal },
      ({ context, signal: cbSignal }) => {
        assert.equal(context, "tenant-a");
        assert.equal(cbSignal, signal);
        return success("ok");
      },
    );

    assert.deepEqual(out, { ok: true, value: "ok" });
  });
});

describe("makeLimitedFunction", () => {
  it("binds a callback and runs it with acquire options", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const limited = makeLimitedFunction(limiter, ({ context }) => {
      assert.equal(context, "tenant-a");
      return success("ok");
    });

    const out = await limited({ context: "tenant-a" });
    assert.deepEqual(out, { ok: true, value: "ok" });
  });

  it("supports calling with no options", async () => {
    const limiter = new Limiter<void>({ limit: new FixedLimit(1) });
    const limited = makeLimitedFunction(limiter, () => success(42));

    const out = await limited();
    assert.deepEqual(out, { ok: true, value: 42 });
  });

  it("resolves { ok: false } and does not run callback when no allotment is available", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    await acquireOk(limiter, { context: "a" });

    let ran = false;
    const limited = makeLimitedFunction(limiter, () => {
      ran = true;
      return success("nope");
    });

    const out = await limited({ context: "a" });
    assert.equal(out.ok, false);
    assert.ok(!out.ok && isAllotmentUnavailableError(out.error));
    assert.equal(ran, false);
  });

  it("passes signal into the bound callback", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const signal = new AbortController().signal;
    const limited = makeLimitedFunction(limiter, ({ signal: cbSignal }) => {
      assert.equal(cbSignal, signal);
      return success("ok");
    });

    const out = await limited({ context: "tenant-a", signal });
    assert.deepEqual(out, { ok: true, value: "ok" });
  });

  it("records drop and rethrows inner error on thrown dropped result", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const err = new Error("overload");
    const limited = makeLimitedFunction(limiter, () => {
      throw dropped(err);
    });

    await assert.rejects(limited({ context: "a" }), (e: unknown) => e === err);
    await acquireOk(limiter, { context: "a" });
  });

  it("records ignore and unwraps thrown ignore result", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const err = new Error("ignored");
    const limited = makeLimitedFunction(limiter, () => {
      throw ignore(err);
    });

    await assert.rejects(limited({ context: "a" }), (e: unknown) => e === err);
    await acquireOk(limiter, { context: "a" });
  });

  it("rejects misuse when bound callback returns dropped result and releases slot", async () => {
    const limiter = new Limiter<string>({ limit: new FixedLimit(1) });
    const limited = makeLimitedFunction(
      limiter,
      (() => dropped(new Error("overload"))) as unknown as () => string,
    );

    await assert.rejects(
      limited({ context: "a" }),
      (e: unknown) =>
        e instanceof Error &&
        e.message.includes("Unexpected value") &&
        e.message.includes('"kind":"dropped"'),
    );

    await acquireOk(limiter, { context: "a" });
  });
});

async function acquireOk<C>(
  limiter: { acquire(options?: AcquireOptions<C>): AcquireResult },
  options?: AcquireOptions<C>,
): Promise<LimitAllotment> {
  const result = await limiter.acquire(options);
  assert.ok(result.ok, "expected an allotment");
  return result.value;
}

async function assertUnavailable(acquired: AcquireResult): Promise<void> {
  const result = await acquired;
  assert.equal(result.ok, false);
  assert.ok(isAllotmentUnavailableError(result.error));
}
