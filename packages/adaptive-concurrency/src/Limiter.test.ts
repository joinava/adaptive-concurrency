import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FixedLimit } from "./limit/FixedLimit.js";
import { SettableLimit } from "./limit/SettableLimit.js";
import type { AdaptiveLimit } from "./limit/StreamingLimit.js";
import type {
  AcquireStrategy,
  AllotmentUnavailableStrategy,
} from "./Limiter.js";
import { Limiter, withLimiter } from "./Limiter.js";
import { LinkedWaiterQueue } from "./utils/LinkedWaiterQueue.js";
import {
  BlockingBacklogRejection,
  MAX_TIMEOUT,
  type BlockingBacklogRejectionOptions,
} from "./limiter/allocation-unavailable-strategies/BlockingBacklogRejection.js";
import {
  AdaptiveTimeoutError,
  QuotaNotAvailable,
  dropped,
  ignore,
  isAdaptiveTimeoutError,
  success,
} from "./RunResult.js";


type BlockingOptions<ContextT> = Partial<
  Pick<
    BlockingBacklogRejectionOptions<ContextT, object>,
    "backlogSize" | "backlogTimeout"
  >
>;

function makeFifoBlockingRejection<ContextT>(
  options: BlockingOptions<ContextT> = {},
): BlockingBacklogRejection<ContextT, object> {
  return new BlockingBacklogRejection<ContextT, object>({
    backlogSize: options.backlogSize ?? Number.POSITIVE_INFINITY,
    backlogTimeout: options.backlogTimeout ?? MAX_TIMEOUT,
    enqueueOptions: { direction: "back" },
    queue: new LinkedWaiterQueue(),
  });
}

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
    assert.ok(
      await limiter.acquire({ context: "admin" }),
      "Admin should bypass",
    );
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

  it("should forward limit changes to rejection strategy", () => {
    const limit = new SettableLimit(2);
    const limitChanges: Array<{ oldLimit: number; newLimit: number }> = [];
    const rejectionStrategy: AllotmentUnavailableStrategy<string> = {
      onAllotmentUnavailable() {
        return Promise.resolve(undefined);
      },
      onAllotmentReleased() {},
      onLimitChanged(oldLimit, newLimit) {
        limitChanges.push({ oldLimit, newLimit });
      },
    };

    new Limiter<string>({
      limit,
      allotmentUnavailableStrategy: rejectionStrategy,
    });
    limit.setLimit(4);

    assert.deepEqual(limitChanges, [{ oldLimit: 2, newLimit: 4 }]);
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

  describe("idempotent allotment release", () => {
    it("calling releaseAndRecordSuccess twice does not double-decrement inflight", async () => {
      const limiter = new Limiter<void>({ limit: new FixedLimit(2) });
      const a = await limiter.acquire({});
      assert.ok(a);

      assert.equal(limiter.getInflight(), 1);
      await a.releaseAndRecordSuccess();
      assert.equal(limiter.getInflight(), 0);
      await a.releaseAndRecordSuccess();
      assert.equal(limiter.getInflight(), 0, "second call should be a no-op");
    });

    it("calling releaseAndIgnore twice does not double-decrement inflight", async () => {
      const limiter = new Limiter<void>({ limit: new FixedLimit(2) });
      const a = await limiter.acquire({});
      assert.ok(a);

      await a.releaseAndIgnore();
      assert.equal(limiter.getInflight(), 0);
      await a.releaseAndIgnore();
      assert.equal(limiter.getInflight(), 0, "second call should be a no-op");
    });

    it("calling releaseAndRecordDropped twice does not double-decrement inflight", async () => {
      const limiter = new Limiter<void>({ limit: new FixedLimit(2) });
      const a = await limiter.acquire({});
      assert.ok(a);

      await a.releaseAndRecordDropped();
      assert.equal(limiter.getInflight(), 0);
      await a.releaseAndRecordDropped();
      assert.equal(limiter.getInflight(), 0, "second call should be a no-op");
    });

    it("calling different release methods on the same allotment only runs the first", async () => {
      const limiter = new Limiter<void>({ limit: new FixedLimit(2) });
      const a = await limiter.acquire({});
      assert.ok(a);

      assert.equal(limiter.getInflight(), 1);
      await a.releaseAndIgnore();
      assert.equal(limiter.getInflight(), 0);

      await a.releaseAndRecordSuccess();
      assert.equal(limiter.getInflight(), 0, "should not decrement again");

      await a.releaseAndRecordDropped();
      assert.equal(limiter.getInflight(), 0, "should not decrement again");
    });

    it("second release does not produce an unhandled rejection when fire-and-forget", async () => {
      const limiter = new Limiter<void>({ limit: new FixedLimit(2) });
      const a = await limiter.acquire({});
      assert.ok(a);

      await a.releaseAndIgnore();

      let unhandledRejection: unknown;
      const onUnhandled = (reason: unknown) => {
        unhandledRejection = reason;
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        // Intentionally fire-and-forget: do not await
        a.releaseAndIgnore();
        // Allow microtasks and a macrotask tick to settle
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        assert.equal(
          unhandledRejection,
          undefined,
          "duplicate release must not produce an unhandled rejection",
        );
      } finally {
        process.removeListener("unhandledRejection", onUnhandled);
      }
    });

    it("idempotent release does not double-release semaphore permits", async () => {
      const limiter = new Limiter<void>({ limit: new FixedLimit(1) });
      const a = await limiter.acquire({});
      assert.ok(a);

      await a.releaseAndRecordSuccess();
      await a.releaseAndRecordSuccess();

      // Only one slot should be available
      const b = await limiter.acquire({});
      assert.ok(b);
      assert.equal(
        await limiter.acquire({}),
        undefined,
        "only 1 slot available, not 2 from double-release",
      );
      await b.releaseAndRecordSuccess();
    });
  });

  describe("abort signal", () => {
    it("returns undefined when signal is already aborted before acquire", async () => {
      const limiter = new Limiter<void>({ limit: new FixedLimit(10) });
      const ac = new AbortController();
      ac.abort();

      const result = await limiter.acquire({ signal: ac.signal });
      assert.equal(result, undefined);
      assert.equal(limiter.getInflight(), 0);
    });

    it("cleans up acquired allotment if signal aborts during tryAcquireAllotment await", async () => {
      const ac = new AbortController();
      let resolveAcquire: ((v: boolean) => void) | undefined;

      const acquireStrategy: AcquireStrategy<void> = {
        tryAcquireAllotment() {
          return new Promise<boolean>((resolve) => {
            resolveAcquire = resolve;
          });
        },
        async onAllotmentReleased() {},
      };

      const limiter = new Limiter<void>({
        limit: new FixedLimit(10),
        acquireStrategy,
      });

      const acquirePromise = limiter.acquire({ signal: ac.signal });

      // Abort while tryAcquireAllotment is pending
      ac.abort();
      resolveAcquire!(true);

      const result = await acquirePromise;
      assert.equal(result, undefined, "should return undefined after abort");
      assert.equal(limiter.getInflight(), 0, "inflight should return to 0");
    });

    it("returns undefined when signal aborts before rejection strategy is entered", async () => {
      const ac = new AbortController();
      let retryCalled = false;

      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: {
          onAllotmentUnavailable(_ctx, retry, signal) {
            retryCalled = true;
            return Promise.resolve(undefined);
          },
          onAllotmentReleased() {},
        },
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);

      // Abort after the acquire starts but the tryAcquireAllotment will fail
      // The abort check happens between tryAcquireAllotment failing and entering
      // the rejection strategy
      ac.abort();
      const result = await limiter.acquire({ signal: ac.signal });
      assert.equal(result, undefined);
      assert.equal(
        retryCalled,
        false,
        "rejection strategy should not be entered",
      );

      await holder!.releaseAndRecordSuccess();
    });

    it("inflight stays consistent through abort+release cycles", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(2),
        allotmentUnavailableStrategy: makeFifoBlockingRejection({
          backlogTimeout: 5_000,
        }),
      });

      const h1 = await limiter.acquire({});
      const h2 = await limiter.acquire({});
      assert.ok(h1);
      assert.ok(h2);
      assert.equal(limiter.getInflight(), 2);

      const ac = new AbortController();
      const abortedPromise = limiter.acquire({ signal: ac.signal });

      ac.abort();
      assert.equal(await abortedPromise, undefined);
      assert.equal(
        limiter.getInflight(),
        2,
        "aborted acquire should not affect inflight",
      );

      await h1!.releaseAndRecordSuccess();
      assert.equal(limiter.getInflight(), 1);

      await h2!.releaseAndRecordSuccess();
      assert.equal(limiter.getInflight(), 0);
    });

    it("does not leak permits when abort races with blocking acquire across multiple slots", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(3),
        allotmentUnavailableStrategy: makeFifoBlockingRejection({
          backlogTimeout: 5_000,
          backlogSize: 10,
        }),
      });

      const holders = await Promise.all([
        limiter.acquire({}),
        limiter.acquire({}),
        limiter.acquire({}),
      ]);
      for (const h of holders) assert.ok(h);
      assert.equal(limiter.getInflight(), 3);

      const controllers = Array.from(
        { length: 5 },
        () => new AbortController(),
      );
      const abortPromises = controllers.map((ac) =>
        limiter.acquire({ signal: ac.signal }),
      );

      for (const ac of controllers) ac.abort();
      for (const p of abortPromises) assert.equal(await p, undefined);

      assert.equal(limiter.getInflight(), 3);

      for (const h of holders) await h!.releaseAndRecordSuccess();
      assert.equal(limiter.getInflight(), 0);

      // All 3 slots should be available
      const fresh = await Promise.all([
        limiter.acquire({}),
        limiter.acquire({}),
        limiter.acquire({}),
      ]);
      for (const f of fresh) assert.ok(f);
      assert.equal(limiter.getInflight(), 3);
      for (const f of fresh) await f!.releaseAndRecordSuccess();
    });

    it("abort during blocking wait does not prevent subsequent non-aborted acquires", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: makeFifoBlockingRejection({
          backlogTimeout: 5_000,
        }),
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);

      const ac = new AbortController();
      const abortedPromise = limiter.acquire({ signal: ac.signal });

      ac.abort();
      assert.equal(await abortedPromise, undefined);

      const nextPromise = limiter.acquire({});
      await holder!.releaseAndRecordSuccess();

      const next = await Promise.race([
        nextPromise,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 500)),
      ]);
      assert.ok(next, "non-aborted acquire should succeed after release");
      await next!.releaseAndRecordSuccess();
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
