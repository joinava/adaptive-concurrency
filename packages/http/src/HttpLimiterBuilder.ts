import {
  type AdaptiveLimit,
  Limiter,
  PartitionedStrategy,
  VegasLimit,
  type MetricRegistry,
  type PartitionConfig,
} from "adaptive-concurrency";
import type { HttpRequest } from "./middleware.js";

/**
 * Builder to simplify creating a Limiter specific to HTTP middleware.
 * By default, the same concurrency limit is shared by all requests.
 * The limiter can be partitioned based on request attributes.
 *
 * Ported from Netflix's ServletLimiterBuilder.
 */
export class HttpLimiterBuilder {
  private readonly resolvers: Array<(req: HttpRequest) => string | undefined> = [];
  private readonly partitions: Record<string, PartitionConfig> = {};
  private limit?: AdaptiveLimit;
  private name?: string;
  private metricRegistry?: MetricRegistry;
  private clock?: () => number;
  private bypassPredicate?: (req: HttpRequest) => boolean;

  /**
   * Partition the limit by header value.
   */
  partitionByHeader(headerName: string): this {
    this.resolvers.push((req) => {
      const val = req.headers[headerName.toLowerCase()];
      return typeof val === "string" ? val : undefined;
    });
    return this;
  }

  /**
   * Partition the limit by URL path. The provided mapping function transforms
   * the path into a partition group name.
   */
  partitionByPath(pathToGroup: (path: string) => string | undefined): this {
    this.resolvers.push((req) => {
      const url = req.url;
      if (!url) return undefined;
      // Extract path portion (before query string)
      const path = url.split("?")[0]!;
      return pathToGroup(path);
    });
    return this;
  }

  /**
   * Partition the limit by HTTP method (GET, POST, etc.).
   */
  partitionByMethod(): this {
    this.resolvers.push((req) => req.method?.toUpperCase());
    return this;
  }

  /**
   * Specify percentage of limit guarantees for a named partition.
   */
  partition(name: string, config: PartitionConfig): this {
    this.partitions[name] = config;
    return this;
  }

  /**
   * Add a bypass resolver. When the predicate returns true for a request,
   * the request bypasses the limiter entirely.
   */
  bypassResolver(predicate: (req: HttpRequest) => boolean): this {
    const prev = this.bypassPredicate;
    this.bypassPredicate = prev
      ? (req) => prev(req) || predicate(req)
      : predicate;
    return this;
  }

  /**
   * Bypass limit if the value of the specified header matches the provided value.
   */
  bypassLimitByHeader(headerName: string, value: string): this {
    return this.bypassResolver(
      (req) => req.headers[headerName.toLowerCase()] === value,
    );
  }

  /**
   * Bypass limit if the request method matches the specified method.
   */
  bypassLimitByMethod(method: string): this {
    return this.bypassResolver(
      (req) => req.method?.toUpperCase() === method.toUpperCase(),
    );
  }

  /**
   * Set the limit algorithm.
   */
  withLimit(limit: AdaptiveLimit): this {
    this.limit = limit;
    return this;
  }

  /**
   * Set the limiter name (used in metric tags).
   */
  named(name: string): this {
    this.name = name;
    return this;
  }

  /**
   * Set the metric registry.
   */
  withMetricRegistry(registry: MetricRegistry): this {
    this.metricRegistry = registry;
    return this;
  }

  /**
   * Set the clock function.
   */
  withClock(clock: () => number): this {
    this.clock = clock;
    return this;
  }

  /**
   * Build the limiter. If partitions and resolvers are configured, returns a
   * partitioned limiter; otherwise returns a simple limiter.
   */
  build(): Limiter<HttpRequest> {
    const adaptiveLimit = this.limit ?? new VegasLimit();
    const baseOptions = {
      limit: adaptiveLimit,
      ...(this.name !== undefined ? { name: this.name } : {}),
      ...(this.metricRegistry !== undefined ? { metricRegistry: this.metricRegistry } : {}),
      ...(this.clock !== undefined ? { clock: this.clock } : {}),
      ...(this.bypassPredicate !== undefined
        ? { bypassResolver: this.bypassPredicate }
        : {}),
    };

    const hasPartitions = Object.keys(this.partitions).length > 0;
    if (hasPartitions) {
      const resolvers = this.resolvers;
      const partitionResolver =
        resolvers.length === 0
          ? () => undefined
          : (req: HttpRequest) => {
              for (const r of resolvers) {
                const name = r(req);
                if (name != null) return name;
              }
              return undefined;
            };
      const partitionedOptions = {
        partitionResolver,
        partitions: this.partitions,
        initialLimit: adaptiveLimit.currentLimit,
        ...(this.metricRegistry !== undefined
          ? { metricRegistry: this.metricRegistry }
          : {}),
      };
      return new Limiter<HttpRequest>({
        ...baseOptions,
        acquireStrategy: new PartitionedStrategy(partitionedOptions),
      });
    }

    return new Limiter<HttpRequest>(baseOptions);
  }
}
