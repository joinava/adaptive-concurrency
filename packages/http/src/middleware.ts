import { type Limiter } from "adaptive-concurrency";

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
  once(event: "finish" | "close", listener: () => void): void;
  setHeader?(name: string, value: string): void;
}

export type NextFunction = (err?: unknown) => void;

export type CompletedResponseClassification = "success" | "ignore" | "dropped";

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

  /**
   * Determines how a completed response should be reported to the limiter.
   *
   * Defaults to:
   * - statusCode >= 500 => "dropped"
   * - statusCode >= 300 => "ignore"
   * - otherwise => "success"
   */
  classifyCompletedResponse?: (
    res: HttpResponse,
  ) => CompletedResponseClassification;
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
  const throttleMessage =
    options.throttleMessage ?? "Concurrency limit exceeded";
  const classifyCompletedResponse =
    options.classifyCompletedResponse ??
    ((response: HttpResponse): CompletedResponseClassification => {
      if (response.statusCode >= 500) return "dropped";
      if (response.statusCode >= 300) return "ignore";
      return "success";
    });

  return async (req: HttpRequest, res: HttpResponse, next: NextFunction) => {
    const allotment = await limiter.acquire({ context: req });

    if (!allotment) {
      res.statusCode = throttleStatus;
      res.end(throttleMessage);
      return;
    }

    let released = false;
    const releaseSuccess = async () => {
      if (released) return;
      released = true;
      await allotment.releaseAndRecordSuccess();
    };
    const releaseIgnore = async () => {
      if (released) return;
      released = true;
      await allotment.releaseAndIgnore();
    };
    const releaseDropped = async () => {
      if (released) return;
      released = true;
      await allotment.releaseAndRecordDropped();
    };

    let sawError = false;

    // Keep the permit for the full response lifetime.
    res.once("finish", () => {
      if (sawError) {
        releaseDropped().catch(() => {});
        return;
      }

      const classification = classifyCompletedResponse(res);
      if (classification === "success") {
        releaseSuccess().catch(() => {});
      } else if (classification === "ignore") {
        releaseIgnore().catch(() => {});
      } else {
        releaseDropped().catch(() => {});
      }
    });
    res.once("close", () => {
      releaseIgnore().catch(() => {});
    });

    try {
      next();
    } catch (e) {
      sawError = true;
      await releaseDropped();
      throw e;
    }
  };
}
