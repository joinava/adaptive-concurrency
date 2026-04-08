// Core interfaces and Limiter
export type { AdaptiveLimit } from "./limit/StreamingLimit.js";
export type { LimitAllotment } from "./LimitAllotment.js";
export {
  Limiter,
  withLimiter,
  type AcquireOptions,
  type AcquireResult,
  type AcquireStrategy,
  type AllotmentUnavailableStrategy,
  type LimitedFunction,
  type LimiterOptions,
  type LimiterState,
  type MaybePromise,
  type RunCallbackArgs,
} from "./Limiter.js";
export { ListenerSet } from "./ListenerSet.js";
export {
  MetricIds,
  NoopMetricRegistry,
  type Counter,
  type DistributionMetric,
  type Gauge,
  type MetricRegistry,
} from "./MetricRegistry.js";
export {
  AdaptiveTimeoutError,
  dropped,
  ignore,
  isAdaptiveTimeoutError,
  isRunResult,
  QuotaNotAvailable,
  success,
  type RunDropped,
  type RunIgnore,
  type RunResult,
  type RunSuccess,
} from "./RunResult.js";

// Limit algorithms
export { AIMDLimit, type AIMDLimitOptions } from "./limit/AIMDLimit.js";
export { FixedLimit } from "./limit/FixedLimit.js";
export {
  GradientLimit,
  type Gradient2LimitOptions,
} from "./limit/GradientLimit.js";
export { GroupAwareLimit } from "./limit/GroupAwareLimit.js";
export { SettableLimit } from "./limit/SettableLimit.js";
export {
  VegasLimit,
  type VegasLimitOptions,
  type VegasLimitPolicy,
} from "./limit/VegasLimit.js";
export {
  WindowedLimit,
  type WindowedLimitOptions,
} from "./limit/WindowedLimit.js";

// Streaming statistics
export { DecayingHistogram } from "./statistics/DecayingHistogram.js";
export { ExpMovingAverage } from "./statistics/ExpMovingAverage.js";
export { MinimumValue } from "./statistics/MinimumValue.js";
export type { StreamingStatistic } from "./statistics/StreamingStatistic.js";

// Sample window types
export { makeAverageSampleWindow } from "./limit/window/AverageSampleWindow.js";
export { createPercentileSampleWindow } from "./limit/window/PercentileSampleWindow.js";
export type { SampleWindow } from "./limit/window/SampleWindow.js";

export {
  LinkedWaiterQueue,
  log10Scale,
  squareRoot,
  squareRootWithBaseline,
} from "./utils/index.js";

export * from "./limiter/factories/index.js";

// Acquire strategies
export {
  PartitionedStrategy,
  type PartitionConfig,
} from "./limiter/acquire-strategies/PartitionedStrategy.js";
export { SemaphoreStrategy } from "./limiter/acquire-strategies/SemaphoreStrategy.js";

// Rejection strategies
export {
  BlockingBacklogRejection,
  MAX_TIMEOUT,
  type BlockingBacklogRejectionOptions,
  type WaiterQueue,
} from "./limiter/allocation-unavailable-strategies/BlockingBacklogRejection.js";
export {
  DelayedRejectStrategy,
  type DelayedRejectStrategyOptions,
} from "./limiter/allocation-unavailable-strategies/DelayedRejectStrategy.js";
export { DelayedThenBlockingRejection } from "./limiter/allocation-unavailable-strategies/DelayedThenBlockingRejection.js";
