import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LimitAllotment } from "../../LimitAllotment.js";
import { FixedLimit } from "../../limit/FixedLimit.js";
import { SettableLimit } from "../../limit/SettableLimit.js";
import type { AcquireResult } from "../../Limiter.js";
import { Limiter } from "../../Limiter.js";
import { FifoBlockingRejection } from "./FifoBlockingRejection.js";
import { LifoBlockingRejection } from "./LifoBlockingRejection.js";

describe("Blocking backlog rejection strategies", () => {
  describe("FifoBlockingRejection", () => {
    it("accepts default unbounded backlog size", () => {
      assert.doesNotThrow(() => new FifoBlockingRejection<void>());
    });

    it("should acquire immediately when under limit", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(10),
        allotmentUnavailableStrategy: new FifoBlockingRejection(),
      });

      const listener = await limiter.acquire({});
      assert.ok(listener, "Should acquire immediately");
      await listener!.releaseAndRecordSuccess();
    });

    it("should block and then acquire when a token is released", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: 5_000,
        }),
      });

      const listener1 = await limiter.acquire({});
      assert.ok(listener1);

      const acquirePromise = limiter.acquire({});

      setTimeout(() => listener1!.releaseAndRecordSuccess(), 50);

      const listener2 = await acquirePromise;
      assert.ok(listener2, "Should acquire after token released");
      await listener2!.releaseAndRecordSuccess();
    });

    it("should return undefined on backlog timeout", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: 100,
        }),
      });

      const listener1 = await limiter.acquire({});
      assert.ok(listener1);

      const start = performance.now();
      const listener2 = await limiter.acquire({});
      const elapsed = performance.now() - start;

      assert.equal(listener2, undefined, "Should return undefined on timeout");
      assert.ok(
        elapsed >= 50,
        `Should have waited at least 50ms, but waited ${elapsed}ms`,
      );
    });

    it("should throw when backlogTimeout exceeds MAX_TIMEOUT", () => {
      assert.throws(
        () => new FifoBlockingRejection({ backlogTimeout: 60 * 60 * 1000 + 1 }),
        /Timeout cannot be greater than/,
      );
    });

    it("should throw when backlogTimeout is NaN", () => {
      assert.throws(
        () => new FifoBlockingRejection({ backlogTimeout: NaN }),
        /Timeout must be a finite number/,
      );
    });

    it("should throw when backlogTimeout is Infinity", () => {
      assert.throws(
        () => new FifoBlockingRejection({ backlogTimeout: Infinity }),
        /Timeout must be a finite number/,
      );
    });

    it("should throw when backlogTimeout is negative", () => {
      assert.throws(
        () => new FifoBlockingRejection({ backlogTimeout: -1 }),
        /Timeout must be a finite number/,
      );
    });

    it("should throw when context-derived backlogTimeout is NaN", async () => {
      const limiter = new Limiter<{ timeoutMs: number }>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: (ctx) => ctx.timeoutMs,
        }),
      });

      const first = await limiter.acquire({ context: { timeoutMs: 5_000 } });
      await assert.rejects(
        () => limiter.acquire({ context: { timeoutMs: NaN } }),
        /Timeout must be a finite number/,
      );
      await first!.releaseAndRecordSuccess();
    });

    it("should unblock multiple waiters on release", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: 5_000,
        }),
      });

      const listener1 = await limiter.acquire({});
      assert.ok(listener1);

      const results: Array<AcquireResult> = [];
      for (let i = 0; i < 3; i++) {
        results.push(limiter.acquire({}));
      }

      await listener1!.releaseAndRecordSuccess();

      const second = await results[0];
      assert.ok(second, "Second should eventually acquire");
    });

    it("should return undefined when aborted while waiting", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: 5_000,
        }),
      });

      const listener1 = await limiter.acquire({});
      assert.ok(listener1);

      const abortController = new AbortController();
      const acquirePromise = limiter.acquire({
        signal: abortController.signal,
      });
      setTimeout(() => abortController.abort(), 20);

      const listener2 = await acquirePromise;
      assert.equal(listener2, undefined, "Should return undefined after abort");

      await listener1!.releaseAndRecordSuccess();
    });

    it("should support context-derived backlog timeout", async () => {
      const limiter = new Limiter<{ timeoutMs: number }>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: (context) => context.timeoutMs,
        }),
      });

      const listener1 = await limiter.acquire({ context: { timeoutMs: 500 } });
      assert.ok(listener1);

      const start = performance.now();
      const listener2 = await limiter.acquire({ context: { timeoutMs: 50 } });
      const elapsed = performance.now() - start;

      assert.equal(listener2, undefined, "Should time out based on context");
      assert.ok(elapsed >= 20);
      await listener1!.releaseAndRecordSuccess();
    });

    it("should return undefined when backlog is full", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogSize: 1,
          backlogTimeout: 5_000,
        }),
      });

      const first = await limiter.acquire({});
      assert.ok(first);

      const secondPromise = limiter.acquire({});
      const third = await limiter.acquire({});

      assert.equal(third, undefined, "Should reject when backlog is full");
      await first!.releaseAndRecordSuccess();
      const second = await secondPromise;
      assert.ok(second);
      await second!.releaseAndRecordSuccess();
    });

    it("should not call retry when signal is already aborted", async () => {
      const strategy = new FifoBlockingRejection<void>({
        backlogTimeout: 5_000,
      });
      const abortController = new AbortController();
      abortController.abort();

      let retryCalls = 0;
      const result = await strategy.onAllotmentUnavailable(
        undefined,
        async () => {
          retryCalls += 1;
          return undefined;
        },
        abortController.signal,
      );

      assert.equal(result, undefined);
      assert.equal(
        retryCalls,
        0,
        "retry should not be called when already aborted",
      );
    });

    it("should remove aborted waiter from backlog", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogSize: 1,
          backlogTimeout: 5_000,
        }),
      });

      const first = await limiter.acquire({});
      assert.ok(first);

      const abortController = new AbortController();
      const abortedWaiter = limiter.acquire({ signal: abortController.signal });
      setTimeout(() => abortController.abort(), 20);
      assert.equal(await abortedWaiter, undefined);

      // If aborted waiters are cleaned up correctly, this should be admitted to backlog.
      const nextWaiterPromise = limiter.acquire({});
      await first!.releaseAndRecordSuccess();
      const next = await nextWaiterPromise;
      assert.ok(next);
      await next!.releaseAndRecordSuccess();
    });

    it("should not drop later waiters when the head waiter expires during retry", async () => {
      let firstRetryResolve:
        | ((value: LimitAllotment | undefined) => void)
        | undefined;
      const staleAcquire = new Promise<LimitAllotment | undefined>(
        (resolve) => {
          firstRetryResolve = resolve;
        },
      );

      let ignoredAllotments = 0;
      const staleAllotment: LimitAllotment = {
        async releaseAndRecordSuccess() {},
        async releaseAndIgnore() {
          ignoredAllotments += 1;
        },
        async releaseAndRecordDropped() {},
      };
      const freshAllotment: LimitAllotment = {
        async releaseAndRecordSuccess() {},
        async releaseAndIgnore() {},
        async releaseAndRecordDropped() {},
      };

      const strategy = new FifoBlockingRejection<{
        id: "stale" | "fresh";
        timeoutMs: number;
      }>({
        backlogTimeout: (context) => context.timeoutMs,
        backlogSize: 2,
      });

      const retry = async (context: {
        id: "stale" | "fresh";
        timeoutMs: number;
      }) => {
        if (context.id === "stale") {
          return staleAcquire;
        }
        return freshAllotment;
      };

      const stalePromise = strategy.onAllotmentUnavailable(
        { id: "stale", timeoutMs: 20 },
        retry,
      );
      const freshPromise = strategy.onAllotmentUnavailable(
        { id: "fresh", timeoutMs: 200 },
        retry,
      );

      const releaseWhileStaleInFlight = strategy.onAllotmentReleased();
      await new Promise((resolve) => setTimeout(resolve, 40)); // let stale timeout
      firstRetryResolve!(staleAllotment);
      await releaseWhileStaleInFlight;

      assert.equal(
        await stalePromise,
        undefined,
        "stale waiter should time out",
      );
      assert.equal(
        ignoredAllotments,
        1,
        "stale retry allotment should be released when waiter already expired",
      );
      assert.equal(
        await freshPromise,
        freshAllotment,
        "fresh waiter should still be served after stale waiter expires",
      );
    });

    it("should drain backlog when limit increases", async () => {
      const limit = new SettableLimit(1);
      const limiter = new Limiter<void>({
        limit,
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: 5_000,
        }),
      });

      const first = await limiter.acquire({});
      assert.ok(first);

      const secondPromise = limiter.acquire({});
      await Promise.resolve();
      limit.setLimit(2);

      const second = await Promise.race([
        secondPromise,
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 300),
        ),
      ]);

      assert.ok(second, "Queued waiter should acquire after limit increase");
      await first!.releaseAndRecordSuccess();
      await second!.releaseAndRecordSuccess();
    });

    it("should serve the next waiter after head waiter aborts during drain", async () => {
      let acquireGateResolve: (() => void) | undefined;
      let acquireCallCount = 0;
      const ac = new AbortController();

      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        acquireStrategy: {
          tryAcquireAllotment(_ctx, state) {
            acquireCallCount++;
            if (acquireCallCount === 1) {
              // First call: the initial acquire that fills the limit.
              return true;
            }
            if (state.inflight >= 1) {
              return false;
            }
            if (!acquireGateResolve) {
              // First retry during drain: gate to let abort fire mid-retry.
              return new Promise<boolean>((resolve) => {
                acquireGateResolve = () => resolve(true);
              });
            }
            return true;
          },
          onAllotmentReleased() {},
          onLimitChanged() {},
        },
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: 5_000,
          backlogSize: 10,
        }),
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);

      const abortedPromise = limiter.acquire({ signal: ac.signal });
      const waitingPromise = limiter.acquire({});

      // Release the holder, triggering drain. The drain will call retry for
      // the head waiter (the one with the abort signal), which blocks on
      // acquireGateResolve.
      const releasePromise = holder!.releaseAndRecordSuccess();

      // Let the drain enter the retry await, then abort the head waiter
      // while the retry is in-flight.
      await new Promise((r) => setTimeout(r, 10));
      ac.abort();
      acquireGateResolve!();

      await releasePromise;
      assert.equal(
        await abortedPromise,
        undefined,
        "aborted waiter resolves undefined",
      );

      const second = await Promise.race([
        waitingPromise,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 500)),
      ]);
      assert.ok(
        second,
        "next waiter should acquire after aborted head is skipped during drain",
      );
      await second!.releaseAndRecordSuccess();
    });

    it("should serve remaining waiters after multiple aborts in sequence", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: 5_000,
          backlogSize: 10,
        }),
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);

      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const aborted1 = limiter.acquire({ signal: ac1.signal });
      const aborted2 = limiter.acquire({ signal: ac2.signal });
      const waitingPromise = limiter.acquire({});

      ac1.abort();
      ac2.abort();
      assert.equal(await aborted1, undefined);
      assert.equal(await aborted2, undefined);

      await holder!.releaseAndRecordSuccess();

      const result = await Promise.race([
        waitingPromise,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 500)),
      ]);
      assert.ok(result, "non-aborted waiter should still acquire");
      await result!.releaseAndRecordSuccess();
    });

    it("should not stall when abort occurs right before release triggers drain", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: 5_000,
          backlogSize: 10,
        }),
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);

      const ac = new AbortController();
      const abortedPromise = limiter.acquire({ signal: ac.signal });
      const waitingPromise = limiter.acquire({});

      // Abort and release in same microtask batch
      ac.abort();
      const releasePromise = holder!.releaseAndRecordSuccess();

      assert.equal(await abortedPromise, undefined);
      await releasePromise;

      const result = await Promise.race([
        waitingPromise,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 500)),
      ]);
      assert.ok(result, "waiter behind aborted head should still acquire");
      await result!.releaseAndRecordSuccess();
    });

    it("should handle abort of all queued waiters without leaking inflight", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: 5_000,
          backlogSize: 10,
        }),
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);
      assert.equal(limiter.getInflight(), 1);

      const controllers = Array.from(
        { length: 3 },
        () => new AbortController(),
      );
      const promises = controllers.map((ac) =>
        limiter.acquire({ signal: ac.signal }),
      );

      for (const ac of controllers) ac.abort();
      for (const p of promises) assert.equal(await p, undefined);

      await holder!.releaseAndRecordSuccess();
      assert.equal(limiter.getInflight(), 0, "inflight must return to 0");

      const fresh = await limiter.acquire({});
      assert.ok(
        fresh,
        "slot should be fully available after all aborts + release",
      );
      await fresh!.releaseAndRecordSuccess();
    });

    it("should handle timeout of head waiter followed by successful drain to next", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: (ctx) => ctx as unknown as number,
          backlogSize: 10,
        }),
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);

      // First waiter has a very short timeout
      const shortTimeout = limiter.acquire({ context: 30 as unknown as void });
      const longTimeout = limiter.acquire({
        context: 5_000 as unknown as void,
      });

      // Wait for short timeout to expire
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(
        await shortTimeout,
        undefined,
        "short-timeout waiter should expire",
      );

      await holder!.releaseAndRecordSuccess();

      const result = await Promise.race([
        longTimeout,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 500)),
      ]);
      assert.ok(result, "long-timeout waiter should still get served");
      await result!.releaseAndRecordSuccess();
    });

    it("should interleave abort and successful acquire without stalling", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(2),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: 5_000,
          backlogSize: 10,
        }),
      });

      const holders = [await limiter.acquire({}), await limiter.acquire({})];
      assert.ok(holders[0]);
      assert.ok(holders[1]);

      const ac = new AbortController();
      const abortedPromise = limiter.acquire({ signal: ac.signal });
      const w1 = limiter.acquire({});
      const w2 = limiter.acquire({});

      ac.abort();
      assert.equal(await abortedPromise, undefined);

      await holders[0]!.releaseAndRecordSuccess();
      const r1 = await Promise.race([
        w1,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 500)),
      ]);
      assert.ok(r1, "first non-aborted waiter should acquire");
      await r1!.releaseAndRecordSuccess();

      await holders[1]!.releaseAndRecordSuccess();
      const r2 = await Promise.race([
        w2,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 500)),
      ]);
      assert.ok(r2, "second non-aborted waiter should acquire");
      await r2!.releaseAndRecordSuccess();
    });

    it("should handle abort after signal passed to acquire but before entering backlog", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new FifoBlockingRejection({
          backlogTimeout: 5_000,
        }),
      });

      const ac = new AbortController();
      ac.abort();

      const result = await limiter.acquire({ signal: ac.signal });
      assert.equal(
        result,
        undefined,
        "pre-aborted signal should return undefined immediately",
      );
      assert.equal(limiter.getInflight(), 0, "inflight should remain 0");
    });

    it("should not drop waiters when the head waiter aborts during an in-flight retry (strategy-level)", async () => {
      let retryResolve: ((v: LimitAllotment | undefined) => void) | undefined;
      const retryGate = new Promise<LimitAllotment | undefined>((resolve) => {
        retryResolve = resolve;
      });

      const allotment: LimitAllotment = {
        async releaseAndRecordSuccess() {},
        async releaseAndIgnore() {},
        async releaseAndRecordDropped() {},
      };

      const strategy = new FifoBlockingRejection<{
        id: string;
        timeoutMs: number;
      }>({
        backlogTimeout: (ctx) => ctx.timeoutMs,
        backlogSize: 5,
      });

      const ac = new AbortController();

      const abortablePromise = strategy.onAllotmentUnavailable(
        { id: "aborting", timeoutMs: 5_000 },
        async () => retryGate,
        ac.signal,
      );
      const stablePromise = strategy.onAllotmentUnavailable(
        { id: "stable", timeoutMs: 5_000 },
        async () => allotment,
      );

      // Start draining — will call retry for the "aborting" waiter
      const drainPromise = strategy.onAllotmentReleased();

      // Abort the head waiter while its retry is in-flight
      ac.abort();

      // Complete the in-flight retry with an allotment
      retryResolve!(allotment);
      await drainPromise;

      // The aborted waiter should resolve undefined (it was removed by abort)
      assert.equal(await abortablePromise, undefined);

      // The allotment should have been released (removeByHandle returns false for
      // the aborted waiter), and the drain should continue to serve the stable waiter
      await strategy.onAllotmentReleased();
      assert.equal(
        await stablePromise,
        allotment,
        "stable waiter should be served",
      );
    });
  });

  describe("LifoBlockingRejection", () => {
    it("returns undefined immediately when signal is already aborted", async () => {
      const strategy = new LifoBlockingRejection<void>({
        backlogTimeout: 5_000,
      });
      const abortController = new AbortController();
      abortController.abort();

      let retryCalls = 0;
      const result = await strategy.onAllotmentUnavailable(
        undefined,
        async () => {
          retryCalls += 1;
          return undefined;
        },
        abortController.signal,
      );

      assert.equal(result, undefined);
      assert.equal(retryCalls, 0);
    });

    it("does not drop the next waiter when the selected waiter times out during retry", async () => {
      let firstRetryResolve:
        | ((value: LimitAllotment | undefined) => void)
        | undefined;
      const staleAcquire = new Promise<LimitAllotment | undefined>(
        (resolve) => {
          firstRetryResolve = resolve;
        },
      );

      let ignoredAllotments = 0;
      const staleAllotment: LimitAllotment = {
        async releaseAndRecordSuccess() {},
        async releaseAndIgnore() {
          ignoredAllotments += 1;
        },
        async releaseAndRecordDropped() {},
      };
      const freshAllotment: LimitAllotment = {
        async releaseAndRecordSuccess() {},
        async releaseAndIgnore() {},
        async releaseAndRecordDropped() {},
      };

      const strategy = new LifoBlockingRejection<{
        id: "fresh" | "stale";
        timeoutMs: number;
      }>({
        backlogTimeout: (context) => context.timeoutMs,
        backlogSize: 2,
      });

      const retry = async (context: {
        id: "fresh" | "stale";
        timeoutMs: number;
      }) => {
        if (context.id === "stale") {
          return staleAcquire;
        }
        return freshAllotment;
      };

      const freshPromise = strategy.onAllotmentUnavailable(
        { id: "fresh", timeoutMs: 200 },
        retry,
      );
      const stalePromise = strategy.onAllotmentUnavailable(
        { id: "stale", timeoutMs: 20 },
        retry,
      );

      const releaseWhileStaleInFlight = strategy.onAllotmentReleased();
      await new Promise((resolve) => setTimeout(resolve, 40)); // let stale timeout
      firstRetryResolve!(staleAllotment);
      await releaseWhileStaleInFlight;

      assert.equal(
        await stalePromise,
        undefined,
        "stale waiter should time out",
      );
      assert.equal(
        ignoredAllotments,
        1,
        "stale retry allotment should be released when waiter already expired",
      );

      await strategy.onAllotmentReleased();
      assert.equal(
        await freshPromise,
        freshAllotment,
        "fresh waiter should still be served after stale waiter expires",
      );
    });

    it("drains backlog when limit increases", async () => {
      const limit = new SettableLimit(1);
      const limiter = new Limiter<void>({
        limit,
        allotmentUnavailableStrategy: new LifoBlockingRejection({
          backlogTimeout: 5_000,
        }),
      });

      const first = await limiter.acquire({});
      assert.ok(first);

      const secondPromise = limiter.acquire({});
      await Promise.resolve();
      limit.setLimit(2);

      const second = await Promise.race([
        secondPromise,
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), 300),
        ),
      ]);

      assert.ok(second, "Queued waiter should acquire after limit increase");
      await first!.releaseAndRecordSuccess();
      await second!.releaseAndRecordSuccess();
    });

    it("should serve remaining waiters after head (most recent) aborts during drain", async () => {
      let acquireGateResolve: (() => void) | undefined;
      let acquireCallCount = 0;
      const ac = new AbortController();

      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        acquireStrategy: {
          tryAcquireAllotment(_ctx, state) {
            acquireCallCount++;
            if (acquireCallCount === 1) {
              return true;
            }
            if (state.inflight >= 1) {
              return false;
            }
            if (!acquireGateResolve) {
              // First retry during drain (for the LIFO head): gate to let
              // abort fire mid-retry.
              return new Promise<boolean>((resolve) => {
                acquireGateResolve = () => resolve(true);
              });
            }
            return true;
          },
          onAllotmentReleased() {},
          onLimitChanged() {},
        },
        allotmentUnavailableStrategy: new LifoBlockingRejection({
          backlogTimeout: 5_000,
          backlogSize: 10,
        }),
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);

      // In LIFO, w1 goes to front, then abortedPromise displaces it to front
      const w1 = limiter.acquire({});
      const abortedPromise = limiter.acquire({ signal: ac.signal });

      // Release triggers drain. The drain retries the LIFO head (the abortable
      // waiter), which blocks on acquireGateResolve.
      const releasePromise = holder!.releaseAndRecordSuccess();

      await new Promise((r) => setTimeout(r, 10));
      ac.abort();
      acquireGateResolve!();

      await releasePromise;
      assert.equal(
        await abortedPromise,
        undefined,
        "aborted waiter resolves undefined",
      );

      const result = await Promise.race([
        w1,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 500)),
      ]);
      assert.ok(
        result,
        "earlier waiter should still get served after head aborts during drain",
      );
      await result!.releaseAndRecordSuccess();
    });

    it("should handle multiple aborts in LIFO order without stalling", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new LifoBlockingRejection({
          backlogTimeout: 5_000,
          backlogSize: 10,
        }),
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);

      const stable = limiter.acquire({});
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const aborted1 = limiter.acquire({ signal: ac1.signal });
      const aborted2 = limiter.acquire({ signal: ac2.signal });

      ac1.abort();
      ac2.abort();
      assert.equal(await aborted1, undefined);
      assert.equal(await aborted2, undefined);

      await holder!.releaseAndRecordSuccess();

      const result = await Promise.race([
        stable,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 500)),
      ]);
      assert.ok(result, "stable waiter should acquire after all aborts");
      await result!.releaseAndRecordSuccess();
    });

    it("should handle abort of all LIFO waiters without leaking inflight", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new LifoBlockingRejection({
          backlogTimeout: 5_000,
          backlogSize: 10,
        }),
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);

      const controllers = Array.from(
        { length: 3 },
        () => new AbortController(),
      );
      const promises = controllers.map((ac) =>
        limiter.acquire({ signal: ac.signal }),
      );

      for (const ac of controllers) ac.abort();
      for (const p of promises) assert.equal(await p, undefined);

      await holder!.releaseAndRecordSuccess();
      assert.equal(limiter.getInflight(), 0);

      const fresh = await limiter.acquire({});
      assert.ok(fresh, "slot should be available after all LIFO aborts");
      await fresh!.releaseAndRecordSuccess();
    });

    it("should not stall when abort and release happen concurrently in LIFO", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new LifoBlockingRejection({
          backlogTimeout: 5_000,
          backlogSize: 10,
        }),
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);

      const w1 = limiter.acquire({});
      const ac = new AbortController();
      const abortedPromise = limiter.acquire({ signal: ac.signal });

      ac.abort();
      const releasePromise = holder!.releaseAndRecordSuccess();

      assert.equal(await abortedPromise, undefined);
      await releasePromise;

      const result = await Promise.race([
        w1,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 500)),
      ]);
      assert.ok(result, "surviving waiter should acquire");
      await result!.releaseAndRecordSuccess();
    });

    it("should handle timeout of head waiter followed by drain to older waiter", async () => {
      const limiter = new Limiter<void>({
        limit: new FixedLimit(1),
        allotmentUnavailableStrategy: new LifoBlockingRejection({
          backlogTimeout: (ctx) => ctx as unknown as number,
          backlogSize: 10,
        }),
      });

      const holder = await limiter.acquire({});
      assert.ok(holder);

      // In LIFO: long-timeout goes first, then short-timeout pushes to head
      const longTimeout = limiter.acquire({
        context: 5_000 as unknown as void,
      });
      const shortTimeout = limiter.acquire({ context: 30 as unknown as void });

      await new Promise((r) => setTimeout(r, 60));
      assert.equal(
        await shortTimeout,
        undefined,
        "short-timeout head should expire",
      );

      await holder!.releaseAndRecordSuccess();

      const result = await Promise.race([
        longTimeout,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), 500)),
      ]);
      assert.ok(
        result,
        "long-timeout waiter should be served after head times out",
      );
      await result!.releaseAndRecordSuccess();
    });

    it("should not drop the earlier waiter when the selected LIFO head aborts during retry (strategy-level)", async () => {
      let retryResolve: ((v: LimitAllotment | undefined) => void) | undefined;
      const retryGate = new Promise<LimitAllotment | undefined>((resolve) => {
        retryResolve = resolve;
      });

      const allotment: LimitAllotment = {
        async releaseAndRecordSuccess() {},
        async releaseAndIgnore() {},
        async releaseAndRecordDropped() {},
      };

      const strategy = new LifoBlockingRejection<{
        id: string;
        timeoutMs: number;
      }>({
        backlogTimeout: (ctx) => ctx.timeoutMs,
        backlogSize: 5,
      });

      const stablePromise = strategy.onAllotmentUnavailable(
        { id: "stable", timeoutMs: 5_000 },
        async () => allotment,
      );

      const ac = new AbortController();
      // LIFO: this goes to the front
      const abortablePromise = strategy.onAllotmentUnavailable(
        { id: "aborting", timeoutMs: 5_000 },
        async () => retryGate,
        ac.signal,
      );

      const drainPromise = strategy.onAllotmentReleased();
      ac.abort();
      retryResolve!(allotment);
      await drainPromise;

      assert.equal(
        await abortablePromise,
        undefined,
        "aborted waiter resolves undefined",
      );

      await strategy.onAllotmentReleased();
      assert.equal(
        await stablePromise,
        allotment,
        "stable waiter should be served",
      );
    });
  });
});
