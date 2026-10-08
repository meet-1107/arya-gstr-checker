// Single source of truth for subscription plans.
// PRICING MODEL (milestone 10): base fee + automatic charge per ACTIVE client firm above the included count. Archived clients are not billed.
// Prices/limits below are the owner's product decisions (not market-verified). Amounts are INR and exclude any taxes; tax handling is undecided.
export type PlanId = "free" | "starter" | "professional" | "firm" | "enterprise";

export interface PlanConfig {
  id: PlanId;
  name: string;
  monthlyPriceInr: number | null; // null = custom
  annualPriceInr: number | null;
  /** Active client firms covered by the base price. null = by contract (Enterprise). */
  includedClients: number | null;
  /** INR per month for each active client firm above includedClients (annual billing: 10 months' worth). null = no overage is sold (Free) or custom (Enterprise). */
  extraClientInr: number | null;
  /**
   * INR per YEAR for each active client above includedClients on annual billing. Explicit data, not derived at runtime.
   * PROPOSED, NOT YET CONFIRMED BY THE OWNER: 10 × the monthly rate (the same "two months free" as the base fee). A test pins this
   * relationship so changing one without the other is a deliberate act. null = no overage sold (Free) or custom (Enterprise).
   */
  annualExtraClientInr: number | null;
  /** GSTINs one client firm may hold (one per state registration). The billing unit is the client firm, not the GSTIN. null = by contract. */
  gstinsPerClient: number | null;
  /**
   * HARD ceiling on active client firms. Free: equals includedClients (upgrade to add more). Paid plans: an abuse/safety ceiling far above
   * what the included count suggests (placeholder values, not a commercial limit); everything between included and the ceiling is billed, not blocked.
   * null = by contract.
   */
  clientLimit: number | null;
  monthlyChecks: number | null;
  userLimit: number | null;
  overagePerCheckInr: number | null;
  historyDays: number;
  features: {
    bulkChecks: boolean;
    scheduledChecks: boolean;
    alerts: boolean;
    pdfReports: boolean;
    auditLog: boolean;
    clientAssignment: boolean;
    clientPortal: boolean;
    whiteLabel: boolean;
    webhooks: boolean;
  };
}

const off = {
  bulkChecks: false, scheduledChecks: false, alerts: false, pdfReports: false,
  auditLog: false, clientAssignment: false, clientPortal: false, whiteLabel: false, webhooks: false,
};
const starterF = { ...off, bulkChecks: true, alerts: true };
const proF = { ...starterF, scheduledChecks: true, pdfReports: true, auditLog: true, clientAssignment: true };
const firmF = { ...proF, clientPortal: true, whiteLabel: true, webhooks: true };

export const PLANS: Record<PlanId, PlanConfig> = {
  free: { id: "free", name: "Free", monthlyPriceInr: 0, annualPriceInr: 0, includedClients: 5, extraClientInr: null, annualExtraClientInr: null, gstinsPerClient: 1, clientLimit: 5, monthlyChecks: 10, userLimit: 1, overagePerCheckInr: null, historyDays: 30, features: off },
  starter: { id: "starter", name: "Starter", monthlyPriceInr: 499, annualPriceInr: 4999, includedClients: 25, extraClientInr: 18, annualExtraClientInr: 180, gstinsPerClient: 5, clientLimit: 1_000, monthlyChecks: 100, userLimit: 1, overagePerCheckInr: null, historyDays: 30, features: starterF },
  professional: { id: "professional", name: "Professional", monthlyPriceInr: 999, annualPriceInr: 9999, includedClients: 50, extraClientInr: 12, annualExtraClientInr: 120, gstinsPerClient: 10, clientLimit: 5_000, monthlyChecks: 500, userLimit: 3, overagePerCheckInr: 0.6, historyDays: 365, features: proF },
  firm: { id: "firm", name: "Firm", monthlyPriceInr: 1999, annualPriceInr: 19999, includedClients: 150, extraClientInr: 8, annualExtraClientInr: 80, gstinsPerClient: 25, clientLimit: 20_000, monthlyChecks: 2000, userLimit: 10, overagePerCheckInr: 0.45, historyDays: 365 * 3, features: firmF },
  enterprise: { id: "enterprise", name: "Enterprise", monthlyPriceInr: null, annualPriceInr: null, includedClients: null, extraClientInr: null, annualExtraClientInr: null, gstinsPerClient: null, clientLimit: null, monthlyChecks: null, userLimit: null, overagePerCheckInr: null, historyDays: 365 * 3, features: firmF },
};

export const PLAN_IDS = Object.keys(PLANS) as PlanId[];
export const getPlan = (id: PlanId): PlanConfig => PLANS[id];

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled" | "expired" | "paused";
// Statuses allowing new GST checks. Others are read-only (data is never deleted on cancel).
export const WRITABLE_STATUSES: SubscriptionStatus[] = ["trialing", "active", "past_due"];
