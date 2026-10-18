import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Request, RequestHandler, Response } from "express";

export interface RateLimitPolicy {
  limit: number;
  windowMilliseconds: number;
  key: (request: Request, response: Response) => string | undefined;
  message: string;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

let requestsSincePrune = 0;

export function initializeRateLimitSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS api_rate_limits (
      key_hash TEXT PRIMARY KEY,
      window_started_at INTEGER NOT NULL,
      request_count INTEGER NOT NULL CHECK(request_count > 0)
    );
    CREATE INDEX IF NOT EXISTS api_rate_limits_window_idx
      ON api_rate_limits(window_started_at);
  `);
}

export function consumeRateLimit(
  database: DatabaseSync,
  key: string,
  limit: number,
  windowMilliseconds: number,
  timestamp: number,
): RateLimitResult {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(windowMilliseconds) ||
    windowMilliseconds < 1 ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  ) {
    throw new Error("Invalid rate limit configuration or timestamp");
  }
  const keyHash = createHash("sha256").update(key).digest("hex");
  requestsSincePrune += 1;
  if (requestsSincePrune >= 256) {
    database
      .prepare("DELETE FROM api_rate_limits WHERE window_started_at < ?")
      .run(timestamp - 24 * 60 * 60 * 1000);
    requestsSincePrune = 0;
  }
  const row = database
    .prepare(
      `INSERT INTO api_rate_limits (key_hash, window_started_at, request_count)
       VALUES (?, ?, 1)
       ON CONFLICT(key_hash) DO UPDATE SET
         window_started_at = CASE
           WHEN api_rate_limits.window_started_at + ? <= ?
           THEN excluded.window_started_at
           ELSE api_rate_limits.window_started_at
         END,
         request_count = CASE
           WHEN api_rate_limits.window_started_at + ? <= ?
           THEN 1
           ELSE api_rate_limits.request_count + 1
         END
       RETURNING window_started_at, request_count`,
    )
    .get(
      keyHash,
      timestamp,
      windowMilliseconds,
      timestamp,
      windowMilliseconds,
      timestamp,
    ) as { window_started_at: number; request_count: number };
  if (row.request_count <= limit) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil(
        (row.window_started_at + windowMilliseconds - timestamp) / 1000,
      ),
    ),
  };
}

export function createRateLimitMiddleware(
  database: DatabaseSync,
  now: () => number,
  policy: RateLimitPolicy,
): RequestHandler {
  return (request, response, next) => {
    const key = policy.key(request, response);
    if (key === undefined) {
      next();
      return;
    }
    const result = consumeRateLimit(
      database,
      key,
      policy.limit,
      policy.windowMilliseconds,
      now(),
    );
    if (!result.allowed) {
      response.setHeader("Retry-After", String(result.retryAfterSeconds));
      response.status(429).json({
        error: policy.message,
        retryAfterSeconds: result.retryAfterSeconds,
      });
      return;
    }
    next();
  };
}
