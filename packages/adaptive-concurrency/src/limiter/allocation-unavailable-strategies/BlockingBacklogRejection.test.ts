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
      assert.equal(retryCalls, 0, "retry should not be called when already aborted");
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
      const staleAcquire = new Promise<LimitAllotment | undefined>((resolve) => {
        firstRetryResolve = resolve;
      });

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

      const retry = async (context: { id: "stale" | "fresh"; timeoutMs: number }) => {
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

      assert.equal(await stalePromise, undefined, "stale waiter should time out");
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
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 300)),
      ]);

      assert.ok(second, "Queued waiter should acquire after limit increase");
      await first!.releaseAndRecordSuccess();
      await second!.releaseAndRecordSuccess();
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
      let firstRetryResolve: ((value: LimitAllotment | undefined) => void) | undefined;
      const staleAcquire = new Promise<LimitAllotment | undefined>((resolve) => {
        firstRetryResolve = resolve;
      });

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

      const retry = async (context: { id: "fresh" | "stale"; timeoutMs: number }) => {
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

      assert.equal(await stalePromise, undefined, "stale waiter should time out");
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
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 300)),
      ]);

      assert.ok(second, "Queued waiter should acquire after limit increase");
      await first!.releaseAndRecordSuccess();
      await second!.releaseAndRecordSuccess();
    });
  });
});
