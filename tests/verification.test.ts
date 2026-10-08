import { PLANS } from "@/config/plans";
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { VerificationService, DEFAULT_VERIFY_OPTIONS } from "@/services/verification";
import { VerificationMetrics } from "@/lib/metrics";
import { ResilientProvider } from "@/providers/gate";
import { ProviderError, type GstinStatus } from "@/providers/types";
import { ForbiddenError } from "@/lib/permissions";
import { AppError } from "@/lib/errors";
import { UsageError, UsageService } from "@/lib/usage";
import { currentMonthKey } from "@/lib/dates";
import { ageLabel, classifyProviderError, EXPLANATIONS, FAILURE_OUTCOMES, INVALID_REASON_TEXT, outcomeFromStatus, type VerificationOutcome } from "@/lib/verification";
import { computeGstinChecksum } from "@/lib/gstin";
import { ctxFor, FAST_LIMITS, gst, NOW, seedOrg, StubProvider } from "./helpers";

let store: MemoryStore, provider: StubProvider, metrics: VerificationMetrics, clock: Date;
let svc: VerificationService;
const build = (p: StubProvider = provider, opts = DEFAULT_VERIFY_OPTIONS) =>
  new VerificationService(store, new ResilientProvider(p, FAST_LIMITS, { sleep: async () => {} }), metrics, opts, () => clock);
const usage = async (org: string, plan: "free" | "professional" = "professional") =>
  new UsageService(store.usage).summary({ organizationId: org, plan, status: "active" }, currentMonthKey(clock));

beforeEach(async () => {
  store = new MemoryStore(); provider = new StubProvider(() => clock); metrics = new VerificationMetrics(); clock = new Date(NOW);
  await seedOrg(store, "a"); await seedOrg(store, "b");
  svc = build();
});

const A = ctxFor("a", "ACCOUNTANT");

describe("local validation — free, no provider call, never a statement about registration", () => {
  const cases: [string, string, keyof typeof INVALID_REASON_TEXT][] = [
    ["", "", "EMPTY"], ["   ", "   ", "EMPTY"], ["short", "short", "LENGTH"], ["too long ".repeat(3), "", "LENGTH"],
    ["!!AAAAA0001A1Z0AA".slice(0, 15), "", "FORMAT"],
  ];
  it.each(cases)("%j is INVALID_GSTIN", async (input) => {
    const v = await svc.verify(A, input);
    expect(v.outcome).toBe("INVALID_GSTIN"); expect(v.formatValid).toBe(false); expect(v.invalidReason).toBeDefined();
    expect(INVALID_REASON_TEXT[v.invalidReason!]).toBeTruthy();
    expect(provider.verifyCalls).toBe(0); expect((await usage("a")).used).toBe(0);
  });
  it("detects a wrong check character separately from a wrong format", async () => {
    const g = gst(1); const bad = g.slice(0, 14) + (g[14] === "A" ? "B" : "A");
    expect((await svc.verify(A, bad)).invalidReason).toBe("CHECKSUM");
  });
  it("normalizes case and whitespace", async () => {
    const v = await svc.verify(A, ` ${gst(2).toLowerCase()} `);
    expect(v.outcome).toBe("ACTIVE"); expect(v.gstin).toBe(gst(2));
  });
  it("non-string input is a request error, not an outcome", async () => {
    await expect(svc.verify(A, 123)).rejects.toBeInstanceOf(AppError);
    await expect(svc.verify(A, undefined)).rejects.toBeInstanceOf(AppError);
  });
});

describe("live verification", () => {
  it("returns a typed, normalized result with freshness and a request id", async () => {
    provider.status = "Active";
    const v = await svc.verify(A, gst(1));
    expect(v).toMatchObject({ gstin: gst(1), outcome: "ACTIVE", formatValid: true, freshness: "live", ageSeconds: 0, retryable: false, source: "stub", verifiedAt: NOW.toISOString() });
    expect(v.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await svc.verify(A, gst(1), { force: true })).requestId).not.toBe(v.requestId);
  });
  it.each<[GstinStatus, VerificationOutcome]>([["Active", "ACTIVE"], ["Suspended", "SUSPENDED"], ["Cancelled", "CANCELLED"], ["Inactive", "INACTIVE"], ["Unknown", "UNKNOWN"], ["API Error", "UNKNOWN"]])(
    "provider status %s → %s", async (s, o) => {
      provider.status = s;
      expect((await svc.verify(A, gst(3))).outcome).toBe(o); expect(outcomeFromStatus(s)).toBe(o);
    });
  it("a clear 'Unknown' is never reported as Inactive/Cancelled", async () => {
    provider.status = "Unknown";
    const v = await svc.verify(A, gst(4));
    expect(v.outcome).toBe("UNKNOWN"); expect(EXPLANATIONS.UNKNOWN.caveat).toMatch(/not the same as inactive/i);
  });
  it("consumes exactly one usage unit, and writes history + audit", async () => {
    await svc.verify(A, gst(5));
    expect((await usage("a")).used).toBe(1);
    expect((await svc.recent(A)).map((r) => r.gstin)).toEqual([gst(5)]);
    const audit = await store.listAudit("a", 5);
    expect(audit[0]).toMatchObject({ action: "GST_VERIFY", target: gst(5), userId: A.userId });
    expect(audit[0].metadata).toMatchObject({ outcome: "ACTIVE" });
  });
  it("makes exactly one provider request (no return history)", async () => {
    await svc.verify(A, gst(6)); expect(provider.verifyCalls).toBe(1); expect(provider.returnCalls).toBe(0);
  });
});

describe("cache and freshness", () => {
  it("serves a fresh stored answer without calling the provider, labelled cached with its age", async () => {
    await svc.verify(A, gst(1));
    clock = new Date(NOW.getTime() + 18 * 60_000);
    const v = await svc.verify(A, gst(1));
    expect(v.freshness).toBe("cached"); expect(v.ageSeconds).toBe(18 * 60); expect(v.verifiedAt).toBe(NOW.toISOString());
    expect(provider.verifyCalls).toBe(1); expect(ageLabel(v.ageSeconds!)).toBe("18 minutes ago");
    const u = await usage("a"); expect(u.used).toBe(1);
    expect((await store.usage.get("a", currentMonthKey(clock)))?.cachedChecks).toBe(1);
  });
  it("force=true bypasses the cache and refreshes the stored answer", async () => {
    await svc.verify(A, gst(1)); provider.status = "Cancelled";
    clock = new Date(NOW.getTime() + 60_000);
    const v = await svc.verify(A, gst(1), { force: true });
    expect(v).toMatchObject({ outcome: "CANCELLED", freshness: "live" }); expect(provider.verifyCalls).toBe(2);
    expect((await svc.verify(A, gst(1))).outcome).toBe("CANCELLED"); // cache now holds the new answer
  });
  it("expires after the TTL", async () => {
    await svc.verify(A, gst(1));
    clock = new Date(NOW.getTime() + DEFAULT_VERIFY_OPTIONS.policy.staleUsableMs + 1000);
    expect((await svc.verify(A, gst(1))).freshness).toBe("live"); expect(provider.verifyCalls).toBe(2);
  });
  it("cache is per organization (another org's lookup never populates mine)", async () => {
    await svc.verify(A, gst(1));
    const v = await svc.verify(ctxFor("b", "ACCOUNTANT"), gst(1));
    expect(v.freshness).toBe("live"); expect(provider.verifyCalls).toBe(2);
    expect(await svc.recent(ctxFor("b", "VIEWER"))).toHaveLength(1);
    await seedOrg(store, "c"); expect(await svc.recent(ctxFor("c", "OWNER"))).toEqual([]);
  });
  it("cached answers are still served when the quota is exhausted", async () => {
    await seedOrg(store, "free1", "free");
    const F = ctxFor("free1", "ACCOUNTANT");
    await svc.verify(F, gst(1));
    for (let i = 2; i <= PLANS.free.monthlyChecks!; i++) await svc.verify(F, gst(i));
    await expect(svc.verify(F, gst(60))).rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });
    expect((await svc.verify(F, gst(1))).freshness).toBe("cached");
  });
});

describe("NOT_FOUND is a registry answer, never an outage and never 'fake'", () => {
  beforeEach(() => { provider.failFor.set(gst(9), new ProviderError("GST_PROVIDER_NOT_FOUND", "none", false)); });
  it("is returned as a typed outcome, consumes no quota, and is not cached", async () => {
    const v = await svc.verify(A, gst(9));
    expect(v).toMatchObject({ outcome: "NOT_FOUND", formatValid: true, retryable: false, freshness: "live" });
    expect((await usage("a")).used).toBe(0);
    await svc.verify(A, gst(9)); expect(provider.verifyCalls).toBe(2); // asked again
    expect(EXPLANATIONS.NOT_FOUND.caveat).toMatch(/not proof of fraud/i);
  });
  it("does not retry (non-retryable) and does not trip the circuit breaker", async () => {
    for (let i = 0; i < 8; i++) await svc.verify(A, gst(9));
    expect(provider.verifyCalls).toBe(8);
    expect((await svc.verify(A, gst(1))).outcome).toBe("ACTIVE");
  });
  it("a later NOT_FOUND replaces the stored answer in history", async () => {
    provider.failFor.clear(); await svc.verify(A, gst(9));
    provider.failFor.set(gst(9), new ProviderError("GST_PROVIDER_NOT_FOUND", "none", false));
    expect((await svc.verify(A, gst(9), { force: true })).outcome).toBe("NOT_FOUND");
    expect((await svc.recent(A))[0].outcome).toBe("NOT_FOUND");
  });
});

describe("failures are classified, refunded, and say nothing about the GSTIN", () => {
  const E = (code: ConstructorParameters<typeof ProviderError>[0], retryable: boolean, retryAfter?: number) => new ProviderError(code, "x", retryable, false, retryAfter);
  it.each<[string, ProviderError, VerificationOutcome, boolean]>([
    ["timeout", E("GST_PROVIDER_TIMEOUT", true), "TIMEOUT", true],
    ["unavailable", E("GST_PROVIDER_UNAVAILABLE", false), "MAINTENANCE", true],
    ["rate limited", E("GST_PROVIDER_RATE_LIMITED", true, 3000), "RATE_LIMITED", true],
    ["auth", E("GST_PROVIDER_AUTH", false), "PROVIDER_ERROR", false],
    ["not configured", E("GST_PROVIDER_NOT_CONFIGURED", false), "PROVIDER_ERROR", false],
    ["bad response", E("GST_PROVIDER_BAD_RESPONSE", false), "PROVIDER_ERROR", false],
  ])("%s", async (_n, err, outcome, retryable) => {
    provider.failAll = err;
    const v = await svc.verify(A, gst(1));
    expect(v.outcome).toBe(outcome); expect(v.retryable).toBe(retryable); expect(v.freshness).toBe("none");
    expect(v.formatValid).toBe(true); expect(v.details).toBeUndefined();
    expect((await usage("a")).used).toBe(0); // reservation refunded
    expect((await store.usage.get("a", currentMonthKey(clock)))?.failedRequests).toBe(1);
    expect(await svc.recent(A)).toEqual([]); // failures are never stored as history
    expect(EXPLANATIONS[outcome].caveat).toMatch(/does not mean the GSTIN is fake/i);
  });
  it("passes through the provider's Retry-After hint", async () => {
    provider.failAll = E("GST_PROVIDER_RATE_LIMITED", false, 4000);
    expect((await svc.verify(A, gst(1))).retryAfterMs).toBe(4000);
  });
  it("a billable failure is not refunded", async () => {
    provider.failAll = new ProviderError("GST_PROVIDER_BAD_RESPONSE", "x", false, true);
    await svc.verify(A, gst(1)); expect((await usage("a")).used).toBe(1);
  });
  it("an unexpected thrown error is a PROVIDER_ERROR outcome, never a 500 or a leak", async () => {
    const odd = { name: "odd", verifyGstin: async () => { throw new Error("secret stack"); }, getReturnHistory: async () => { throw new Error("x"); } };
    const s = new VerificationService(store, odd, metrics, DEFAULT_VERIFY_OPTIONS, () => clock);
    const v = await s.verify(A, gst(1));
    expect(v.outcome).toBe("PROVIDER_ERROR"); expect(JSON.stringify(v)).not.toContain("secret");
  });
  it("a failure after a good answer keeps the stored answer and shows it as lastKnown (stale), never as current", async () => {
    await svc.verify(A, gst(1));
    clock = new Date(NOW.getTime() + 3 * 86_400_000); provider.failAll = E("GST_PROVIDER_TIMEOUT", true);
    const v = await svc.verify(A, gst(1));
    expect(v.outcome).toBe("TIMEOUT"); expect(v.freshness).toBe("none"); expect(v.details).toBeUndefined();
    expect(v.lastKnown).toMatchObject({ outcome: "ACTIVE", verifiedAt: NOW.toISOString() });
    expect((await svc.recent(A))[0]).toMatchObject({ outcome: "ACTIVE", ageSeconds: 3 * 86400 }); // stored answer untouched
  });
  it("hard deadline: a provider that never answers yields TIMEOUT within the deadline", async () => {
    const hang = { name: "hang", verifyGstin: () => new Promise<never>(() => {}), getReturnHistory: async () => { throw new Error("x"); } };
    const s = new VerificationService(store, hang, metrics, { ...DEFAULT_VERIFY_OPTIONS, deadlineMs: 30 }, () => clock);
    const t = Date.now(); const v = await s.verify(A, gst(1));
    expect(v.outcome).toBe("TIMEOUT"); expect(Date.now() - t).toBeLessThan(1000);
    expect((await usage("a")).used).toBe(0);
  });
  it("an open circuit breaker surfaces as MAINTENANCE immediately", async () => {
    provider.failAll = E("GST_PROVIDER_TIMEOUT", true);
    for (let i = 0; i < 6; i++) await svc.verify(A, gst(1));
    const calls = provider.verifyCalls;
    const v = await svc.verify(A, gst(2));
    expect(v.outcome).toBe("MAINTENANCE"); expect(provider.verifyCalls).toBe(calls); // fail-fast: provider not called
  });
});

describe("access control and subscription", () => {
  it("VIEWER cannot verify (it spends quota); can read recent; only ADMIN+ can read health", async () => {
    await expect(svc.verify(ctxFor("a", "VIEWER"), gst(1))).rejects.toBeInstanceOf(ForbiddenError);
    expect(provider.verifyCalls).toBe(0);
    await expect(svc.recent(ctxFor("a", "VIEWER"))).resolves.toEqual([]);
    expect(() => svc.health(ctxFor("a", "ACCOUNTANT"))).toThrow(ForbiddenError);
    expect(svc.health(ctxFor("a", "ADMIN")).total).toBe(0);
  });
  it("an expired subscription blocks live verification but still serves cached answers", async () => {
    await seedOrg(store, "x");
    await svc.verify(ctxFor("x", "ACCOUNTANT"), gst(1));
    await store.updateOrg("x", { subscriptionStatus: "expired" });
    expect((await svc.verify(ctxFor("x", "ACCOUNTANT"), gst(1))).freshness).toBe("cached");
    await expect(svc.verify(ctxFor("x", "ACCOUNTANT"), gst(2))).rejects.toBeInstanceOf(UsageError);
  });
  it("recent() clamps its limit and is newest-first", async () => {
    for (let i = 1; i <= 4; i++) { clock = new Date(NOW.getTime() + i * 1000); await svc.verify(A, gst(i)); }
    expect((await svc.recent(A, 2)).map((r) => r.gstin)).toEqual([gst(4), gst(3)]);
    expect((await svc.recent(A, 9999)).length).toBe(4); expect((await svc.recent(A, -5)).length).toBeGreaterThan(0);
  });
});

describe("metrics", () => {
  it("tracks outcomes, cache hits and latency percentiles per organization", async () => {
    const m = new VerificationMetrics(10);
    for (const d of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) m.record("o", { outcome: "ACTIVE", durationMs: d, cached: false, at: 0 });
    const s = m.snapshot("o");
    expect(s).toMatchObject({ total: 10, successRate: 1, p50Ms: 500, p95Ms: 1000, cacheHitRate: 0 });
    expect(m.snapshot("other").total).toBe(0); expect(m.snapshot("other").successRate).toBeNull();
  });
  it("is a bounded window", () => {
    const m = new VerificationMetrics(3);
    for (let i = 0; i < 10; i++) m.record("o", { outcome: "ACTIVE", durationMs: i, cached: false, at: 0 });
    expect(m.snapshot("o").total).toBe(3);
  });
  it("end to end: invalid input is excluded from success rate; failures lower it; cache counted", async () => {
    await svc.verify(A, "nope");            // invalid
    await svc.verify(A, gst(1));            // live ok
    await svc.verify(A, gst(1));            // cached ok
    provider.failAll = new ProviderError("GST_PROVIDER_TIMEOUT", "x", true);
    await svc.verify(A, gst(2));            // timeout
    const s = svc.health(ctxFor("a", "OWNER"));
    expect(s.total).toBe(4); expect(s.byOutcome).toMatchObject({ INVALID_GSTIN: 1, ACTIVE: 2, TIMEOUT: 1 });
    expect(s.successRate).toBeCloseTo(2 / 3, 3); expect(s.cacheHitRate).toBeCloseTo(1 / 3, 3);
    expect(s.timeoutRate).toBeCloseTo(1 / 3, 3); expect(s.invalidRate).toBe(0.25);
  });
});

describe("classification table and copy", () => {
  it("every failure outcome carries the 'does not mean the GSTIN is fake' caveat; none implies a registry statement", () => {
    for (const o of FAILURE_OUTCOMES) { expect(EXPLANATIONS[o].caveat).toMatch(/does not mean the GSTIN is fake/i); expect(EXPLANATIONS[o].tone).toBe("info"); }
  });
  it("no copy calls a GSTIN 'fake' as a finding", () => {
    for (const [o, e] of Object.entries(EXPLANATIONS)) expect(`${e.title} ${e.meaning}`.toLowerCase(), o).not.toMatch(/\bfake\b|fraud/);
  });
  it("classifies non-provider errors as a retryable PROVIDER_ERROR", () => {
    expect(classifyProviderError(new Error("x"))).toMatchObject({ outcome: "PROVIDER_ERROR", retryable: true });
    expect(classifyProviderError("string")).toMatchObject({ outcome: "PROVIDER_ERROR" });
  });
  it("ageLabel buckets", () => {
    expect([10, 60, 3600, 7200, 3 * 86400].map(ageLabel)).toEqual(["just now", "1 minute ago", "1 hour ago", "2 hours ago", "3 days ago"]);
  });
  it("test helper GSTINs are valid", () => { expect(computeGstinChecksum(gst(1).slice(0, 14))).toBe(gst(1)[14]); });
});
