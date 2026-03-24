import {
  Limiter,
  type LimiterOptions,
} from "../../Limiter.js";
import {
  FifoBlockingRejection,
  type FifoBlockingRejectionOptions,
} from "../allocation-unavailable-strategies/FifoBlockingRejection.js";

export function makeBlockingLimiter<ContextT = void>(
  options: {
    backlogSize?: number;
    backlogTimeout?: FifoBlockingRejectionOptions<ContextT>["backlogTimeout"];
    limiter?: Omit<LimiterOptions<ContextT>, "allotmentUnavailableStrategy">;
  } = {},
): Limiter<ContextT> {
  return new Limiter<ContextT>({
    ...options.limiter,
    allotmentUnavailableStrategy: new FifoBlockingRejection<ContextT>({
      backlogSize: options.backlogSize,
      backlogTimeout: options.backlogTimeout,
    }),
  });
}
