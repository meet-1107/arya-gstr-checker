import { describe, it, expect } from "vitest";
import {
  additionalClientCharge, additionalClients, ANNUAL_MONTHS_PAID, applyTax, billableClientCount, calculateBill, computeBill, divRoundHalfUp, extraClientRate, parseClientCount,
} from "@/lib/pricing";
import { PLANS, PLAN_IDS, type PlanId } from "@/config/plans";
import { MemoryStore } from "@/lib/store/memory";
import { ClientService } from "@/services/clients";
import { SubscriptionService } from "@/services/subscription";
import { CheckService } from "@/services/checks";
import { MockGstProvider } from "@/providers/mock";
import { ctxFor, gst, NOW, seedOrg } from "./helpers";

const m = (p: PlanId, n: number) => computeBill(p, n, "monthly");
const a = (p: PlanId, n: number) => computeBill(p, n, "annual");

describe("plan configuration (data-driven, consistent)", () => {
  it("matches the published table", () => {
    const row = (id: PlanId) => { const p = PLANS[id]; return [p.monthlyPriceInr, p.annualPriceInr, p.includedClients, p.extraClientInr, p.annualExtraClientInr]; };
    expect(row("free")).toEqual([0, 0, 5, null, null]);
    expect(row("starter")).toEqual([499, 4999, 25, 18, 180]);
    expect(row("professional")).toEqual([999, 9999, 50, 12, 120]);
    expect(row("firm")).toEqual([1999, 19999, 150, 8, 80]);
    expect(row("enterprise")).toEqual([null, null, null, null, null]);
  });
  it("annual overage is explicit data AND equals 10 × monthly (proposed rule, pending owner confirmation)", () => {
    for (const id of ["starter", "professional", "firm"] as const) expect(PLANS[id].annualExtraClientInr).toBe(PLANS[id].extraClientInr! * ANNUAL_MONTHS_PAID);
  });
  it("annual base is cheaper than 12 months, and the annual discount is the same two months on base and overage", () => {
    for (const id of ["starter", "professional", "firm"] as const) {
      const p = PLANS[id];
      expect(p.annualPriceInr!).toBeLessThan(p.monthlyPriceInr! * 12);
      expect(p.monthlyPriceInr! * 12 - p.annualPriceInr!).toBeGreaterThanOrEqual(p.monthlyPriceInr! * 1.9); // ≈ 2 months free on the base
      expect(p.extraClientInr! * 12 - p.annualExtraClientInr!).toBe(p.extraClientInr! * 2);                 // exactly 2 months free on overage
    }
  });
  it("tiers are ordered: price, included clients and checks rise; the per-extra-client rate falls", () => {
    const paid = ["starter", "professional", "firm"] as const;
    for (let i = 1; i < paid.length; i++) {
      const lo = PLANS[paid[i - 1]], hi = PLANS[paid[i]];
      expect(hi.monthlyPriceInr!).toBeGreaterThan(lo.monthlyPriceInr!); expect(hi.includedClients!).toBeGreaterThan(lo.includedClients!);
      expect(hi.monthlyChecks!).toBeGreaterThan(lo.monthlyChecks!); expect(hi.extraClientInr!).toBeLessThan(lo.extraClientInr!);
    }
  });
  it("free sells no overage; enterprise is entirely custom; included never exceeds the ceiling", () => {
    expect(PLANS.free).toMatchObject({ extraClientInr: null, annualExtraClientInr: null, clientLimit: PLANS.free.includedClients });
    expect(Object.values(PLANS.enterprise).filter((v) => v === null).length).toBeGreaterThanOrEqual(8);
    for (const id of PLAN_IDS) { const p = PLANS[id]; if (p.includedClients !== null && p.clientLimit !== null) expect(p.clientLimit).toBeGreaterThanOrEqual(p.includedClients); }
  });
  it("all prices and rates are whole rupees (so base, overage and totals never need intermediate rounding)", () => {
    for (const id of PLAN_IDS) for (const v of [PLANS[id].monthlyPriceInr, PLANS[id].annualPriceInr, PLANS[id].extraClientInr, PLANS[id].annualExtraClientInr]) if (v !== null) expect(Number.isInteger(v)).toBe(true);
  });
});

describe("monthly totals at the required client counts", () => {
  const cases: [PlanId, number, number][] = [
    ["starter", 0, 499], ["starter", 5, 499], ["starter", 25, 499], ["starter", 50, 949], ["starter", 80, 1489], ["starter", 150, 2749], ["starter", 200, 3649],
    ["professional", 0, 999], ["professional", 5, 999], ["professional", 25, 999], ["professional", 50, 999], ["professional", 80, 1359], ["professional", 150, 2199], ["professional", 200, 2799],
    ["firm", 0, 1999], ["firm", 5, 1999], ["firm", 25, 1999], ["firm", 50, 1999], ["firm", 80, 1999], ["firm", 150, 1999], ["firm", 200, 2399],
    ["free", 0, 0], ["free", 5, 0],
  ];
  it.each(cases)("%s with %i active clients = ₹%i", (plan, n, total) => { expect(m(plan, n).totalInr).toBe(total); });
  it("included-client boundary and the first additional client", () => {
    expect(m("starter", 25)).toMatchObject({ extraClients: 0, extraInr: 0, totalInr: 499 });
    expect(m("starter", 26)).toMatchObject({ extraClients: 1, extraInr: 18, totalInr: 517 });
    expect(m("professional", 51)).toMatchObject({ extraClients: 1, extraInr: 12, totalInr: 1011 });
    expect(m("firm", 151)).toMatchObject({ extraClients: 1, extraInr: 8, totalInr: 2007 });
    expect(a("starter", 26)).toMatchObject({ extraClients: 1, extraInr: 180, totalInr: 5179 });
  });
});

describe("annual totals", () => {
  it("base at/below the allowance is the published annual price", () => {
    expect([a("starter", 25).totalInr, a("professional", 50).totalInr, a("firm", 150).totalInr]).toEqual([4999, 9999, 19999]);
  });
  it("annual overage uses the explicit annual rate (10 × monthly)", () => {
    expect(a("starter", 80)).toMatchObject({ baseInr: 4999, extraClients: 55, extraClientInr: 180, extraInr: 9900, totalInr: 14899 });
    expect(a("professional", 80)).toMatchObject({ extraClients: 30, extraClientInr: 120, extraInr: 3600, totalInr: 13599 });
    expect(a("firm", 200)).toMatchObject({ extraClients: 50, extraClientInr: 80, extraInr: 4000, totalInr: 23999 });
  });
  it("effective monthly equivalent: whole rupees for display, paise for exactness, rounded once at the end", () => {
    expect(a("professional", 80)).toMatchObject({ perMonthInr: 1133, perMonthExactInr: 1133.25 });       // 13,599 ÷ 12 = 1133.25
    expect(a("starter", 80)).toMatchObject({ perMonthInr: 1242, perMonthExactInr: 1241.58 });            // 14,899 ÷ 12 = 1241.5833…
    expect(a("firm", 200)).toMatchObject({ perMonthInr: 2000, perMonthExactInr: 1999.92 });              // 23,999 ÷ 12 = 1999.9166…
    expect(a("starter", 25).perMonthExactInr).toBe(416.58);                                              // 4,999 ÷ 12 = 416.5833…
    expect(m("starter", 80)).toMatchObject({ perMonthInr: 1489, perMonthExactInr: 1489 });
  });
  it("monthly vs annual: annual is always cheaper than twelve monthly bills, and the saving is reported", () => {
    for (const id of ["starter", "professional", "firm"] as const) for (const n of [0, 25, 50, 80, 150, 200]) {
      const mo = m(id, n).totalInr! * 12, an = a(id, n);
      expect(an.totalInr!).toBeLessThan(mo); expect(an.annualSavingInr).toBe(mo - an.totalInr!);
    }
    expect(a("professional", 80).annualSavingInr).toBe(1359 * 12 - 13599);
  });
  it("Free annual is ₹0 with no saving to claim", () => { expect(a("free", 5)).toMatchObject({ totalInr: 0, perMonthExactInr: 0, annualSavingInr: 0 }); });
});

describe("transparent breakdown", () => {
  it("itemised lines sum exactly to the total", () => {
    for (const id of PLAN_IDS) for (const n of [0, 5, 26, 80, 200]) for (const period of ["monthly", "annual"] as const) {
      const b = computeBill(id, n, period); if (b.custom || b.overCap) continue;
      expect(b.lines.reduce((s, l) => s + l.amountInr, 0)).toBe(b.totalInr);
      for (const l of b.lines) expect(l.amountInr).toBe(l.quantity * l.unitInr);
    }
    expect(m("professional", 80).lines.map((l) => [l.key, l.quantity, l.unitInr, l.amountInr])).toEqual([["base", 1, 999, 999], ["additional_clients", 30, 12, 360]]);
    expect(m("professional", 50).lines).toHaveLength(1);                         // no additional-clients line when there are none
  });
  it("additional-client charge on its own", () => {
    expect(additionalClientCharge("professional", 80, "monthly")).toEqual({ extraClients: 30, rateInr: 12, chargeInr: 360 });
    expect(additionalClientCharge("professional", 80, "annual")).toEqual({ extraClients: 30, rateInr: 120, chargeInr: 3600 });
    expect(additionalClientCharge("professional", 50, "monthly").chargeInr).toBe(0);
    expect(additionalClientCharge("free", 5, "monthly")).toEqual({ extraClients: 0, rateInr: null, chargeInr: 0 });
    expect(additionalClientCharge("enterprise", 500, "monthly")).toEqual({ extraClients: 0, rateInr: null, chargeInr: null });
    expect(additionalClients("starter", 24)).toBe(0); expect(additionalClients("starter", 30)).toBe(5);
    expect(extraClientRate("starter", "annual")).toBe(180);
  });
});

describe("archived clients are not billable", () => {
  it("billableClientCount ignores archived records", () => {
    const list = [{ status: "active" }, { status: "archived" }, {}, { status: "active" }, { status: "archived" }];
    expect(billableClientCount(list)).toBe(3);
    expect(billableClientCount([])).toBe(0);
  });
  it("the bill follows the active count only (service level)", async () => {
    const store = new MemoryStore(), clients = new ClientService(store, () => NOW), subs = new SubscriptionService(store, () => NOW);
    await seedOrg(store, "st", "starter");
    const O = ctxFor("st", "OWNER"); const made = [];
    for (let i = 1; i <= 27; i++) made.push(await clients.create(O, { name: `C${i}`, gstin: gst(i) }));
    expect((await subs.overview(O)).pricing.bill).toMatchObject({ activeClients: 27, extraClients: 2, totalInr: 499 + 2 * 18 });
    await clients.archive(O, made[0].id); await clients.archive(O, made[1].id);
    expect((await subs.overview(O)).pricing.bill).toMatchObject({ activeClients: 25, extraClients: 0, totalInr: 499 });
  });
});

describe("Free plan limits", () => {
  it("₹0 up to the 5 included; the strict calculator rejects a 6th, in both periods", () => {
    for (const period of ["monthly", "annual"] as const) {
      expect(calculateBill("free", 5, period)).toMatchObject({ ok: true, bill: { totalInr: 0 } });
      expect(calculateBill("free", 6, period)).toMatchObject({ ok: false, code: "PLAN_CLIENT_CAP" });
      expect(calculateBill("free", 200, period)).toMatchObject({ ok: false, code: "PLAN_CLIENT_CAP" });
    }
    expect(computeBill("free", 6, "monthly")).toMatchObject({ overCap: true, totalInr: 0, extraInr: 0 });     // display helper reports it, never bills it
  });
});

describe("invalid client counts", () => {
  it("the strict calculator rejects negative, fractional, non-finite and non-numeric input", () => {
    for (const bad of [-1, -0.5, 1.5, 25.0001, Number.NaN, Infinity, -Infinity, "5", null, undefined, {}, true]) {
      expect(calculateBill("professional", bad, "monthly")).toMatchObject({ ok: false, code: "INVALID_CLIENT_COUNT" });
    }
    expect(calculateBill("professional", 0, "monthly")).toMatchObject({ ok: true });
    expect(parseClientCount(3)).toEqual({ ok: true, count: 3 }); expect(parseClientCount(2.5).ok).toBe(false);
  });
  it("the display helper (computeBill) keeps its documented lenient behaviour and never returns NaN", () => {
    expect(computeBill("professional", -5, "monthly")).toMatchObject({ activeClients: 0, totalInr: 999 });
    expect(computeBill("professional", Number.NaN, "monthly").totalInr).toBe(999);
    expect(computeBill("professional", Infinity, "monthly").totalInr).toBe(999);
    expect(computeBill("professional", 60.9, "monthly")).toMatchObject({ activeClients: 60, extraClients: 10, totalInr: 1119 });
  });
});

describe("Enterprise / custom pricing", () => {
  it("returns a custom bill with no amounts and no tax, never a made-up price", () => {
    for (const period of ["monthly", "annual"] as const) {
      const r = calculateBill("enterprise", 500, period);
      expect(r).toMatchObject({ ok: true, bill: { custom: true, baseInr: null, extraInr: null, totalInr: null, perMonthInr: null, perMonthExactInr: null, lines: [], tax: { status: "undecided" } } });
    }
    expect(additionalClientCharge("enterprise", 1, "annual").chargeInr).toBeNull();
  });
});

describe("currency rounding", () => {
  it("integer half-up division", () => {
    expect([divRoundHalfUp(1, 2), divRoundHalfUp(3, 2), divRoundHalfUp(5, 12), divRoundHalfUp(6, 12), divRoundHalfUp(17, 12), divRoundHalfUp(0, 12)]).toEqual([1, 2, 0, 1, 1, 0]);
  });
  it("a half-paisa rounds up, once, in tax", () => {
    expect(applyTax(1, { pricesIncludeGst: false, gstRatePercent: 12.5 })).toMatchObject({ taxInr: 0.13, grossInr: 1.13 }); // 12.5 paise → 13
    expect(applyTax(3, { pricesIncludeGst: false, gstRatePercent: 5 })).toMatchObject({ taxInr: 0.15, grossInr: 3.15 });
  });
  it("no floating-point drift on awkward totals", () => {
    for (let t = 0; t <= 100_000; t += 7) { const p = divRoundHalfUp(t * 100, 12); expect(Number.isInteger(p)).toBe(true); expect(Math.abs(p / 100 - t / 12)).toBeLessThanOrEqual(0.005 + 1e-9); }
  });
});

describe("tax is configurable and undecided by default", () => {
  it("bills carry no tax amounts until a policy is set", () => {
    expect(m("professional", 80).tax).toEqual({ status: "undecided" });
    expect(applyTax(999)).toEqual({ status: "undecided" });
    expect(applyTax(999, { pricesIncludeGst: true, gstRatePercent: null })).toEqual({ status: "undecided" });
    expect(applyTax(999, { pricesIncludeGst: null, gstRatePercent: 18 })).toEqual({ status: "undecided" });
    expect(applyTax(null, { pricesIncludeGst: false, gstRatePercent: 18 })).toEqual({ status: "undecided" });
  });
  it("exclusive: GST is added on top; inclusive: GST is carved out of the price", () => {
    expect(applyTax(999, { pricesIncludeGst: false, gstRatePercent: 18 })).toEqual({ status: "applied", treatment: "exclusive", ratePercent: 18, netInr: 999, taxInr: 179.82, grossInr: 1178.82 });
    expect(applyTax(1178.82, { pricesIncludeGst: true, gstRatePercent: 18 })).toMatchObject({ treatment: "inclusive", netInr: 999, taxInr: 179.82, grossInr: 1178.82 });
    expect(applyTax(999, { pricesIncludeGst: false, gstRatePercent: 0 })).toMatchObject({ taxInr: 0, grossInr: 999 });
  });
});

describe("live-check quotas are a separate meter", () => {
  it("running (and re-running) GST checks never changes the client-count bill", async () => {
    const store = new MemoryStore(), clients = new ClientService(store, () => NOW), subs = new SubscriptionService(store, () => NOW);
    await seedOrg(store, "st", "starter");
    const O = ctxFor("st", "OWNER"); const c = await clients.create(O, { name: "A", gstin: gst(1) });
    const before = (await subs.overview(O)).pricing.bill;
    const checks = new CheckService(store, new MockGstProvider({ now: () => NOW }), undefined, () => NOW);
    await checks.checkClient(O, c.id); await checks.checkClient(O, c.id, { force: true }); await checks.checkClient(O, c.id);   // live, live, cached
    const o = await subs.overview(O);
    expect(o.pricing.bill).toEqual(before);
    expect(o.usage.used).toBeGreaterThan(0);                                       // the quota meter moved; the bill did not
  });
});
