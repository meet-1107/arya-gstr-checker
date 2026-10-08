import { getPlan, WRITABLE_STATUSES, type PlanId, type SubscriptionStatus } from "@/config/plans";

export const TRIAL_DAYS = 14;

export interface SubscriptionFields {
  plan: PlanId;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt?: string;
  currentPeriodEnd?: string;
}

/**
 * Status as enforced by the backend. A trial that has passed its end date is treated as
 * expired even if no webhook/cron has flipped the stored value yet.
 * Data is never deleted on expiry; the workspace becomes read-only.
 */
export function effectiveStatus(s: SubscriptionFields, now = new Date()): SubscriptionStatus {
  if (s.subscriptionStatus === "trialing" && s.trialEndsAt && new Date(s.trialEndsAt) <= now) return "expired";
  if (s.subscriptionStatus === "cancelled" && s.currentPeriodEnd && new Date(s.currentPeriodEnd) > now) {
    return "active"; // cancelled but paid period not over: remains fully usable until period end
  }
  return s.subscriptionStatus;
}

export const isWritable = (s: SubscriptionFields, now = new Date()) =>
  WRITABLE_STATUSES.includes(effectiveStatus(s, now));

/** Annual saving vs 12 monthly payments, as a whole percentage. Computed, never hard-coded. */
export function annualSavingsPercent(plan: PlanId): number | null {
  const p = getPlan(plan);
  if (!p.monthlyPriceInr || p.annualPriceInr === null) return null;
  const yearly = p.monthlyPriceInr * 12;
  return Math.round(((yearly - p.annualPriceInr) / yearly) * 100);
}
