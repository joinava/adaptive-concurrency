import {
  Limiter,
  type AsyncAcquireResult,
  type LimiterOptions,
} from "../../Limiter.js";
import {
  LifoBlockingRejection,
  type LifoBlockingRejectionOptions,
} from "../LifoBlockingRejection.js";

export function makeLifoBlockingLimiter<ContextT = void>(
  options: {
    backlogSize?: number;
    backlogTimeout?: LifoBlockingRejectionOptions<ContextT>["backlogTimeout"];
    limiter?: Omit<
      LimiterOptions<ContextT, AsyncAcquireResult>,
      "allotmentUnavailableStrategy"
    >;
  } = {},
): Limiter<ContextT, AsyncAcquireResult> {
  return new Limiter<ContextT, AsyncAcquireResult>({
    ...options.limiter,
    allotmentUnavailableStrategy: new LifoBlockingRejection<ContextT>({
      backlogSize: options.backlogSize,
      backlogTimeout: options.backlogTimeout,
    }),
  });
}
