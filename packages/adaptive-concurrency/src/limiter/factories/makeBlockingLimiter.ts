import {
  Limiter,
  type AsyncAcquireResult,
  type LimiterOptions,
} from "../../Limiter.js";
import { FifoBlockingRejection } from "../FifoBlockingRejection.js";

export function makeBlockingLimiter<ContextT = void>(
  options: {
    timeout?: number;
    limiter?: Omit<
      LimiterOptions<ContextT, AsyncAcquireResult>,
      "allotmentUnavailableStrategy"
    >;
  } = {},
): Limiter<ContextT, AsyncAcquireResult> {
  return new Limiter<ContextT, AsyncAcquireResult>({
    ...options.limiter,
    allotmentUnavailableStrategy: new FifoBlockingRejection<ContextT>({
      timeout: options.timeout,
    }),
  });
}
