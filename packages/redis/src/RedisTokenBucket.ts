import type { MaybePromise } from "adaptive-concurrency";

/**
 * Minimal Redis client surface used for token-bucket operations.
 *
 * Implementations only need to expose `SCRIPT LOAD` + `EVALSHA`, which the
 * standard `redis` (node-redis) client already provides via `scriptLoad` and
 * `evalSha` with the same signatures used here. This minimal interface lets
 * this package work with any Redis client without a hard dependency on a
 * specific one.
 */
export type RedisTokenBucketClient = {
  scriptLoad(script: string): Promise<string>;
  evalSha(
    sha: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
};

/**
 * Lua script for atomic token bucket acquire.
 *
 * Loaded once per process via SCRIPT LOAD; executions use EVALSHA so the
 * script source is not sent on every tryAcquire (see RedisTokenBucket).
 *
 * KEYS[1] = bucket key (e.g., "myratelimit:tenant-1234")
 * ARGV[1] = maxTokens
 * ARGV[2] = refillIntervalMs
 * ARGV[3] = current time in ms
 *
 * Note: We expire the key after refillIntervalMs. Because refillIntervalMs is
 * the time it takes to refill an empty bucket to maxTokens, so we KNOW that a
 * bucket that's been untouched for refillIntervalMs is full. Therefore, it's
 * safe to expire the key because it'll get recreated with a full bucket.
 *
 * Allowing the caller to provide an expiry time less than refillIntervalMs
 * would risk the following scenario: a key untouched for expiry time ms has
 * _fewer_ than a full bucket worth of tokens, then expires, then gets recreated
 * with a full bucket, allowing the caller to exceed the intended rate limit.
 *
 * The code could compute a _dynamic_ expiry time based on the number of tokens
 * in the bucket (i.e., at current token count, how long until the bucket is
 * full?). This isn't worth the complexity though, nor is it an unambiguous win:
 * it reclaims Redis memory faster, but slows down some acquires as the bucket
 * key needs to be recreated.
 *
 * Returns:
 *   - [1, 0] if token acquired successfully
 *   - [0, waitTimeMs] if no tokens available, caller should wait waitTimeMs
 */
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local maxTokens = tonumber(ARGV[1])
local refillIntervalMs = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])

local bucket = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
local tokens = tonumber(bucket[1])
local lastRefillMs = tonumber(bucket[2])

-- Initialize bucket if it doesn't exist
if tokens == nil or lastRefillMs == nil then
  tokens = maxTokens - 1
  redis.call('HMSET', key, 'tokens', tokens, 'lastRefillMs', nowMs)
  redis.call('PEXPIRE', key, refillIntervalMs)
  return {1, 0}
end

-- Calculate refill: proportional tokens based on elapsed time
local elapsedMs = nowMs - lastRefillMs
local tokensToAdd = math.floor(elapsedMs * maxTokens / refillIntervalMs)

if tokensToAdd > 0 then
  tokens = math.min(maxTokens, tokens + tokensToAdd)
  lastRefillMs = lastRefillMs + math.floor(tokensToAdd * refillIntervalMs / maxTokens)
end

-- Try to consume a token
if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HMSET', key, 'tokens', tokens, 'lastRefillMs', lastRefillMs)
  redis.call('PEXPIRE', key, refillIntervalMs)
  return {1, 0}
end

-- No tokens: compute wait time until next token refills
local msPerToken = refillIntervalMs / maxTokens
local waitMs = math.ceil(msPerToken - (nowMs - lastRefillMs))
if waitMs < 0 then waitMs = 0 end

redis.call('PEXPIRE', key, refillIntervalMs)
return {0, waitMs}
`;

/**
 * Lua script that refunds a previously-acquired token to the bucket. Used
 * when a downstream gate rejects a request whose token has already been
 * consumed (see RedisTokenBucketStrategy's bucket-first fallback path), so
 * that the token isn't lost and the configured rate is preserved.
 *
 * Refund increments the token count by 1, capped at maxTokens. If the bucket
 * key doesn't exist, the script is a no-op: an absent key implicitly
 * represents a full bucket on next access (see TOKEN_BUCKET_LUA), so there's
 * nothing to put back. We refresh the PEXPIRE on a successful refund so the
 * key continues to live at least one full refill interval — same invariant
 * the acquire script relies on.
 *
 * KEYS[1] = bucket key
 * ARGV[1] = maxTokens
 * ARGV[2] = refillIntervalMs
 *
 * Returns:
 *   - 1 if a token was refunded
 *   - 0 if the bucket was already at maxTokens or didn't exist
 */
const TOKEN_BUCKET_REFUND_LUA = `
local key = KEYS[1]
local maxTokens = tonumber(ARGV[1])
local refillIntervalMs = tonumber(ARGV[2])

local tokens = tonumber(redis.call('HGET', key, 'tokens'))
if tokens == nil then
  return 0
end

if tokens < maxTokens then
  redis.call('HINCRBY', key, 'tokens', 1)
  redis.call('PEXPIRE', key, refillIntervalMs)
  return 1
end

return 0
`;

export type RedisTokenBucketConfig = {
  /** Redis key prefix, e.g., "emr-ratelimit:axiscare-api". */
  keyPrefix: string;
  /** Max tokens in the bucket. */
  maxTokens: number;
  /** Refill interval in ms (time to refill an empty bucket back to maxTokens). */
  refillIntervalMs: number;
  /**
   * Optional callback invoked when a Redis call fails. The bucket degrades
   * gracefully on Redis failures (allowing the request through), so this is
   * how callers can plug in their own logger/metrics for visibility.
   *
   * `tryAcquire` and `refund` do not await the callback before returning,
   * so a slow async logger can't add latency to the request path.
   * Synchronous throws and rejected promises returned from the callback
   * are both swallowed — the callback is observability-only and must not
   * be able to break the bucket's "always degrades gracefully" contract.
   */
  onError?: (info: { keyPrefix: string; key: string; error: unknown }) => void;
};

export type AcquireResult =
  | { acquired: true }
  | { acquired: false; waitMs: number };

export class RedisTokenBucket {
  readonly #config: RedisTokenBucketConfig;
  readonly #acquireTokenScript: RedisScript<[number, number]>;
  readonly #refundTokenScript: RedisScript<number>;

  constructor(
    redisClient: RedisTokenBucketClient,
    config: RedisTokenBucketConfig,
  ) {
    if (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0) {
      throw new RangeError("maxTokens must be a positive safe integer");
    }

    if (
      !Number.isSafeInteger(config.refillIntervalMs) ||
      config.refillIntervalMs <= 0
    ) {
      throw new RangeError("refillIntervalMs must be a positive safe integer");
    }

    this.#config = config;
    this.#acquireTokenScript = new RedisScript(redisClient, TOKEN_BUCKET_LUA);
    this.#refundTokenScript = new RedisScript(
      redisClient,
      TOKEN_BUCKET_REFUND_LUA,
    );
  }

  /**
   * Attempt to acquire a token for the given key.
   * If Redis is unavailable, degrades gracefully by allowing the request.
   */
  async tryAcquire(key: string): Promise<AcquireResult> {
    const redisKey = `${this.#config.keyPrefix}:${key}`;

    try {
      const result = await this.#acquireTokenScript.evaluate({
        keys: [redisKey],
        arguments: [
          String(this.#config.maxTokens),
          String(this.#config.refillIntervalMs),
          String(Date.now()),
        ],
      });

      if (result[0] === 1) {
        return { acquired: true };
      }

      return { acquired: false, waitMs: result[1] ?? 0 };
    } catch (error) {
      this.#fireOnError(key, error);
      // Degrade gracefully: allow the request through.
      return { acquired: true };
    }
  }

  /**
   * Refund a previously-acquired token back to the bucket. Use this when a
   * downstream gate rejects a request after `tryAcquire` already consumed a
   * token, so the configured rate is preserved.
   *
   * If Redis is unavailable, degrades gracefully: the refund is silently
   * dropped (the token will refill naturally over `refillIntervalMs`).
   */
  async refund(key: string): Promise<void> {
    const redisKey = `${this.#config.keyPrefix}:${key}`;

    try {
      await this.#refundTokenScript.evaluate({
        keys: [redisKey],
        arguments: [
          String(this.#config.maxTokens),
          String(this.#config.refillIntervalMs),
        ],
      });
    } catch (error) {
      this.#fireOnError(key, error);
    }
  }

  /**
   * Invoke the user-supplied `onError` callback fire-and-forget style:
   *
   * - We do **not** await it, so a slow async logger can't extend the
   *   latency of the request path. Synchronous side effects of the
   *   callback (the typical `errors.push(...)` shape) still happen before
   *   this method returns, since the call itself is synchronous.
   * - If the callback throws synchronously OR returns a rejected promise,
   *   the resulting rejection is swallowed inside `fireAndForget` so it
   *   can't surface as an unhandled rejection.
   *
   * Both guarantees are contractually important: the bucket promises to
   * degrade gracefully on Redis errors, and a misbehaving observer must
   * not be able to break that promise.
   */
  #fireOnError(key: string, error: unknown): void {
    const onError = this.#config.onError;
    if (!onError) return;
    const keyPrefix = this.#config.keyPrefix;
    void fireAndForget(() => onError({ keyPrefix, key, error }));
  }
}

class RedisScript<TResult> {
  #shaPromise: Promise<string> | undefined; // undefined until first evaluate
  readonly #redisClient: RedisTokenBucketClient;
  readonly #lua: string;

  constructor(redisClient: RedisTokenBucketClient, lua: string) {
    this.#redisClient = redisClient;
    this.#lua = lua;
  }

  async #ensureLoadedAndGetSha(): Promise<string> {
    if (this.#shaPromise === undefined) {
      this.#shaPromise = this.#redisClient
        .scriptLoad(this.#lua)
        .catch((error) => {
          this.#shaPromise = undefined;
          throw error;
        });
    }

    return await this.#shaPromise;
  }

  async evaluate(options: {
    keys: string[];
    arguments: string[];
  }): Promise<TResult> {
    const sha = await this.#ensureLoadedAndGetSha();
    try {
      return (await this.#redisClient.evalSha(sha, options)) as TResult;
    } catch (error) {
      // Reload the script if deleted or removed from redis cache.
      if (isNoScriptError(error)) {
        this.#shaPromise = undefined;
        const newSha = await this.#ensureLoadedAndGetSha();
        return (await this.#redisClient.evalSha(newSha, options)) as TResult;
      }

      throw error;
    }
  }
}

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("NOSCRIPT");
}

async function fireAndForget(fn: () => MaybePromise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // Ignore errors deliberately.
  }
}
