import {
  Limiter,
  SemaphoreStrategy,
  type LimiterOptions,
  type SyncAcquireResult,
} from "../../Limiter.js";

export function makeSimpleLimiter<ContextT = void>(
  options: Omit<
    LimiterOptions<ContextT, SyncAcquireResult>,
    "acquireStrategy"
  > = {},
): Limiter<ContextT, SyncAcquireResult> {
  const limit = options.limit ?? Limiter.makeDefaultLimit();
  return new Limiter<ContextT, SyncAcquireResult>({
    ...options,
    limit,
    acquireStrategy: new SemaphoreStrategy(limit.currentLimit),
  });
}
