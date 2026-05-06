import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AllotmentReservation } from "./AllotmentReservation.js";
import { AIMDLimit } from "./limit/AIMDLimit.js";
import { FixedLimit } from "./limit/FixedLimit.js";
import { SettableLimit } from "./limit/SettableLimit.js";
import type { AdaptiveLimit } from "./limit/StreamingLimit.js";
import type {
  AcquireStrategy,
  AllotmentUnavailableStrategy,
} from "./Limiter.js";
import { Limiter } from "./Limiter.js";
import {
  BlockingBacklogRejection,
  MAX_TIMEOUT,
  type BlockingBacklogRejectionOptions,
} from "./limiter/allocation-unavailable-strategies/BlockingBacklogRejection.js";
import type {
  Counter,
  DistributionMetric,
  Gauge,
  MetricRegistry,
} from "./MetricRegistry.js";
import { MetricIds } from "./MetricRegistry.js";
import { AdaptiveTimeoutError, isAdaptiveTimeoutError } from "./RunResult.js";
import { LinkedWaiterQueue } from "./utils/LinkedWaiterQueue.js";

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

  it("drives a strategy's two-phase API through reserve+commit on success and reserve+release on completion", async () => {
    const reserveCalls: string[] = [];
    const commitCalls: string[] = [];
    const cancelCalls: string[] = [];
    const releasedCalls: string[] = [];
    let permits = 1;

    const acquireStrategy: AcquireStrategy<string> = {
      tryReserveAllotment(ctx) {
        reserveCalls.push(ctx);
        if (permits <= 0) return undefined;
        permits--;
        return new AllotmentReservation(
          () => {
            commitCalls.push(ctx);
          },
          () => {
            cancelCalls.push(ctx);
            permits++;
          },
        );
      },
      onAllotmentReleased(ctx) {
        releasedCalls.push(ctx);
        permits++;
      },
    };

    const limiter = new Limiter<string>({
      limit: new FixedLimit(1),
      acquireStrategy,
    });

    const first = await limiter.acquire({ context: "a" });
    assert.ok(first, "first acquire is admitted");
    assert.deepEqual(reserveCalls, ["a"]);
    assert.deepEqual(commitCalls, ["a"], "Limiter must commit on success");
    assert.deepEqual(cancelCalls, []);

    const denied = await limiter.acquire({ context: "b" });
    assert.equal(denied, undefined, "no permits left");
    assert.deepEqual(reserveCalls, ["a", "b"]);
    assert.deepEqual(
      cancelCalls,
      [],
      "Limiter must NOT cancel a reservation that was never granted",
    );

    await first.releaseAndRecordSuccess();
    assert.deepEqual(releasedCalls, ["a"]);

    const third = await limiter.acquire({ context: "c" });
    assert.ok(third, "permit returned via release; next acquire is admitted");
    assert.deepEqual(commitCalls, ["a", "c"]);
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
      addSample(startTime, rtt, inflight, didDrop, _operationName) {
        samples.push({ startTime, rtt, inflight, didDrop });
      },
    };

    let resolveRelease: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const acquireStrategy: AcquireStrategy<string> = {
      tryReserveAllotment() {
        return new AllotmentReservation(
          () => {},
          () => {},
        );
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

    it("cleans up acquired allotment if signal aborts during tryReserveAllotment await", async () => {
      const ac = new AbortController();
      let resolveReserve: ((v: AllotmentReservation) => void) | undefined;

      const acquireStrategy: AcquireStrategy<void> = {
        tryReserveAllotment() {
          return new Promise<AllotmentReservation>((resolve) => {
            resolveReserve = resolve;
          });
        },
        async onAllotmentReleased() {},
      };

      const limiter = new Limiter<void>({
        limit: new FixedLimit(10),
        acquireStrategy,
      });

      const acquirePromise = limiter.acquire({ signal: ac.signal });

      // Abort while tryReserveAllotment is pending
      ac.abort();
      resolveReserve!(
        new AllotmentReservation(
          () => {},
          () => {},
        ),
      );

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

      // Abort after the acquire starts but the reservation will fail.
      // The abort check happens between tryReserveAllotment failing and
      // entering the rejection strategy.
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

    it("cleans up if signal aborts after queued retry acquires an allotment", async () => {
      const ac = new AbortController();
      let resolveRetryStarted: (() => void) | undefined;
      const retryStarted = new Promise<void>((resolve) => {
        resolveRetryStarted = resolve;
      });
      let resolveReturnFromStrategy: (() => void) | undefined;
      const returnFromStrategy = new Promise<void>((resolve) => {
        resolveReturnFromStrategy = resolve;
      });

      const rejectionStrategy: AllotmentUnavailableStrategy<void> = {
        async onAllotmentUnavailable(_ctx, retry) {
          const allotment = await retry(undefined);
          resolveRetryStarted?.();
          await returnFromStrategy;
          return allotment;
        },
        onAllotmentReleased() {},
      };

      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: rejectionStrategy,
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);

      const queued = limiter.acquire({ signal: ac.signal });
      await holder.releaseAndRecordSuccess();
      await retryStarted;

      assert.equal(limiter.getInflight(), 1);
      ac.abort();
      resolveReturnFromStrategy?.();

      const result = await queued;
      assert.equal(result, undefined);
      assert.equal(
        limiter.getInflight(),
        0,
        "aborted queued acquire should release the acquired allotment",
      );

      const fresh = await limiter.acquire({});
      assert.ok(fresh, "slot should be available after abort cleanup");
      await fresh.releaseAndRecordSuccess();
    });
  });

  describe("AdaptiveTimeoutError", () => {
    it("provides an error type guard", () => {
      assert.equal(isAdaptiveTimeoutError(new AdaptiveTimeoutError("x")), true);
      assert.equal(isAdaptiveTimeoutError({ code: "ADAPTIVE_TIMEOUT" }), true);
      assert.equal(isAdaptiveTimeoutError(new Error("x")), false);
    });
  });

  describe("recovery probe", () => {
    /**
     * Minimal fake timer used to drive the limiter's probe state machine
     * deterministically. Tasks fire in order of scheduled time when
     * {@link FakeTimer.advance} is called.
     */
    class FakeTimer {
      now = 0;
      private nextHandle = 1;
      private readonly tasks = new Map<
        number,
        { fn: () => void; at: number }
      >();

      readonly setTimeout = (fn: () => void, ms: number): number => {
        const handle = this.nextHandle++;
        this.tasks.set(handle, { fn, at: this.now + ms });
        return handle;
      };

      readonly clearTimeout = (handle: unknown): void => {
        if (typeof handle === "number") this.tasks.delete(handle);
      };

      pendingCount(): number {
        return this.tasks.size;
      }

      pendingMs(): number | undefined {
        let earliest: number | undefined;
        for (const t of this.tasks.values()) {
          if (earliest === undefined || t.at < earliest) earliest = t.at;
        }
        return earliest === undefined ? undefined : earliest - this.now;
      }

      /** Advance time by `ms`, firing any tasks whose deadline has passed. */
      advance(ms: number): number {
        this.now += ms;
        const due = [...this.tasks].filter(([, t]) => t.at <= this.now);
        due.sort((a, b) => a[1].at - b[1].at);
        for (const [h] of due) this.tasks.delete(h);
        for (const [, t] of due) t.fn();
        return due.length;
      }
    }

    /**
     * Helper: build a limiter with AIMD-based probing and a fake timer.
     * AIMD with `initialLimit: 1, minLimit: 0, backoffJitter: 0` collapses
     * to 0 on a single drop, which makes the test scenarios easy to set up.
     */
    function makeAimdLimiter(opts?: {
      timeout?: number;
      jitter?: number;
      maxMs?: number;
    }) {
      const timer = new FakeTimer();
      const limit = new AIMDLimit({
        initialLimit: 1,
        minLimit: 0,
        maxLimit: 100,
        backoffRatio: 0.9,
        backoffJitter: 0,
        timeout: opts?.timeout ?? 1_000,
      });
      const limiter = new Limiter<void>({
        limit,
        timer,
        recoveryProbe: {
          jitter: opts?.jitter ?? 0,
          maxMs: opts?.maxMs ?? 60_000,
        },
      });
      return { timer, limit, limiter };
    }

    it("arms a probe when the limit hits 0 with no inflight, and the probe raises the limit to 1", async () => {
      const { timer, limiter } = makeAimdLimiter({ timeout: 500 });

      const a = await limiter.acquire({});
      assert.ok(a);
      assert.equal(limiter.getLimit(), 1);

      await a.releaseAndRecordDropped();

      assert.equal(limiter.getLimit(), 0, "limit should drop to 0");
      assert.equal(limiter.getInflight(), 0);
      assert.equal(timer.pendingCount(), 1, "probe should be armed");
      assert.equal(timer.pendingMs(), 500, "first probe at base = timeout");

      timer.advance(500);

      assert.equal(limiter.getLimit(), 1, "probe should raise limit to 1");
      assert.equal(timer.pendingCount(), 0);

      limiter.dispose();
    });

    it("does not arm a probe while requests are still inflight", async () => {
      const timer = new FakeTimer();
      // Two-shot AIMD: initialLimit 2 takes two drops to reach 0.
      const limit = new AIMDLimit({
        initialLimit: 2,
        minLimit: 0,
        maxLimit: 100,
        backoffRatio: 0.5,
        backoffJitter: 0,
        timeout: 1_000,
      });
      const limiter = new Limiter<void>({
        limit,
        timer,
        recoveryProbe: { jitter: 0 },
      });

      const a = await limiter.acquire({});
      const b = await limiter.acquire({});
      assert.ok(a);
      assert.ok(b);

      await a.releaseAndRecordDropped();
      assert.equal(limiter.getLimit(), 1);
      assert.equal(limiter.getInflight(), 1);
      assert.equal(timer.pendingCount(), 0, "should not arm: inflight > 0");

      await b.releaseAndRecordDropped();
      assert.equal(limiter.getLimit(), 0);
      assert.equal(limiter.getInflight(), 0);
      assert.equal(
        timer.pendingCount(),
        1,
        "should arm once inflight drains and limit is still 0",
      );

      limiter.dispose();
    });

    it("rearms with exponentially-growing intervals on consecutive failed probes", async () => {
      const { timer, limiter } = makeAimdLimiter({ timeout: 200 });

      const a = await limiter.acquire({});
      assert.ok(a);
      await a.releaseAndRecordDropped();

      assert.equal(timer.pendingMs(), 200, "n=0 → base");

      timer.advance(200);
      assert.equal(limiter.getLimit(), 1);

      // Probe-induced acquire that drops again -> back to 0, n becomes 1.
      const b = await limiter.acquire({});
      assert.ok(b);
      await b.releaseAndRecordDropped();
      assert.equal(limiter.getLimit(), 0);
      assert.equal(timer.pendingMs(), 400, "n=1 → 2 * base");

      timer.advance(400);
      const c = await limiter.acquire({});
      assert.ok(c);
      await c.releaseAndRecordDropped();
      assert.equal(timer.pendingMs(), 800, "n=2 → 4 * base");

      limiter.dispose();
    });

    it("resets the failure counter on a non-drop sample and cancels the pending probe", async () => {
      const { timer, limiter } = makeAimdLimiter({ timeout: 200 });

      // Run the failure ladder up to n=2.
      const a = await limiter.acquire({});
      assert.ok(a);
      await a.releaseAndRecordDropped();
      timer.advance(200);

      const b = await limiter.acquire({});
      assert.ok(b);
      await b.releaseAndRecordDropped();
      assert.equal(timer.pendingMs(), 400);

      // Cancel mid-wait by succeeding a request (e.g. a probe-fired request
      // that completed cleanly): the probe should be cancelled and the
      // counter reset.
      timer.advance(400);
      assert.equal(limiter.getLimit(), 1);

      const c = await limiter.acquire({});
      assert.ok(c);
      await c.releaseAndRecordSuccess();

      assert.equal(
        timer.pendingCount(),
        0,
        "successful sample cancels any pending probe",
      );

      // Drop until we reach 0 again. AIMD increases on success, so the
      // limit climbed past 1 above and we need multiple drops to hit 0.
      while (limiter.getLimit() > 0) {
        const d = await limiter.acquire({});
        assert.ok(d);
        await d.releaseAndRecordDropped();
      }
      assert.equal(timer.pendingMs(), 200, "counter reset → base interval");

      limiter.dispose();
    });

    it("caps a single probe interval at recoveryProbe.maxMs", async () => {
      const { timer, limiter } = makeAimdLimiter({
        timeout: 1_000,
        maxMs: 1_500,
      });

      const a = await limiter.acquire({});
      assert.ok(a);
      await a.releaseAndRecordDropped();
      assert.equal(timer.pendingMs(), 1_000);

      timer.advance(1_000);
      const b = await limiter.acquire({});
      assert.ok(b);
      await b.releaseAndRecordDropped();
      assert.equal(timer.pendingMs(), 1_500, "capped from 2_000 to 1_500");

      timer.advance(1_500);
      const c = await limiter.acquire({});
      assert.ok(c);
      await c.releaseAndRecordDropped();
      assert.equal(timer.pendingMs(), 1_500, "stays capped");

      limiter.dispose();
    });

    it("applies symmetric jitter within the configured band", async () => {
      const observed = new Set<number>();
      for (let trial = 0; trial < 30; trial++) {
        const { timer, limiter } = makeAimdLimiter({
          timeout: 1_000,
          jitter: 0.2,
          maxMs: 10_000,
        });
        const a = await limiter.acquire({});
        assert.ok(a);
        await a.releaseAndRecordDropped();
        const ms = timer.pendingMs()!;
        observed.add(ms);
        assert.ok(
          ms >= 800 && ms <= 1_200,
          `jittered interval out of band: ${ms}`,
        );
        limiter.dispose();
      }
      assert.ok(observed.size > 1, "jitter should produce varying intervals");
    });

    it("arms a probe immediately when constructed with an initial limit of 0", () => {
      const timer = new FakeTimer();
      // Strategy starts at 0 (e.g. a deserialized snapshot). Without
      // construction-time probe arming, the limiter would be permanently
      // stuck: no acquires can land, so no samples can arrive, so no probe
      // would ever be triggered.
      const limit = new AIMDLimit({
        initialLimit: 0,
        minLimit: 0,
        maxLimit: 100,
        backoffRatio: 0.9,
        backoffJitter: 0,
        timeout: 500,
      });
      const limiter = new Limiter<void>({
        limit,
        timer,
        recoveryProbe: { jitter: 0 },
      });

      assert.equal(limiter.getLimit(), 0);
      assert.equal(timer.pendingCount(), 1, "probe should arm at construction");
      assert.equal(timer.pendingMs(), 500);

      timer.advance(500);
      assert.equal(limiter.getLimit(), 1);

      limiter.dispose();
    });

    it("dispose() unsubscribes from the underlying limit so post-dispose limit changes are ignored", () => {
      const timer = new FakeTimer();
      const inner = new SettableLimit(5);
      const limiter = new Limiter<void>({
        limit: inner,
        timer,
        recoveryProbe: { jitter: 0 },
      });

      assert.equal(limiter.getLimit(), 5);
      limiter.dispose();
      inner.setLimit(42);
      assert.equal(
        limiter.getLimit(),
        5,
        "post-dispose changes to the inner limit must not leak back into the limiter",
      );
    });

    it("Symbol.dispose runs the same cleanup as dispose() (usable with `using`)", () => {
      const timer = new FakeTimer();
      const inner = new SettableLimit(5);

      {
        using limiter = new Limiter<void>({
          limit: inner,
          timer,
          recoveryProbe: { jitter: 0 },
        });
        assert.equal(limiter.getLimit(), 5);
      }

      // After the `using` block, the limiter should have unsubscribed from
      // `inner`, so further changes to `inner` would no longer propagate.
      // We can't observe the disposed limiter here since it's out of scope,
      // but we can at least confirm `inner.setLimit` doesn't throw and that
      // no listeners are still attached (changing `inner` would have thrown
      // had the listener captured a now-disposed `Limiter` whose state
      // accesses misbehaved).
      inner.setLimit(99);
    });

    it("dispose() is safe to call multiple times (idempotent)", () => {
      let unsubscribeCallCount = 0;
      const inner = new SettableLimit(5);
      const originalSubscribe = inner.subscribe.bind(inner);
      inner.subscribe = (listener) => {
        const unsub = originalSubscribe(listener);
        return () => {
          unsubscribeCallCount++;
          unsub();
        };
      };

      const limiter = new Limiter<void>({
        limit: inner,
        recoveryProbe: { jitter: 0 },
      });

      limiter.dispose();
      limiter.dispose();
      limiter.dispose();

      assert.equal(
        unsubscribeCallCount,
        1,
        "unsubscribeFromLimit must be called exactly once even with multiple dispose() calls",
      );
    });

    it("does not arm a new probe when an outstanding allotment releases after dispose()", async () => {
      const timer = new FakeTimer();
      const limit = new AIMDLimit({
        initialLimit: 1,
        minLimit: 0,
        maxLimit: 100,
        backoffRatio: 0.9,
        backoffJitter: 0,
        timeout: 500,
      });
      const limiter = new Limiter<void>({
        limit,
        timer,
        recoveryProbe: { jitter: 0 },
      });

      const allotment = await limiter.acquire({});
      assert.ok(allotment);

      limiter.dispose();
      await allotment.releaseAndRecordDropped();

      assert.equal(
        timer.pendingCount(),
        0,
        "disposed limiter must not schedule a new recovery probe",
      );
    });

    it("does not arm a probe for limits that lack probe support (FixedLimit)", async () => {
      const timer = new FakeTimer();
      const limiter = new Limiter<void>({
        limit: new FixedLimit(0),
        timer,
        recoveryProbe: { jitter: 0 },
      });

      // Acquire is rejected since limit is 0; nothing inflight, nothing to
      // do. Confirm no probe is armed.
      const result = await limiter.acquire({});
      assert.equal(result, undefined);
      assert.equal(timer.pendingCount(), 0);

      limiter.dispose();
    });

    it("rejects invalid recoveryProbe options", () => {
      assert.throws(
        () =>
          new Limiter<void>({
            limit: new FixedLimit(1),
            recoveryProbe: { maxMs: 0 },
          }),
        /recoveryProbe\.maxMs must be a finite number > 0/,
      );
      assert.throws(
        () =>
          new Limiter<void>({
            limit: new FixedLimit(1),
            recoveryProbe: { jitter: 0.5 },
          }),
        /recoveryProbe\.jitter must be a finite number in/,
      );
      assert.throws(
        () =>
          new Limiter<void>({
            limit: new FixedLimit(1),
            recoveryProbe: { jitter: -0.1 },
          }),
        /recoveryProbe\.jitter must be a finite number in/,
      );
      assert.throws(
        () =>
          new Limiter<void>({
            limit: new FixedLimit(1),
            recoveryProbe: { jitter: Number.NaN },
          }),
        /recoveryProbe\.jitter must be a finite number in/,
      );
    });

    // `NaN <= 0` is `false`, so a NaN slips past the basic positivity check
    // unless we also test for finiteness. Without rejection, `Math.min(NaN,
    // base)` is NaN and `setTimeout(fn, NaN)` is coerced to ~1ms in Node,
    // silently turning a misconfiguration into a near-busy-loop probe.
    it("rejects NaN for recoveryProbe.maxMs", () => {
      assert.throws(
        () =>
          new Limiter<void>({
            limit: new FixedLimit(1),
            recoveryProbe: { maxMs: Number.NaN },
          }),
        /recoveryProbe\.maxMs must be a finite number > 0/,
      );
    });

    // Infinity passes a `> 0` check and would work downstream (`Math.min(Infinity,
    // base) === base`), but it's almost always a misconfiguration when it shows
    // up — usually from `maxMs: someBudget / 0` or similar. Reject it for
    // symmetry with NaN.
    it("rejects Infinity for recoveryProbe.maxMs", () => {
      assert.throws(
        () =>
          new Limiter<void>({
            limit: new FixedLimit(1),
            recoveryProbe: { maxMs: Number.POSITIVE_INFINITY },
          }),
        /recoveryProbe\.maxMs must be a finite number > 0/,
      );
    });
  });

  describe("acquire metrics semantics", () => {
    it("counts each failed tryReserveAllotment, including from retries", async () => {
      // Documents the current contract: `acquire_attempt{status=failed}`
      // tracks every `tryReserveAllotment` that returned `undefined`, NOT
      // the number of logical `acquire()` calls that ended up rejected. A
      // single logical acquire that is woken N-1 times before finally
      // landing therefore emits N failures + 1 success.
      const events: Array<{ id: string; status: string; delta: number }> = [];
      const collectingRegistry = makeRecordingMetricRegistry(events);

      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        metricRegistry: collectingRegistry,
        // Custom rejection strategy that retries N times before succeeding.
        allotmentUnavailableStrategy: {
          async onAllotmentUnavailable(_ctx, retry) {
            for (let attempt = 0; attempt < 3; attempt++) {
              const r = await retry(undefined);
              if (r) return r;
            }
            return undefined;
          },
          onAllotmentReleased() {},
        },
      });

      // Hold the only slot so all retries fail.
      const holder = await limiter.acquire({});
      assert.ok(holder);

      // Issue an acquire that will retry 3 times and ultimately fail.
      const result = await limiter.acquire({});
      assert.equal(result, undefined);

      const failed = events.filter(
        (e) => e.id === MetricIds.ACQUIRE_ATTEMPT_NAME && e.status === "failed",
      );
      // 1 (initial) + 3 (retries) = 4 fails for one logical acquire.
      assert.equal(
        failed.length,
        4,
        "each tryReserveAllotment failure is counted",
      );

      await holder.releaseAndRecordSuccess();
    });

    it("counts retry that finally succeeds as one succeeded + N-1 failed", async () => {
      const events: Array<{ id: string; status: string; delta: number }> = [];
      const collectingRegistry = makeRecordingMetricRegistry(events);

      let releaseHolder: () => Promise<void> = async () => {};
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        metricRegistry: collectingRegistry,
        allotmentUnavailableStrategy: {
          async onAllotmentUnavailable(_ctx, retry) {
            // First retry will fail (slot still held). After we release the
            // holder, the second retry succeeds.
            const first = await retry(undefined);
            if (first) return first;
            await releaseHolder();
            return retry(undefined);
          },
          onAllotmentReleased() {},
        },
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);
      releaseHolder = async () => {
        await holder.releaseAndRecordSuccess();
      };

      const result = await limiter.acquire({});
      assert.ok(result, "second retry should succeed after holder released");

      const failed = events.filter(
        (e) => e.id === MetricIds.ACQUIRE_ATTEMPT_NAME && e.status === "failed",
      ).length;
      const succeeded = events.filter(
        (e) =>
          e.id === MetricIds.ACQUIRE_ATTEMPT_NAME && e.status === "succeeded",
      ).length;

      assert.equal(failed, 2, "initial + first retry both counted as failed");
      assert.equal(
        succeeded,
        2,
        "holder-acquire + retry-acquire both counted as succeeded",
      );

      await result.releaseAndRecordSuccess();
    });
  });

  describe("bypass allotment", () => {
    it("counts a bypass acquire on the bypassed counter", async () => {
      const events: Array<{ id: string; status: string; delta: number }> = [];
      const limiter = new Limiter<string>({
        limit: new FixedLimit(0),
        bypassResolver: (ctx) => ctx === "vip",
        metricRegistry: makeRecordingMetricRegistry(events),
      });

      const allotment = await limiter.acquire({ context: "vip" });
      assert.ok(allotment);
      const bypassed = events.filter(
        (e) =>
          e.id === MetricIds.ACQUIRE_ATTEMPT_NAME && e.status === "bypassed",
      );
      assert.equal(bypassed.length, 1);
    });

    // Non-bypassed allotments are one-shot via `releaseStarted` (see the
    // `idempotent allotment release` suite). Bypassed allotments must
    // behave the same way so accidental double-release in user `finally`
    // blocks doesn't double-count metrics.
    it("is one-shot: double-release does not double-count metrics", async () => {
      const events: Array<{ id: string; status: string; delta: number }> = [];
      const limiter = new Limiter<string>({
        limit: new FixedLimit(0),
        bypassResolver: () => true,
        metricRegistry: makeRecordingMetricRegistry(events),
      });

      const a = await limiter.acquire({ context: "x" });
      assert.ok(a);
      await a.releaseAndRecordSuccess();
      await a.releaseAndRecordSuccess();
      await a.releaseAndIgnore();

      const successCount = events.filter(
        (e) => e.id === MetricIds.CALL_NAME && e.status === "success",
      ).length;
      const ignoredCount = events.filter(
        (e) => e.id === MetricIds.CALL_NAME && e.status === "ignored",
      ).length;
      assert.equal(
        successCount,
        1,
        "second releaseAndRecordSuccess should be a no-op",
      );
      assert.equal(
        ignoredCount,
        0,
        "subsequent releaseAndIgnore on already-released allotment should be a no-op",
      );
    });

    // Non-bypassed allotments tag their CALL_NAME counters with the
    // operation name (via `operationNameFor`). Bypassed allotments must
    // do the same so per-operation dashboards include bypassed traffic.
    it("tags success/ignored/dropped counters with operationNameFor when bypassing", async () => {
      const events: Array<{
        id: string;
        status: string;
        tags: Record<string, string>;
      }> = [];
      const recording: MetricRegistry = {
        counter(id, attrs) {
          return {
            add(_n, addTags) {
              events.push({
                id,
                status: attrs?.status ?? "",
                tags: { ...(attrs ?? {}), ...(addTags ?? {}) },
              });
            },
          };
        },
        gauge: () => ({ record() {} }),
        distribution: () => ({ addSample() {} }),
      };

      const limiter = new Limiter<string>({
        limit: new FixedLimit(0),
        bypassResolver: () => true,
        operationNameFor: (ctx) => ctx,
        metricRegistry: recording,
      });

      const a = await limiter.acquire({ context: "list-things" });
      assert.ok(a);
      await a.releaseAndRecordSuccess();

      const successEvent = events.find(
        (e) => e.id === MetricIds.CALL_NAME && e.status === "success",
      );
      assert.ok(successEvent);
      assert.equal(
        successEvent.tags[MetricIds.OPERATION_NAME_TAG],
        "list-things",
        "bypassed success should carry the operation tag",
      );
    });
  });

  describe("release-path resilience to user-supplied throws", () => {
    // The release methods wrap every interaction with user-supplied code
    // (metrics, clock, the limit algorithm, the strategies) in try/catch
    // so that a single misbehaving collaborator can't leave the strategy
    // with a leaked permit or stall queued waiters in a blocking rejection
    // strategy. If we didn't, a metric exporter that throws on
    // `successCounter.add` would skip the `try { onAllotmentReleased }`
    // block entirely.
    it("throwing successCounter does not leak strategy permits", async () => {
      let throwOnSuccess = true;
      const throwingRegistry: MetricRegistry = {
        counter(_id, attrs) {
          return {
            add() {
              if (throwOnSuccess && attrs?.status === "success") {
                throw new Error("metric exporter unavailable");
              }
            },
          };
        },
        gauge: () => ({ record() {} }),
        distribution: () => ({ addSample() {} }),
      };

      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        metricRegistry: throwingRegistry,
      });

      const a = await limiter.acquire({});
      assert.ok(a);

      await a.releaseAndRecordSuccess();
      throwOnSuccess = false;

      const next = await limiter.acquire({});
      assert.ok(
        next,
        "permit should be returned to the strategy even if a metric throws",
      );
      await next.releaseAndRecordSuccess();
    });

    // Same shape as above but exercising the rejection-strategy
    // notification path: if the success counter throws, `onAllotmentReleased`
    // must still fire on the rejection strategy, otherwise its waiters
    // can stall.
    it("throwing successCounter still notifies rejection strategy onAllotmentReleased", async () => {
      let throwOnSuccess = true;
      const throwingRegistry: MetricRegistry = {
        counter(_id, attrs) {
          return {
            add() {
              if (throwOnSuccess && attrs?.status === "success") {
                throw new Error("boom");
              }
            },
          };
        },
        gauge: () => ({ record() {} }),
        distribution: () => ({ addSample() {} }),
      };

      let releasedNotifications = 0;
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        metricRegistry: throwingRegistry,
        allotmentUnavailableStrategy: {
          onAllotmentUnavailable: () => Promise.resolve(undefined),
          onAllotmentReleased() {
            releasedNotifications++;
          },
        },
      });

      const a = await limiter.acquire({});
      assert.ok(a);
      await a.releaseAndRecordSuccess();
      throwOnSuccess = false;

      assert.equal(
        releasedNotifications,
        1,
        "rejection strategy must learn about the released allotment",
      );
    });

    // `createAllotment` calls `this.clock()` and `this.operationNameFor?.(ctx)`
    // *after* the strategy has handed back a reservation but *before*
    // committing it. If either throws, the reservation must be cancelled
    // so the strategy permit isn't permanently leaked. (Cancelling rather
    // than releasing also means composers like `RedisTokenBucketStrategy`
    // can roll back side effects taken during reserve, e.g. refund the
    // bucket token, that `onAllotmentReleased` can't undo.)
    //
    // `acquire()` itself also calls `this.clock()` at the start (for the
    // acquire-time distribution). We arrange for the *second* call (the
    // one inside `createAllotment`, which runs after a reservation has
    // been taken) to throw so we exercise the rollback path.
    it("throwing clock during createAllotment does not leak strategy permits", async () => {
      let calls = 0;
      let armed = false;
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        clock: () => {
          calls++;
          if (armed && calls === 2) {
            throw new Error("monotonic clock failed");
          }
          return performance.now();
        },
      });

      armed = true;
      calls = 0;
      await assert.rejects(() => limiter.acquire({}), /monotonic clock failed/);
      armed = false;

      const next = await limiter.acquire({});
      assert.ok(
        next,
        "permit must be returned to the strategy when createAllotment throws",
      );
      await next.releaseAndRecordSuccess();
    });

    // Same as above but for `operationNameFor`.
    it("throwing operationNameFor during createAllotment does not leak strategy permits", async () => {
      let throwOnNextName = false;
      const limiter = new Limiter<string>({
        limit: new FixedLimit(1),
        operationNameFor: (ctx) => {
          if (throwOnNextName) {
            throwOnNextName = false;
            throw new Error("bad context");
          }
          return ctx;
        },
      });

      throwOnNextName = true;
      await assert.rejects(
        () => limiter.acquire({ context: "boom" }),
        /bad context/,
      );

      const next = await limiter.acquire({ context: "ok" });
      assert.ok(next);
      await next.releaseAndRecordSuccess();
    });

    // After `createAllotment` succeeds the slot is already reserved.
    // If the post-acquire metrics bookkeeping throws, `acquire()` must
    // still return the allotment so the caller can release it. Without
    // protection the permit would be permanently leaked.
    it("throwing acquireSucceededCounter does not leak permits after successful acquire", async () => {
      let throwOnAcquireSucceed = false;
      const throwingRegistry: MetricRegistry = {
        counter(_id, attrs) {
          return {
            add() {
              if (throwOnAcquireSucceed && attrs?.status === "succeeded") {
                throw new Error("counter unavailable");
              }
            },
          };
        },
        gauge: () => ({ record() {} }),
        distribution: () => ({ addSample() {} }),
      };

      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        metricRegistry: throwingRegistry,
      });

      throwOnAcquireSucceed = true;
      const a = await limiter.acquire({});
      assert.ok(
        a,
        "acquire() must return the allotment even when acquireSucceededCounter throws",
      );
      throwOnAcquireSucceed = false;
      await a.releaseAndRecordSuccess();

      // Permit was properly returned, so the next acquire should succeed.
      const next = await limiter.acquire({});
      assert.ok(
        next,
        "permit must not be leaked when acquireSucceededCounter throws",
      );
      await next.releaseAndRecordSuccess();
    });

    it("throwing acquireTimeOnSuccessDistribution does not leak permits after successful acquire", async () => {
      let throwOnSample = false;
      const throwingRegistry: MetricRegistry = {
        counter: () => ({ add() {} }),
        gauge: () => ({ record() {} }),
        distribution(_id) {
          return {
            addSample() {
              if (throwOnSample) {
                throw new Error("distribution unavailable");
              }
            },
          };
        },
      };

      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        metricRegistry: throwingRegistry,
      });

      throwOnSample = true;
      const a = await limiter.acquire({});
      assert.ok(
        a,
        "acquire() must return the allotment even when distribution.addSample throws",
      );
      throwOnSample = false;
      await a.releaseAndRecordSuccess();

      const next = await limiter.acquire({});
      assert.ok(
        next,
        "permit must not be leaked when acquireTimeOnSuccessDistribution throws",
      );
      await next.releaseAndRecordSuccess();
    });
  });

  describe("limit subscription error handling", () => {
    // `acquireStrategy.onLimitChanged` runs synchronously inside the
    // subscribe callback the limiter registers with the underlying
    // `AdaptiveLimit`. If it throws we deliberately do NOT try to "roll
    // back" any state we'd already updated — instead, the strategy is
    // notified BEFORE `_limit` / the gauge / rejection strategy / probe
    // are touched. An atomic refusal therefore leaves the limiter pinned
    // to the old limit (no partial-commit to clean up); a non-atomic
    // throw still propagates so the user can fix the underlying bug.
    it("propagates synchronous throws and leaves _limit pinned to oldLimit", () => {
      const settable = new SettableLimit(2);
      const gaugeRecords: number[] = [];
      const recordingRegistry: MetricRegistry = {
        counter: () => ({ add() {} }),
        distribution: () => ({ addSample() {} }),
        gauge: (id) => ({
          record(v) {
            if (id === MetricIds.LIMIT_NAME) gaugeRecords.push(v);
          },
        }),
      };

      let rejectionStrategyNotified = false;
      const limiter = new Limiter<void>({
        limit: settable,
        metricRegistry: recordingRegistry,
        acquireStrategy: {
          tryReserveAllotment: () =>
            new AllotmentReservation(
              () => {},
              () => {},
            ),
          onAllotmentReleased() {},
          onLimitChanged(oldLimit, newLimit) {
            throw new Error(
              `strategy refused limit change ${oldLimit}->${newLimit}`,
            );
          },
        },
        allotmentUnavailableStrategy: {
          onAllotmentUnavailable: () => Promise.resolve(undefined),
          onAllotmentReleased() {},
          onLimitChanged() {
            rejectionStrategyNotified = true;
          },
        },
      });

      // Constructor recorded the initial limit on the gauge.
      assert.deepEqual(gaugeRecords, [2]);

      assert.throws(
        () => settable.setLimit(5),
        /strategy refused limit change 2->5/,
      );

      assert.equal(
        limiter.getLimit(),
        2,
        "_limit should not advance past an atomic strategy refusal",
      );
      assert.deepEqual(
        gaugeRecords,
        [2],
        "gauge should not record the rejected limit",
      );
      assert.equal(
        rejectionStrategyNotified,
        false,
        "rejection strategy should not be notified of a refused change",
      );

      limiter.dispose();
    });

    // The release path swallows errors from `addSample` for liveness, so
    // a strategy that throws on `onLimitChanged` while a release-path
    // `addSample` is the trigger does NOT crash the release. This pins
    // down the asymmetry between caller-driven `setLimit` (which sees
    // the throw) and release-driven `addSample` (which doesn't).
    it("release-path addSample swallows subscribe-callback throws", async () => {
      let releasePathLimitChanges = 0;

      class ThrowOnceLimit implements AdaptiveLimit {
        private subscriber?: (n: number) => void;
        get currentLimit() {
          return 5;
        }
        subscribe(consumer: (n: number) => void) {
          this.subscriber = consumer;
          return () => {
            this.subscriber = undefined;
          };
        }
        addSample() {
          // Synthesize a limit change from inside `addSample`, like a
          // real adaptive limit would.
          this.subscriber?.(6);
        }
      }

      const limiter = new Limiter<void>({
        limit: new ThrowOnceLimit(),
        acquireStrategy: {
          tryReserveAllotment: () =>
            new AllotmentReservation(
              () => {},
              () => {},
            ),
          onAllotmentReleased() {},
          onLimitChanged() {
            releasePathLimitChanges++;
            throw new Error("strategy choked on limit change");
          },
        },
      });

      const a = await limiter.acquire({});
      assert.ok(a);
      // Should not throw or reject — the release path's try/catch around
      // `addSample` keeps liveness even when the subscribe callback throws.
      await a.releaseAndRecordSuccess();
      assert.equal(releasePathLimitChanges, 1);
      limiter.dispose();
    });
  });

  describe("signal abort during rejection-strategy retry", () => {
    // Complements the existing "cleans up if signal aborts after queued
    // retry acquires an allotment" test by also checking metrics: the
    // aborted-but-acquired-then-released attempt should still register a
    // CALL_NAME=ignored entry from the cleanup release, and an
    // ACQUIRE_ATTEMPT_NAME=succeeded entry from the retry that did acquire.
    it("records ignored CALL_NAME when signal aborts after retry acquires", async () => {
      const events: Array<{ id: string; status: string; delta: number }> = [];
      const ac = new AbortController();

      let resolveRetryStarted: (() => void) | undefined;
      const retryStarted = new Promise<void>((resolve) => {
        resolveRetryStarted = resolve;
      });
      let resolveReturnFromStrategy: (() => void) | undefined;
      const returnFromStrategy = new Promise<void>((resolve) => {
        resolveReturnFromStrategy = resolve;
      });

      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        metricRegistry: makeRecordingMetricRegistry(events),
        allotmentUnavailableStrategy: {
          async onAllotmentUnavailable(_ctx, retry) {
            const allotment = await retry(undefined);
            resolveRetryStarted?.();
            await returnFromStrategy;
            return allotment;
          },
          onAllotmentReleased() {},
        },
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);

      const queued = limiter.acquire({ signal: ac.signal });
      await holder.releaseAndRecordSuccess();
      await retryStarted;

      ac.abort();
      resolveReturnFromStrategy?.();

      const result = await queued;
      assert.equal(result, undefined);
      assert.equal(limiter.getInflight(), 0);

      // The retry's tryReserveAllotment did succeed, so we expect an
      // ACQUIRE_ATTEMPT_NAME=succeeded for it. The aborted cleanup should
      // record an ignored CALL_NAME.
      const ignored = events.filter(
        (e) => e.id === MetricIds.CALL_NAME && e.status === "ignored",
      ).length;
      assert.ok(
        ignored >= 1,
        "abort-after-retry-acquired should record an ignored call",
      );
    });
  });
});

/**
 * Build a {@link MetricRegistry} that pushes every counter increment into a
 * shared event log. Useful for asserting metric semantics in tests without
 * coupling to a real backend.
 */
function makeRecordingMetricRegistry(
  events: Array<{ id: string; status: string; delta: number }>,
): MetricRegistry {
  const counter = (id: string, attrs?: Record<string, string>): Counter => ({
    add(value) {
      events.push({ id, status: attrs?.status ?? "", delta: value });
    },
  });
  const gauge = (): Gauge => ({ record() {} });
  const distribution = (): DistributionMetric => ({ addSample() {} });
  return { counter, gauge, distribution };
}
