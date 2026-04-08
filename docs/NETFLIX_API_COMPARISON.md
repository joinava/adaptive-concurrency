# Netflix Java `concurrency-limits` vs this TypeScript port

This document catalogs API and architecture differences between Netflix's Java library and this project's TypeScript packages:

- `adaptive-concurrency` (core)
- `@adaptive-concurrency/http` (HTTP middleware integration)

It is intended to help:

- maintainers merge upstream Java changes into this codebase, and
- users migrate from Java usage patterns to this TypeScript API.

Reference Java repo: [Netflix/concurrency-limits](https://github.com/Netflix/concurrency-limits)

---

## 1. Repository and integration surface

| Java (Netflix)                                                              | TypeScript (this repo)                                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Multi-module Maven project (`concurrency-limits-core`, servlet, gRPC, etc.) | Monorepo with `packages/adaptive-concurrency` and `packages/http` |
| Framework-specific servlet and gRPC integrations                            | HTTP middleware integration for Node/Express-style frameworks     |
| Includes servlet filter and gRPC modules                                    | No gRPC package currently                                         |

The TypeScript HTTP package is intentionally minimal and framework-agnostic, based on request/response shape rather than servlet APIs.

---

## 2. Core architectural differences

### Java limiter class hierarchy -> one `Limiter` + strategies

Java behavior is spread across classes/decorators:

- `Limiter<ContextT>` interface
- `AbstractLimiter<ContextT>`
- `SimpleLimiter<ContextT>`
- `AbstractPartitionedLimiter<ContextT>`
- `BlockingLimiter<ContextT>`
- `LifoBlockingLimiter<ContextT>`

TypeScript uses one concrete `Limiter` class plus two extension points:

- `AcquireStrategy<ContextT>`: decides slot allocation (semaphore, partitioned, etc.)
- `AllotmentUnavailableStrategy<ContextT>`: decides behavior when no slot is available

This moves customization from subclassing to composition.

### Blocking is an allotment-unavailable strategy, not a wrapper limiter

- Java: blocking behavior is typically added by wrapping a limiter (`BlockingLimiter.wrap(...)`, `LifoBlockingLimiter...build()`).
- TypeScript: blocking behavior is configured via `Limiter` option `allotmentUnavailableStrategy` (`BlockingBacklogRejection`,`DelayedThenBlockingRejection`, etc).

Because JavaScript is single-threaded, "blocking" means promise-based waiting, not thread blocking.

### No `AbstractLimit` base class

- Java limit implementations generally inherit from `AbstractLimit`.
- TypeScript limit implementations directly implement `AdaptiveLimit` and commonly use `ListenerSet` for change listeners. This is more composition over inheritance.

---

## 3. Core contract mapping

### `Limit` -> `AdaptiveLimit`

| Java `Limit`                                  | TypeScript `AdaptiveLimit`                                        |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `int getLimit()`                              | `currentLimit` getter                                             |
| `notifyOnChange(Consumer<Integer>)`           | `subscribe(listener, { signal? }): () => void`                    |
| `onSample(startNs, rttNs, inflight, didDrop)` | `addSample(startMs, rttMs, inflight, didDrop, operationName?)`    |
| nanosecond time units                         | fractional milliseconds                                           |

The TypeScript `addSample` accepts an optional fifth parameter, `operationName?: string`, used by group-aware limits (e.g. `GroupAwareLimit`) to distinguish heterogeneous workloads. All existing limit implementations accept and ignore the parameter.

Time conversion is a key migration concern: Java nanoseconds vs TypeScript milliseconds.

### `Limiter.Listener` -> `LimitAllotment`

| Java                                | TypeScript                           |
| ----------------------------------- | ------------------------------------ |
| `Limiter.Listener` nested interface | top-level `LimitAllotment` interface |
| `onSuccess()`                       | `releaseAndRecordSuccess()`          |
| `onIgnore()`                        | `releaseAndIgnore()`           |
| `onDropped()`                       | `releaseAndRecordDropped()`          |

Semantics are equivalent: exactly one completion method should be called.

### `Limiter` interface -> `Limiter` class

| Java                                   | TypeScript                                                       |
| -------------------------------------- | ---------------------------------------------------------------- |
| functional interface                   | concrete class                                                   |
| `acquire(context): Optional<Listener>` | `acquire(options?): Promise<LimitAllotment \| undefined>`         |
| rejection via `Optional.empty()`       | rejection via `undefined` (sync or async)                        |
| context passed positionally            | options object (`{ context, signal? }`)                          |

TypeScript `AcquireOptions` adds `signal?: AbortSignal`.

### `LimiterOptions.operationNameFor`

No Java equivalent. TypeScript `LimiterOptions` accepts an optional `operationNameFor?: (context) => string | undefined` callback that derives an operation name from the request context. The returned name is forwarded to `AdaptiveLimit.addSample()` so group-aware limits (e.g. `GroupAwareLimit`) can maintain separate baselines per operation type.

### Bypass configuration

- Java uses builder-level bypass resolvers/helpers (combined OR-style).
- TypeScript `LimiterOptions` has `bypassResolver?: (context) => boolean`.
- Bypassed calls return a no-op allotment and do not affect inflight/limit sampling.

---

## 4. New TypeScript-only core APIs

### `withLimiter(limiter)` and `RunResult`

No direct Java equivalent.

- `withLimiter(limiter)` creates `limited`, then call `limited(fn)` or `limited(options, fn)` to acquire and scope execution.
- Callback returns `RunResult`: `success(value)`, `ignore(value)`, or `dropped(error)`.
- If no allotment is available, returns `QuotaNotAvailable` and does not invoke `fn`.
- Callback receives `{ context, signal }` from `AcquireOptions`.
- If `fn` throws/rejects unexpectedly, `limited()` calls `releaseAndIgnore()` and rethrows, except `AdaptiveTimeoutError`, which is treated as dropped (`releaseAndRecordDropped()`) and rethrown.

### Other TS-only helpers/types

- `LimiterState` (`{ limit, inflight }`) passed to acquire strategies
- `ListenerSet`
- exported run helpers/types (`RunResult`, `RunSuccess`, `RunIgnore`, `RunDropped`)

---

## 5. Limiter implementation mapping

| Java                         | TypeScript                                                       |
| ---------------------------- | ---------------------------------------------------------------- |
| `SimpleLimiter`              | `Limiter` with default `SemaphoreStrategy`                       |
| `AbstractPartitionedLimiter` | `PartitionedStrategy` plugged into `Limiter.acquireStrategy`     |
| `BlockingLimiter`            | `BlockingBacklogRejection` with `enqueueOptions: { direction: "back" }` + `new LinkedWaiterQueue()` in `Limiter.allotmentUnavailableStrategy` |
| `LifoBlockingLimiter`        | `BlockingBacklogRejection` with `enqueueOptions: { direction: "front" }` + `new LinkedWaiterQueue()` in `Limiter.allotmentUnavailableStrategy` |

Default adaptive limit selection is centralized in `Limiter.makeDefaultLimit()`, which currently returns `new GradientLimit()`, **not a `VegasLimit`**, which is what the Java code used.

### `PartitionedStrategy` notes

- Partition guarantees and burst semantics are preserved: partitions have guaranteed share but can exceed it when global inflight is below the global limit.
- `partitionResolver` is a single function; ordered fallback is left to the caller.
- `PartitionedStrategy` accepts a second type parameter `PartitionName` (default `string`) so `partitions`, the resolver return type, and `getPartition`’s `name` can be narrowed (e.g. `"read" | "write"`).
- Unknown partition behavior is retained.
- `PartitionConfig` has required **`percent`** plus optional **`burstMode`** (`unbounded` default, `capped`, or `none`) for below-saturation bursting policy.
- Java-style **sleep-then-reject** is not a `PartitionConfig` field; use **`DelayedRejectStrategy`** with `delayMsForContext` keyed by your partition mapping.
- Factory helpers (`makePartitionedLimiter`, `makePartitionedBlockingLimiter`, `makePartitionedLifoBlockingLimiter`) add a convenience `delayMs` field per partition (`PartitionConfig & { delayMs?: number }`) and wire it to `DelayedRejectStrategy`.
- Java's `maxDelayedThreads` maps to **`DelayedRejectStrategy`**'s `maxConcurrentDelays` (default 100).
- `PartitionedStrategy` requires `initialLimit`.
- `PartitionedStrategy` itself throws if no partitions are provided; `HttpLimiterBuilder` falls back to non-partitioned `Limiter` when no partitions are configured.

### Blocking strategy behavior

| Aspect                                     | Java                                           | TypeScript                                                                                                |
| ------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| FIFO blocking                              | `BlockingLimiter` wrapper                      | `BlockingBacklogRejection` + `enqueueOptions: { direction: "back" }` + `new LinkedWaiterQueue()`       |
| LIFO blocking                              | `LifoBlockingLimiter` wrapper                  | `BlockingBacklogRejection` + `enqueueOptions: { direction: "front" }` + `new LinkedWaiterQueue()`      |
| Delay then reject (`partitionRejectDelay`) | `Thread.sleep` in `AbstractPartitionedLimiter` | `DelayedRejectStrategy` (`delayMsForContext`, `maxConcurrentDelays`); delays are not on `PartitionConfig` |
| Delay then block                           | N/A                                            | `DelayedThenBlockingRejection` (compose delay + FIFO/LIFO blocking)                                      |
| Blocking mechanism                         | thread wait/latch primitives                   | Promise queues                                                                                            |
| Cancellation                               | interrupt-based                                | `AbortSignal` support                                                                                     |

Additional details:

- FIFO and LIFO blocking are both created from `BlockingBacklogRejection` and use:
  - `backlogSize` (maximum queued callers),
  - `backlogTimeout` (`number` or `(context) => number`),
  - max timeout cap of 1 hour.
- Defaults differ to mirror Java intent:
  - FIFO: `backlogSize = Infinity`, `backlogTimeout = 1 hour`.
  - LIFO: `backlogSize = 100`, `backlogTimeout = 1 second`.
- `enqueueOptions.direction` determines LIFO (`"front"`) vs FIFO (`"back"`), and `enqueueOptions` can be provided as a function of context.
- `LinkedWaiterQueue` now acts as a priority queue; `enqueueOptions.priority` can be used to prioritize queued waiters (higher priority is served first).
- Both strategies react to limit increases (`onLimitChanged`) by scheduling a backlog drain, so queued callers can be served without waiting for another release event.
- `DelayedRejectStrategy`: awaits a delay then returns no allotment (does not call `retry`); unlike blocking strategies, it does not wait for capacity.
- `DelayedThenBlockingRejection`: runs delayed rejection first, then retries once, and if still unavailable delegates to configured blocking strategy.

### Java-style builder wrappers -> TS factory helpers

The TypeScript package also exports convenience factory functions that map common Java limiter wrappers/builders to composed `Limiter` options:

| Java usage pattern                                      | TypeScript helper                           |
| ------------------------------------------------------- | ------------------------------------------- |
| `SimpleLimiter.newBuilder()...build()`                  | `makeSimpleLimiter(...)`                    |
| `BlockingLimiter.wrap(...)` / blocking builder variants | `makeBlockingLimiter(...)`                  |
| `LifoBlockingLimiter...build()`                         | `makeLifoBlockingLimiter(...)`              |
| partitioned limiter builder                             | `makePartitionedLimiter(...)`               |
| partitioned + blocking                                  | `makePartitionedBlockingLimiter(...)`       |
| partitioned + lifo blocking                             | `makePartitionedLifoBlockingLimiter(...)`   |

These are convenience APIs; the underlying model remains explicit composition via `new Limiter({...})`.

---

## 6. Limit algorithm surface differences

### Builders -> constructors/options objects

Java fluent builders (`newBuilder()...build()`) are replaced with TypeScript constructors with options objects.

Examples:

- Java `VegasLimit.newBuilder()...build()` -> TypeScript `new VegasLimit({...})`
- Java `AIMDLimit.newBuilder()...build()` -> TypeScript `new AIMDLimit({...})`
- Java `WindowedLimit.newBuilder().build(delegate)` -> TypeScript `new WindowedLimit(delegate, options?)`
- Java `FixedLimit.of(x)` -> TypeScript `new FixedLimit(x)`
- Java `SettableLimit.startingAt(x)` -> TypeScript `new SettableLimit(x)`

### Time unit normalization

All algorithm time inputs/options in TypeScript use milliseconds (not Java nanoseconds + `TimeUnit` conversions), including:

- `AdaptiveLimit.addSample(...)` timing values
- `AIMDLimitOptions.timeout`
- `WindowedLimitOptions.minWindowTimeMs` / `maxWindowTimeMs`
- limiter clock values (default `performance.now()` semantics)

### `VegasLimit`

- Policy hooks are grouped under `policy`:
  - `alpha`, `beta`, `threshold`, `increase`, `decrease`
- `alpha`, `beta`, `threshold`, and `increase` are `(limit: number) => number`.
- `decrease` is `(limit: number, didDrop: boolean) => number`, so the policy can distinguish latency-driven decreases from drop-driven ones.
- Java deprecated builder methods (`alpha(...)`, `beta(...)`, `tolerance(...)`, `backoffRatio(...)`) are not carried over.
- Java `Log10RootIntFunction` is not a standalone class in TS; equivalent behavior is an exported `log10Scale` helper in `utils`.

### `AIMDLimit`

- TypeScript adds a `backoffJitter` option (default `0.02`): an absolute +/- jitter band around `backoffRatio` applied to each multiplicative decrease. This breaks lockstep oscillation when multiple independent clients share the same configuration. Must be in `[0, 0.05]`.

### `Gradient2Limit` naming

- Implementation/export name in TS is `GradientLimit`.
- Option type is `Gradient2LimitOptions`.
- `queueSize` supports `number | ((concurrency: number) => number)`.
- `getLastRtt()` and `getRttNoLoad()` return milliseconds.

### `WindowedLimit` and sample windows

- TS constructor takes delegate directly: `new WindowedLimit(delegate, options?)`.
- TS `SampleWindow` is immutable (`addSample` returns new `SampleWindow`).
- Properties use readonly fields (`candidateRttMs`, `trackedRttMs`, `maxInFlight`, `sampleCount`, `dropped`) instead of Java getter methods.
- Factory style is function-based (`sampleWindowFactory?: () => SampleWindow`).
- TS adds `createPercentileSampleWindow(...)` in addition to average windows.

### `FixedLimit`, `SettableLimit`

- `FixedLimit` and `SettableLimit` implement `AdaptiveLimit` directly.
- `SettableLimit.setLimit(...)` has no synchronization concerns (single-threaded runtime model).

### Gradient v1

- Java has both `GradientLimit` (v1) and `Gradient2Limit` (v2).
- This TypeScript port only exposes the v2-style algorithm surface under the name `GradientLimit`.

---

## 7. Executor differences

Java's `BlockingAdaptiveExecutor` has no direct TypeScript class equivalent now. Its role is covered by `withLimiter(limiter)`:

- Java `execute(Runnable)` style maps to wrapping your async work in `withLimiter(limiter)`.
- Acquire failures are represented by `QuotaNotAvailable` (instead of executor-specific rejection exceptions).
- Drop signaling can be done via `dropped(err)` return values, or by throwing `AdaptiveTimeoutError`.
- No JVM thread-pool abstraction is provided in core TypeScript APIs.

---

## 8. Metrics API differences

| Aspect               | Java                                         | TypeScript                                            |
| -------------------- | -------------------------------------------- | ----------------------------------------------------- |
| Sample listener type | nested `MetricRegistry.SampleListener`       | `DistributionMetric`                                  |
| Sample methods       | multiple boxed-number variants               | single `addSample(value: number)`                     |
| Counter type         | nested                                       | top-level `Counter`                                   |
| `counter` tags       | varargs name/value pairs                     | object map `Record<string,string>`                    |
| `distribution` tags  | varargs strings                              | varargs strings                                       |
| `gauge`              | `Supplier<Number>` (registration often void) | attributes object + returned `Gauge` handle (`record(value)`) |
| no-op registry       | singleton class                              | `NoopMetricRegistry` object constant                  |

Shared metric **name** strings used by `Limiter`, `PartitionedStrategy`, and adaptive limits (e.g. `limit`, `call`, `inflight`, `min_rtt`) live in the `MetricIds` constant, co-exported from `MetricRegistry.ts` with `MetricRegistry` / `NoopMetricRegistry`.

Metric semantics differ slightly from the Java implementation. In Java, `MetricIds.CALL_NAME` is used for **all** limiter outcomes: `success`, `dropped`, `ignored`, plus acquire-time `rejected` and `bypassed` (see `AbstractLimiter.createRejectedListener` / `createBypassListener`). That means the Java `call` metric mixes "we executed the downstream" outcomes with "we could not acquire a slot" outcomes. In this TypeScript port, those are split: `call` is only for post-acquire outcomes, and `acquire_attempt` captures `succeeded`, `failed`, and `bypassed` acquisition results (including retries).

Additionally, the TypeScript port tracks `acquire_time` as a distribution metric (`MetricIds.ACQUIRE_TIME_NAME`) with status `success` or `unavailable`, measuring how long `acquire()` takes (including any time spent in rejection strategies such as blocking or delayed rejection). This has no Java equivalent.

Bypassed requests now track call-level outcomes (success/ignored/dropped) through the bypass allotment, rather than using a no-op allotment as previously.

The main public API change to be aware of is that `MetricRegistry`'s gauge model changed from supplier-style registration to an explicit `Gauge.record(...)` handle.

Java deprecated metric registration APIs (`registerDistribution`, `registerGauge`, `registerGuage`) are not present in TS.

---

## 9. Statistics / measurement mapping

`Measurement` -> `StreamingStatistic`:

| Java                               | TypeScript                         |
| ---------------------------------- | ---------------------------------- |
| `add(Number)`                      | `addSample(number)`                |
| `get()`                            | `currentValue` getter              |
| `reset()`                          | `reset()`                          |
| `update(Function<Number, Number>)` | `update((current:number)=>number)` |

Implementation mapping:

| Java                 | TypeScript                               |
| -------------------- | ---------------------------------------- |
| `ExpAvgMeasurement`  | `ExpMovingAverage`                       |
| `MinimumMeasurement` | `MinimumValue`                           |
| -                    | `MostRecentValue` (new TS addition)      |
| -                    | `DecayingHistogram` (new TS addition)    |

---

## 10. HTTP package differences (servlet-style vs Node middleware)

| Java                            | TypeScript                                               |
| ------------------------------- | -------------------------------------------------------- |
| `ConcurrencyLimitServletFilter` | `concurrencyLimitMiddleware(...)`                        |
| `ServletLimiterBuilder`         | `HttpLimiterBuilder`                                     |
| servlet request model           | minimal `HttpRequest` shape (`method`, `url`, `headers`) |
| HTTP 429 overload responses     | default 429 (`throttleStatus` configurable)              |

`HttpLimiterBuilder` supports:

- partitioning by header
- partitioning by path mapping function
- partitioning by method
- bypass by header/method/custom predicate

If several `partitionBy*` methods are used, `build()` merges them **in registration order** into a **single** `partitionResolver` (first non-null/undefined name wins) before constructing `PartitionedStrategy`—the strategy itself always takes one resolver function; ordered fallback is either composed here or implemented manually when constructing `PartitionedStrategy` directly.

Java servlet helpers without direct built-in equivalents (e.g. parameter/attribute/principal-specific builders) should be implemented via custom resolver/predicate logic in TS.

---

## 11. Removed or not-ported Java items

- `LimiterRegistry` convenience abstraction is not present.
- Standalone `Log10RootIntFunction` class is not present (equivalent `log10Scale` is exported from utils).
- `TracingLimitDecorator` was previously ported but has been removed. If tracing is needed, subscribe to `AdaptiveLimit` change events or wrap at the `MetricRegistry` level.
- Java gRPC integration modules are not ported in this repo.

---

## 12. New items without Java equivalents

- `withLimiter(limiter)`
- `RunResult` + `success/ignore/dropped`
- `GroupAwareLimit` — mix-agnostic limit algorithm with per-group RTT baselines
- `QuotaNotAvailable` sentinel
- `LimiterState` strategy input
- `AcquireStrategy` / `AllotmentUnavailableStrategy` public extension points
- `DelayedThenBlockingRejection`
- limiter factory helpers (`makeSimpleLimiter`, `makeBlockingLimiter`, `makeLifoBlockingLimiter`, `makePartitionedLimiter`, `makePartitionedBlockingLimiter`, `makePartitionedLifoBlockingLimiter`)
- `ListenerSet`
- `createPercentileSampleWindow(...)`
- `MostRecentValue`
- `DecayingHistogram` - A histogram with log-spaced bins and continuous exponential time decay. Provides approximate percentile queries in O(numBins) time and fixed memory.
- `LimiterOptions.operationNameFor` — derives operation names from context for group-aware limits
- `AdaptiveLimit.addSample()` `operationName` parameter
- `AIMDLimit.backoffJitter` option
- `acquire_attempt` metric (`MetricIds.ACQUIRE_ATTEMPT_NAME`)
- `acquire_time` distribution metric (`MetricIds.ACQUIRE_TIME_NAME`)
- broad `AbortSignal` support in acquire/rejection/subscribe APIs
- `squareRoot(...)` and `squareRootWithBaseline(...)` helpers
- `AdaptiveTimeoutError`, `isAdaptiveTimeoutError(...)`

---

## 13. Migration checklist

1. Replace `Optional<Limiter.Listener>` with `LimitAllotment | undefined` (or promise thereof).
2. Rename listener methods: `onSuccess/onIgnore/onDropped` -> `releaseAndRecordSuccess/releaseAndIgnore/releaseAndRecordDropped`.
3. Replace `Limit` API usage with `AdaptiveLimit` (`getLimit`/`notifyOnChange`/`onSample` -> `currentLimit`/`subscribe`/`addSample`).
4. Convert nanosecond logic to milliseconds.
5. Replace builder/decorator constructions with `new Limiter({...})` plus strategies.
6. Replace `BlockingLimiter`/`LifoBlockingLimiter` wrapping with `allotmentUnavailableStrategy` strategies.
7. For partitioned limiting, pass a single `partitionResolver` in the `PartitionedStrategy` constructor options (compose multiple Java-style resolvers yourself, or use `HttpLimiterBuilder`, which does this at `build()`).
8. If you need stricter partition bursting than Java defaults, configure TS `PartitionConfig.burstMode` (`unbounded`/`capped`/`none`).
9. If using TS partitioned factory helpers and Java-style reject delays, set per-partition `delayMs` (factory convenience) or wire your own `DelayedRejectStrategy`.
10. Prefer `withLimiter(limiter)` for scoped acquire/complete flows where appropriate.
11. If using TS blocking factories, use `backlogTimeout`/`backlogSize` options (not `timeout`).

---

## 14. Upstream merge guide (maintainers)

When upstream Java commits change behavior, likely TS touchpoints are:

- listener lifecycle/acquire semantics -> `Limiter.ts`, `LimitAllotment.ts`
- partition logic -> `limiter/acquire-strategies/PartitionedStrategy.ts`
- blocking behavior -> `limiter/allocation-unavailable-strategies/BlockingBacklogRejection.ts`, `limiter/allocation-unavailable-strategies/DelayedThenBlockingRejection.ts`
- Java partition reject delay -> `limiter/allocation-unavailable-strategies/DelayedRejectStrategy.ts` (optional; compose with `delayMsForContext` or via factory `delayMs`)
- algorithm math -> files under `limit/` (including `GroupAwareLimit.ts`, `DecayingHistogram.ts`)
- metrics tagging/counters -> `MetricRegistry.ts` (`MetricIds`) + limiter/strategy call sites
- operation name plumbing -> `StreamingLimit.ts` (`AdaptiveLimit.addSample` signature), `Limiter.ts` (`operationNameFor`)
- servlet integration deltas -> `packages/http` (or new integration package work)

Because this port factors behavior into strategies, a Java change in `SimpleLimiter` vs `AbstractPartitionedLimiter` may map to the same TypeScript `Limiter` with different options rather than new classes.
