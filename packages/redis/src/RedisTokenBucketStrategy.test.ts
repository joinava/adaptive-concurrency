import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AllotmentReservation,
  Limiter,
  PartitionedStrategy,
  SemaphoreStrategy,
  SettableLimit,
  type AcquireStrategy,
  type LimiterState,
} from "adaptive-concurrency";
import {
  RedisTokenBucket,
  type RedisTokenBucketClient,
} from "./RedisTokenBucket.js";
import { RedisTokenBucketStrategy } from "./RedisTokenBucketStrategy.js";

/**
 * Acquire-script return shape. `[1, 0]` = granted; `[0, waitMs]` = denied.
 */
type AcquireResponse = [1, 0] | [0, number];

/**
 * Refund-script return shape. `1` = refunded; `0` = bucket already full
 * or absent. The strategy doesn't branch on this value, but the mock has to
 * return something.
 */
type RefundResponse = 0 | 1;

type ScriptedResponse = AcquireResponse | RefundResponse;

/**
 * Mock client whose `evalSha` ignores the actual script and returns whatever
 * the test scripted via `responses`. `scriptLoad` always succeeds with a fake
 * SHA. `error` lets a test simulate a Redis outage.
 */
function makeMockClient(options: {
  responses?: Array<ScriptedResponse>;
  error?: Error;
}): RedisTokenBucketClient & {
  readonly scriptLoadCalls: number;
  readonly evalShaCalls: ReadonlyArray<{
    keys: string[];
    arguments: string[];
  }>;
} {
  const responses = options.responses ?? [];
  let scriptLoadCalls = 0;
  const evalShaCalls: Array<{ keys: string[]; arguments: string[] }> = [];

  return {
    get scriptLoadCalls() {
      return scriptLoadCalls;
    },
    get evalShaCalls() {
      return evalShaCalls;
    },
    async scriptLoad(_script: string): Promise<string> {
      scriptLoadCalls++;
      if (options.error) throw options.error;
      return "fake-sha";
    },
    async evalSha(
      _sha: string,
      args: { keys: string[]; arguments: string[] },
    ): Promise<unknown> {
      evalShaCalls.push(args);
      if (options.error) throw options.error;
      if (responses.length === 0) {
        throw new Error("Mock client out of scripted responses");
      }
      return responses.shift();
    },
  };
}

/**
 * Inner-strategy stub that records every call. `reserveResults` scripts the
 * sequence of reserve outcomes (default: always grant). `commitThrows` /
 * `cancelThrows` make the next matching transition throw.
 */
function makeInnerStub<ContextT>(
  options: {
    reserveResults?: boolean[];
    commitThrows?: Error;
    cancelThrows?: Error;
  } = {},
) {
  const results = options.reserveResults ?? [];
  const reserveCalls: ContextT[] = [];
  const commitCalls: ContextT[] = [];
  const cancelCalls: ContextT[] = [];
  const releasedCalls: ContextT[] = [];
  const limitChanges: Array<[number, number]> = [];

  const strategy: AcquireStrategy<ContextT> = {
    tryReserveAllotment(
      context: ContextT,
      _state: LimiterState,
    ): AllotmentReservation | undefined {
      reserveCalls.push(context);
      const granted = results.shift() ?? true;
      if (!granted) return undefined;
      return new AllotmentReservation(
        () => {
          commitCalls.push(context);
          if (options.commitThrows) throw options.commitThrows;
        },
        () => {
          cancelCalls.push(context);
          if (options.cancelThrows) throw options.cancelThrows;
        },
      );
    },
    onAllotmentReleased(context: ContextT): void {
      releasedCalls.push(context);
    },
    onLimitChanged(oldLimit: number, newLimit: number): void {
      limitChanges.push([oldLimit, newLimit]);
    },
  };

  return {
    strategy,
    reserveCalls,
    commitCalls,
    cancelCalls,
    releasedCalls,
    limitChanges,
  };
}

const fakeState: LimiterState = { limit: 10, inflight: 0 };

describe("RedisTokenBucket", () => {
  it("rejects invalid maxTokens values before any Redis calls", () => {
    const invalidValues = [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN];

    for (const maxTokens of invalidValues) {
      const client = makeMockClient({ responses: [[1, 0]] });

      assert.throws(
        () =>
          new RedisTokenBucket(client, {
            keyPrefix: "test",
            maxTokens,
            refillIntervalMs: 1000,
          }),
        /maxTokens must be a positive safe integer/,
      );
      assert.equal(
        client.scriptLoadCalls,
        0,
        "invalid config must fail before loading Redis scripts",
      );
    }
  });

  it("rejects invalid refillIntervalMs values before any Redis calls", () => {
    const invalidValues = [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN];

    for (const refillIntervalMs of invalidValues) {
      const client = makeMockClient({ responses: [[1, 0]] });

      assert.throws(
        () =>
          new RedisTokenBucket(client, {
            keyPrefix: "test",
            maxTokens: 5,
            refillIntervalMs,
          }),
        /refillIntervalMs must be a positive safe integer/,
      );
      assert.equal(
        client.scriptLoadCalls,
        0,
        "invalid config must fail before loading Redis scripts",
      );
    }
  });
});

describe("RedisTokenBucketStrategy", () => {
  describe("composition contract (inner reserves first; bucket second)", () => {
    it("admits when both gates grant: reserve, bucket OK, commit", async () => {
      const client = makeMockClient({ responses: [[1, 0]] });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 5,
        refillIntervalMs: 1000,
      });
      const inner = makeInnerStub<string>({ reserveResults: [true] });
      const strategy = new RedisTokenBucketStrategy<string>({
        bucket,
        inner: inner.strategy,
      });

      const reservation = await strategy.tryReserveAllotment("ctx-1", fakeState);
      assert.ok(reservation, "outer reservation should be granted");
      assert.deepEqual(inner.reserveCalls, ["ctx-1"]);
      assert.deepEqual(inner.commitCalls, []);
      assert.equal(client.evalShaCalls.length, 1, "tryAcquire only");

      await reservation.commit();
      assert.deepEqual(
        inner.commitCalls,
        ["ctx-1"],
        "inner commit fires on outer commit",
      );
      assert.deepEqual(inner.cancelCalls, []);
      assert.equal(
        client.evalShaCalls.length,
        1,
        "no refund on the success path",
      );
    });

    it("rejects without contacting Redis when the inner reserve denies", async () => {
      const client = makeMockClient({ responses: [] });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 5,
        refillIntervalMs: 1000,
      });
      const inner = makeInnerStub<void>({ reserveResults: [false] });
      const strategy = new RedisTokenBucketStrategy<void>({
        bucket,
        inner: inner.strategy,
      });

      assert.equal(
        await strategy.tryReserveAllotment(undefined, fakeState),
        undefined,
        "outer reserve must reflect inner denial",
      );
      assert.equal(client.evalShaCalls.length, 0, "Redis not consulted");
      assert.deepEqual(inner.commitCalls, []);
      assert.deepEqual(inner.cancelCalls, []);
    });

    it("rejects + cancels the inner when the bucket denies after the inner reserved", async () => {
      const client = makeMockClient({ responses: [[0, 100]] });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 5,
        refillIntervalMs: 1000,
      });
      const inner = makeInnerStub<string>({ reserveResults: [true] });
      const strategy = new RedisTokenBucketStrategy<string>({
        bucket,
        inner: inner.strategy,
      });

      assert.equal(
        await strategy.tryReserveAllotment("ctx-d", fakeState),
        undefined,
        "outer reserve must reflect bucket denial",
      );
      assert.deepEqual(inner.reserveCalls, ["ctx-d"]);
      assert.deepEqual(
        inner.cancelCalls,
        ["ctx-d"],
        "inner reservation must be cancelled when the bucket denies",
      );
      assert.deepEqual(inner.commitCalls, []);
      assert.equal(
        client.evalShaCalls.length,
        1,
        "tryAcquire only; no refund (no token was consumed)",
      );
    });

    it("cancels both gates when the outer reservation is cancelled after both granted", async () => {
      const client = makeMockClient({
        responses: [
          [1, 0], // tryAcquire grants
          1, // refund succeeds
        ],
      });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 5,
        refillIntervalMs: 1000,
      });
      const inner = makeInnerStub<string>({ reserveResults: [true] });
      const strategy = new RedisTokenBucketStrategy<string>({
        bucket,
        inner: inner.strategy,
      });

      const reservation = await strategy.tryReserveAllotment("ctx-x", fakeState);
      assert.ok(reservation);

      await reservation.cancel();

      assert.deepEqual(
        inner.cancelCalls,
        ["ctx-x"],
        "outer cancel propagates to inner",
      );
      assert.deepEqual(inner.commitCalls, []);
      assert.equal(
        client.evalShaCalls.length,
        2,
        "outer cancel after both gates granted must refund the bucket token",
      );
    });

    it("forwards onAllotmentReleased and onLimitChanged to inner", () => {
      const client = makeMockClient({});
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 5,
        refillIntervalMs: 1000,
      });
      const inner = makeInnerStub<string>();
      const strategy = new RedisTokenBucketStrategy<string>({
        bucket,
        inner: inner.strategy,
      });

      strategy.onAllotmentReleased("released-ctx");
      strategy.onLimitChanged(5, 9);

      assert.deepEqual(inner.releasedCalls, ["released-ctx"]);
      assert.deepEqual(inner.limitChanges, [[5, 9]]);
    });
  });

  describe("error handling on inner reservation transitions", () => {
    it("surfaces cancel-throws via onReservationError(phase: cancel) without throwing (bucket-denied path)", async () => {
      const client = makeMockClient({ responses: [[0, 100]] });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 5,
        refillIntervalMs: 1000,
      });
      const cancelError = new Error("cancel exploded");
      const inner = makeInnerStub<string>({
        reserveResults: [true],
        cancelThrows: cancelError,
      });
      const errors: Array<{
        context: string;
        phase: "cancel" | "commit";
        error: unknown;
      }> = [];
      const strategy = new RedisTokenBucketStrategy<string>({
        bucket,
        inner: inner.strategy,
        onReservationError: (info) => errors.push(info),
      });

      const result = await strategy.tryReserveAllotment("ctx-x", fakeState);
      assert.equal(
        result,
        undefined,
        "cancel-throw on bucket denial must not turn into a thrown reserve",
      );
      assert.deepEqual(errors, [
        { context: "ctx-x", phase: "cancel", error: cancelError },
      ]);
    });

    it("surfaces cancel-throws via onReservationError(phase: cancel) on outer-cancel after both granted", async () => {
      const client = makeMockClient({
        responses: [
          [1, 0], // tryAcquire grants
          1, // refund succeeds
        ],
      });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 5,
        refillIntervalMs: 1000,
      });
      const cancelError = new Error("late cancel exploded");
      const inner = makeInnerStub<string>({
        reserveResults: [true],
        cancelThrows: cancelError,
      });
      const errors: Array<{
        context: string;
        phase: "cancel" | "commit";
        error: unknown;
      }> = [];
      const strategy = new RedisTokenBucketStrategy<string>({
        bucket,
        inner: inner.strategy,
        onReservationError: (info) => errors.push(info),
      });

      const reservation = await strategy.tryReserveAllotment("ctx-y", fakeState);
      assert.ok(reservation);
      await reservation.cancel();

      assert.deepEqual(errors, [
        { context: "ctx-y", phase: "cancel", error: cancelError },
      ]);
      assert.equal(
        client.evalShaCalls.length,
        2,
        "bucket token must still be refunded even when the inner cancel throws",
      );
    });

    it("refunds the bucket and re-throws on commit-throw, surfacing onReservationError(phase: commit)", async () => {
      const client = makeMockClient({
        responses: [
          [1, 0], // tryAcquire grants
          1, // refund succeeds
        ],
      });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 5,
        refillIntervalMs: 1000,
      });
      const commitError = new Error("commit exploded");
      const inner = makeInnerStub<string>({
        reserveResults: [true],
        commitThrows: commitError,
      });
      const errors: Array<{
        context: string;
        phase: "cancel" | "commit";
        error: unknown;
      }> = [];
      const strategy = new RedisTokenBucketStrategy<string>({
        bucket,
        inner: inner.strategy,
        onReservationError: (info) => errors.push(info),
      });

      const reservation = await strategy.tryReserveAllotment("ctx-c", fakeState);
      assert.ok(reservation);

      await assert.rejects(
        async () => reservation.commit(),
        commitError,
        "commit-throw must propagate to the caller",
      );
      assert.deepEqual(errors, [
        { context: "ctx-c", phase: "commit", error: commitError },
      ]);
      assert.equal(
        client.evalShaCalls.length,
        2,
        "bucket token must be refunded after commit-throw",
      );
      assert.equal(client.evalShaCalls[1]?.keys[0], "test:default");
    });

    it("makes commit/cancel idempotent on a single outer reservation", async () => {
      const client = makeMockClient({ responses: [[1, 0]] });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 5,
        refillIntervalMs: 1000,
      });
      const inner = makeInnerStub<string>({ reserveResults: [true] });
      const strategy = new RedisTokenBucketStrategy<string>({
        bucket,
        inner: inner.strategy,
      });

      const reservation = await strategy.tryReserveAllotment("ctx-i", fakeState);
      assert.ok(reservation);

      await reservation.commit();
      await reservation.commit();
      await reservation.cancel();

      assert.deepEqual(
        inner.commitCalls,
        ["ctx-i"],
        "duplicate commit/cancel calls on the outer reservation must not re-fire the inner",
      );
      assert.deepEqual(inner.cancelCalls, []);
      assert.equal(
        client.evalShaCalls.length,
        1,
        "no refund: only the first commit ran, and it succeeded",
      );
    });
  });

  describe("keyResolver", () => {
    it("derives the bucket sub-key per context", async () => {
      const client = makeMockClient({
        responses: [
          [1, 0],
          [1, 0],
        ],
      });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 5,
        refillIntervalMs: 1000,
      });
      const inner = makeInnerStub<{ tenant: string }>();
      const strategy = new RedisTokenBucketStrategy<{ tenant: string }>({
        bucket,
        inner: inner.strategy,
        keyResolver: (ctx) => ctx.tenant,
      });

      const r1 = await strategy.tryReserveAllotment(
        { tenant: "alpha" },
        fakeState,
      );
      const r2 = await strategy.tryReserveAllotment(
        { tenant: "beta" },
        fakeState,
      );
      assert.ok(r1);
      assert.ok(r2);
      await r1.commit();
      await r2.commit();

      assert.deepEqual(client.evalShaCalls[0]?.keys, ["test:alpha"]);
      assert.deepEqual(client.evalShaCalls[1]?.keys, ["test:beta"]);
    });

    it("defaults to a single shared sub-key", async () => {
      const client = makeMockClient({ responses: [[1, 0]] });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 5,
        refillIntervalMs: 1000,
      });
      const inner = makeInnerStub<void>();
      const strategy = new RedisTokenBucketStrategy<void>({
        bucket,
        inner: inner.strategy,
      });

      const reservation = await strategy.tryReserveAllotment(
        undefined,
        fakeState,
      );
      assert.ok(reservation);
      await reservation.commit();
      assert.deepEqual(client.evalShaCalls[0]?.keys, ["test:default"]);
    });
  });

  describe("graceful degradation", () => {
    it("falls back to inner-only behavior when Redis is unavailable", async () => {
      const errors: unknown[] = [];
      const client = makeMockClient({ error: new Error("ECONNREFUSED") });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 5,
        refillIntervalMs: 1000,
        onError: (info) => {
          errors.push(info.error);
        },
      });
      const inner = makeInnerStub<void>({
        reserveResults: [true, false],
      });
      const strategy = new RedisTokenBucketStrategy<void>({
        bucket,
        inner: inner.strategy,
      });

      const r1 = await strategy.tryReserveAllotment(undefined, fakeState);
      assert.ok(r1, "Redis fails open on tryAcquire; inner grants");
      await r1.commit();

      assert.equal(
        await strategy.tryReserveAllotment(undefined, fakeState),
        undefined,
        "inner denies before Redis is consulted on the rejection path",
      );

      // Only one Redis call happened (the first reserve's bucket.tryAcquire,
      // which failed); the second reserve was rejected at the inner without
      // touching Redis at all.
      assert.equal(errors.length, 1);
    });
  });

  describe("integration with SemaphoreStrategy", () => {
    it("rejects via either gate", async () => {
      const client = makeMockClient({
        responses: [
          [1, 0], // 1st acquire: bucket grants
          [1, 0], // 2nd acquire: bucket grants
          // 3rd acquire: semaphore at limit, so the bucket is never consulted
        ],
      });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 100,
        refillIntervalMs: 1000,
      });
      const limit = new SettableLimit(2);
      const limiter = new Limiter<void>({
        limit,
        acquireStrategy: new RedisTokenBucketStrategy<void>({
          bucket,
          inner: new SemaphoreStrategy(limit.currentLimit),
        }),
      });

      const a = await limiter.acquire();
      const b = await limiter.acquire();
      assert.ok(a && b, "first two acquires use the local permits");
      assert.equal(client.evalShaCalls.length, 2);

      assert.equal(
        await limiter.acquire(),
        undefined,
        "third acquire rejected by the semaphore before Redis is consulted",
      );
      assert.equal(
        client.evalShaCalls.length,
        2,
        "inner-first ordering: a denied semaphore reserve short-circuits the bucket call",
      );
    });

    it("rejects via the bucket without committing the semaphore", async () => {
      const client = makeMockClient({
        responses: [
          [0, 100], // bucket denies
          [1, 0], // bucket grants
        ],
      });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 100,
        refillIntervalMs: 1000,
      });
      const limit = new SettableLimit(1);
      const limiter = new Limiter<void>({
        limit,
        acquireStrategy: new RedisTokenBucketStrategy<void>({
          bucket,
          inner: new SemaphoreStrategy(limit.currentLimit),
        }),
      });

      assert.equal(
        await limiter.acquire(),
        undefined,
        "bucket denies → semaphore reservation is cancelled, permit returned",
      );
      const allotment = await limiter.acquire();
      assert.ok(
        allotment,
        "the local semaphore still has its permit available for the next bucket grant",
      );
      assert.equal(client.evalShaCalls.length, 2);
    });
  });

  describe("integration with PartitionedStrategy", () => {
    it("does not pollute the partition's inflight distribution on bucket denials", async () => {
      const client = makeMockClient({
        responses: [
          [0, 100], // bucket denies first attempt
          [1, 0], // bucket grants second attempt
        ],
      });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 100,
        refillIntervalMs: 1000,
      });

      const inflightSamples: number[] = [];
      const recordingRegistry = {
        distribution(id: string, attributes?: Record<string, string>) {
          if (id === "inflight" && attributes?.["partition"] === "a") {
            return {
              addSample(value: number) {
                inflightSamples.push(value);
              },
            };
          }
          return { addSample() {} };
        },
        gauge() {
          return { record() {} };
        },
        counter() {
          return { add() {} };
        },
      };

      const limit = new SettableLimit(10);
      const partitioned = new PartitionedStrategy<string, "a">({
        initialLimit: limit.currentLimit,
        partitionResolver: (ctx) => (ctx === "a" ? ctx : undefined),
        partitions: { a: { percent: 1.0 } },
        metricRegistry: recordingRegistry,
      });
      const limiter = new Limiter<string>({
        limit,
        acquireStrategy: new RedisTokenBucketStrategy<string>({
          bucket,
          inner: partitioned,
        }),
      });

      const denied = await limiter.acquire({ context: "a" });
      assert.equal(denied, undefined, "bucket denies the first acquire");
      assert.deepEqual(
        inflightSamples,
        [],
        "bucket denial must not emit any inflight distribution sample for the partition",
      );

      const granted = await limiter.acquire({ context: "a" });
      assert.ok(granted, "bucket grants the second acquire");
      assert.deepEqual(
        inflightSamples,
        [1],
        "successful commit emits exactly one inflight sample",
      );
    });

    it("guards a partitioned strategy with the bucket", async () => {
      const client = makeMockClient({
        responses: [
          [1, 0], // partition a, granted
          [0, 100], // partition b, bucket denies
          [1, 0], // partition b, granted
        ],
      });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "test",
        maxTokens: 100,
        refillIntervalMs: 1000,
      });
      const limit = new SettableLimit(10);
      const partitioned = new PartitionedStrategy<string, "a" | "b">({
        initialLimit: limit.currentLimit,
        partitionResolver: (ctx) => (ctx === "a" || ctx === "b" ? ctx : undefined),
        partitions: { a: { percent: 0.5 }, b: { percent: 0.5 } },
      });
      const limiter = new Limiter<string>({
        limit,
        acquireStrategy: new RedisTokenBucketStrategy<string>({
          bucket,
          inner: partitioned,
          keyResolver: (ctx) => ctx,
        }),
      });

      const okA = await limiter.acquire({ context: "a" });
      assert.ok(okA, "partition a admitted by both gates");
      assert.deepEqual(client.evalShaCalls.at(-1)?.keys, ["test:a"]);
      assert.equal(
        partitioned.getPartition("a")?.inFlight,
        1,
        "partition a's inflight is incremented",
      );

      const deniedB = await limiter.acquire({ context: "b" });
      assert.equal(deniedB, undefined, "partition b denied by the bucket");
      assert.equal(
        partitioned.getPartition("b")?.inFlight,
        0,
        "partition b's reservation was returned after the bucket denial",
      );

      const okB = await limiter.acquire({ context: "b" });
      assert.ok(okB, "partition b admitted on retry");
    });
  });
});
