import { describe, it, expect } from "vitest";
import { validateGstin, computeGstinChecksum, normalizeGstin } from "@/lib/gstin";
import { PLANS } from "@/config/plans";
import { can, assertCan, ForbiddenError } from "@/lib/permissions";
import { parseCsv, toCsv, sanitizeCell, analyzeImport, guessMapping } from "@/lib/csv";
import { dueDateFor, currentFinancialYear, returnPeriodsForFinancialYear } from "@/lib/dates";
import { classifyReturn, complianceIndicator } from "@/lib/compliance";
import { UsageService, MemoryUsageStore, UsageError } from "@/lib/usage";
import { withRetry, RateLimiter, runWithConcurrency } from "@/lib/resilience";
import { ProviderError } from "@/providers/types";
import { MockGstProvider } from "@/providers/mock";
import { createProvider } from "@/providers";

const mk = (base14: string) => base14 + computeGstinChecksum(base14);
const G1 = mk("24AAACC1206D1Z"); // well-formed, checksum generated
const G2 = mk("27AAPFU0939F1Z");

describe("GSTIN validation", () => {
  it("accepts valid and normalizes", () => {
    expect(validateGstin(` ${G1.toLowerCase()} `).valid).toBe(true);
    expect(normalizeGstin(" 24aa ")).toBe("24AA");
  });
  it("known real-format GSTIN passes checksum", () => {
    expect(validateGstin("27AAPFU0939F1ZV").valid).toBe(true); // published sample GSTIN
  });
  it("rejects bad length/format/checksum", () => {
    expect(validateGstin("")).toMatchObject({ valid: false, reason: "EMPTY" });
    expect(validateGstin("24AAA")).toMatchObject({ reason: "LENGTH" });
    expect(validateGstin("00AAACC1206D1ZX")).toMatchObject({ reason: "FORMAT" });
    const bad = G1.slice(0, 14) + (G1[14] === "A" ? "B" : "A");
    expect(validateGstin(bad)).toMatchObject({ reason: "CHECKSUM" });
  });
});

describe("plans", () => {
  it("matches spec values", () => {
    expect(PLANS.free).toMatchObject({ monthlyPriceInr: 0, includedClients: 5, extraClientInr: null, clientLimit: 5, monthlyChecks: 10, userLimit: 1 });
    expect(PLANS.starter).toMatchObject({ monthlyPriceInr: 499, annualPriceInr: 4999, includedClients: 25, extraClientInr: 18, monthlyChecks: 100, userLimit: 1 });
    expect(PLANS.professional).toMatchObject({ monthlyPriceInr: 999, annualPriceInr: 9999, includedClients: 50, extraClientInr: 12, monthlyChecks: 500, userLimit: 3 });
    expect(PLANS.firm).toMatchObject({ monthlyPriceInr: 1999, annualPriceInr: 19999, includedClients: 150, extraClientInr: 8, monthlyChecks: 2000, userLimit: 10 });
    expect(PLANS.enterprise).toMatchObject({ monthlyPriceInr: null, includedClients: null, extraClientInr: null, clientLimit: null });
    expect(PLANS.free.features.bulkChecks).toBe(false);
    expect(PLANS.enterprise.monthlyChecks).toBeNull();
    // Annual base is "about two months free"; the published prices are not exactly 10x monthly, so assert the intent: 14-17% cheaper than 12 months.
    for (const p of [PLANS.starter, PLANS.professional, PLANS.firm]) { const save = 1 - p.annualPriceInr! / (p.monthlyPriceInr! * 12); expect(save).toBeGreaterThan(0.14); expect(save).toBeLessThan(0.17); }
    // paid plans: the hard ceiling sits far above the included count (they bill extra clients, they do not block them)
    for (const p of [PLANS.starter, PLANS.professional, PLANS.firm]) expect(p.clientLimit!).toBeGreaterThan(p.includedClients! * 5);
  });
});

describe("permissions", () => {
  it("enforces matrix", () => {
    expect(can("VIEWER", "clients:write")).toBe(false);
    expect(can("VIEWER", "clients:read")).toBe(true);
    expect(can("ACCOUNTANT", "billing:manage")).toBe(false);
    expect(can("ADMIN", "billing:manage")).toBe(false);
    expect(can("ADMIN", "team:manage")).toBe(true);
    expect(can("ACCOUNTANT", "team:manage")).toBe(false);
    expect(can("OWNER", "org:delete")).toBe(true);
    expect(can(undefined, "clients:read")).toBe(false);
    expect(() => assertCan("VIEWER", "checks:run")).toThrow(ForbiddenError);
  });
});

describe("CSV", () => {
  it("parses quotes, CRLF, BOM", () => {
    const rows = parseCsv('﻿name,gstin\r\n"A, Inc","x""y"\r\n\r\nB,z\n');
    expect(rows).toEqual([["name", "gstin"], ["A, Inc", 'x"y'], ["B", "z"]]);
  });
  it("sanitizes formula injection on export", () => {
    for (const v of ["=CMD()", "+1", "-1", "@SUM(A1)"]) expect(sanitizeCell(v).startsWith("'")).toBe(true);
    expect(sanitizeCell("safe")).toBe("safe");
    expect(toCsv([["=1+1"]])).toBe(`"'=1+1"`);
  });
  it("analyzes import: valid / invalid / duplicate / existing", () => {
    const data = parseCsv(`client_name,gstin,email\nA,${G1},a@x.com\nB,${G1.toLowerCase()},\nC,BAD,\nD,${G2},\n`);
    const m = guessMapping(data[0]);
    expect(m).toMatchObject({ name: 0, gstin: 1, email: 2 });
    const a = analyzeImport(data, m as { gstin: number }, new Set([G2]));
    expect(a.counts).toEqual({ total: 4, valid: 1, invalid: 1, duplicate: 1, existing: 1 });
    expect(a.rows[0].line).toBe(2);
  });
});

describe("dates & compliance", () => {
  it("financial year and periods", () => {
    expect(currentFinancialYear(new Date("2026-10-06"))).toBe("2026-27");
    expect(currentFinancialYear(new Date("2027-02-01"))).toBe("2026-27");
    expect(returnPeriodsForFinancialYear("2026-27")[0]).toBe("042026");
    expect(returnPeriodsForFinancialYear("2026-27")[11]).toBe("032027");
  });
  it("due dates", () => {
    expect(dueDateFor("GSTR1", "082026", "MONTHLY").toISOString().slice(0, 10)).toBe("2026-09-11");
    expect(dueDateFor("GSTR3B", "122026", "MONTHLY").toISOString().slice(0, 10)).toBe("2027-01-20");
    expect(dueDateFor("GSTR1", "102026", "QUARTERLY").toISOString().slice(0, 10)).toBe("2027-01-13");
  });
  it("classifies returns", () => {
    const base = { returnType: "GSTR3B" as const, period: "082026", financialYear: "2026-27" };
    const now = new Date("2026-10-06");
    expect(classifyReturn({ ...base, status: "FILED", filingDate: "2026-09-18T00:00:00Z" }, "MONTHLY", now)).toBe("FILED_ON_TIME");
    expect(classifyReturn({ ...base, status: "FILED", filingDate: "2026-09-25T00:00:00Z" }, "MONTHLY", now)).toBe("FILED_LATE");
    expect(classifyReturn({ ...base, status: "NOT_FILED" }, "MONTHLY", now)).toBe("NOT_FILED");
    expect(classifyReturn({ ...base, period: "092026", status: "NOT_FILED" }, "MONTHLY", now)).toBe("PENDING");
    expect(classifyReturn({ ...base, status: "UNKNOWN" }, "MONTHLY", now)).toBe("UNKNOWN");
  });
  it("indicator never treats Unknown as inactive/bad", () => {
    expect(complianceIndicator({ gstinStatus: "Unknown", states: ["NOT_FILED"] })).toBe("Data Unavailable");
    expect(complianceIndicator({ gstinStatus: "Cancelled", states: [] })).toBe("High Attention");
    expect(complianceIndicator({ gstinStatus: "Active", states: ["FILED_ON_TIME"] })).toBe("Good");
    expect(complianceIndicator({ gstinStatus: "Active", states: ["NOT_FILED", "FILED_ON_TIME"] })).toBe("Needs Attention");
    expect(complianceIndicator({ gstinStatus: "Active", states: ["NOT_FILED", "NOT_FILED"] })).toBe("High Attention");
    expect(complianceIndicator({ gstinStatus: "Active", states: [] })).toBe("Data Unavailable");
  });
});

describe("usage quota", () => {
  const org = { organizationId: "o1", plan: "free" as const, status: "active" as const };
  it("never exceeds limit under 200 concurrent reservations", async () => {
    const svc = new UsageService(new MemoryUsageStore());
    const results = await Promise.allSettled(Array.from({ length: 200 }, () => svc.reserveCheck(org, "2026-10")));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(PLANS.free.monthlyChecks);
    expect((await svc.summary(org, "2026-10")).remaining).toBe(0);
  });
  it("blocks inactive subscriptions and supports refund", async () => {
    const svc = new UsageService(new MemoryUsageStore());
    await expect(svc.reserveCheck({ ...org, status: "cancelled" }, "2026-10")).rejects.toMatchObject({ code: "SUBSCRIPTION_INACTIVE" });
    await svc.reserveCheck(org, "2026-10");
    await svc.refund(org, "2026-10");
    expect((await svc.summary(org, "2026-10")).used).toBe(0);
    await expect(svc.reserveCheck({ ...org, status: "paused" }, "m")).rejects.toBeInstanceOf(UsageError);
  });
  it("enterprise has no numeric cap", async () => {
    const svc = new UsageService(new MemoryUsageStore());
    await svc.reserveCheck({ ...org, plan: "enterprise" }, "2026-10");
    expect((await svc.summary({ ...org, plan: "enterprise" }, "2026-10")).remaining).toBeNull();
  });
});

describe("resilience", () => {
  it("retries retryable errors only, with backoff", async () => {
    let n = 0;
    const waits: number[] = [];
    const r = await withRetry(async () => { if (++n < 3) throw new ProviderError("GST_PROVIDER_TIMEOUT", "t", true); return "ok"; },
      { retries: 3, baseMs: 100, maxMs: 1000, sleep: async (ms) => { waits.push(ms); } });
    expect(r).toBe("ok"); expect(n).toBe(3); expect(waits.length).toBe(2);
    let m = 0;
    await expect(withRetry(async () => { m++; throw new ProviderError("GST_PROVIDER_AUTH", "x", false); }, { retries: 3, baseMs: 1, maxMs: 1, sleep: async () => {} })).rejects.toThrow();
    expect(m).toBe(1);
  });
  it("rate limiter delays beyond limit", async () => {
    let t = 0; const waited: number[] = [];
    const rl = new RateLimiter(2, 1000, () => t, async (ms) => { waited.push(ms); t += ms; });
    await rl.acquire(); await rl.acquire(); await rl.acquire();
    expect(waited.length).toBe(1);
  });
  it("bounds concurrency", async () => {
    let active = 0, peak = 0;
    await runWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 5, async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 1)); active--; });
    expect(peak).toBeLessThanOrEqual(5);
  });
});

describe("providers", () => {
  it("mock is deterministic and reports source", async () => {
    const p = new MockGstProvider({ now: () => new Date("2026-10-06T00:00:00Z") });
    const a = await p.verifyGstin(G1), b = await p.verifyGstin(G1);
    expect(a.status).toBe(b.status); expect(a.source).toBe("mock");
    const h = await p.getReturnHistory(G1);
    expect(h.records.length).toBeGreaterThan(0);
  });
  it("mock failure maps to GST_PROVIDER_TIMEOUT", async () => {
    await expect(new MockGstProvider({ failFor: new Set([G1]) }).verifyGstin(G1)).rejects.toMatchObject({ code: "GST_PROVIDER_TIMEOUT" });
  });
  it("factory refuses mock in production and fails closed for unconfigured vendors", async () => {
    expect(() => createProvider({ GST_PROVIDER: "mock", NODE_ENV: "production" })).toThrow();
    const p = createProvider({ GST_PROVIDER: "gstinapi", NODE_ENV: "production" });
    await expect(p.verifyGstin(G1)).rejects.toMatchObject({ code: "GST_PROVIDER_NOT_CONFIGURED" });
  });
});
