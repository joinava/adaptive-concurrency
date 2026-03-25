import { Limiter, type LimiterOptions } from "../../Limiter.js";
import { LinkedWaiterQueue } from "../../utils/LinkedWaiterQueue.js";
import {
  BlockingBacklogRejection,
  MAX_TIMEOUT,
  type Waiter,
} from "../allocation-unavailable-strategies/BlockingBacklogRejection.js";

export function makeBlockingLimiter<ContextT = void>(
  options: {
    backlogSize?: number;
    backlogTimeout?: number | ((context: ContextT) => number);
    limiter?: Omit<LimiterOptions<ContextT>, "allotmentUnavailableStrategy">;
  } = {},
): Limiter<ContextT> {
  return new Limiter<ContextT>({
    ...options.limiter,
    allotmentUnavailableStrategy: new BlockingBacklogRejection({
      backlogSize: options.backlogSize ?? Number.POSITIVE_INFINITY,
      backlogTimeout: options.backlogTimeout ?? MAX_TIMEOUT,
      enqueueOptions: { direction: "back" },
      queue: new LinkedWaiterQueue<Waiter<ContextT>>(),
    }),
  });
}
