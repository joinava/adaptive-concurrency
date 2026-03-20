import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LimitAllotment } from "../../LimitAllotment.js";
import type {
  AcquireResult,
  AllotmentUnavailableStrategy,
} from "../../Limiter.js";
import { DelayedRejectStrategy } from "./DelayedRejectStrategy.js";
import { DelayedThenBlockingRejection } from "./DelayedThenBlockingRejection.js";

describe("DelayedThenBlockingRejection", () => {
  it("applies delay before delegating to blocking strategy", async () => {
    let delegateCalledAt = -1;
    const blocking: AllotmentUnavailableStrategy<string> = {
      onAllotmentUnavailable() {
        delegateCalledAt = performance.now();
        return Promise.resolve(undefined);
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
    await strategy.onAllotmentUnavailable("a", async () => undefined);
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
        return Promise.resolve(undefined);
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

  it("returns delegate allotment result after delay", async () => {
    const allotment: LimitAllotment = {
      async releaseAndRecordSuccess() {},
      async releaseAndIgnore() {},
      async releaseAndRecordDropped() {},
    };

    const blocking: AllotmentUnavailableStrategy<string> = {
      onAllotmentUnavailable(
        _context: string,
        retry: (context: string) => AcquireResult,
      ) {
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
});
