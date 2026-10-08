// Cost-control policy for PAID provider calls. Freshness and provider-health policy live in verification-policy.ts; this file is only
// about money: who may spend, how much, and whether results may be shared between customers.
// EVERY value is a commercial decision that depends on the chosen provider's contract (permitted caching/redistribution, credit pricing,
// rate limits). None is verified: the only provider in this repo is a mock. Defaults share nothing between organizations.
export interface CostPolicy {
  /** Share normalized results between organizations (central cache + cross-org in-flight de-duplication). OFF until the provider's terms allow it. */
  sharedCache: boolean;
  /** An explicit live refresh is ignored (stored answer served) when the stored answer is younger than this. 0 = off (an explicit live check always asks the provider); a few minutes stops refresh-button hammering. */
  minRefreshMs: number;
  /** Paid calls per organization (separate from the customer's billing quota). Bulk jobs are exempt from the per-minute cap (they are paced by the provider gate). */
  orgPerMinute: number;
  orgPerDay: number;
  /** Paid calls per UTC day across all organizations; 0 = unlimited. */
  globalPerDay: number;
  /** Credits available this calendar month as configured by the operator; null = unknown (credit protection disabled). NOT read from the provider. */
  monthlyCreditBudget: number | null;
  creditsPerCall: number;
  /** Remaining-budget fractions at which protection starts. */
  lowFraction: number;
  criticalFraction: number;
  /** Estimated INR per credit for the cost dashboard; null = not configured (no cost is invented). */
  costPerCreditInr: number | null;
  /** User ids allowed to read platform-wide provider spend (there is no platform-admin role). */
  operatorUids: string[];
  verified: false;
}

const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d; };
const opt = (v: string | undefined) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : null; };

export function costPolicy(env: Record<string, string | undefined> = process.env): CostPolicy {
  return {
    sharedCache: env.VERIFY_SHARED_CACHE === "on",
    minRefreshMs: num(env.VERIFY_MIN_REFRESH_MS, 0),
    orgPerMinute: num(env.VERIFY_ORG_PER_MINUTE, 120),
    orgPerDay: num(env.VERIFY_ORG_PER_DAY, 5000),
    globalPerDay: num(env.VERIFY_GLOBAL_PER_DAY, 0),
    monthlyCreditBudget: opt(env.PROVIDER_MONTHLY_CREDIT_BUDGET),
    creditsPerCall: num(env.PROVIDER_CREDITS_PER_CALL, 1) || 1,
    lowFraction: num(env.VERIFY_LOW_CREDIT_FRACTION, 0.2),
    criticalFraction: num(env.VERIFY_CRITICAL_CREDIT_FRACTION, 0.05),
    costPerCreditInr: opt(env.PROVIDER_COST_PER_CREDIT_INR),
    operatorUids: (env.OPERATOR_UIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    verified: false,
  };
}

export const DEFAULT_COST_POLICY: CostPolicy = costPolicy({});
