import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { concurrencyLimitMiddleware } from "./middleware.js";
import { HttpLimiterBuilder } from "./HttpLimiterBuilder.js";
import { FixedLimit, Limiter } from "adaptive-concurrency";
import type { HttpRequest, HttpResponse, NextFunction } from "./middleware.js";

function makeReq(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: "GET",
    url: "/test",
    headers: {},
    ...overrides,
  };
}

function makeRes(): HttpResponse & { body?: string } {
  const res = {
    statusCode: 200,
    body: undefined as string | undefined,
    end(data?: string) {
      this.body = data;
    },
    setHeader() {},
  };
  return res;
}

describe("concurrencyLimitMiddleware", () => {
  it("should pass requests through when under limit", () => {
    const limiter = new Limiter<HttpRequest>({ limit: new FixedLimit(10) });
    const mw = concurrencyLimitMiddleware(limiter);

    let called = false;
    mw(makeReq(), makeRes(), () => { called = true; });
    assert.ok(called, "next() should have been called");
  });

  it("should return 429 when limit is exceeded", () => {
    const limiter = new Limiter<HttpRequest>({ limit: new FixedLimit(1) });
    const mw = concurrencyLimitMiddleware(limiter);

    // Consume the single slot (don't call next to simulate long-running)
    // Instead, acquire directly to hold the slot
    const listener = limiter.acquire({ context: makeReq() });
    assert.ok(listener);

    // Second request through middleware should be rejected
    const res = makeRes();
    let nextCalled = false;
    mw(makeReq(), res, () => { nextCalled = true; });

    assert.equal(nextCalled, false, "next() should not be called");
    assert.equal(res.statusCode, 429);
    assert.equal(res.body, "Concurrency limit exceeded");
  });

  it("should use custom throttle status and message", () => {
    const limiter = new Limiter<HttpRequest>({ limit: new FixedLimit(1) });
    const mw = concurrencyLimitMiddleware(limiter, {
      throttleStatus: 503,
      throttleMessage: "Service busy",
    });

    // Consume the slot
    limiter.acquire({ context: makeReq() });

    const res = makeRes();
    mw(makeReq(), res, () => {});

    assert.equal(res.statusCode, 503);
    assert.equal(res.body, "Service busy");
  });
});

describe("HttpLimiterBuilder", () => {
  it("should build a simple limiter", () => {
    const limiter = new HttpLimiterBuilder()
      .withLimit(new FixedLimit(5))
      .build();

    const listeners = [];
    for (let i = 0; i < 5; i++) {
      const l = limiter.acquire({ context: makeReq() });
      assert.ok(l, `Should acquire ${i}`);
      listeners.push(l!);
    }
    assert.equal(limiter.acquire({ context: makeReq() }), undefined);
  });

  it("should partition by header", () => {
    const limiter = new HttpLimiterBuilder()
      .withLimit(new FixedLimit(10))
      .partitionByHeader("x-group")
      .partition("live", { percent: 0.9 })
      .partition("batch", { percent: 0.1 })
      .build();

    // Should be able to acquire for both groups
    const l1 = limiter.acquire({ context: makeReq({ headers: { "x-group": "live" } }) });
    const l2 = limiter.acquire({ context: makeReq({ headers: { "x-group": "batch" } }) });
    assert.ok(l1);
    assert.ok(l2);
  });

  it("should support bypass by header", () => {
    const limiter = new HttpLimiterBuilder()
      .withLimit(new FixedLimit(1))
      .bypassLimitByHeader("x-bypass", "true")
      .build();

    // Exhaust limit
    const l1 = limiter.acquire({ context: makeReq() });
    assert.ok(l1);
    assert.equal(limiter.acquire({ context: makeReq() }), undefined);

    // Bypass should work
    const bypass = limiter.acquire({ context: makeReq({ headers: { "x-bypass": "true" } }) });
    assert.ok(bypass, "Should bypass");
  });

  it("should support bypass by method", () => {
    const limiter = new HttpLimiterBuilder()
      .withLimit(new FixedLimit(1))
      .bypassLimitByMethod("OPTIONS")
      .build();

    limiter.acquire({ context: makeReq() });
    assert.equal(limiter.acquire({ context: makeReq() }), undefined);

    const bypass = limiter.acquire({ context: makeReq({ method: "OPTIONS" }) });
    assert.ok(bypass, "OPTIONS should bypass");
  });
});
