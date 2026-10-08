import { describe, it, expect } from "vitest";
import { ANNUAL_MONTHS_PAID, cheapestPlan, computeBill, previewAddClient, quoteAll } from "@/lib/pricing";
import { PLANS, PLAN_IDS, type PlanId } from "@/config/plans";

const monthly = (p: PlanId, n: number) => computeBill(p, n, "monthly").totalInr;
const annual = (p: PlanId, n: number) => computeBill(p, n, "annual").totalInr;

describe("plan data (the owner's model)", () => {
  it("base prices, included clients, extra-client rates and fair-use allowances", () => {
    const row = (id: PlanId) => { const p = PLANS[id]; return [p.monthlyPriceInr, p.annualPriceInr, p.includedClients, p.extraClientInr, p.userLimit, p.monthlyChecks]; };
    expect(row("free")).toEqual([0, 0, 5, null, 1, 10]);
    expect(row("starter")).toEqual([499, 4999, 25, 18, 1, 100]);
    expect(row("professional")).toEqual([999, 9999, 50, 12, 3, 500]);
    expect(row("firm")).toEqual([1999, 19999, 150, 8, 10, 2000]);
    expect(row("enterprise")).toEqual([null, null, null, null, null, null]);
  });
});

describe("monthly bill = base + extra active clients × rate", () => {
  it("never charges below the included count", () => {
    for (const n of [0, 1, 10, 25]) expect(monthly("starter", n)).toBe(499);
    for (const n of [0, 25, 50]) expect(monthly("professional", n)).toBe(999);
    for (const n of [0, 100, 150]) expect(monthly("firm", n)).toBe(1999);
  });
  it("Professional: the worked examples", () => {
    const t: Record<number, number> = { 10: 999, 25: 999, 50: 999, 60: 1119, 80: 1359, 100: 1599, 150: 2199, 200: 2799, 500: 6399 };
    for (const [n, total] of Object.entries(t)) expect(monthly("professional", Number(n))).toBe(total);
  });
  it("Starter at ₹18 stays above Professional once past ~50 clients, so Professional is the obvious upgrade", () => {
    const t: Record<number, [number, number]> = { 10: [499, 999], 25: [499, 999], 40: [769, 999], 50: [949, 999], 60: [1129, 1119], 80: [1489, 1359], 100: [1849, 1599], 150: [2749, 2199], 200: [3649, 2799] };
    for (const [n, [s, p]] of Object.entries(t)) { expect(monthly("starter", Number(n))).toBe(s); expect(monthly("professional", Number(n))).toBe(p); }
    // the crossover: Starter is cheaper up to 50 clients, Professional from 60 (51..59 is a deliberate near-tie)
    expect(monthly("starter", 50)!).toBeLessThan(monthly("professional", 50)!);
    expect(monthly("starter", 60)!).toBeGreaterThan(monthly("professional", 60)!);
  });
  it("Firm: flat to 150 clients, then ₹8 each", () => {
    expect([monthly("firm", 150), monthly("firm", 160), monthly("firm", 200)]).toEqual([1999, 2079, 2399]);
  });
  it("is monotonic in the client count for every priced plan", () => {
    for (const id of ["starter", "professional", "firm"] as const) { let prev = 0; for (let n = 0; n <= 400; n++) { const t = monthly(id, n)!; expect(t).toBeGreaterThanOrEqual(prev); prev = t; } }
  });
});

describe("annual bill: published annual base + 10 months of overage per extra client", () => {
  it("equals the base when no extra clients", () => {
    expect(annual("starter", 25)).toBe(4999); expect(annual("professional", 50)).toBe(9999); expect(annual("firm", 150)).toBe(19999);
  });
  it("Professional at 80 clients: 9,999 + 30 × 12 × 10 = 13,599 (≈ ₹1,133/mo vs ₹1,359 monthly)", () => {
    const b = computeBill("professional", 80, "annual");
    expect(ANNUAL_MONTHS_PAID).toBe(10);
    expect(b).toMatchObject({ baseInr: 9999, extraInr: 3600, totalInr: 13599, perMonthInr: 1133, extraClients: 30 });
    expect(b.annualSavingInr).toBe(1359 * 12 - 13599); // 2,709: always cheaper than 12 monthly payments
  });
  it("is always cheaper than twelve monthly payments, and the discount is about 2 months", () => {
    for (const id of ["starter", "professional", "firm"] as const) for (const n of [0, 30, 60, 100, 250, 1000]) {
      const m = monthly(id, n)! * 12, a = annual(id, n)!; expect(a).toBeLessThan(m); expect((m - a) / m).toBeGreaterThan(0.1); expect((m - a) / m).toBeLessThan(0.18);
    }
  });
});

describe("hard-capped and custom plans", () => {
  it("Free is ₹0 up to its 5 clients; beyond that it is over its cap, not billed", () => {
    expect(computeBill("free", 5, "monthly")).toMatchObject({ totalInr: 0, overCap: false, extraClients: 0 });
    expect(computeBill("free", 6, "monthly")).toMatchObject({ totalInr: 0, overCap: true, extraClients: 1 });
    expect(computeBill("free", 3, "annual").totalInr).toBe(0);
  });
  it("Enterprise is custom: no amounts", () => {
    expect(computeBill("enterprise", 500, "monthly")).toMatchObject({ custom: true, totalInr: null, baseInr: null, perMonthInr: null });
  });
  it("bad counts are treated as zero / floored, never NaN", () => {
    expect(computeBill("professional", -5, "monthly").activeClients).toBe(0);
    expect(computeBill("professional", Number.NaN, "monthly").totalInr).toBe(999);
    expect(computeBill("professional", 60.9, "monthly").extraClients).toBe(10);
  });
});

describe("previewAddClient — the 'your price will increase' warning", () => {
  it("free of charge inside the included count; the extra rate beyond it", () => {
    expect(previewAddClient("professional", 49, "monthly")).toEqual({ deltaInr: 0, newTotalInr: 999, blocked: false });
    expect(previewAddClient("professional", 80, "monthly")).toEqual({ deltaInr: 12, newTotalInr: 1371, blocked: false }); // the example in the brief: 81st client → ₹1,371
    expect(previewAddClient("starter", 25, "monthly")).toMatchObject({ deltaInr: 18, newTotalInr: 517 });
  });
  it("annual: the delta is a year's worth (10 months)", () => {
    expect(previewAddClient("professional", 80, "annual")).toMatchObject({ deltaInr: 120, newTotalInr: 13719 });
  });
  it("Free at its cap is blocked; a paid plan is blocked only at its safety ceiling", () => {
    expect(previewAddClient("free", 5, "monthly")).toMatchObject({ blocked: true, blockedBy: "plan_cap" });
    expect(previewAddClient("free", 4, "monthly")).toMatchObject({ blocked: false, deltaInr: 0 });
    expect(previewAddClient("professional", PLANS.professional.clientLimit!, "monthly").blocked).toBe(true);
    expect(previewAddClient("professional", PLANS.professional.clientLimit! - 1, "monthly").blocked).toBe(false);
  });
  it("custom plans: no price change is quoted", () => { expect(previewAddClient("enterprise", 10, "monthly")).toEqual({ deltaInr: 0, newTotalInr: null, blocked: false }); });
});

describe("quotes and cheapest plan", () => {
  it("quoteAll prices every self-serve plan that can hold the count, cheapest first; omits custom and over-capacity plans", () => {
    expect(quoteAll(3, "monthly").map((q) => q.planId)).toEqual(["free", "starter", "professional", "firm"]);
    expect(quoteAll(10, "monthly").map((q) => q.planId)).not.toContain("free");
    expect(quoteAll(10, "monthly").map((q) => q.planId)).not.toContain("enterprise");
  });
  it("cheapest by price alone: Starter to 50, Professional 60-133, Firm from 134 (users and features differ, so this is a hint, not advice)", () => {
    const at = (n: number) => cheapestPlan(n, "monthly")!.planId;
    expect([at(3), at(40), at(50), at(60), at(100), at(133)]).toEqual(["free", "starter", "starter", "professional", "professional", "professional"]);
    expect([at(134), at(150), at(200)]).toEqual(["firm", "firm", "firm"]);
    expect(monthly("professional", 133)).toBeLessThanOrEqual(monthly("firm", 133)!);
    expect(monthly("professional", 134)).toBeGreaterThan(monthly("firm", 134)!);
  });
  it("the same ordering holds annually (crossover points move slightly)", () => {
    expect(cheapestPlan(10, "annual")!.planId).toBe("starter");
    expect(cheapestPlan(200, "annual")!.planId).toBe("firm");
  });
  it("every priced plan is covered by PLAN_IDS", () => { expect(PLAN_IDS.filter((id) => PLANS[id].monthlyPriceInr !== null)).toHaveLength(4); });
});
