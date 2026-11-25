import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allotmentUnavailableError,
  isAllotmentUnavailableError,
} from "../../errors.js";
import type {
  AllotmentUnavailableStrategy,
  LimitAllotment,
  RetryAcquire,
} from "../../Limiter.js";
import { DelayedRejectStrategy } from "./DelayedRejectStrategy.js";
import { DelayedThenBlockingRejection } from "./DelayedThenBlockingRejection.js";

describe("DelayedThenBlockingRejection", () => {
  it("applies delay before delegating to blocking strategy", async () => {
    let delegateCalledAt = -1;
    const blocking: AllotmentUnavailableStrategy<string> = {
      onAllotmentUnavailable() {
        delegateCalledAt = performance.now();
        return Promise.reject(
          allotmentUnavailableError({ message: "refused" }),
        );
      },
      onAllotmentReleased() {},
    };

    const strategy = new DelayedThenBlockingRejection<string>({
      delayStrategy: new DelayedRejectStrategy<string>({
        delayMsForContext: () => 35,
      }),
      blockingStrategy: blocking,
    });

    const start = performance.now();
    await assert.rejects(
      strategy.onAllotmentUnavailable("a", async () => undefined),
      isAllotmentUnavailableError,
    );
    const elapsed = delegateCalledAt - start;
    assert.ok(
      elapsed >= 25,
      `expected delay before delegate, got ${elapsed}ms`,
    );
  });

  it("forwards onAllotmentReleased to blocking strategy", async () => {
    let releaseCalls = 0;
    const blocking: AllotmentUnavailableStrategy<string> = {
      onAllotmentUnavailable() {
        return Promise.reject(
          allotmentUnavailableError({ message: "refused" }),
        );
      },
      onAllotmentReleased() {
        releaseCalls++;
      },
    };

    const strategy = new DelayedThenBlockingRejection<string>({
      delayStrategy: new DelayedRejectStrategy<string>({
        delayMsForContext: () => 0,
      }),
      blockingStrategy: blocking,
    });

    await strategy.onAllotmentReleased();
    assert.equal(releaseCalls, 1);
  });

  it("forwards onLimitChanged to blocking strategy", () => {
    const limitChanges: Array<{ oldLimit: number; newLimit: number }> = [];
    const blocking: AllotmentUnavailableStrategy<string> = {
      onAllotmentUnavailable() {
        return Promise.reject(
          allotmentUnavailableError({ message: "refused" }),
        );
      },
      onAllotmentReleased() {},
      onLimitChanged(oldLimit, newLimit) {
        limitChanges.push({ oldLimit, newLimit });
      },
    };

    const strategy = new DelayedThenBlockingRejection<string>({
      delayStrategy: new DelayedRejectStrategy<string>({
        delayMsForContext: () => 0,
      }),
      blockingStrategy: blocking,
    });

    strategy.onLimitChanged(2, 5);
    assert.deepEqual(limitChanges, [{ oldLimit: 2, newLimit: 5 }]);
  });

  it("returns delegate allotment result after delay", async () => {
    const allotment: LimitAllotment = {
      async releaseAndRecordSuccess() {},
      async releaseAndIgnore() {},
      async releaseAndRecordDropped() {},
    };

    const blocking: AllotmentUnavailableStrategy<string> = {
      onAllotmentUnavailable(_context: string, retry: RetryAcquire<string>) {
        return retry("a").then((value) => value ?? allotment);
      },
      onAllotmentReleased() {},
    };

    const strategy = new DelayedThenBlockingRejection<string>({
      delayStrategy: new DelayedRejectStrategy<string>({
        delayMsForContext: () => 5,
      }),
      blockingStrategy: blocking,
    });

    const out = await strategy.onAllotmentUnavailable(
      "a",
      async () => undefined,
    );
    assert.equal(out, allotment);
  });

  it("rejects with the signal's reason when the signal aborts during the delay", async () => {
    let delegateCalls = 0;
    const blocking: AllotmentUnavailableStrategy<string> = {
      onAllotmentUnavailable() {
        delegateCalls++;
        return Promise.reject(
          allotmentUnavailableError({ message: "refused" }),
        );
      },
      onAllotmentReleased() {},
    };

    const strategy = new DelayedThenBlockingRejection<string>({
      delayStrategy: new DelayedRejectStrategy<string>({
        delayMsForContext: () => 10_000,
      }),
      blockingStrategy: blocking,
    });

    const controller = new AbortController();
    const reason = new Error("aborted by test");
    const result = strategy.onAllotmentUnavailable(
      "a",
      async () => undefined,
      controller.signal,
    );
    controller.abort(reason);

    await assert.rejects(result, (error) => error === reason);
    assert.equal(delegateCalls, 0);
  });
});
