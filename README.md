# adaptive-concurrency

Automatically detect and adjust services' concurrency limits to achieve optimal throughput with optimal latency and availability. This keeps systems reliable and available without constant manual tuning of concurrency limits as system performance/topology evolves. It borrows concepts from TCP congestion control and other algorithms.

This package was originally a TypeScript adaptation of [Netflix's concurrency-limits](https://github.com/Netflix/concurrency-limits) library. However, extra functionality has been added, and the API has been [adjusted substantially](./docs/NETFLIX_API_COMPARISON.md) to better suit TypeScript's type system and JavaScript's idioms and concurrency model.

## Background

When thinking of service availability, operators traditionally think in terms of RPS (requests per second). However, in large distributed systems that auto-scale, static RPS limits quickly go out of date. Instead of thinking in terms of RPS, we should think in terms of concurrent requests, applying queuing theory to determine the number of concurrent requests a service can handle before latency increases. This relationship is described by Little's Law:

```
Limit = Average RPS × Average Latency
```

This library estimates and enforces concurrency limits at each point in the network, borrowing from TCP congestion control algorithms.

## Packages

| Package                       | Description                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `adaptive-concurrency`        | Core library with limit algorithms and limiter implementations                    |
| `@adaptive-concurrency/http`  | HTTP middleware for Express/Connect-compatible frameworks                         |
| `@adaptive-concurrency/redis` | Redis-backed acquire strategies (e.g. distributed token-bucket rate limiting)     |

## Quick Start

```bash
npm i adaptive-concurrency
```

#### Creating a Limiter

The core type is **`Limiter`**: it combines an adaptive **`limit`** (default: `GradientLimit`), an optional **`bypassResolver`**, an **`acquireStrategy`** (default: semaphore-style permits), and an optional **`allotmentUnavailableStrategy`** for blocking or queued behavior when no allotment is available.

```typescript
import { Limiter, VegasLimit } from "adaptive-concurrency";

const limiter = new Limiter<string>({
  limit: new VegasLimit({ initialLimit: 20, maxConcurrency: 200 }),
});
```

See details on the [available limit types/strategies](#limit-algorithms).

#### Using the Limiter

For the common case—"run some work subject to/using the limit and record the right outcome"—use **`makeLimitedFunction(limiter, fn)`** to create a **`callWithLimiter`** helper for a specific callback.

```typescript
import {
  Limiter,
  VegasLimit,
  QuotaNotAvailable,
  makeLimitedFunction,
  success,
  ignore,
  dropped,
} from "adaptive-concurrency";

const limiter = new Limiter<string>({ limit: new VegasLimit() });
const callWithLimiter = makeLimitedFunction(
  limiter,
  async ({ context, signal }) => {
    try {
      const data = await fetchData({ context, signal });

      // If this operation's round-trip time should, for some reason,
      // be excluded from the concurrency limit calculation, you'd return
      // `ignore(data)` instead.
      return success(data);
    } catch (e) {
      // detect 429 or anything else indicating that your request was dropped
      // (i.e., subject to load shedding), or hit a timeout that you interpret 
      // as a signal that the backend is overloaded. If you see such overload,
      // you MUST inform the limiter by throwing dropped(e) so it'll reduce
      // the limit.
      if (isRateLimitError || didTimeOutOrLoadShed) {
        throw dropped(e);
      }

      // Otherwise, treat as ignored failure: this round-trip time isn't
      // representative/usable for computing the concurrency limit.
      // `throw e` is equivalent to `throw ignore(e)`.
      throw ignore(e);
    }
  },
);

try {
  // Options argument is optional here; is passed as options to acquire().
  const result = await callWithLimiter({ context: "tenant-a" });

  if (result === QuotaNotAvailable) {
    // Callback was not run because calls to the downstream were already
    // at the max concurrency (and the limiter wasn't set up to queue further
    // acquire calls)
  } else {
    // `result` is the value inside `success` / `ignore`
  }
} catch (e) {
  // handle the error the callback threw, if any.
}
```

##### Callback contract (`makeLimitedFunction`)

`makeLimitedFunction(limiter, fn)` returns `callWithLimiter(options?)`. The callback `fn` receives `{ context, signal }` and drives limiter bookkeeping via what it returns or throws:

| Callback behavior | Limiter bookkeeping | `callWithLimiter` outcome |
| ----------------- | ------------------- | ------------------------- |
| `return success(v)` or `return v` | `releaseAndRecordSuccess()` | resolves with `v` |
| `return ignore(v)` | `releaseAndIgnore()` | resolves with `v` |
| `throw dropped(err)` | `releaseAndRecordDropped()` | rejects with `err` |
| `throw AdaptiveTimeoutError` / `throw AdaptiveRejectionError` | `releaseAndRecordDropped()` | rejects with the same error |
| `throw ignore(err)` or `throw err` | `releaseAndIgnore()` | rejects with `err` |

Notes:

- Returning a non-`RunResult` value is shorthand for `return success(value)`.
- Throwing a non-`RunResult` error is shorthand for `throw ignore(error)`.
- Returning `dropped(error)` is invalid; use `throw dropped(error)` for drop semantics.
- If `acquire` yields no allotment, `callWithLimiter` returns `QuotaNotAvailable` and does not call `fn` (compare with `=== QuotaNotAvailable`).

For advanced usage patterns—including `withLimiter(limiter)` and direct `acquire` flows—see [Advanced usage patterns](./docs/ADVANCED_USAGE_PATTERNS.md).

### HTTP Middleware

```bash
pnpm add adaptive-concurrency @adaptive-concurrency/http
```

```typescript
import { VegasLimit, WindowedLimit } from "adaptive-concurrency";
import {
  HttpLimiterBuilder,
  concurrencyLimitMiddleware,
} from "@adaptive-concurrency/http";
import express from "express";

const limiter = new HttpLimiterBuilder()
  .withLimit(new WindowedLimit(new VegasLimit()))
  .partitionByHeader("x-traffic-type")
  .partition("live", { percent: 0.9 })
  .partition("batch", { percent: 0.1 })
  .build();

const app = express();
app.use(concurrencyLimitMiddleware(limiter));
```

## Limit Algorithms


### GroupAwareLimit [New]

An ideal limit when a single limiter protects a downstream that handles heterogenous operations using shared resources. E.g., imagine an API that supports some very quick/cheap operations and some very slow ones, with both types of operations sharing the same database. A `GroupAwareLimit` put in front of that API will detect congestion using per-group (i.e., per-operation-type) RTT spikes.

This is immune to operation mix shifts: when traffic transitions from fast to slow operations, standard algorithms see an RTT spike and erroneously reduce the limit. `GroupAwareLimit` avoids this because each group is measured against its own baseline.

Compared to using a separate limiter per operation type, the single `GroupAwareLimit` is more stable -- it better handles some operation types having few samples and propagates a drop signal from the backend through the whole limit (not just the limiter for whichever operation happened to witness the drop). See code for details.

```typescript
import { Limiter, GroupAwareLimit } from "adaptive-concurrency";

const limiter = new Limiter<string>({
  limit: new GroupAwareLimit({ initialLimit: 20, maxLimit: 200 }),
  operationNameFor: (ctx) => someOperationName, // derive from request metadata
});
```

### VegasLimit

Delay-based algorithm inspired by TCP Vegas. Estimates queue size as `limit × (1 − RTTnoLoad / RTTactual)` and adjusts the limit based on whether the queue is above or below configurable thresholds. The `policy.decrease` function receives `(limit, didDrop)` so the policy can distinguish latency-driven decreases from drop-driven ones.

### GradientLimit

Adjusts the limit based on the gradient between a long-term exponentially smoothed average RTT and the current short-term RTT. Uses average instead of minimum RTT to handle bursty RPC workloads.

This matches Netflix's **Gradient2Limit** algorithm, not the deprecated v1 algorithm called GradientLimit in their package.
### AIMDLimit

Simple additive-increase/multiplicative-decrease algorithm. Increases the limit by 1 on success and multiplies by a backoff ratio on drops or timeouts. Supports a `backoffJitter` option (default `0.02`) that adds a small random perturbation to each decrease, breaking lockstep oscillation when multiple independent clients share the same configuration.

### WindowedLimit

Decorator that buffers samples into time-based windows before forwarding aggregated results to a delegate algorithm, reducing noise from individual samples.

### FixedLimit / SettableLimit

- **`FixedLimit`** — constant, non-adaptive limit.
- **`SettableLimit`** — mutable limit, useful for tests/manual control.

## Limiter building blocks

- **`Limiter`** — Composable limiter: adaptive `limit`, optional bypass, **`SemaphoreStrategy`** (default) or custom **`AcquireStrategy`**, optional **`allotmentUnavailableStrategy`**, and optional **`operationNameFor`** to tag samples for group-aware limits.
- **`AcquireStrategy`** — Two-phase admission contract. `tryReserveAllotment(context, state)` returns an `AllotmentReservation` when capacity is tentatively reserved; the limiter then calls `commit()` when admission succeeds or `cancel()` when an outer decision rejects/aborts before the allotment is returned. This lets composed strategies reserve locally without emitting metrics or waking waiters until the overall acquire succeeds.
- **`LimitAllotment`** — Handle returned from `Limiter.acquire()`. Call exactly one release method: `releaseAndRecordSuccess()`, `releaseAndIgnore()`, or `releaseAndRecordDropped()`.
- **`AllotmentReservation`** — Helper class for implementing two-phase `AcquireStrategy` instances. Its `commit()` and `cancel()` methods are idempotent.
- **`PartitionedStrategy`** — Percentage-based partitions with configurable `burstMode` (`unbounded`, `capped`, `none`) per partition. It tracks speculative reservations separately from committed inflight work so cancelled reservations do not pollute partition metrics.
- **`BlockingBacklogRejection`** — Generic queue-based blocking strategy used for both FIFO and LIFO behavior. Configure `backlogSize`, `backlogTimeout` (`number` or `(context) => number`), and `enqueueOptions` (`{ direction: "back" }` for FIFO/fair or `{ direction: "front" }` for LIFO/tail-latency focused). `enqueueOptions` can also include `priority` and can be context-derived via a function. Enqueue-triggered drains are coalesced and only retry the queue head, avoiding lost wakeups without fanning out retries across the whole queue.
- **`DelayedRejectStrategy`** — When at capacity, await a caller-defined delay (`delayMsForContext`) then still return no allotment (Java-style partition reject delay). Cap concurrent delays with `maxConcurrentDelays`. Does not retry for capacity.
- **`DelayedThenBlockingRejection`** — Two-stage behavior: unconditionally delay first (as a form of backpressure), then queue and block if there's still no available allotment.

## Redis Token Bucket

The optional `@adaptive-concurrency/redis` package provides a distributed token-bucket gate that can be composed with any core acquire strategy.

```bash
pnpm add adaptive-concurrency @adaptive-concurrency/redis
```

```typescript
import { FixedLimit, Limiter, SemaphoreStrategy } from "adaptive-concurrency";
import {
  RedisTokenBucket,
  RedisTokenBucketStrategy,
} from "@adaptive-concurrency/redis";

const localConcurrency = 50;
const bucket = new RedisTokenBucket(redisClient, {
  keyPrefix: "my-service:rate-limit",
  maxTokens: 1_000,
  refillIntervalMs: 60_000,
});

const limiter = new Limiter<{ tenant: string }>({
  limit: new FixedLimit(localConcurrency),
  acquireStrategy: new RedisTokenBucketStrategy({
    bucket,
    inner: new SemaphoreStrategy(localConcurrency),
    keyResolver: (ctx) => ctx.tenant,
  }),
});
```

`RedisTokenBucketStrategy` consults its inner strategy first, then consumes a Redis token. If Redis denies, it cancels the inner reservation. If Redis is unavailable, the bucket fails open and invokes the optional `onError` callback for observability.

## Factory helpers

The package also exports factory helpers for common configurations:

- `makeSimpleLimiter`
- `makeBlockingLimiter`
- `makeLifoBlockingLimiter`
- `makePartitionedLimiter`
- `makePartitionedBlockingLimiter`
- `makePartitionedLifoBlockingLimiter`

For direct strategy composition (without a factory), instantiate the generic strategy explicitly:

```typescript
import {
  BlockingBacklogRejection,
  LinkedWaiterQueue,
  Limiter,
} from "adaptive-concurrency";

const fifoLimiter = new Limiter({
  allotmentUnavailableStrategy: new BlockingBacklogRejection({
    backlogSize: Number.POSITIVE_INFINITY,
    backlogTimeout: 60 * 60 * 1000,
    enqueueOptions: { direction: "back" }, // FIFO
    queue: new LinkedWaiterQueue(),
  }),
});

const lifoLimiter = new Limiter({
  allotmentUnavailableStrategy: new BlockingBacklogRejection({
    backlogSize: 100,
    backlogTimeout: 1_000,
    enqueueOptions: { direction: "front" }, // LIFO
    queue: new LinkedWaiterQueue(),
  }),
});
```

The partitioned factory helpers accept `partitions` as `PartitionConfig & { delayMs?: number }`, so they support both:

- core partition behavior (`percent`, optional `burstMode`) and
- Java-style per-partition delay via `delayMs`, wired internally to `DelayedRejectStrategy`.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
```

## License

Apache-2.0 (following the original Netflix library)
