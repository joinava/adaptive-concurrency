# Changelog

All notable changes to the `adaptive-concurrency` package are recorded here.
The Redis package is versioned separately; its 0.2.0 pairs with core 0.14.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The package is pre-1.0, so a minor version bump can contain breaking changes.

Releases before 0.14.0 have no entries; see the git history.

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
