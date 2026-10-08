// Explicit infrastructure constraints for the GST provider (ISSUE-005).
// ALL values are environment-driven and UNVERIFIED for any real vendor until a contract/docs are confirmed.
export interface ProviderLimits {
  /** Sustained provider request budget. The spec claims 60/min for GSTIN API; unverified. */
  requestsPerMinute: number;
  /** Hard cap on simultaneous in-flight provider requests. */
  maxConcurrent: number;
  timeoutMs: number;
  retries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Consecutive retryable failures before the circuit opens ("provider unavailable"). */
  breakerFailureThreshold: number;
  breakerCooldownMs: number;
  /** Worker-side parallelism for bulk jobs (only useful up to maxConcurrent). */
  bulkConcurrency: number;
  verified: false;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export function providerLimits(env: Record<string, string | undefined> = process.env): ProviderLimits {
  return {
    requestsPerMinute: num(env.GST_RATE_LIMIT_PER_MIN, 60),
    maxConcurrent: num(env.GST_MAX_CONCURRENT, 5),
    timeoutMs: num(env.GST_TIMEOUT_MS, 15_000),
    retries: Math.floor(num(env.GST_RETRIES, 2)),
    backoffBaseMs: num(env.GST_BACKOFF_BASE_MS, 500),
    backoffMaxMs: num(env.GST_BACKOFF_MAX_MS, 8_000),
    breakerFailureThreshold: Math.floor(num(env.GST_BREAKER_THRESHOLD, 5)),
    breakerCooldownMs: num(env.GST_BREAKER_COOLDOWN_MS, 30_000),
    bulkConcurrency: Math.floor(num(env.BULK_CONCURRENCY, 5)),
    verified: false,
  };
}

/** Provider requests consumed by one GST check: verify = 1, return history = 1 (when included). */
export const providerRequestsPerCheck = (includeReturns: boolean) => (includeReturns ? 2 : 1);

/** Wall-clock estimate for N checks under the requests-per-minute cap (concurrency is not the bottleneck). */
export function estimateSeconds(checks: number, includeReturns: boolean, l: ProviderLimits): number {
  return Math.ceil((checks * providerRequestsPerCheck(includeReturns) * 60) / l.requestsPerMinute);
}
