// Core interfaces and Limiter
export type { AdaptiveLimit } from "./limit/StreamingLimit.js";
export type { LimitAllotment } from "./LimitAllotment.js";
export {
  Limiter,
  SemaphoreStrategy,
  whenAcquireSettled,
  withLimiter,
  type AcquireOptions,
  type AcquireResult,
  type AcquireStrategy,
  type AllotmentUnavailableStrategy,
  type AsyncAcquireResult,
  type LimitedFunction,
  type LimiterOptions,
  type LimiterState,
  type RunCallbackArgs,
  type SyncAcquireResult,
  type SyncLimiter,
} from "./Limiter.js";
export { ListenerSet } from "./ListenerSet.js";
export {
  MetricIds,
  NoopMetricRegistry,
  type Counter,
  type DistributionMetric,
  type GaugeMetric,
  type MetricRegistry,
} from "./MetricRegistry.js";
export {
  AdaptiveTimeoutError,
  dropped,
  ignore,
  isAdaptiveTimeoutError,
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
export { SettableLimit } from "./limit/SettableLimit.js";
export { TracingLimitDecorator } from "./limit/TracingLimitDecorator.js";
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
export { ExpMovingAverage } from "./statistics/ExpMovingAverage.js";
export { MinimumValue } from "./statistics/MinimumValue.js";
export type { StreamingStatistic } from "./statistics/StreamingStatistic.js";

// Sample window types
export { makeAverageSampleWindow } from "./limit/window/AverageSampleWindow.js";
export { createPercentileSampleWindow } from "./limit/window/PercentileSampleWindow.js";
export type { SampleWindow } from "./limit/window/SampleWindow.js";

// Limit functions
export { squareRoot, squareRootWithBaseline } from "./utils/index.js";

// Acquire strategies
export * from "./limiter/factories/index.js";
export {
  PartitionedStrategy,
  type PartitionConfig,
} from "./limiter/PartitionedStrategy.js";

// Rejection strategies
export {
  DelayedRejectStrategy,
  type DelayedRejectStrategyOptions,
} from "./limiter/DelayedRejectStrategy.js";
export { DelayedThenBlockingRejection } from "./limiter/DelayedThenBlockingRejection.js";
export { FifoBlockingRejection } from "./limiter/FifoBlockingRejection.js";
export {
  LifoBlockingRejection,
  type LifoBlockingRejectionOptions,
} from "./limiter/LifoBlockingRejection.js";
