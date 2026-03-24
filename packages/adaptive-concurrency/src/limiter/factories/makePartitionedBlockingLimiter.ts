import { Limiter, type LimiterOptions } from "../../Limiter.js";
import {
  PartitionedStrategy,
  type PartitionConfig,
} from "../acquire-strategies/PartitionedStrategy.js";
import { DelayedRejectStrategy } from "../allocation-unavailable-strategies/DelayedRejectStrategy.js";
import { DelayedThenBlockingRejection } from "../allocation-unavailable-strategies/DelayedThenBlockingRejection.js";
import {
  FifoBlockingRejection,
  type FifoBlockingRejectionOptions,
} from "../allocation-unavailable-strategies/FifoBlockingRejection.js";

export function makePartitionedBlockingLimiter<
  ContextT,
  PartitionName extends string = string,
>(options: {
  partitionResolver: (context: ContextT) => PartitionName | undefined;
  partitions: Record<PartitionName, PartitionConfig & { delayMs?: number }>;
  limiter?: Omit<LimiterOptions<ContextT>, "acquireStrategy">;
  maxConcurrentDelays?: number;
  backlogSize?: FifoBlockingRejectionOptions<ContextT>["backlogSize"];
  backlogTimeout?: FifoBlockingRejectionOptions<ContextT>["backlogTimeout"];
}): Limiter<ContextT> {
  const limit = options.limiter?.limit ?? Limiter.makeDefaultLimit();
  const delayByPartition = new Map<PartitionName, number>(
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
        delayMsForContext(context) {
          const partition = options.partitionResolver(context);
          return partition === undefined
            ? 0
            : (delayByPartition.get(partition) ?? 0);
        },
        maxConcurrentDelays: options.maxConcurrentDelays,
      }),
      blockingStrategy: new FifoBlockingRejection<ContextT>({
        backlogSize: options.backlogSize,
        backlogTimeout: options.backlogTimeout,
      }),
    }),
  });
}
