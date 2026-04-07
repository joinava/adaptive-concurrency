/**
 * Common metric ids used by the limiters and limit algorithms.
 *
 * `CALL_NAME` records outcomes for work that actually executed under a limiter
 * (status: `success`, `ignored`, `dropped`). `ACQUIRE_ATTEMPT_NAME` records
 * acquire outcomes (status: `succeeded`, `failed`, `bypassed`), including
 * failures from retry attempts.
 */
export const MetricIds = {
  LIMIT_NAME: "limit",
  CALL_NAME: "call",
  ACQUIRE_ATTEMPT_NAME: "acquire_attempt",
  INFLIGHT_NAME: "inflight",
  PARTITION_LIMIT_NAME: "limit.partition",
  MIN_RTT_NAME: "min_rtt",
  WINDOW_MIN_RTT_NAME: "min_window_rtt",
  WINDOW_QUEUE_SIZE_NAME: "queue_size",
  ACQUIRE_TIME_NAME: "acquire_time",
} as const;

/**
 * Listener to receive samples for a distribution.
 */
export interface DistributionMetric {
  addSample(value: number): void;
}

/**
 * A counter that can be incremented when an event occurs. Counters normally
 * translate into an actions-per-second metric.
 */
export interface Counter {
  increment(): void;
}

/** Opaque handle for a registered gauge (supplier is polled by the registry on flush). */
export interface Gauge {
  record(value: number): void;
}

/**
 * Simple abstraction for tracking metrics in the limiters.
 */
export interface MetricRegistry {
  /**
   * Register a sample distribution. Samples are added to the distribution via
   * the returned {@link DistributionMetric}. Will reuse an existing
   * {@link DistributionMetric} if the distribution already exists.
   *
   * @param id Metric identifier
   * @param tagNameValuePairs Pairs of tag name and tag value
   * @returns SampleListener for the caller to add samples
   */
  distribution(
    id: string,
    attributes?: Record<string, string>,
  ): DistributionMetric;

  /**
   * Register a gauge using the provided supplier. The supplier will be polled
   * whenever the gauge value is flushed by the registry.
   *
   * @param id Metric identifier
   * @param supplier Function that returns the current gauge value
   * @param tagNameValuePairs Pairs of tag name and tag value
   * @returns Registration handle for the gauge
   */
  gauge(id: string, attributes?: Record<string, string>): Gauge;

  /**
   * Create a counter that will be incremented when an event occurs.
   *
   * @param id Metric identifier
   * @param attributes Counter attributes/tags
   */
  counter(id: string, attributes?: Record<string, string>): Counter;
}

const NOOP_SAMPLE_LISTENER: DistributionMetric = { addSample() {} };
const NOOP_COUNTER: Counter = { increment() {} };
const NOOP_GAUGE: Gauge = { record() {} };

/**
 * No-op MetricRegistry that discards all metrics. Used as the default when
 * no registry is configured.
 */
export const NoopMetricRegistry: MetricRegistry = {
  distribution() {
    return NOOP_SAMPLE_LISTENER;
  },
  gauge() {
    return NOOP_GAUGE;
  },
  counter() {
    return NOOP_COUNTER;
  },
};
