# Changelog

All notable changes to the `@adaptive-concurrency/redis` package are recorded
here. The core `adaptive-concurrency` package is versioned separately; see the
[changelog at the repository root](../../CHANGELOG.md).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The package is pre-1.0, so a minor version bump can contain breaking changes.

Releases before 0.3.0 have no entries; see the git history.

## [0.3.0] - 2026-09-16

### Added

- `RedisTokenBucketStrategy` accepts `appliesTo`, a predicate selecting which
  contexts the bucket governs. It defaults to every context, so existing
  callers do not change. Return `false` to exempt a context: the inner strategy
  still reserves and bounds it, but the bucket is skipped, so no token is taken
  and none has to be refunded. An exempt context is still bounded locally,
  because it still goes through the inner strategy. The predicate and the key
  resolver both run before the inner reserves, so a throw from either cannot
  strand a reservation, and an exempt context never resolves a bucket key.

  The intended shape is a sub-budget. Nest the strategy inside an outer one
  whose bucket governs every context, and let the inner bucket meter one class
  of traffic. Exempting a class from the only bucket in a chain is a different
  thing, and the option's documentation says so: it gives up the fleet-wide
  ceiling for that class, leaving it bounded only per process.

  The deprecated `@zingage/adaptive-concurrency-redis` fork carried this
  behaviour from its 0.1.1 under the name `shouldUseBucket`, but it was never
  in this repository, so that fork was not a pure rename of this source. The
  admission logic here matches the fork's. It differs in two deliberate ways:
  the option's name, and the point at which the predicate and the key resolver
  are evaluated. The fork ran both around the inner reservation, which strands
  that reservation if either throws.
