# Advanced Usage Patterns

This document covers lower-level and more configurable limiter usage patterns that are beyond the Quick Start flow in the main `README`.

## `withLimiter(limiter)`

For cases where you want to pass a callback at each call site (rather than pre-binding one callback with `makeLimitedFunction`), use `withLimiter(limiter)` to create a `callWithLimiter` helper.

```typescript
import {
  Limiter,
  VegasLimit,
  withLimiter,
  success,
  ignore,
  dropped,
} from "adaptive-concurrency";

const limiter = new Limiter<string>({ limit: new VegasLimit() });
const callWithLimiter = withLimiter(limiter);

const result = await callWithLimiter(
  { context: "tenant-a" },
  async ({ context, signal }) => {
    try {
      const data = await fetchData({ context, signal });

      // If this operation's round-trip time should, for some reason,
      // be excluded from the concurrency limit calculation, you'd return
      // `ignore(data)` instead.
      return success(data);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));

      // detect 429 or anything else indicating that your request was dropped
      // (i.e., subject to load shedding), or any timeout that you interpret
      // as a signal that the backend is overloaded. If you see such overload,
      // you MUST inform the limiter by throwing dropped(error) so it'll reduce
      // the limit.
      if (isRateLimitError || didTimeOutOrLoadShed) {
        throw dropped(error);
      }

      // Otherwise, treat as ignored failure: this round-trip time isn't
      // representative/usable for computing the concurrency limit.
      // `throw e` is equivalent to `throw ignore(e)`.
      throw ignore(e);
    }
  },
);

if (!result.ok) {
  // Callback was not run because calls to the downstream were already
  // at the max concurrency (and the limiter wasn't set up to queue further
  // acquire calls)
} else {
  // `result.value` is the value inside `success` / `ignore`
}
```

### Callback contract (`withLimiter`)

`withLimiter(limiter)` returns `callWithLimiter`. It can be invoked as `callWithLimiter(fn)` or `callWithLimiter(options, fn)`. The callback `fn` receives `{ context, signal }` and drives limiter bookkeeping via what it returns or throws:

| Callback behavior | Limiter bookkeeping | `callWithLimiter` outcome |
| ----------------- | ------------------- | ------------------------- |
| `return success(v)` or `return v` | `releaseAndRecordSuccess()` | resolves with `{ ok: true, value: v }` |
| `return ignore(v)` | `releaseAndIgnore()` | resolves with `{ ok: true, value: v }` |
| `throw dropped(err)` | `releaseAndRecordDropped()` | rejects with `err` |
| `throw AdaptiveTimeoutError` / `throw AdaptiveRejectionError` | `releaseAndRecordDropped()` | rejects with the same error |
| `throw ignore(err)` or `throw err` | `releaseAndIgnore()` | rejects with `err` |

Notes:

- Returning a non-`RunResult` value is shorthand for `return success(value)`.
- Throwing a non-`RunResult` error is shorthand for `throw ignore(error)`.
- Returning `dropped(error)` is invalid; use `throw dropped(error)` for drop semantics.
- If `acquire` gives no allotment, `callWithLimiter` resolves with its `{ ok: false, error }` and does not call `fn`. `error` is an `allotmentUnavailableError`. If `acquire` rejects, for example with the signal's reason after an abort, `callWithLimiter` rejects too.

## Direct `acquire` + `LimitAllotment`

`acquire` is a lower-level API that's not as safe, as you MUST be sure to call `releaseAndRecordSuccess()`, `releaseAndRecordDropped()` or `releaseAndIgnore()` when the operation is complete.

```typescript
const acquired = await limiter.acquire({ context: "tenant-a" });
if (!acquired.ok) {
  // No allotment right now. `acquired.error` is the
  // `allotmentUnavailableError`.
  return;
}

const allotment = acquired.value;
try {
  await doWork();
  await allotment.releaseAndRecordSuccess();
} catch {
  await allotment.releaseAndRecordDropped();
}
```

To use it, pass `AcquireOptions`: `{ context }` when the limiter is keyed by context, `{ signal }` for `AbortSignal`, or omit/`{}` for a void context.

`acquire` returns `Promise<Result<LimitAllotment>>` and should be awaited directly. It resolves with `{ ok: false, error }` when the limiter gives no allotment, where `error` is an `allotmentUnavailableError`. It rejects with the signal's `reason` when the signal aborts first.

Use `acquire` + `LimitAllotment` when you need a separate acquire and release (framework hooks, streaming lifetimes, handoff to another owner). Use `withLimiter(limiter)` or `makeLimitedFunction(limiter, fn)` when a single async scope is enough.
