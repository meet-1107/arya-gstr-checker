import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "@/lib/store/memory";
import { VerificationService, DEFAULT_VERIFY_OPTIONS } from "@/services/verification";
import { CostGuard } from "@/services/cost-guard";
import { VerificationMetrics } from "@/lib/metrics";
import { ProviderHealth } from "@/lib/provider-health";
import { ResilientProvider } from "@/providers/gate";
import { ProviderError } from "@/providers/types";
import { UsageService } from "@/lib/usage";
import { currentMonthKey } from "@/lib/dates";
import { costPolicy, DEFAULT_COST_POLICY, type CostPolicy } from "@/config/cost-policy";
import { detectChange } from "@/lib/change-detection";
import { ForbiddenError } from "@/lib/permissions";
import { ctxFor, FAST_LIMITS, gst, NOW, seedOrg, StubProvider } from "./helpers";

const H = 3600_000, D = 24 * H;
let store: MemoryStore, provider: StubProvider, clock: Date, mono: number;
const A = ctxFor("a", "ACCOUNTANT"), B = ctxFor("b", "ACCOUNTANT");

function mk(cost: Partial<CostPolicy> = {}) {
  const policy = { ...DEFAULT_COST_POLICY, ...cost };
  const o = DEFAULT_VERIFY_OPTIONS;
  const guard = new CostGuard(store, policy, () => clock);
  const svc = new VerificationService(store, new ResilientProvider(provider, { ...FAST_LIMITS, retries: 0, breakerFailureThreshold: 1000 }, { sleep: async () => {} }), new VerificationMetrics(), o, () => clock, () => mono, new ProviderHealth(o.policy, () => mono), guard);
  return { svc, guard };
}
const usedUnits = async (org = "a") => (await new UsageService(store.usage).summary({ organizationId: org, plan: "professional", status: "active" }, currentMonthKey(clock))).used;
const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); mono += ms; };

beforeEach(async () => {
  store = new MemoryStore(); provider = new StubProvider(() => clock); clock = new Date(NOW); mono = 1_000_000;
  await seedOrg(store, "a"); await seedOrg(store, "b");
});

describe("cost counters: searches → paid calls → avoided calls", () => {
  it("counts every outcome path, per organization and globally", async () => {
    const { svc, guard } = mk();
    await svc.verify(A, gst(1), { mode: "auto" });          // miss + paid
    await svc.verify(A, gst(1), { mode: "auto" });          // hit
    await svc.verify(A, gst(1), { mode: "auto" });          // hit
    await svc.verify(A, gst(2), { mode: "live" });          // miss + paid
    await svc.verify(B, gst(1), { mode: "auto" });          // other org: miss + paid (no sharing)
    const a = (await guard.orgReport("a")).today, g = (await guard.platformReport()).today;
    expect(a).toMatchObject({ searches: 4, paidCalls: 2, cacheHits: 2, cacheMisses: 2, credits: 2, sharedHits: 0, deduped: 0, failures: 0 });
    expect(a.avoidedCallRate).toBe(0.5);
    expect(g).toMatchObject({ searches: 5, paidCalls: 3, cacheHits: 2, credits: 3 });
    expect((await guard.orgReport("b")).today.paidCalls).toBe(1);
  });
  it("invalid input is not a search and costs nothing", async () => {
    const { svc, guard } = mk(); await svc.verify(A, "nope", { mode: "auto" });
    expect((await guard.orgReport("a")).today.searches).toBe(0); expect(provider.verifyCalls).toBe(0);
  });
  it("failures are counted as paid calls that failed; credits only when the provider bills them", async () => {
    const { svc, guard } = mk();
    provider.failFor.set(gst(1), new ProviderError("GST_PROVIDER_TIMEOUT", "x", true));
    provider.failFor.set(gst(2), new ProviderError("GST_PROVIDER_BAD_RESPONSE", "x", false, true));      // billable error
    provider.failFor.set(gst(3), new ProviderError("GST_PROVIDER_NOT_FOUND", "x", false));               // completed lookup
    for (const n of [1, 2, 3]) await svc.verify(A, gst(n), { mode: "live" });
    expect((await guard.orgReport("a")).today).toMatchObject({ paidCalls: 3, failures: 2, credits: 2 });
  });
  it("estimated cost is null until a price is configured (no invented numbers)", async () => {
    const x = mk(); await x.svc.verify(A, gst(1), { mode: "auto" });
    expect((await x.guard.orgReport("a")).month.estimatedCostInr).toBeNull();
    const y = mk({ costPerCreditInr: 0.5, creditsPerCall: 2 }); await y.svc.verify(A, gst(2), { mode: "auto" });
    expect((await y.guard.orgReport("a")).month.estimatedCostInr).toBe(1.5); // 3 credits (1 + 2) × 0.5
  });
  it("day and month periods roll over by the clock", async () => {
    const { svc, guard } = mk(); await svc.verify(A, gst(1), { mode: "auto" });
    advance(2 * D); await svc.verify(A, gst(2), { mode: "auto" });
    const r = await guard.orgReport("a");
    expect(r.today.paidCalls).toBe(1); expect(r.month.paidCalls + 0).toBeGreaterThanOrEqual(1);
  });
  it("only admins read the org cost report", async () => {
    const { svc } = mk();
    await expect(svc.costs(ctxFor("a", "ACCOUNTANT"))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await svc.costs(ctxFor("a", "ADMIN"))).today.searches).toBe(0);
  });
});

describe("credit protection", () => {
  const budget = { monthlyCreditBudget: 10 };
  const spend = async (svc: VerificationService, n: number, from = 100) => { for (let i = 0; i < n; i++) await svc.verify(A, gst(from + i), { mode: "live" }); };
  it("reports ok / low / critical / exhausted from the configured budget", async () => {
    const { svc, guard } = mk(budget);
    expect((await guard.creditStatus()).state).toBe("ok");
    await spend(svc, 8); expect(await guard.creditStatus()).toMatchObject({ state: "low", used: 8, remaining: 2, budget: 10 });
    await spend(svc, 1, 200); expect((await guard.creditStatus()).state).toBe("low");  // 1 of 10 left = 10%
    await spend(svc, 1, 300); expect(await guard.creditStatus()).toMatchObject({ state: "exhausted", remaining: 0 });
  });
  it("is disabled without a configured budget (never blocks on unknown credits)", async () => {
    const { svc, guard } = mk(); await spend(svc, 30);
    expect((await guard.creditStatus())).toMatchObject({ state: "ok", budget: null, remaining: null });
  });
  it("LOW: an explicit refresh of a usable stored answer is replaced by the stored answer plus a notice; no paid call", async () => {
    const { svc } = mk(budget); await svc.verify(A, gst(1), { mode: "live" }); await spend(svc, 7);          // 8 used → low
    const calls = provider.verifyCalls;
    const v = await svc.verify(A, gst(1), { mode: "live" });
    expect(v).toMatchObject({ freshness: "cached", notice: "CREDIT_PROTECTION", refreshSkipped: "capacity", provenance: "CACHE" });
    expect(provider.verifyCalls).toBe(calls);
  });
  it("LOW: stale answers are served without recommending a refresh; unseen GSTINs still verify", async () => {
    const { svc } = mk(budget); await svc.verify(A, gst(1), { mode: "live" }); await spend(svc, 7);
    advance(3 * D);
    const stale = await svc.verify(A, gst(1), { mode: "auto" });
    expect(stale).toMatchObject({ freshness: "cached", staleness: "stale", refreshSkipped: "capacity" }); expect(stale.refreshRecommended).toBeUndefined();
    expect((await svc.verify(A, gst(900), { mode: "auto" })).freshness).toBe("live");
  });
  it("LOW: an answer past the usable window may be refreshed (it is no longer a good substitute)", async () => {
    const { svc } = mk(budget); await svc.verify(A, gst(1), { mode: "live" }); await spend(svc, 7);
    advance(8 * D); // past the 7-day usable window, same calendar month
    expect((await svc.verify(A, gst(1), { mode: "auto" })).freshness).toBe("live");
  });
  it("CRITICAL: seen GSTINs are served from storage at any age; only unseen GSTINs may use a credit", async () => {
    const { svc, guard } = mk({ monthlyCreditBudget: 20 }); await svc.verify(A, gst(1), { mode: "live" }); await spend(svc, 18);   // 19 of 20 → 5% left
    expect((await guard.creditStatus()).state).toBe("critical");
    advance(20 * D); // still the same calendar month (credit budget is monthly)
    expect(await svc.verify(A, gst(1), { mode: "live" })).toMatchObject({ freshness: "cached", notice: "CREDIT_PROTECTION" });
    expect((await svc.verify(A, gst(901), { mode: "auto" })).freshness).toBe("live");
  });
  it("EXHAUSTED: no paid call, no quota used, a clear CAPACITY_LIMITED outcome that keeps the last known answer; stored answers still served", async () => {
    const { svc } = mk({ monthlyCreditBudget: 3 }); await svc.verify(A, gst(1), { mode: "live" }); await spend(svc, 2);
    const calls = provider.verifyCalls, units = await usedUnits();
    const v = await svc.verify(A, gst(950), { mode: "auto" });
    expect(v).toMatchObject({ outcome: "CAPACITY_LIMITED", freshness: "none", retryable: true });
    expect(provider.verifyCalls).toBe(calls); expect(await usedUnits()).toBe(units);
    expect(await svc.verify(A, gst(1), { mode: "auto" })).toMatchObject({ freshness: "cached", outcome: expect.stringMatching(/ACTIVE|SUSPENDED|CANCELLED|INACTIVE|UNKNOWN/) });
  });
  it("a silent refresh under protection is skipped, never an error", async () => {
    const { svc } = mk(budget); await svc.verify(A, gst(1), { mode: "live" }); await spend(svc, 7); advance(3 * D);
    const v = await svc.verify(A, gst(1), { mode: "refresh" });
    expect(v).toMatchObject({ freshness: "cached", refreshSkipped: "capacity" }); expect(v.notice).toBeUndefined();
  });
});

describe("rate limits protect the provider budget", () => {
  it("per-organization per-minute cap: RATE_LIMITED with a retry hint, no provider call, no quota; other orgs unaffected; window slides", async () => {
    const { svc } = mk({ orgPerMinute: 3 });
    for (let i = 1; i <= 3; i++) await svc.verify(A, gst(i), { mode: "live" });
    const units = await usedUnits(), calls = provider.verifyCalls;
    const v = await svc.verify(A, gst(4), { mode: "live" });
    expect(v).toMatchObject({ outcome: "RATE_LIMITED", retryable: true, freshness: "none" }); expect(v.retryAfterMs).toBeGreaterThan(0);
    expect(provider.verifyCalls).toBe(calls); expect(await usedUnits()).toBe(units);
    expect((await svc.verify(B, gst(4), { mode: "live" })).freshness).toBe("live");
    advance(61_000);
    expect((await svc.verify(A, gst(4), { mode: "live" })).freshness).toBe("live");
  });
  it("cached answers do not consume the per-minute allowance", async () => {
    const { svc } = mk({ orgPerMinute: 2 }); await svc.verify(A, gst(1), { mode: "auto" });
    for (let i = 0; i < 10; i++) expect((await svc.verify(A, gst(1), { mode: "auto" })).freshness).toBe("cached");
    expect((await svc.verify(A, gst(2), { mode: "auto" })).freshness).toBe("live");
  });
  it("per-organization daily cap, and it resets the next UTC day", async () => {
    const { svc } = mk({ orgPerDay: 2 }); await svc.verify(A, gst(1), { mode: "live" }); await svc.verify(A, gst(2), { mode: "live" });
    const v = await svc.verify(A, gst(3), { mode: "live" });
    expect(v).toMatchObject({ outcome: "RATE_LIMITED" }); expect(v.retryAfterMs).toBeGreaterThan(0); expect(v.retryAfterMs).toBeLessThanOrEqual(D);
    advance(D + 1000); expect((await svc.verify(A, gst(3), { mode: "live" })).freshness).toBe("live");
  });
  it("global daily cap protects the whole balance: CAPACITY_LIMITED for every organization", async () => {
    const { svc } = mk({ globalPerDay: 2 }); await svc.verify(A, gst(1), { mode: "live" }); await svc.verify(B, gst(2), { mode: "live" });
    expect(await svc.verify(A, gst(3), { mode: "live" })).toMatchObject({ outcome: "CAPACITY_LIMITED" });
    expect(await svc.verify(B, gst(4), { mode: "live" })).toMatchObject({ outcome: "CAPACITY_LIMITED" });
    expect((await svc.verify(A, gst(1), { mode: "auto" })).freshness).toBe("cached");
  });
  it("bulk (held) calls skip the per-minute cap but still honour the daily caps", async () => {
    const { svc } = mk({ orgPerMinute: 1, orgPerDay: 3 });
    const held = (n: number) => svc.verify(A, gst(n), { held: true });
    for (let i = 1; i <= 3; i++) expect((await held(i)).freshness).toBe("live");
    expect(await held(4)).toMatchObject({ outcome: "RATE_LIMITED" });
  });
  it("limited requests do not leave a flight behind (the next caller is not stuck)", async () => {
    const { svc } = mk({ orgPerMinute: 1 }); await svc.verify(A, gst(1), { mode: "live" });
    await svc.verify(A, gst(2), { mode: "live" }); advance(61_000);
    expect((await svc.verify(A, gst(2), { mode: "live" })).freshness).toBe("live");
  });
});

describe("explicit refresh throttle", () => {
  it("off by default: an explicit live check always asks the provider", async () => {
    const { svc } = mk(); await svc.verify(A, gst(1), { mode: "live" }); await svc.verify(A, gst(1), { mode: "live" });
    expect(provider.verifyCalls).toBe(2);
  });
  it("when set, a refresh of a moments-old answer is declined with an explanation; later it goes through", async () => {
    const { svc } = mk({ minRefreshMs: 60_000 }); await svc.verify(A, gst(1), { mode: "live" });
    advance(10_000);
    const v = await svc.verify(A, gst(1), { mode: "live" });
    expect(v).toMatchObject({ freshness: "cached", notice: "REFRESH_TOO_SOON" }); expect(provider.verifyCalls).toBe(1);
    advance(60_000); expect((await svc.verify(A, gst(1), { mode: "live" })).freshness).toBe("live");
  });
});

describe("cross-organization sharing (opt-in)", () => {
  it("OFF (default): organizations never see or reuse each other's results; each pays its own call; nothing is written to the shared store", async () => {
    const { svc } = mk(); await svc.verify(A, gst(1), { mode: "auto" });
    const v = await svc.verify(B, gst(1), { mode: "auto" });
    expect(v).toMatchObject({ freshness: "live", provenance: "LIVE_PROVIDER" }); expect(provider.verifyCalls).toBe(2);
    expect(await store.getSharedResult(gst(1))).toBeNull();
  });
  it("ON: the second organization is served the shared answer with no paid call, tagged SHARED_CACHE, and it is adopted into its own store", async () => {
    const { svc, guard } = mk({ sharedCache: true }); const a = await svc.verify(A, gst(1), { mode: "auto" });
    const b = await svc.verify(B, gst(1), { mode: "auto" });
    expect(provider.verifyCalls).toBe(1);
    expect(b).toMatchObject({ freshness: "cached", provenance: "SHARED_CACHE", outcome: a.outcome, verifiedAt: a.verifiedAt });
    expect((await store.getVerification("b", gst(1)))).toMatchObject({ provenance: "SHARED_CACHE", outcome: a.outcome });
    expect((await guard.orgReport("b")).today).toMatchObject({ sharedHits: 1, paidCalls: 0 });
    // next lookup is a plain own-store hit
    expect((await svc.verify(B, gst(1), { mode: "auto" })).provenance).toBe("CACHE");
  });
  it("the shared record carries no organization or user identity and no notes/tags", async () => {
    const { svc } = mk({ sharedCache: true }); await svc.verify(A, gst(1), { mode: "auto" });
    await svc.annotate(A, gst(1), { note: "secret note", tags: ["vip"] }); await svc.setSaved(A, gst(1), true);
    const s = await store.getSharedResult(gst(1));
    expect(Object.keys(s!).sort()).toEqual(["details", "gstin", "outcome", "provenance", "source", "verifiedAt"]);
    expect(JSON.stringify(s)).not.toMatch(/secret note|vip|"a"|ACCOUNTANT|by|requestId/);
    const b = await svc.verify(B, gst(1), { mode: "auto" }); expect(b.note).toBeUndefined(); expect(b.saved).toBe(false);
  });
  it("ON: concurrent requests from different organizations make ONE paid call; both end up with a record", async () => {
    provider.delayMs = 25; const { svc } = mk({ sharedCache: true });
    const [a, b] = await Promise.all([svc.verify(A, gst(1), { mode: "live" }), svc.verify(B, gst(1), { mode: "live" })]);
    expect(provider.verifyCalls).toBe(1);
    expect([a.provenance, b.provenance].sort()).toEqual(["DEDUPED", "LIVE_PROVIDER"]);
    expect(await store.getVerification("a", gst(1))).not.toBeNull(); expect(await store.getVerification("b", gst(1))).not.toBeNull();
  });
  it("OFF: the same concurrent requests make two calls (never joins across organizations)", async () => {
    provider.delayMs = 25; const { svc } = mk();
    await Promise.all([svc.verify(A, gst(1), { mode: "live" }), svc.verify(B, gst(1), { mode: "live" })]);
    expect(provider.verifyCalls).toBe(2);
  });
  it("ON: a stale shared answer is not served as fresh; a fresher own answer wins over an older shared one", async () => {
    const { svc } = mk({ sharedCache: true }); await svc.verify(A, gst(1), { mode: "auto" });
    advance(3 * D);
    expect((await svc.verify(B, gst(1), { mode: "auto" })).staleness).toBe("stale");
    advance(30 * D);
    expect((await svc.verify(B, gst(1), { mode: "auto" })).freshness).toBe("live");
  });
  it("sharing is a boolean env switch, off unless exactly 'on'", () => {
    expect(costPolicy({}).sharedCache).toBe(false); expect(costPolicy({ VERIFY_SHARED_CACHE: "true" }).sharedCache).toBe(false); expect(costPolicy({ VERIFY_SHARED_CACHE: "on" }).sharedCache).toBe(true);
  });
});

describe("change detection", () => {
  it("detectChange: status moves, detail edits, and what is NOT a change", () => {
    const snap = (outcome: "ACTIVE" | "CANCELLED" | "SUSPENDED" | "UNKNOWN" | "NOT_FOUND", legalName?: string, at = "2026-10-01T00:00:00.000Z") => ({ outcome, details: legalName ? { legalName } : undefined, verifiedAt: at });
    expect(detectChange(snap("ACTIVE", "ABC LTD"), snap("CANCELLED", "ABC LTD", "2026-10-06T00:00:00.000Z"))).toMatchObject({ from: "ACTIVE", to: "CANCELLED", fields: ["status"], deteriorated: true });
    expect(detectChange(snap("CANCELLED"), snap("ACTIVE"))).toMatchObject({ deteriorated: false });
    expect(detectChange(snap("ACTIVE", "ABC LTD"), snap("ACTIVE", "ABC  ltd"))).toBeNull();                  // case/space only
    expect(detectChange(snap("ACTIVE", "ABC LTD"), snap("ACTIVE", "XYZ LTD"))).toMatchObject({ fields: ["legalName"], deteriorated: false });
    expect(detectChange(snap("ACTIVE"), snap("ACTIVE", "ABC LTD"))).toBeNull();                              // newly provided detail is not a change
    expect(detectChange(snap("ACTIVE"), snap("UNKNOWN"))).toBeNull(); expect(detectChange(snap("UNKNOWN"), snap("ACTIVE"))).toBeNull();
    expect(detectChange(snap("NOT_FOUND"), snap("ACTIVE"))).toBeNull(); expect(detectChange(null, snap("ACTIVE"))).toBeNull();
  });
  it("a live re-verification reports the change, keeps the previous snapshot, and alerts only for a saved GSTIN that got worse", async () => {
    const { svc } = mk();
    provider.status = "Active"; await svc.verify(A, gst(1), { mode: "live" }); await svc.verify(A, gst(2), { mode: "live" });
    await svc.setSaved(A, gst(1), true);
    advance(2 * H); provider.status = "Cancelled";
    const v1 = await svc.verify(A, gst(1), { mode: "live" }), v2 = await svc.verify(A, gst(2), { mode: "live" });
    expect(v1.change).toMatchObject({ from: "ACTIVE", to: "CANCELLED", deteriorated: true, fields: ["status"] });
    expect(await store.getVerification("a", gst(1))).toMatchObject({ previous: { outcome: "ACTIVE" }, change: { to: "CANCELLED" } });
    expect(v2.change?.deteriorated).toBe(true);
    const alerts = await store.listAlerts("a", 10);
    expect(alerts.filter((x) => x.type.startsWith("GSTIN_")).map((x) => x.gstin)).toEqual([gst(1)]);   // saved only
  });
  it("no change → no change field; an improvement is reported but not alerted", async () => {
    const { svc } = mk();
    provider.status = "Cancelled"; await svc.verify(A, gst(1), { mode: "live" }); await svc.setSaved(A, gst(1), true);
    expect((await svc.verify(A, gst(1), { mode: "live" })).change).toBeUndefined();
    provider.status = "Active"; const v = await svc.verify(A, gst(1), { mode: "live" });
    expect(v.change).toMatchObject({ from: "CANCELLED", to: "ACTIVE", deteriorated: false });
    expect(await store.listAlerts("a", 10)).toEqual([]);
  });
});

describe("provenance", () => {
  it("live → LIVE_PROVIDER; stored → CACHE; joined → DEDUPED", async () => {
    const { svc } = mk();
    expect((await svc.verify(A, gst(1), { mode: "auto" })).provenance).toBe("LIVE_PROVIDER");
    expect((await svc.verify(A, gst(1), { mode: "auto" })).provenance).toBe("CACHE");
    provider.delayMs = 20;
    const vs = await Promise.all([svc.verify(A, gst(2), { mode: "live" }), svc.verify(A, gst(2), { mode: "live" })]);
    expect(vs.map((v) => v.provenance).sort()).toEqual(["DEDUPED", "LIVE_PROVIDER"]);
    expect((await store.getVerification("a", gst(2)))?.provenance).toBe("LIVE_PROVIDER");
  });
});

describe("the paid API key never reaches the browser", () => {
  const walk = (dir: string, out: string[] = []) => { for (const n of readdirSync(dir)) { const f = join(dir, n); if (statSync(f).isDirectory()) walk(f, out); else if (/\.(ts|tsx)$/.test(n)) out.push(f); } return out; };
  const clientFiles = [...walk("src/components"), ...walk("src/lib/client"), ...walk("src/app").filter((f) => !f.includes(`${join("src", "app", "api")}`) && !/route\.ts$/.test(f))];
  it("no client-side file reads a non-public env var or names a provider secret", () => {
    const bad: string[] = [];
    for (const f of clientFiles) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) if (!m[1].startsWith("NEXT_PUBLIC_") && m[1] !== "NODE_ENV") bad.push(`${f}: ${m[0]}`);
      if (/GST_(PROVIDER_)?API_KEY|GSTIN_API_KEY|WHITEBOOKS|PROVIDER_SECRET/i.test(src)) bad.push(`${f}: provider secret name`);
    }
    expect(bad).toEqual([]);
  });
  it("provider modules are imported only by server code", () => {
    const offenders = clientFiles.filter((f) => /from "@\/providers\/(mock|gate|index)"|from "@\/server\/|^import (?!type)[^;\n]*from "@\/services\//m.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
