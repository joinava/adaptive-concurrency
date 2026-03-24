import { Limiter, type LimiterOptions } from "../../Limiter.js";
import { SemaphoreStrategy } from "../acquire-strategies/SemaphoreStrategy.js";

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
