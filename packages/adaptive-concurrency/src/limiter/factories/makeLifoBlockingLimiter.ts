import {
  Limiter,
  type LimiterOptions,
} from "../../Limiter.js";
import {
  LifoBlockingRejection,
  type LifoBlockingRejectionOptions,
} from "../allocation-unavailable-strategies/LifoBlockingRejection.js";

export function makeLifoBlockingLimiter<ContextT = void>(
  options: {
    backlogSize?: number;
    backlogTimeout?: LifoBlockingRejectionOptions<ContextT>["backlogTimeout"];
    limiter?: Omit<LimiterOptions<ContextT>, "allotmentUnavailableStrategy">;
  } = {},
): Limiter<ContextT> {
  return new Limiter<ContextT>({
    ...options.limiter,
    allotmentUnavailableStrategy: new LifoBlockingRejection<ContextT>({
      backlogSize: options.backlogSize,
      backlogTimeout: options.backlogTimeout,
    }),
  });
}
