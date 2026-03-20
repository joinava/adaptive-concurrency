import {
  Limiter,
  SemaphoreStrategy,
  type LimiterOptions,
} from "../../Limiter.js";

export function makeSimpleLimiter<ContextT = void>(
  options: Omit<LimiterOptions<ContextT>, "acquireStrategy"> = {},
): Limiter<ContextT> {
  const limit = options.limit ?? Limiter.makeDefaultLimit();
  return new Limiter<ContextT>({
    ...options,
    limit,
    acquireStrategy: new SemaphoreStrategy(limit.currentLimit),
  });
}
