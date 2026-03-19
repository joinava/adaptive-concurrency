import {
  whenAcquireSettled,
  type LimitAllotment,
  type Limiter,
} from "adaptive-concurrency";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Minimal request interface compatible with Node.js IncomingMessage,
 * Express Request, and similar frameworks.
 */
export interface HttpRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Minimal response interface compatible with Node.js ServerResponse,
 * Express Response, and similar frameworks.
 */
export interface HttpResponse {
  statusCode: number;
  end(data?: string): void;
  setHeader?(name: string, value: string): void;
}

export type NextFunction = (err?: unknown) => void;

export interface ConcurrencyLimitMiddlewareOptions {
  /**
   * HTTP status code to return when the concurrency limit has been reached.
   * Default: 429
   */
  throttleStatus?: number;

  /**
   * Response body to send when the concurrency limit has been reached.
   * Default: "Concurrency limit exceeded"
   */
  throttleMessage?: string;
}

/**
 * HTTP middleware that enforces concurrency limits on incoming requests.
 * Returns HTTP 429 Too Many Requests when the limit has been reached.
 *
 * Compatible with Express, Connect, and any middleware framework that uses
 * the (req, res, next) signature.
 *
 * Ported from Netflix's ConcurrencyLimitServletFilter.
 *
 * @see HttpLimiterBuilder for building a limiter with partition support
 */
export function concurrencyLimitMiddleware(
  limiter: Limiter<HttpRequest>,
  options: ConcurrencyLimitMiddlewareOptions = {},
): (req: HttpRequest, res: HttpResponse, next: NextFunction) => void {
  const throttleStatus = options.throttleStatus ?? 429;
  const throttleMessage = options.throttleMessage ?? "Concurrency limit exceeded";

  return (req: HttpRequest, res: HttpResponse, next: NextFunction) => {
    whenAcquireSettled(limiter.acquire({ context: req }), (allotment: LimitAllotment | undefined) => {
      if (allotment) {
        try {
          next();
          allotment.reportSuccess();
        } catch (e) {
          allotment.reportIgnore();
          throw e;
        }
      } else {
        res.statusCode = throttleStatus;
        res.end(throttleMessage);
      }
    });
  };
}
