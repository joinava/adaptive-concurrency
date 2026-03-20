import {
  Limiter,
  type LimiterOptions,
} from "../../Limiter.js";
import { FifoBlockingRejection } from "../allocation-unavailable-strategies/FifoBlockingRejection.js";

export function makeBlockingLimiter<ContextT = void>(
  options: {
    timeout?: number;
    limiter?: Omit<LimiterOptions<ContextT>, "allotmentUnavailableStrategy">;
  } = {},
): Limiter<ContextT> {
  return new Limiter<ContextT>({
    ...options.limiter,
    allotmentUnavailableStrategy: new FifoBlockingRejection<ContextT>({
      timeout: options.timeout,
    }),
  });
}
