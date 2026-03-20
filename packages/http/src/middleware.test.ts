import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import type { RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { concurrencyLimitMiddleware } from "./middleware.js";
import { HttpLimiterBuilder } from "./HttpLimiterBuilder.js";
import { FixedLimit, Limiter } from "adaptive-concurrency";
import type { HttpRequest, HttpResponse } from "./middleware.js";
import type { LimitAllotment } from "adaptive-concurrency";

function makeReq(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: "GET",
    url: "/test",
    headers: {},
    ...overrides,
  };
}

function makeRes(): HttpResponse & { body?: string; triggerClose(): void } {
  const listeners: Partial<Record<"finish" | "close", Array<() => void>>> = {};
  const emit = (event: "finish" | "close") => {
    const eventListeners = listeners[event];
    if (!eventListeners) return;
    listeners[event] = [];
    for (const listener of eventListeners) {
      listener();
    }
  };

  const res = {
    statusCode: 200,
    body: undefined as string | undefined,
    end(data?: string) {
      this.body = data;
      emit("finish");
    },
    once(event: "finish" | "close", listener: () => void) {
      const eventListeners = listeners[event] ?? [];
      eventListeners.push(listener);
      listeners[event] = eventListeners;
    },
    triggerClose() {
      emit("close");
    },
    setHeader() {},
  };
  return res;
}

function makeHttpRequest(
  baseUrl: string,
  path: string,
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = get(`${baseUrl}${path}`, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
  });
}

async function startServer(
  handler: RequestListener,
): Promise<{ baseUrl: string; closeServer: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    closeServer: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function makeMockLimiter(allotment: LimitAllotment | undefined): Limiter<HttpRequest> {
  return {
    acquire: async () => allotment,
  } as unknown as Limiter<HttpRequest>;
}

describe("concurrencyLimitMiddleware", () => {
  it("should pass requests through when under limit", async () => {
    const limiter = new Limiter<HttpRequest>({ limit: new FixedLimit(10) });
    const mw = concurrencyLimitMiddleware(limiter);

    const res = makeRes();
    let called = false;
    await mw(makeReq(), res, () => {
      called = true;
      res.end("ok");
    });
    assert.ok(called, "next() should have been called");
  });

  it("should return 429 when limit is exceeded", async () => {
    const limiter = new Limiter<HttpRequest>({ limit: new FixedLimit(1) });
    const mw = concurrencyLimitMiddleware(limiter);

    // Consume the single slot (don't call next to simulate long-running)
    // Instead, acquire directly to hold the slot
    const listener = await limiter.acquire({ context: makeReq() });
    assert.ok(listener);

    // Second request through middleware should be rejected
    const res = makeRes();
    let nextCalled = false;
    await mw(makeReq(), res, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false, "next() should not be called");
    assert.equal(res.statusCode, 429);
    assert.equal(res.body, "Concurrency limit exceeded");
  });

  it("should use custom throttle status and message", async () => {
    const limiter = new Limiter<HttpRequest>({ limit: new FixedLimit(1) });
    const mw = concurrencyLimitMiddleware(limiter, {
      throttleStatus: 503,
      throttleMessage: "Service busy",
    });

    // Consume the slot
    await limiter.acquire({ context: makeReq() });

    const res = makeRes();
    await mw(makeReq(), res, () => {});

    assert.equal(res.statusCode, 503);
    assert.equal(res.body, "Service busy");
  });

  it("should enforce limit across in-flight requests on a real http.Server", async () => {
    const limiter = new Limiter<HttpRequest>({ limit: new FixedLimit(1) });
    const middleware = concurrencyLimitMiddleware(limiter);

    let resolveHoldStarted: (() => void) | undefined;
    const holdStarted = new Promise<void>((resolve) => {
      resolveHoldStarted = resolve;
    });

    const { baseUrl, closeServer } = await startServer((req, res) => {
      void middleware(req, res, () => {
        if (req.url === "/hold") {
          resolveHoldStarted?.();
          setTimeout(() => {
            res.statusCode = 200;
            res.end("held");
          }, 60);
          return;
        }

        res.statusCode = 200;
        res.end("ok");
      });
    });

    try {
      const firstRequest = makeHttpRequest(baseUrl, "/hold");
      await holdStarted;

      const secondResponse = await makeHttpRequest(baseUrl, "/fast");
      assert.equal(secondResponse.statusCode, 429);
      assert.equal(secondResponse.body, "Concurrency limit exceeded");

      const firstResponse = await firstRequest;
      assert.equal(firstResponse.statusCode, 200);
      assert.equal(firstResponse.body, "held");

      // Ensure the permit is released after response completion.
      const thirdResponse = await makeHttpRequest(baseUrl, "/after");
      assert.equal(thirdResponse.statusCode, 200);
      assert.equal(thirdResponse.body, "ok");
    } finally {
      await closeServer();
    }
  });

  it("should record dropped when response finishes with a 5xx status", async () => {
    let successCalls = 0;
    let ignoreCalls = 0;
    let droppedCalls = 0;
    const allotment: LimitAllotment = {
      releaseAndRecordSuccess: async () => {
        successCalls += 1;
      },
      releaseAndIgnore: async () => {
        ignoreCalls += 1;
      },
      releaseAndRecordDropped: async () => {
        droppedCalls += 1;
      },
    };
    const middleware = concurrencyLimitMiddleware(
      makeMockLimiter(allotment),
    ) as unknown as (
      req: HttpRequest,
      res: HttpResponse,
      next: () => void,
    ) => Promise<void>;

    const res = makeRes();
    await middleware(makeReq(), res, () => {
      res.statusCode = 503;
      res.end("error");
    });

    assert.equal(successCalls, 0);
    assert.equal(ignoreCalls, 0);
    assert.equal(droppedCalls, 1);
  });

  it("should record ignore when response finishes with a 3xx status by default", async () => {
    let successCalls = 0;
    let ignoreCalls = 0;
    let droppedCalls = 0;
    const allotment: LimitAllotment = {
      releaseAndRecordSuccess: async () => {
        successCalls += 1;
      },
      releaseAndIgnore: async () => {
        ignoreCalls += 1;
      },
      releaseAndRecordDropped: async () => {
        droppedCalls += 1;
      },
    };
    const middleware = concurrencyLimitMiddleware(
      makeMockLimiter(allotment),
    ) as unknown as (
      req: HttpRequest,
      res: HttpResponse,
      next: () => void,
    ) => Promise<void>;

    const res = makeRes();
    await middleware(makeReq(), res, () => {
      res.statusCode = 302;
      res.end("redirect");
    });

    assert.equal(successCalls, 0);
    assert.equal(ignoreCalls, 1);
    assert.equal(droppedCalls, 0);
  });

  it("should record ignore when response finishes with a 4xx status", async () => {
    let successCalls = 0;
    let ignoreCalls = 0;
    let droppedCalls = 0;
    const allotment: LimitAllotment = {
      releaseAndRecordSuccess: async () => {
        successCalls += 1;
      },
      releaseAndIgnore: async () => {
        ignoreCalls += 1;
      },
      releaseAndRecordDropped: async () => {
        droppedCalls += 1;
      },
    };
    const middleware = concurrencyLimitMiddleware(
      makeMockLimiter(allotment),
    ) as unknown as (
      req: HttpRequest,
      res: HttpResponse,
      next: () => void,
    ) => Promise<void>;

    const res = makeRes();
    await middleware(makeReq(), res, () => {
      res.statusCode = 400;
      res.end("bad request");
    });

    assert.equal(successCalls, 0);
    assert.equal(ignoreCalls, 1);
    assert.equal(droppedCalls, 0);
  });

  it("should record ignore when connection closes before finish", async () => {
    let successCalls = 0;
    let ignoreCalls = 0;
    let droppedCalls = 0;
    const allotment: LimitAllotment = {
      releaseAndRecordSuccess: async () => {
        successCalls += 1;
      },
      releaseAndIgnore: async () => {
        ignoreCalls += 1;
      },
      releaseAndRecordDropped: async () => {
        droppedCalls += 1;
      },
    };
    const middleware = concurrencyLimitMiddleware(
      makeMockLimiter(allotment),
    ) as unknown as (
      req: HttpRequest,
      res: HttpResponse,
      next: () => void,
    ) => Promise<void>;

    const res = makeRes();
    await middleware(makeReq(), res, () => {
      res.triggerClose();
    });

    assert.equal(successCalls, 0);
    assert.equal(ignoreCalls, 1);
    assert.equal(droppedCalls, 0);
  });

  it("should release only once when both finish and close fire", async () => {
    let successCalls = 0;
    let ignoreCalls = 0;
    let droppedCalls = 0;
    const allotment: LimitAllotment = {
      releaseAndRecordSuccess: async () => {
        successCalls += 1;
      },
      releaseAndIgnore: async () => {
        ignoreCalls += 1;
      },
      releaseAndRecordDropped: async () => {
        droppedCalls += 1;
      },
    };
    const middleware = concurrencyLimitMiddleware(
      makeMockLimiter(allotment),
    ) as unknown as (
      req: HttpRequest,
      res: HttpResponse,
      next: () => void,
    ) => Promise<void>;

    const res = makeRes();
    await middleware(makeReq(), res, () => {
      res.statusCode = 200;
      res.end("ok");
      res.triggerClose();
    });

    assert.equal(successCalls, 1);
    assert.equal(ignoreCalls, 0);
    assert.equal(droppedCalls, 0);
  });

  it("should record dropped when next throws synchronously", async () => {
    let successCalls = 0;
    let ignoreCalls = 0;
    let droppedCalls = 0;
    const allotment: LimitAllotment = {
      releaseAndRecordSuccess: async () => {
        successCalls += 1;
      },
      releaseAndIgnore: async () => {
        ignoreCalls += 1;
      },
      releaseAndRecordDropped: async () => {
        droppedCalls += 1;
      },
    };
    const middleware = concurrencyLimitMiddleware(
      makeMockLimiter(allotment),
    ) as unknown as (
      req: HttpRequest,
      res: HttpResponse,
      next: () => void,
    ) => Promise<void>;

    const error = new Error("boom");
    await assert.rejects(
      middleware(makeReq(), makeRes(), () => {
        throw error;
      }),
      (err: unknown) => err === error,
    );

    assert.equal(successCalls, 0);
    assert.equal(ignoreCalls, 0);
    assert.equal(droppedCalls, 1);
  });

  it("should support custom response classification", async () => {
    let successCalls = 0;
    let ignoreCalls = 0;
    let droppedCalls = 0;
    const allotment: LimitAllotment = {
      releaseAndRecordSuccess: async () => {
        successCalls += 1;
      },
      releaseAndIgnore: async () => {
        ignoreCalls += 1;
      },
      releaseAndRecordDropped: async () => {
        droppedCalls += 1;
      },
    };
    const middleware = concurrencyLimitMiddleware(makeMockLimiter(allotment), {
      classifyCompletedResponse: (res) =>
        res.statusCode === 302 ? "success" : "ignore",
    }) as unknown as (
      req: HttpRequest,
      res: HttpResponse,
      next: () => void,
    ) => Promise<void>;

    const res = makeRes();
    await middleware(makeReq(), res, () => {
      res.statusCode = 302;
      res.end("redirect");
    });

    assert.equal(successCalls, 1);
    assert.equal(ignoreCalls, 0);
    assert.equal(droppedCalls, 0);
  });
});

describe("HttpLimiterBuilder", () => {
  it("should build a simple limiter", async () => {
    const limiter = new HttpLimiterBuilder()
      .withLimit(new FixedLimit(5))
      .build();

    for (let i = 0; i < 5; i++) {
      const l = await limiter.acquire({ context: makeReq() });
      assert.ok(l, `Should acquire ${i}`);
    }
    assert.equal(await limiter.acquire({ context: makeReq() }), undefined);
  });

  it("should partition by header", async () => {
    const limiter = new HttpLimiterBuilder()
      .withLimit(new FixedLimit(10))
      .partitionByHeader("x-group")
      .partition("live", { percent: 0.9 })
      .partition("batch", { percent: 0.1 })
      .build();

    // Should be able to acquire for both groups
    const l1 = await limiter.acquire({
      context: makeReq({ headers: { "x-group": "live" } }),
    });
    const l2 = await limiter.acquire({
      context: makeReq({ headers: { "x-group": "batch" } }),
    });
    assert.ok(l1);
    assert.ok(l2);
  });

  it("should support bypass by header", async () => {
    const limiter = new HttpLimiterBuilder()
      .withLimit(new FixedLimit(1))
      .bypassLimitByHeader("x-bypass", "true")
      .build();

    // Exhaust limit
    const l1 = await limiter.acquire({ context: makeReq() });
    assert.ok(l1);
    assert.equal(await limiter.acquire({ context: makeReq() }), undefined);

    // Bypass should work
    const bypass = await limiter.acquire({
      context: makeReq({ headers: { "x-bypass": "true" } }),
    });
    assert.ok(bypass, "Should bypass");
  });

  it("should support bypass by method", async () => {
    const limiter = new HttpLimiterBuilder()
      .withLimit(new FixedLimit(1))
      .bypassLimitByMethod("OPTIONS")
      .build();

    await limiter.acquire({ context: makeReq() });
    assert.equal(await limiter.acquire({ context: makeReq() }), undefined);

    const bypass = await limiter.acquire({
      context: makeReq({ method: "OPTIONS" }),
    });
    assert.ok(bypass, "OPTIONS should bypass");
  });
});
