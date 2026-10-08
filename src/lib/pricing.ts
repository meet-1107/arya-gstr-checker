// Pure bill calculator. No I/O, no clock, no payment provider: given a plan, an ACTIVE client-firm count and a billing period it returns
// what the model says the bill is. The same function drives the pricing page, the billing screen and the "adding a client" warning, so
// the numbers cannot drift apart.
//
// MONEY RULES
//  • Every rate and price in the plan config is a whole INR amount and every charge is count × rate, so base, overage and total are exact
//    integers: nothing is rounded on the way to a total.
//  • The only derived figures are the effective monthly equivalent of an annual bill (total ÷ 12) and tax. Those are rounded exactly once,
//    at the end, half-up, using integer arithmetic (paise), never floating-point multiplication. `perMonthInr` is whole rupees (for display);
//    `perMonthExactInr` is to the paisa.
//  • Amounts exclude tax unless the owner decides otherwise: see TAX_POLICY (undecided → no tax amounts are produced).
//  • Live GST-check quotas and per-check overage are a separate meter and never influence this bill; saved verification results cost nothing.
import { getPlan, PLAN_IDS, type PlanId } from "@/config/plans";
import { TAX_POLICY, type TaxPolicy } from "@/config/pricing-policy";

export type BillingPeriod = "monthly" | "annual";

/** Annual billing = 12 months for the price of 10. Documents the relationship pinned (by test) between each plan's monthly and annual overage rate. */
export const ANNUAL_MONTHS_PAID = 10;

// ---- rounding (integer-safe, half-up) --------------------------------------------------------------
/** round(numerator ÷ denominator), halves away from zero. Integer inputs only. */
export const divRoundHalfUp = (numerator: number, denominator: number): number => Math.floor((2 * numerator + denominator) / (2 * denominator));
export const roundInr = (amountInr: number): number => Math.floor(amountInr * 100 + 0.5 + 1e-9) / 100;

// ---- tax -----------------------------------------------------------------------------------------------
export type TaxBreakdown =
  | { status: "undecided" }
  | { status: "applied"; treatment: "exclusive" | "inclusive"; ratePercent: number; netInr: number; taxInr: number; grossInr: number };

/** Tax on a bill total under a policy. Undecided policy → no amounts (never an assumed rate). Rounded once, to the paisa, half-up. */
export function applyTax(totalInr: number | null, policy: TaxPolicy = TAX_POLICY): TaxBreakdown {
  const { pricesIncludeGst: incl, gstRatePercent: rate } = policy;
  if (totalInr === null || incl === null || rate === null || !Number.isFinite(rate) || rate < 0) return { status: "undecided" };
  const totalPaise = totalInr * 100, bp = Math.round(rate * 100); // rate in basis points: 18% → 1800
  if (incl) {
    const netPaise = divRoundHalfUp(totalPaise * 10_000, 10_000 + bp); // net = gross ÷ (1 + rate)
    return { status: "applied", treatment: "inclusive", ratePercent: rate, netInr: netPaise / 100, taxInr: (totalPaise - netPaise) / 100, grossInr: totalInr };
  }
  const taxPaise = divRoundHalfUp(totalPaise * bp, 10_000);
  return { status: "applied", treatment: "exclusive", ratePercent: rate, netInr: totalInr, taxInr: taxPaise / 100, grossInr: (totalPaise + taxPaise) / 100 };
}

// ---- bill ----------------------------------------------------------------------------------------------
export interface BillLine { key: "base" | "additional_clients"; label: string; quantity: number; unitInr: number; amountInr: number }

export interface Bill {
  planId: PlanId;
  period: BillingPeriod;
  /** Active (billable) client firms this bill was computed for. */
  activeClients: number;
  includedClients: number | null;
  extraClients: number;
  /** Per-month rate (monthly billing) or per-year rate (annual billing) charged for each additional client; the rate actually used. */
  extraClientInr: number | null;
  /** True for plans priced by contract; no amounts are produced. */
  custom: boolean;
  /** True when the count exceeds a hard cap (Free over its 5 included): the clients cannot be added, nothing is "billed". */
  overCap: boolean;
  /** Base fee for the period (monthly base, or the published annual price). */
  baseInr: number | null;
  /** Additional-client charge for the period. */
  extraInr: number | null;
  /** Total for the period (a month for monthly, a year for annual), before any tax. */
  totalInr: number | null;
  /** What it averages per month (annual total ÷ 12, rounded to whole rupees). Equals totalInr for monthly. */
  perMonthInr: number | null;
  /** Same as perMonthInr but to the paisa (half-up). */
  perMonthExactInr: number | null;
  /** Annual only: how much cheaper than paying the same plan monthly for 12 months. */
  annualSavingInr: number | null;
  /** Itemised lines that sum to totalInr. */
  lines: BillLine[];
  /** Tax on totalInr; `undecided` until the owner sets TAX_POLICY. */
  tax: TaxBreakdown;
}

/** The additional-client rate for a plan and period, or null when none is sold. */
export function extraClientRate(planId: PlanId, period: BillingPeriod): number | null {
  const p = getPlan(planId);
  return period === "monthly" ? p.extraClientInr : p.annualExtraClientInr;
}

/** Active clients above the included allowance (0 for custom plans and at/below the allowance). */
export function additionalClients(planId: PlanId, activeClients: number): number {
  const inc = getPlan(planId).includedClients;
  return inc === null ? 0 : Math.max(0, normalizeCount(activeClients) - inc);
}

export interface ExtraClientCharge { extraClients: number; rateInr: number | null; chargeInr: number | null }
/** The additional-client charge alone, for the period. chargeInr is null for custom plans, 0 where no overage is sold. */
export function additionalClientCharge(planId: PlanId, activeClients: number, period: BillingPeriod): ExtraClientCharge {
  const p = getPlan(planId);
  if (p.includedClients === null || p.monthlyPriceInr === null) return { extraClients: 0, rateInr: null, chargeInr: null };
  const extra = additionalClients(planId, activeClients), rate = extraClientRate(planId, period);
  return { extraClients: extra, rateInr: rate, chargeInr: rate === null ? 0 : extra * rate };
}

/** Lenient normalisation used by the display helpers: NaN/∞/negative → 0, fractions floored. Use `parseClientCount` where input must be rejected. */
const normalizeCount = (n: number): number => Math.max(0, Math.floor(Number.isFinite(n) ? n : 0));

export function computeBill(planId: PlanId, activeClients: number, period: BillingPeriod): Bill {
  const p = getPlan(planId);
  const n = normalizeCount(activeClients);
  const base: Bill = {
    planId, period, activeClients: n, includedClients: p.includedClients, extraClients: 0, extraClientInr: extraClientRate(planId, period),
    custom: false, overCap: false, baseInr: null, extraInr: null, totalInr: null, perMonthInr: null, perMonthExactInr: null, annualSavingInr: null,
    lines: [], tax: { status: "undecided" },
  };
  if (p.monthlyPriceInr === null || p.annualPriceInr === null || p.includedClients === null) return { ...base, custom: true };
  const extra = Math.max(0, n - p.includedClients);
  const baseInr = period === "monthly" ? p.monthlyPriceInr : p.annualPriceInr;
  const rate = extraClientRate(planId, period);
  const baseLine: BillLine = { key: "base", label: `${p.name} plan, ${period}`, quantity: 1, unitInr: baseInr, amountInr: baseInr };
  const finish = (extraInr: number, overCap: boolean): Bill => {
    const total = baseInr + extraInr;
    const perMonthExact = period === "monthly" ? total : divRoundHalfUp(total * 100, 12) / 100;
    const monthlyTotal = p.monthlyPriceInr! + extra * (p.extraClientInr ?? 0);
    return {
      ...base, extraClients: extra, overCap, baseInr, extraInr, totalInr: total,
      perMonthInr: period === "monthly" ? total : divRoundHalfUp(total, 12), perMonthExactInr: perMonthExact,
      annualSavingInr: period === "annual" ? monthlyTotal * 12 - total : null,
      lines: [baseLine, ...(rate !== null && extra > 0 ? [{ key: "additional_clients" as const, label: "Additional active clients", quantity: extra, unitInr: rate, amountInr: extraInr }] : [])],
      tax: applyTax(total),
    };
  };
  // No overage sold (Free): the included count is a hard cap, nothing extra is billed.
  if (rate === null) return finish(0, extra > 0);
  return finish(extra * rate, false);
}

// ---- strict entry point: reject bad input instead of coercing it ---------------------------------------
export type PricingErrorCode = "INVALID_CLIENT_COUNT" | "PLAN_CLIENT_CAP";
export type PriceResult = { ok: true; bill: Bill } | { ok: false; code: PricingErrorCode; message: string };

/** A client count must be a finite, non-negative integer. */
export function parseClientCount(n: unknown): { ok: true; count: number } | { ok: false; message: string } {
  if (typeof n !== "number" || !Number.isFinite(n)) return { ok: false, message: "Client count must be a finite number." };
  if (!Number.isInteger(n)) return { ok: false, message: "Client count must be a whole number." };
  if (n < 0) return { ok: false, message: "Client count cannot be negative." };
  return { ok: true, count: n };
}

/**
 * Price a plan for an active-client count, rejecting invalid counts (negative, fractional, NaN, ∞, non-numbers) and, on a hard-capped plan
 * (Free), counts above the included allowance. Custom (Enterprise) plans succeed with `custom: true` and no amounts.
 */
export function calculateBill(planId: PlanId, activeClients: unknown, period: BillingPeriod): PriceResult {
  const c = parseClientCount(activeClients);
  if (!c.ok) return { ok: false, code: "INVALID_CLIENT_COUNT", message: c.message };
  const bill = computeBill(planId, c.count, period);
  if (bill.overCap) return { ok: false, code: "PLAN_CLIENT_CAP", message: `The ${getPlan(planId).name} plan includes ${bill.includedClients} active clients and does not allow more. Upgrade to add clients.` };
  return { ok: true, bill };
}

/** Billable clients are the non-archived ones. (Archived clients never count toward a bill.) */
export const billableClientCount = (clients: Iterable<{ status?: string }>): number => {
  let n = 0;
  for (const c of clients) if (c.status !== "archived") n++;
  return n;
};

export interface AddClientPreview {
  /** Adding one more active client changes the bill by this much for the period (0 while inside the included count). */
  deltaInr: number;
  /** Total for the period after adding it. null for custom plans. */
  newTotalInr: number | null;
  /** "blocked" when the plan cannot take another client (hard cap). */
  blocked: boolean;
  /** Which limit blocks it, for the message. */
  blockedBy?: "plan_cap";
}

/** What happens to the bill if one more active client firm is added. Shown BEFORE it is added so there are no billing surprises. */
export function previewAddClient(planId: PlanId, activeClients: number, period: BillingPeriod): AddClientPreview {
  const p = getPlan(planId);
  const now = computeBill(planId, activeClients, period);
  if (now.custom) return { deltaInr: 0, newTotalInr: null, blocked: false };
  if (p.clientLimit !== null && activeClients + 1 > p.clientLimit) return { deltaInr: 0, newTotalInr: now.totalInr, blocked: true, blockedBy: "plan_cap" };
  const next = computeBill(planId, activeClients + 1, period);
  if (next.overCap) return { deltaInr: 0, newTotalInr: now.totalInr, blocked: true, blockedBy: "plan_cap" };
  return { deltaInr: (next.totalInr ?? 0) - (now.totalInr ?? 0), newTotalInr: next.totalInr, blocked: false };
}

export interface PlanQuote { planId: PlanId; bill: Bill }

/** Every self-serve plan priced for this client count, cheapest first. Plans that cannot hold the count (Free) or are custom are omitted. */
export function quoteAll(activeClients: number, period: BillingPeriod): PlanQuote[] {
  return PLAN_IDS
    .map((planId) => ({ planId, bill: computeBill(planId, activeClients, period) }))
    .filter((q) => !q.bill.custom && !q.bill.overCap && q.bill.totalInr !== null && !(getPlan(q.planId).clientLimit !== null && activeClients > getPlan(q.planId).clientLimit!))
    .sort((a, b) => (a.bill.totalInr! - b.bill.totalInr!) || (PLAN_IDS.indexOf(a.planId) - PLAN_IDS.indexOf(b.planId)));
}

/** The lowest-priced plan that can hold this many active clients. (Price only: plans also differ in users and features.) */
export const cheapestPlan = (activeClients: number, period: BillingPeriod): PlanQuote | null => quoteAll(activeClients, period)[0] ?? null;
