import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import RedisMock from "ioredis-mock";
import {
  RedisTokenBucket,
  type RedisTokenBucketClient,
} from "./RedisTokenBucket.js";

/**
 * A {@link RedisTokenBucketClient} backed by `ioredis-mock`, which executes the
 * real Lua via a bundled Lua VM (fengari) against an in-memory Redis. The mock
 * doesn't implement `SCRIPT LOAD` / `EVALSHA`, so we model that layer here: a
 * `scriptLoad` stores the source under its SHA1 (matching how Redis derives the
 * SHA) and returns it; `evalSha` looks the source back up and runs it via the
 * mock's `eval`. Looking up an unknown SHA throws a `NOSCRIPT` error, exactly
 * as a real Redis does after a `SCRIPT FLUSH` — which is what `flushScripts()`
 * simulates, exercising {@link RedisTokenBucket}'s reload-on-NOSCRIPT path.
 */
function makeIoredisBackedClient() {
  const raw = new RedisMock();
  const scripts = new Map<string, string>();
  let scriptLoadCalls = 0;

  const client: RedisTokenBucketClient = {
    async scriptLoad(script: string): Promise<string> {
      scriptLoadCalls++;
      const sha = createHash("sha1").update(script).digest("hex");
      scripts.set(sha, script);
      return sha;
    },
    async evalSha(
      sha: string,
      options: { keys: string[]; arguments: string[] },
    ): Promise<unknown> {
      const script = scripts.get(sha);
      if (script === undefined) {
        throw new Error("NOSCRIPT No matching script. Please use EVAL.");
      }
      return raw.eval(
        script,
        options.keys.length,
        ...options.keys,
        ...options.arguments,
      );
    },
  };

  return {
    client,
    raw,
    get scriptLoadCalls() {
      return scriptLoadCalls;
    },
    /** Simulate `SCRIPT FLUSH`: subsequent `evalSha` for a known SHA throws NOSCRIPT. */
    flushScripts() {
      scripts.clear();
    },
  };
}

/**
 * A hand-rolled client for the failure/observability paths, where we don't care
 * about Lua behavior but do need to control whether `scriptLoad` / `evalSha`
 * fail. `evalSha` defaults to a successful acquire (`[1, 0]`).
 */
function makeFakeClient(
  options: { failScriptLoad?: Error; failEvalSha?: Error } = {},
): RedisTokenBucketClient & {
  readonly scriptLoadCalls: number;
  readonly evalShaCalls: number;
} {
  let scriptLoadCalls = 0;
  let evalShaCalls = 0;
  return {
    get scriptLoadCalls() {
      return scriptLoadCalls;
    },
    get evalShaCalls() {
      return evalShaCalls;
    },
    async scriptLoad(): Promise<string> {
      scriptLoadCalls++;
      if (options.failScriptLoad) throw options.failScriptLoad;
      return "fake-sha";
    },
    async evalSha(): Promise<unknown> {
      evalShaCalls++;
      if (options.failEvalSha) throw options.failEvalSha;
      return [1, 0];
    },
  };
}

describe("RedisTokenBucket", () => {
  // ioredis-mock keeps a single in-memory store shared across every
  // `new RedisMock()` instance, so flush it between tests to keep each
  // bucket's state isolated. (Flushing any instance clears the shared store.)
  beforeEach(async () => {
    await new RedisMock().flushall();
  });

  describe("constructor validation", () => {
    it("rejects invalid maxTokens before any Redis call", () => {
      for (const maxTokens of [
        0,
        -1,
        1.5,
        Number.POSITIVE_INFINITY,
        Number.NaN,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        const fake = makeFakeClient();
        assert.throws(
          () =>
            new RedisTokenBucket(fake, {
              keyPrefix: "p",
              maxTokens,
              refillIntervalMs: 1000,
            }),
          /maxTokens must be a positive safe integer/,
        );
        assert.equal(
          fake.scriptLoadCalls,
          0,
          "invalid config must fail before loading Redis scripts",
        );
      }
    });

    it("rejects invalid refillIntervalMs before any Redis call", () => {
      for (const refillIntervalMs of [
        0,
        -1,
        1.5,
        Number.POSITIVE_INFINITY,
        Number.NaN,
      ]) {
        const fake = makeFakeClient();
        assert.throws(
          () =>
            new RedisTokenBucket(fake, {
              keyPrefix: "p",
              maxTokens: 10,
              refillIntervalMs,
            }),
          /refillIntervalMs must be a positive safe integer/,
        );
        assert.equal(fake.scriptLoadCalls, 0);
      }
    });
  });

  describe("acquire script (real Lua via ioredis-mock)", () => {
    it("grants up to maxTokens, then denies with the time-until-next-token", async () => {
      const backing = makeIoredisBackedClient();
      const bucket = new RedisTokenBucket(backing.client, {
        keyPrefix: "rl",
        maxTokens: 4,
        refillIntervalMs: 1000, // 250ms per token
        clock: () => 0,
      });

      for (let i = 0; i < 4; i++) {
        assert.deepEqual(await bucket.tryAcquire("k"), { acquired: true });
      }
      assert.deepEqual(await bucket.tryAcquire("k"), {
        acquired: false,
        waitMs: 250,
      });
    });

    it("namespaces the bucket as `${keyPrefix}:${key}`", async () => {
      const backing = makeIoredisBackedClient();
      const bucket = new RedisTokenBucket(backing.client, {
        keyPrefix: "rl",
        maxTokens: 2,
        refillIntervalMs: 1000,
        clock: () => 0,
      });

      await bucket.tryAcquire("tenant-1");

      assert.equal(await backing.raw.exists("rl:tenant-1"), 1);
      assert.equal(await backing.raw.exists("tenant-1"), 0);
    });

    it("sets a PEXPIRE of refillIntervalMs on the bucket key", async () => {
      const backing = makeIoredisBackedClient();
      const refillIntervalMs = 5000;
      const bucket = new RedisTokenBucket(backing.client, {
        keyPrefix: "rl",
        maxTokens: 2,
        refillIntervalMs,
        clock: () => 0,
      });

      await bucket.tryAcquire("k");

      const pttl = await backing.raw.pttl("rl:k");
      assert.ok(
        pttl > refillIntervalMs - 200 && pttl <= refillIntervalMs,
        `expected pttl within (refill-200, refill]; got ${pttl}`,
      );
    });

    it("refills proportionally to elapsed time", async () => {
      const backing = makeIoredisBackedClient();
      let now = 0;
      const bucket = new RedisTokenBucket(backing.client, {
        keyPrefix: "rl",
        maxTokens: 4,
        refillIntervalMs: 1000, // 250ms per token
        clock: () => now,
      });

      // Drain the bucket at t=0.
      for (let i = 0; i < 4; i++) await bucket.tryAcquire("k");
      assert.deepEqual(await bucket.tryAcquire("k"), {
        acquired: false,
        waitMs: 250,
      });

      // One token's worth of time elapses -> exactly one more grant.
      now = 250;
      assert.deepEqual(await bucket.tryAcquire("k"), { acquired: true });
      assert.deepEqual(await bucket.tryAcquire("k"), {
        acquired: false,
        waitMs: 250,
      });
    });

    it("reports a shrinking waitMs as the next token approaches", async () => {
      const backing = makeIoredisBackedClient();
      let now = 0;
      const bucket = new RedisTokenBucket(backing.client, {
        keyPrefix: "rl",
        maxTokens: 4,
        refillIntervalMs: 1000, // 250ms per token
        clock: () => now,
      });

      for (let i = 0; i < 4; i++) await bucket.tryAcquire("k");

      now = 100; // 100ms into the 250ms wait for the next token
      assert.deepEqual(await bucket.tryAcquire("k"), {
        acquired: false,
        waitMs: 150,
      });
    });

    it("caps refill at maxTokens no matter how long the bucket sat idle", async () => {
      const backing = makeIoredisBackedClient();
      let now = 0;
      const bucket = new RedisTokenBucket(backing.client, {
        keyPrefix: "rl",
        maxTokens: 3,
        refillIntervalMs: 1000,
        clock: () => now,
      });

      for (let i = 0; i < 3; i++) await bucket.tryAcquire("k");

      // Idle for many refill intervals; bucket should refill to at most 3.
      now = 1_000_000;
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(await bucket.tryAcquire("k"), { acquired: true });
      }
      assert.equal((await bucket.tryAcquire("k")).acquired, false);
    });
  });

  describe("refund script (real Lua via ioredis-mock)", () => {
    it("returns a consumed token so the next acquire can reuse it", async () => {
      const backing = makeIoredisBackedClient();
      const bucket = new RedisTokenBucket(backing.client, {
        keyPrefix: "rl",
        maxTokens: 1,
        refillIntervalMs: 1000,
        clock: () => 0, // no natural refill within the test
      });

      assert.deepEqual(await bucket.tryAcquire("k"), { acquired: true });
      assert.equal((await bucket.tryAcquire("k")).acquired, false);

      await bucket.refund("k");

      // The refunded token is available again without any time passing.
      assert.deepEqual(await bucket.tryAcquire("k"), { acquired: true });
    });

    it("never exceeds maxTokens when refunding a full bucket", async () => {
      const backing = makeIoredisBackedClient();
      const bucket = new RedisTokenBucket(backing.client, {
        keyPrefix: "rl",
        maxTokens: 2,
        refillIntervalMs: 1000,
        clock: () => 0,
      });

      // Create the key (tokens = maxTokens - 1) then refund back to maxTokens.
      await bucket.tryAcquire("k");
      await bucket.refund("k"); // -> 2 (full)
      await bucket.refund("k"); // -> capped, still 2

      const tokens = Number(await backing.raw.hget("rl:k", "tokens"));
      assert.equal(tokens, 2);

      // Capacity is exactly maxTokens, proving no over-refund leaked through.
      assert.deepEqual(await bucket.tryAcquire("k"), { acquired: true });
      assert.deepEqual(await bucket.tryAcquire("k"), { acquired: true });
      assert.equal((await bucket.tryAcquire("k")).acquired, false);
    });

    it("is a no-op for an absent bucket key (full-on-next-access invariant)", async () => {
      const backing = makeIoredisBackedClient();
      const bucket = new RedisTokenBucket(backing.client, {
        keyPrefix: "rl",
        maxTokens: 2,
        refillIntervalMs: 1000,
        clock: () => 0,
      });

      await bucket.refund("never-touched");

      assert.equal(await backing.raw.exists("rl:never-touched"), 0);
    });

    it("refreshes the PEXPIRE on a successful refund", async () => {
      const backing = makeIoredisBackedClient();
      const refillIntervalMs = 5000;
      const bucket = new RedisTokenBucket(backing.client, {
        keyPrefix: "rl",
        maxTokens: 2,
        refillIntervalMs,
        clock: () => 0,
      });

      await bucket.tryAcquire("k");
      // Shrink the TTL, then refund and confirm it was bumped back up.
      await backing.raw.pexpire("rl:k", 100);
      await bucket.refund("k");

      const pttl = await backing.raw.pttl("rl:k");
      assert.ok(
        pttl > refillIntervalMs - 200 && pttl <= refillIntervalMs,
        `expected refreshed pttl within (refill-200, refill]; got ${pttl}`,
      );
    });
  });

  describe("SCRIPT LOAD / EVALSHA lifecycle", () => {
    it("loads each script once and reuses the cached SHA", async () => {
      const backing = makeIoredisBackedClient();
      const bucket = new RedisTokenBucket(backing.client, {
        keyPrefix: "rl",
        maxTokens: 100,
        refillIntervalMs: 1000,
        clock: () => 0,
      });

      for (let i = 0; i < 5; i++) await bucket.tryAcquire("k");
      // Only the acquire script has been loaded so far.
      assert.equal(backing.scriptLoadCalls, 1);

      await bucket.refund("k");
      // First refund lazily loads the refund script.
      assert.equal(backing.scriptLoadCalls, 2);

      await bucket.refund("k");
      await bucket.tryAcquire("k");
      // No further loads: both SHAs are cached.
      assert.equal(backing.scriptLoadCalls, 2);
    });

    it("reloads the script on a NOSCRIPT error (e.g. after SCRIPT FLUSH)", async () => {
      const backing = makeIoredisBackedClient();
      const bucket = new RedisTokenBucket(backing.client, {
        keyPrefix: "rl",
        maxTokens: 2,
        refillIntervalMs: 1000,
        clock: () => 0,
      });

      assert.deepEqual(await bucket.tryAcquire("k"), { acquired: true });
      assert.equal(backing.scriptLoadCalls, 1);

      backing.flushScripts(); // Redis forgot the script.

      // The bucket should transparently reload and still succeed.
      assert.deepEqual(await bucket.tryAcquire("k"), { acquired: true });
      assert.equal(backing.scriptLoadCalls, 2);
    });
  });

  describe("graceful degradation + onError", () => {
    it("allows the request through when acquire fails, reporting via onError", async () => {
      const errors: Array<{ keyPrefix: string; key: string; error: unknown }> =
        [];
      const failure = new Error("redis down");
      const bucket = new RedisTokenBucket(
        makeFakeClient({ failEvalSha: failure }),
        {
          keyPrefix: "rl",
          maxTokens: 1,
          refillIntervalMs: 1000,
          onError: (info) => errors.push(info),
        },
      );

      assert.deepEqual(await bucket.tryAcquire("tenant-9"), { acquired: true });
      assert.equal(errors.length, 1);
      assert.deepEqual(errors[0], {
        keyPrefix: "rl",
        key: "tenant-9",
        error: failure,
      });
    });

    it("degrades and reports when the script fails to load, and retries the load next time", async () => {
      const errors: unknown[] = [];
      const client = makeFakeClient({ failScriptLoad: new Error("load fail") });
      const bucket = new RedisTokenBucket(client, {
        keyPrefix: "rl",
        maxTokens: 1,
        refillIntervalMs: 1000,
        onError: (info) => errors.push(info.error),
      });

      assert.deepEqual(await bucket.tryAcquire("k"), { acquired: true });
      assert.deepEqual(await bucket.tryAcquire("k"), { acquired: true });
      // A failed load resets the cached SHA promise, so each attempt re-loads.
      assert.equal(client.scriptLoadCalls, 2);
      assert.equal(errors.length, 2);
    });

    it("swallows refund failures (token recovers on the next natural refill)", async () => {
      const errors: unknown[] = [];
      const bucket = new RedisTokenBucket(
        makeFakeClient({ failEvalSha: new Error("redis down") }),
        {
          keyPrefix: "rl",
          maxTokens: 1,
          refillIntervalMs: 1000,
          onError: (info) => errors.push(info.error),
        },
      );

      await assert.doesNotReject(bucket.refund("k"));
      assert.equal(errors.length, 1);
    });

    it("does not await onError, so a slow callback can't add request latency", async () => {
      let callbackSettled = false;
      let releaseCallback!: () => void;
      const pending = new Promise<void>((resolve) => {
        releaseCallback = () => {
          callbackSettled = true;
          resolve();
        };
      });

      const bucket = new RedisTokenBucket(
        makeFakeClient({ failEvalSha: new Error("redis down") }),
        {
          keyPrefix: "rl",
          maxTokens: 1,
          refillIntervalMs: 1000,
          onError: () => pending, // stays pending until we release it
        },
      );

      assert.deepEqual(await bucket.tryAcquire("k"), { acquired: true });
      // tryAcquire resolved without waiting on the still-pending callback.
      assert.equal(callbackSettled, false);

      releaseCallback();
      await pending;
    });

    it("survives an onError callback that throws or rejects", async () => {
      const throwing = new RedisTokenBucket(
        makeFakeClient({ failEvalSha: new Error("redis down") }),
        {
          keyPrefix: "rl",
          maxTokens: 1,
          refillIntervalMs: 1000,
          onError: () => {
            throw new Error("observer blew up");
          },
        },
      );
      assert.deepEqual(await throwing.tryAcquire("k"), { acquired: true });

      const rejecting = new RedisTokenBucket(
        makeFakeClient({ failEvalSha: new Error("redis down") }),
        {
          keyPrefix: "rl",
          maxTokens: 1,
          refillIntervalMs: 1000,
          onError: () => Promise.reject(new Error("async observer blew up")),
        },
      );
      assert.deepEqual(await rejecting.tryAcquire("k"), { acquired: true });
    });
  });
});
