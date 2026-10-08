// Rolling provider health, learned from real verification attempts. Process-local (see metrics.ts for the same honest limits).
// Purpose: when the provider is struggling, stop spending calls on work nobody is waiting for, and stop sending bursts into a failing service.
import type { VerificationPolicy } from "@/config/verification-policy";

export type HealthState = "healthy" | "degraded" | "down";

export interface HealthSample { ok: boolean; ms: number; at: number }

export interface HealthSnapshot {
  state: HealthState;
  /** Why the state is not "healthy" (for logs and the UI). */
  reason?: "breaker_open" | "consecutive_failures" | "failure_rate" | "slow" | "recovering";
  samples: number;
  successRate: number | null;
  p95Ms: number | null;
  consecutiveFailures: number;
  lastFailureAt?: string;
}

const p95 = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
};

export class ProviderHealth {
  private samples: HealthSample[] = [];
  private consecutive = 0;
  private lastFailure = 0;
  private lastProbe = 0;
  constructor(private policy: VerificationPolicy, private now: () => number = Date.now, private breakerOpen: () => boolean = () => false) {}

  /** ok=true for any definite provider answer (including "no registration found"); ok=false for timeouts / outages / unusable responses. */
  record(ok: boolean, ms: number) {
    const at = this.now();
    this.samples.push({ ok, ms, at });
    if (this.samples.length > this.policy.healthMaxSamples) this.samples.shift();
    if (ok) this.consecutive = 0; else { this.consecutive++; this.lastFailure = at; }
  }

  snapshot(): HealthSnapshot {
    const t = this.now();
    const recent = this.samples.filter((s) => t - s.at <= this.policy.healthWindowMs);
    const fails = recent.filter((s) => !s.ok).length;
    const base = {
      samples: recent.length, successRate: recent.length ? Math.round(((recent.length - fails) / recent.length) * 10_000) / 10_000 : null,
      p95Ms: p95(recent.filter((s) => s.ok).map((s) => s.ms)), consecutiveFailures: this.consecutive,
      lastFailureAt: this.lastFailure ? new Date(this.lastFailure).toISOString() : undefined,
    };
    const p = this.policy;
    if (this.breakerOpen()) return { ...base, state: "down", reason: "breaker_open" };
    if (this.consecutive >= p.downConsecutiveFailures) {
      // Down for downHoldMs after the last failure, then "degraded" until a success is seen (so a probe can prove recovery).
      return t - this.lastFailure < p.downHoldMs ? { ...base, state: "down", reason: "consecutive_failures" } : { ...base, state: "degraded", reason: "recovering" };
    }
    if (recent.length >= p.healthMinSamples) {
      if (fails / recent.length >= p.degradedFailureRate) return { ...base, state: "degraded", reason: "failure_rate" };
      if (base.p95Ms !== null && base.p95Ms >= p.degradedP95Ms) return { ...base, state: "degraded", reason: "slow" };
    }
    return { ...base, state: "healthy" };
  }

  /** While "down", an explicit live check may probe at most once per probe interval. Returns true (and records the probe) if allowed. */
  tryProbe(): boolean {
    const t = this.now();
    if (t - this.lastProbe < this.policy.probeIntervalMs) return false;
    this.lastProbe = t;
    return true;
  }
}
