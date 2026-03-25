import { Limiter, type LimiterOptions } from "../../Limiter.js";
import { LinkedWaiterQueue } from "../../utils/LinkedWaiterQueue.js";
import {
  BlockingBacklogRejection,
  type Waiter,
} from "../allocation-unavailable-strategies/BlockingBacklogRejection.js";

export function makeLifoBlockingLimiter<ContextT = void>(
  options: {
    backlogSize?: number;
    backlogTimeout?: number | ((context: ContextT) => number);
    limiter?: Omit<LimiterOptions<ContextT>, "allotmentUnavailableStrategy">;
  } = {},
): Limiter<ContextT> {
  return new Limiter<ContextT>({
    ...options.limiter,
    allotmentUnavailableStrategy: new BlockingBacklogRejection({
      backlogSize: options.backlogSize ?? 100,
      backlogTimeout: options.backlogTimeout ?? 1_000,
      enqueueDirection: "front",
      queue: new LinkedWaiterQueue<Waiter<ContextT>>(),
    }),
  });
}
