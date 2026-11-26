# Changelog

All notable changes to the `adaptive-concurrency` package are recorded here.
The Redis package is versioned separately and has
[its own changelog](packages/redis/CHANGELOG.md); its 0.2.0 and later pair
with core 0.14.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The package is pre-1.0, so a minor version bump can contain breaking changes.

Releases before 0.14.0 have no entries; see the git history.

## [0.15.0] - Unreleased

Pairs with `@adaptive-concurrency/redis` 0.4.0 and `@adaptive-concurrency/http`
0.3.0.

### Breaking

- `Limiter.acquire()` resolves with a `Result<LimitAllotment>`, not with a
  `LimitAllotment | undefined`. `AcquireResult` is now
  `Promise<Result<LimitAllotment>>`, where
  `Result<T> = { ok: true, value: T } | { ok: false, error: Error }`.
  - `{ ok: true, value }` holds the allotment.
  - `{ ok: false, error }` means no allotment was available, the backlog was
    full, or the request timed out in the backlog. `error` is an
    `allotmentUnavailableError`.
  - The promise rejects with the signal's `reason` when the caller's signal
    aborts, including a signal that had aborted before the call. It also
    rejects when a strategy, the clock, or another callback throws.
- `AllotmentUnavailableStrategy.onAllotmentUnavailable` returns the same
  `AcquireResult`. To give up, it resolves with `{ ok: false, error }`, where
  `error` is an `allotmentUnavailableError` that it makes. On abort, it
  rejects with the signal's `reason`. Its `retry` callback is typed
  `RetryAcquire<ContextT>` and still resolves with `undefined` while the
  acquire strategy refuses. A strategy that resolves with anything that is
  not a result makes `acquire()` reject with a `TypeError`.
- `withLimiter` and `makeLimitedFunction` resolve with a `Result<T>`:
  `{ ok: true, value }`, or `acquire()`'s `{ ok: false, error }` when the
  limiter gave no allotment and `fn` did not run. If `acquire()` rejects, for
  example after an abort, they reject too. `QuotaNotAvailable` is removed.
- `@zingage/errors` (^1.1.0) is a new peer dependency.
- `PartitionedStrategy` splits the global limit among partitions by the
  largest-remainder method. Each partition gets the floor of
  `globalLimit * percent`, and the leftover slots go to the largest fractional
  remainders. The shares were
  `max(1, ceil(globalLimit * percent))` each.
  - The shares never sum to more than the global limit, and a share can be 0.
    With 60%/20%/20% partitions, a limit of 1 gives 1/0/0 (was 1/1/1).
  - A tie goes to the partition that comes first in the enumeration order of
    `partitions`. That is insertion order, except that integer-like names
    such as `"1"` come first, in ascending numeric order. List partitions in
    priority order, and do not give them integer-like names.
  - A `capped` burst is `ceil(globalLimit * percent * maxBurstMultiplier)`,
    from the unrounded share (was
    `ceil(limitAtGlobalSaturation * maxBurstMultiplier)`).
  - Below saturation, a `capped` or `none` partition with a nonzero percent
    may still use one slot of slack, so a share of 0 cannot starve it.
  - A partition with a percent of 0 has a share of 0 (was 1).

### Added

- `Result<T, E = Error>`.
- `allotmentUnavailableError`, `isAllotmentUnavailableError`, and
  `adaptiveConcurrencyErrorVocabulary`. The error type
  `ALLOTMENT_UNAVAILABLE` is under the `SERVICE_UNAVAILABLE` root: safe to
  retry, clears on its own, and signals high load. A throw site can state a
  `retryAfter`, or a different `load`. An app that reads errors with
  `@zingage/errors` lists the vocabulary in `makeErrorHelpers({ vocabularies })`.
- `DelayedRejectStrategy.delay(context, signal)`, the delay alone, which
  `DelayedThenBlockingRejection` uses.
- `LimitAllotment.releaseAndRecordSuccess` and `releaseAndRecordDropped` take
  an optional `weight`: the amount of work that the operation represented,
  for example the number of items in a batch call. `Limiter` passes it to the
  limit algorithm as a new optional last argument of `AdaptiveLimit.addSample`.
  The built-in limits ignore it, and `WindowedLimit` does not forward it.

### Fixed

- A `PartitionedStrategy` admitted requests at a global limit of 0. At limit 0
  every acquire takes the saturation path, and the floor of 1 let each
  partition admit one request. Now no partition is admitted at limit 0, so
  the recovery probe controls when traffic resumes.
- At a small global limit, the floor of 1 let every partition admit a request
  at saturation, so a pod at limit 1 could run one request per partition and
  partition priority had no effect.
- The RTT sample left out the time that `AllotmentReservation.commit()`
  takes. Before, `Limiter` started the operation's clock before the commit,
  so a slow async commit inflated every RTT. The acquire-time metric now
  includes the commit, and stall detection checks the operation's real start.
  If the clock throws when it is read after the commit, the allotment records
  no success sample and no acquire time; a drop is still recorded, with an RTT
  of 0.
- A queued waiter could wait until its backlog timeout although capacity was
  free. An acquire attempt can reserve capacity and then cancel it: `Limiter`
  cancels when `clock()` or `operationNameFor()` throws, and
  `RedisTokenBucketStrategy` cancels its inner reservation when the bucket
  denies. A waiter's retry that failed against that reservation was not
  tried again, because a cancel is not a release. Now, when an attempt ends
  without an allotment and another attempt failed while it ran, `Limiter`
  calls the rejection strategy's `onAllotmentReleased()`, so a blocking
  backlog retries its head.

## [0.14.0] - 2026-09-16

### Breaking

- `GroupAwareLimit` measures congestion differently. Each group keeps two
  log-binned histograms of RTT, a time-decayed baseline and a count-decayed
  recent window, and compares the same percentile of both (default the
  median). The old design compared an exponential moving average of recent
  RTT to the baseline's p10, which read any skewed latency distribution as
  congestion and could pin the limit at `minLimit`.
  - `alpha` and `beta` are replaced by
    `rttRatioThresholds: { increaseBelow, decreaseAbove }` (defaults `1.06`
    and `1.5`).
  - `decrease` is now `{ ratio, jitter }` (defaults `0.9` and `0.02`), not a
    `(limit, didDrop) => number` function.
  - `clock` is removed. All time comes from samples, including the time the
    recovery probe reads.
  - `recentRttWindow` is the sample window of the recent histogram.
  - New options `percentile` (default `0.5`) and `binsPerDecade` (default `20`).
- `AIMDLimit`: `backoffRatio` and `backoffJitter` are replaced by
  `decrease: { ratio, jitter }` with the same defaults and validation.
- `DecayingHistogram`: `halfLife` and `sampleWindow` are mutually exclusive,
  enforced by the constructor's option type. The default `binsPerDecade` is
  `20` (was `5`), so percentile queries are within ±6% (were ±26%).

### Added

- `LimiterOptions.stallDetection`. The limiter keeps a small event-loop stall
  log and withholds the RTT sample of any successful request whose start or
  observed end fell inside a stall. Withheld samples are counted on the new
  `stall_ignored_sample` metric (`MetricIds.STALL_IGNORED_SAMPLE_NAME`).
  Drops are always recorded. Limiters on the default clock share one log per
  configuration, released when the last of them is disposed.
- `AIMDLimit` and `GroupAwareLimit` apply at most one increase and one
  decrease per flight of requests. A change only affects requests admitted
  after it, so samples from earlier requests never compound it.
- `minUtilizationToGrow` option on `AIMDLimit`, `GradientLimit` and
  `GroupAwareLimit` (default `0.5`). A sample can raise the limit only if at
  least that fraction of the limit was in flight when the request was
  admitted. This was hard-coded at `0.5`.
- `DecayingHistogram` accepts `sampleWindow` for decay by sample count.
- Exported types `AppLimitedOptions` and `MultiplicativeDecreaseOptions`.

### Fixed

- `GroupAwareLimit` could stop growing at some base RTTs because the 5 bins
  per decade histogram returned bin midpoints with up to ±26% error.
