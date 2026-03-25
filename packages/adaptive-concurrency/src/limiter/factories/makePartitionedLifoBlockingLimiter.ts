import { Limiter, type LimiterOptions } from "../../Limiter.js";
import { LinkedWaiterQueue } from "../../utils/LinkedWaiterQueue.js";
import {
  PartitionedStrategy,
  type PartitionConfig,
} from "../acquire-strategies/PartitionedStrategy.js";
import {
  BlockingBacklogRejection,
  type Waiter,
} from "../allocation-unavailable-strategies/BlockingBacklogRejection.js";
import { DelayedRejectStrategy } from "../allocation-unavailable-strategies/DelayedRejectStrategy.js";
import { DelayedThenBlockingRejection } from "../allocation-unavailable-strategies/DelayedThenBlockingRejection.js";

export function makePartitionedLifoBlockingLimiter<
  ContextT,
  PartitionName extends string = string,
>(options: {
  partitionResolver: (context: ContextT) => PartitionName | undefined;
  partitions: Record<PartitionName, PartitionConfig & { delayMs?: number }>;
  limiter?: Omit<LimiterOptions<ContextT>, "acquireStrategy">;
  maxConcurrentDelays?: number;
  backlogSize?: number;
  backlogTimeout?: number | ((context: ContextT) => number);
}): Limiter<ContextT> {
  const limit = options.limiter?.limit ?? Limiter.makeDefaultLimit();
  const delayByPartition = new Map(
    Object.entries(options.partitions).map(([name, cfg]) => [
      name satisfies string as PartitionName,
      (cfg as { delayMs?: number }).delayMs ?? 0,
    ]),
  );

  return new Limiter<ContextT>({
    ...options.limiter,
    limit,
    acquireStrategy: new PartitionedStrategy<ContextT, PartitionName>({
      partitionResolver: options.partitionResolver,
      partitions: options.partitions,
      initialLimit: limit.currentLimit,
      metricRegistry: options.limiter?.metricRegistry,
    }),
    allotmentUnavailableStrategy: new DelayedThenBlockingRejection<ContextT>({
      delayStrategy: new DelayedRejectStrategy<ContextT>({
        delayMsForContext: (context) => {
          const partition = options.partitionResolver(context);
          return partition === undefined
            ? 0
            : (delayByPartition.get(partition) ?? 0);
        },
        maxConcurrentDelays: options.maxConcurrentDelays,
      }),
      blockingStrategy: new BlockingBacklogRejection({
        backlogSize: options.backlogSize ?? 100,
        backlogTimeout: options.backlogTimeout ?? 1_000,
        enqueueOptions: { direction: "front" },
        queue: new LinkedWaiterQueue<Waiter<ContextT>>(),
      }),
    }),
  });
}
