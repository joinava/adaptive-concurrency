# Changelog

All notable changes to the `adaptive-concurrency` package are recorded here.
The Redis package is versioned separately and has
[its own changelog](packages/redis/CHANGELOG.md); its 0.2.0 and later pair
with core 0.14.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The package is pre-1.0, so a minor version bump can contain breaking changes.

Releases before 0.14.0 have no entries; see the git history.

## [Unreleased]

### Breaking

- `PartitionedStrategy` splits the global limit among partitions by the
  largest-remainder method. Each partition gets the floor of
  `globalLimit * percent`, and the leftover slots go to the largest fractional
  remainders, with ties to the partition declared first. The shares were
  `max(1, ceil(globalLimit * percent))` each.
  - The shares never sum to more than the global limit, and a share can be 0.
    With 60%/20%/20% partitions, a limit of 1 gives 1/0/0 (was 1/1/1).
  - Declaration order in `partitions` is now the tie-break, so declare
    partitions in priority order.
  - A `capped` burst is `ceil(globalLimit * percent * maxBurstMultiplier)`,
    from the unrounded share (was `ceil(limitAtGlobalSaturation *
maxBurstMultiplier)`).
  - Below saturation, a `capped` or `none` partition with a nonzero percent
    may still use one slot of slack, so a share of 0 cannot starve it.
  - A partition with a percent of 0 has a share of 0 (was 1).

### Fixed

- A `PartitionedStrategy` admitted requests at a global limit of 0. At limit 0
  every acquire takes the saturation path, and the floor of 1 let each
  partition admit one request. Now no partition is admitted at limit 0, so
  the recovery probe controls when traffic resumes.
- At a small global limit, the floor of 1 let every partition admit a request
  at saturation, so a pod at limit 1 could run one request per partition and
  partition priority had no effect.

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
