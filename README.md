# adaptive-concurrency

Automatically detect and adjust services' concurrency limits to achieve optimal throughput with optimal latency and availability. This keeps systems reliable and available without constant manual tuning of concurrency limits as system performance/topology evolves. It borrows concepts from TCP congestion control and other algorithms.

This package is a TypeScript adaptation of [Netflix's concurrency-limits](https://github.com/Netflix/concurrency-limits) library. However, API has been [adjusted substantially](./docs/NETFLIX_API_COMPARISON.md) to better suit TypeScript's type system, and JavaScript's idioms and concurrency model.

## Background

When thinking of service availability, operators traditionally think in terms of RPS (requests per second). However, in large distributed systems that auto-scale, static RPS limits quickly go out of date. Instead of thinking in terms of RPS, we should think in terms of concurrent requests, applying queuing theory to determine the number of concurrent requests a service can handle before latency increases. This relationship is described by Little's Law:

```
Limit = Average RPS × Average Latency
```

This library estimates and enforces concurrency limits at each point in the network, borrowing from TCP congestion control algorithms.

## Packages

| Package                      | Description                                                    |
| ---------------------------- | -------------------------------------------------------------- |
| `adaptive-concurrency`       | Core library with limit algorithms and limiter implementations |
| `@adaptive-concurrency/http` | HTTP middleware for Express/Connect-compatible frameworks      |

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

For the common case—"run this work under the limit and record the right outcome"—use **`withLimiter(limiter)`** to create a **`limited`** helper. It acquires an allotment, invokes your callback, maps the result to the correct `LimitAllotment` method, and avoids leaking slots if the callback throws.

```typescript
import {
  Limiter,
  VegasLimit,
  QuotaNotAvailable,
  AdaptiveTimeoutError,
  withLimiter,
  success,
  ignore,
  dropped,
} from "adaptive-concurrency";

const limiter = new Limiter<string>({ limit: new VegasLimit() });
const limited = withLimiter(limiter);

const out = await limited(
  { context: "tenant-a" },
  async ({ context, signal }) => {
    try {
      const data = await fetchData({ context, signal });

      // If this operation's round-trip time should, for some reason,
      // be excluded from the concurrency limit calculation, you'd return
      // `ignore(data)` instead.
      return success(data);
    } catch (e) {
      // detect 429 or anything else indicating that your request was dropped
      // (i.e., subject to load shedding). If you see such shedding, you MUST
      // inform the limiter by returning dropped(e);
      if (isRateLimitError) {
        return dropped(e);
      }

      // Or throw AdaptiveTimeoutError to signal dropped semantics.
      if (didTimeOutOrLoadShed) {
        throw new AdaptiveTimeoutError("request timed out");
      }

      // Otherwise, for any unexpected errors that mean that the operation might
      // have failed midway through, and therefore the round-trip time isn't
      // representative/usable for computing the concurrency limit, you can simply
      // rethrow.
      throw e;
    }
  },
);

if (out === QuotaNotAvailable) {
  // No allotment: callback was not run (rejected, timed out, aborted, etc.)
} else {
  // `out` is the value inside `success` / `ignore`
}
```

**Signatures**

- `limited(fn)` — void context.
- `limited(options, fn)` — same options as `acquire` (`context`, `signal`).
- Callback args are `{ context, signal }` from `AcquireOptions`.

**Callback return type (`RunResult`)**

Build values with the helpers **`success(value)`**, **`ignore(value)`**, and **`dropped(error)`**. Callers should always use these helper functions rather than constructing `RunResult` objects directly.

If your callback returns any value that is **not** a valid `RunResult`, `withLimiter(...)` treats it as an implicit success (calls `releaseAndRecordSuccess()`) and resolves with that value.

| Result         | Effect                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------- |
| `success(v)`   | `releaseAndRecordSuccess()`, limit algorithm gets an RTT sample; **`limited` resolves with `v`**.  |
| `ignore(v)`    | `releaseAndIgnore()`, no RTT sample; **`limited` resolves with `v`**.                        |
| `dropped(err)` | `releaseAndRecordDropped()`, overload-style signal to the limit; **`limited` rejects with `err`**. |

**`QuotaNotAvailable`**

If `acquire` yields no allotment, **`limited` returns the sentinel `QuotaNotAvailable`** and does **not** call `fn`. Compare with `=== QuotaNotAvailable` (it is a `Symbol`).

**Errors thrown from `fn`**

If the callback **rejects** or **throws** before returning a `RunResult`, the allotment is completed with **`releaseAndIgnore()`**, and the error is **rethrown**. The one exception is **`AdaptiveTimeoutError`**, which is treated as a drop (`releaseAndRecordDropped()`) and then rethrown. Use `dropped(yourError)` or throw `AdaptiveTimeoutError` when the outcome should count as a **drop** for adaptive limiting.

#### Advanced Usage with `acquire`

Acquire is a lower-level API that's not as safe, as you MUST be sure to call `releaseAndRecordSuccess()`, `releaseAndRecordDropped()` or `releaseAndIgnore()` when the operation is complete.

```typescript
const allotment = await limiter.acquire({ context: "tenant-a" });
if (allotment) {
  try {
    await doWork();
    await allotment.releaseAndRecordSuccess();
  } catch {
    await allotment.releaseAndRecordDropped();
  }
} else {
  // No allotment right now
}
```

To use it, pass **`AcquireOptions`**: `{ context }` when the limiter is keyed by context, `{ signal }` for `AbortSignal`, or omit/`{}` for a void context.

`acquire` returns **`Promise<LimitAllotment | undefined>`** and should be awaited directly.

Use **`acquire` + `LimitAllotment`** when you need a separate acquire and release (framework hooks, streaming lifetimes, handoff to another owner). Use **`withLimiter(limiter)`** when a single async scope is enough.

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

### VegasLimit

Delay-based algorithm inspired by TCP Vegas. Estimates queue size as `limit × (1 − RTTnoLoad / RTTactual)` and adjusts the limit based on whether the queue is above or below configurable thresholds.

### GradientLimit

Adjusts the limit based on the gradient between a long-term exponentially smoothed average RTT and the current short-term RTT. Uses average instead of minimum RTT to handle bursty RPC workloads.

This matches Netflix's **Gradient2Limit** algorithm, not the deprecated v1 algorithm called GradientLimit in their package.

### AIMDLimit

Simple additive-increase/multiplicative-decrease algorithm. Increases the limit by 1 on success and multiplies by a backoff ratio on drops or timeouts.

### WindowedLimit

Decorator that buffers samples into time-based windows before forwarding aggregated results to a delegate algorithm, reducing noise from individual samples.

### FixedLimit / SettableLimit / TracingLimitDecorator

- **`FixedLimit`** — constant, non-adaptive limit.
- **`SettableLimit`** — mutable limit, useful for tests/manual control.
- **`TracingLimitDecorator`** — wraps a limit and emits debug logs on updates.

## Limiter building blocks

- **`Limiter`** — Composable limiter: adaptive `limit`, optional bypass, **`SemaphoreStrategy`** (default) or custom **`AcquireStrategy`**, optional **`allotmentUnavailableStrategy`**.
- **`PartitionedStrategy`** — Percentage-based partitions with configurable `burstMode` (`unbounded`, `capped`, `none`) per partition. Combine with `Limiter` via `acquireStrategy`.
- **`BlockingBacklogRejection`** — Generic queue-based blocking strategy used for both FIFO and LIFO behavior. Configure `backlogSize`, `backlogTimeout` (`number` or `(context) => number`), and `enqueueOptions` (`{ direction: "back" }` for FIFO/fair or `{ direction: "front" }` for LIFO/tail-latency focused). `enqueueOptions` can also include `priority` and can be context-derived via a function.
- **`DelayedRejectStrategy`** — When at capacity, await a caller-defined delay (`delayMsForContext`) then still return no allotment (Java-style partition reject delay). Cap concurrent delays with `maxConcurrentDelays`. Does not retry for capacity.
- **`DelayedThenBlockingRejection`** — Two-stage behavior: uncoditionally delay first (as a form of backpressure), then queue and block if there's still no available allotment.

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
