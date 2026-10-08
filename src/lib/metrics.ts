// In-process verification metrics. HONEST LIMITS: per server instance, reset on restart, not exported anywhere.
// Good enough to see "the provider is failing right now" in one process; a real deployment needs a metrics backend.
import { FAILURE_OUTCOMES, type VerificationOutcome } from "./verification";

export interface VerificationSample {
  outcome: VerificationOutcome; durationMs: number; cached: boolean; at: number;
  /** Joined a live check already in flight (no extra provider call). */
  joined?: boolean;
  /** A stale stored answer was served instantly (stale-while-refresh). */
  staleServed?: boolean;
  /** This request itself sent a request to the provider. */
  providerCalled?: boolean;
}

export interface MetricsSnapshot {
  windowSize: number;
  total: number;
  /** Requests that reached a registry answer (live or cached) ÷ requests that were valid GSTINs. null when there is no data. */
  successRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  /** Latency of live (non-cached) provider calls only. */
  liveP50Ms: number | null;
  liveP95Ms: number | null;
  cacheHitRate: number | null;
  byOutcome: Partial<Record<VerificationOutcome, number>>;
  timeoutRate: number | null;
  providerErrorRate: number | null;
  invalidRate: number | null;
  notFoundRate: number | null;
  /** Requests in the window that actually reached the provider. */
  providerCalls: number;
  /** Valid-GSTIN requests answered WITHOUT a new provider call (stored result served, or joined an in-flight check). */
  callsAvoided: number;
  joined: number;
  staleServed: number;
}

const pct = (sorted: number[], p: number): number | null => {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
};
const ratio = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 10_000) / 10_000);

/** Ring buffer of the last `windowSize` samples per organization (counts are over that window, not all time). */
export class VerificationMetrics {
  private byOrg = new Map<string, VerificationSample[]>();
  constructor(private windowSize = 500) {}

  record(orgId: string, s: VerificationSample) {
    const a = this.byOrg.get(orgId) ?? [];
    a.push(s);
    if (a.length > this.windowSize) a.shift();
    this.byOrg.set(orgId, a);
  }

  snapshot(orgId: string): MetricsSnapshot {
    const a = this.byOrg.get(orgId) ?? [];
    const byOutcome: Partial<Record<VerificationOutcome, number>> = {};
    for (const s of a) byOutcome[s.outcome] = (byOutcome[s.outcome] ?? 0) + 1;
    const n = (...o: VerificationOutcome[]) => o.reduce((t, k) => t + (byOutcome[k] ?? 0), 0);
    const valid = a.length - n("INVALID_GSTIN");
    const failures = a.filter((s) => FAILURE_OUTCOMES.includes(s.outcome)).length;
    const lat = a.filter((s) => s.outcome !== "INVALID_GSTIN").map((s) => s.durationMs).sort((x, y) => x - y);
    const live = a.filter((s) => !s.cached && s.outcome !== "INVALID_GSTIN").map((s) => s.durationMs).sort((x, y) => x - y);
    return {
      windowSize: this.windowSize, total: a.length,
      successRate: ratio(valid - failures, valid),
      p50Ms: pct(lat, 50), p95Ms: pct(lat, 95), liveP50Ms: pct(live, 50), liveP95Ms: pct(live, 95),
      cacheHitRate: ratio(a.filter((s) => s.cached).length, valid),
      byOutcome,
      timeoutRate: ratio(n("TIMEOUT"), valid),
      providerErrorRate: ratio(n("PROVIDER_ERROR", "MAINTENANCE", "RATE_LIMITED"), valid),
      invalidRate: ratio(n("INVALID_GSTIN"), a.length),
      notFoundRate: ratio(n("NOT_FOUND"), valid),
      providerCalls: a.filter((x) => x.providerCalled).length,
      callsAvoided: a.filter((x) => x.outcome !== "INVALID_GSTIN" && (x.cached || x.joined)).length,
      joined: a.filter((x) => x.joined).length,
      staleServed: a.filter((x) => x.staleServed).length,
    };
  }
}
