import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LimitAllotment } from "../LimitAllotment.js";
import type {
  AllotmentUnavailableStrategy,
  AsyncAcquireResult,
  SyncAcquireResult,
} from "../Limiter.js";
import { DelayedRejectStrategy } from "./DelayedRejectStrategy.js";
import { DelayedThenBlockingRejection } from "./DelayedThenBlockingRejection.js";

describe("DelayedThenBlockingRejection", () => {
  it("applies delay before delegating to blocking strategy", async () => {
    let delegateCalledAt = -1;
    const blocking: AllotmentUnavailableStrategy<string, AsyncAcquireResult> = {
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
    await strategy.onAllotmentUnavailable("a", () => undefined);
    const elapsed = delegateCalledAt - start;
    assert.ok(elapsed >= 25, `expected delay before delegate, got ${elapsed}ms`);
  });

  it("forwards onAllotmentReleased to blocking strategy", () => {
    let releaseCalls = 0;
    const blocking: AllotmentUnavailableStrategy<string, AsyncAcquireResult> = {
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

    strategy.onAllotmentReleased();
    assert.equal(releaseCalls, 1);
  });

  it("returns delegate allotment result after delay", async () => {
    const allotment: LimitAllotment = {
      reportSuccess() {},
      reportIgnore() {},
      reportDropped() {},
    };

    const blocking: AllotmentUnavailableStrategy<string, AsyncAcquireResult> = {
      onAllotmentUnavailable(
        _context: string,
        retry: (context: string) => SyncAcquireResult,
      ) {
        return Promise.resolve(retry("a") ?? allotment);
      },
      onAllotmentReleased() {},
    };

    const strategy = new DelayedThenBlockingRejection<string>({
      delayStrategy: new DelayedRejectStrategy<string>({
        delayMsForContext: () => 5,
      }),
      blockingStrategy: blocking,
    });

    const out = await strategy.onAllotmentUnavailable("a", () => undefined);
    assert.equal(out, allotment);
  });
});
