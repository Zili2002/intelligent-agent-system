import type { RetryPolicy } from "./types.js";

export interface RetryContext {
  attempt: number;
  delayMs: number;
  error: Error;
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  options: {
    sleep?: (milliseconds: number) => Promise<void>;
    onRetry?: (context: RetryContext) => Promise<void> | void;
  } = {},
): Promise<{ value: T; attempts: number }> {
  validatePolicy(policy);
  const sleep = options.sleep ?? delay;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return { value: await operation(attempt), attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt >= policy.maxAttempts || !isRetryableError(lastError)) {
        throw lastError;
      }
      const delayMs = Math.min(
        policy.maxDelayMs,
        policy.initialDelayMs * 2 ** (attempt - 1),
      );
      await options.onRetry?.({ attempt, delayMs, error: lastError });
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("Retry operation failed");
}

export function isRetryableError(error: Error): boolean {
  const message = `${error.name}: ${error.message}`.toLowerCase();
  if (
    /(approval|budget|safety|invalid|malformed|not configured|not allowed|collision|already completed|already running)/.test(
      message,
    )
  ) {
    return false;
  }
  return /(429|5\d\d|econnreset|econnrefused|etimedout|eai_again|fetch failed|socket hang up|temporar|timeout|docker.*connect)/.test(
    message,
  );
}

function validatePolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error("retry.maxAttempts must be a positive integer");
  }
  if (policy.initialDelayMs < 0 || policy.maxDelayMs < policy.initialDelayMs) {
    throw new Error("retry delay values are invalid");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
