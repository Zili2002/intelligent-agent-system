import {
  isTransientError,
  withRetry as withSharedRetry,
} from "@intelligent-agent/shared";
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
  return withSharedRetry(operation, policy, {
    ...options,
    isRetryable: isRetryableError,
  });
}

export function isRetryableError(error: Error): boolean {
  return isTransientError(error);
}
