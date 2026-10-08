// Freshness and provider-health policy for GSTIN verification. EVERY value is a configuration input, not a fact:
// what a real provider's terms permit (how long a result may be reused, whether it may be stored at all, call budgets) is UNVERIFIED
// until a provider is chosen. Tighten these to the contract before launch.
export interface VerificationPolicy {
  /** A stored answer younger than this is served as-is with no provider call. */
  freshMs: number;
  /** Between freshMs and this, an answer is served instantly as "stale" and a refresh is recommended. Older than this, a live check is required. */
  staleUsableMs: number;
  /** Rolling window used to judge provider health. */
  healthWindowMs: number;
  healthMaxSamples: number;
  /** Don't judge on fewer samples than this. */
  healthMinSamples: number;
  /** Failure share at or above which the provider is "degraded". */
  degradedFailureRate: number;
  /** Live p95 latency at or above which the provider is "degraded". */
  degradedP95Ms: number;
  /** Consecutive provider failures that mark it "down". */
  downConsecutiveFailures: number;
  /** After the last failure, "down" relaxes to "degraded" so recovery can be observed. */
  downHoldMs: number;
  /** While "down", an explicit user-requested live check may probe the provider at most this often. */
  probeIntervalMs: number;
  verified: false;
}

const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export function verificationPolicy(env: Record<string, string | undefined> = process.env): VerificationPolicy {
  const freshMs = num(env.VERIFY_FRESH_MS, 24 * 3600_000);
  return {
    freshMs,
    staleUsableMs: Math.max(freshMs, num(env.VERIFY_STALE_USABLE_MS, 7 * 24 * 3600_000)),
    healthWindowMs: num(env.VERIFY_HEALTH_WINDOW_MS, 5 * 60_000),
    healthMaxSamples: Math.floor(num(env.VERIFY_HEALTH_MAX_SAMPLES, 30)),
    healthMinSamples: Math.floor(num(env.VERIFY_HEALTH_MIN_SAMPLES, 5)),
    degradedFailureRate: Math.min(1, num(env.VERIFY_DEGRADED_FAILURE_RATE, 0.3)),
    degradedP95Ms: num(env.VERIFY_DEGRADED_P95_MS, 6_000),
    downConsecutiveFailures: Math.floor(num(env.VERIFY_DOWN_CONSECUTIVE, 5)),
    downHoldMs: num(env.VERIFY_DOWN_HOLD_MS, 30_000),
    probeIntervalMs: num(env.VERIFY_PROBE_INTERVAL_MS, 10_000),
    verified: false,
  };
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = verificationPolicy({});
