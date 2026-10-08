import { PLANS } from "@/config/plans";
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { VerificationService, DEFAULT_VERIFY_OPTIONS, type VerifyOptions } from "@/services/verification";
import { VerificationMetrics } from "@/lib/metrics";
import { ProviderHealth } from "@/lib/provider-health";
import { ResilientProvider } from "@/providers/gate";
import { ProviderError } from "@/providers/types";
import { UsageService } from "@/lib/usage";
import { currentMonthKey } from "@/lib/dates";
import { verificationPolicy, DEFAULT_VERIFICATION_POLICY } from "@/config/verification-policy";
import { isVerifyMode } from "@/lib/verification";
import { ctxFor, FAST_LIMITS, gst, NOW, seedOrg, StubProvider } from "./helpers";

const H = 3600_000, D = 24 * H;
let store: MemoryStore, provider: StubProvider, metrics: VerificationMetrics, clock: Date, mono: number, health: ProviderHealth;
const A = ctxFor("a", "ACCOUNTANT");

function mk(opts: Partial<VerifyOptions> = {}, p: StubProvider = provider) {
  const o = { ...DEFAULT_VERIFY_OPTIONS, ...opts };
  health = new ProviderHealth(o.policy, () => mono);
  return new VerificationService(store, new ResilientProvider(p, { ...FAST_LIMITS, retries: 0, breakerFailureThreshold: 1000 }, { sleep: async () => {} }), metrics, o, () => clock, () => mono, health);
}
const used = async (org = "a") => (await new UsageService(store.usage).summary({ organizationId: org, plan: "professional", status: "active" }, currentMonthKey(clock))).used;
const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); mono += ms; };

beforeEach(async () => {
  store = new MemoryStore(); provider = new StubProvider(() => clock); metrics = new VerificationMetrics(); clock = new Date(NOW); mono = 1_000_000;
  await seedOrg(store, "a"); await seedOrg(store, "b");
});

describe("freshness policy: fresh / stale / expired", () => {
  it("fresh: served instantly with no refresh recommended and no provider call", async () => {
    const svc = mk(); await svc.verify(A, gst(1), { mode: "auto" });
    advance(3 * H);
    const v = await svc.verify(A, gst(1), { mode: "auto" });
    expect(v).toMatchObject({ freshness: "cached", staleness: "fresh" }); expect(v.refreshRecommended).toBeUndefined();
    expect(provider.verifyCalls).toBe(1);
  });
  it("stale: served instantly AND a silent refresh is recommended (stale-while-refresh); no provider call, no quota", async () => {
    const svc = mk(); await svc.verify(A, gst(1), { mode: "auto" });
    advance(2 * D);
    const v = await svc.verify(A, gst(1), { mode: "auto" });
    expect(v).toMatchObject({ freshness: "cached", staleness: "stale", refreshRecommended: true, outcome: "ACTIVE" });
    expect(v.ageSeconds).toBe(2 * 86400); expect(provider.verifyCalls).toBe(1); expect(await used()).toBe(1);
  });
  it("the follow-up refresh goes live, replaces the stored answer, and the next view is fresh", async () => {
    const svc = mk(); await svc.verify(A, gst(1), { mode: "auto" });
    advance(2 * D); provider.status = "Cancelled";
    const r = await svc.verify(A, gst(1), { mode: "refresh" });
    expect(r).toMatchObject({ outcome: "CANCELLED", freshness: "live" }); expect(provider.verifyCalls).toBe(2); expect(await used()).toBe(2);
    expect(await svc.verify(A, gst(1), { mode: "auto" })).toMatchObject({ outcome: "CANCELLED", staleness: "fresh" });
  });
  it("a failed refresh keeps the stored answer untouched and reports the failure with lastKnown", async () => {
    const svc = mk(); await svc.verify(A, gst(1), { mode: "auto" });
    advance(2 * D); provider.failAll = new ProviderError("GST_PROVIDER_TIMEOUT", "x", true);
    const r = await svc.verify(A, gst(1), { mode: "refresh" });
    expect(r).toMatchObject({ outcome: "TIMEOUT", freshness: "none" }); expect(r.lastKnown).toMatchObject({ outcome: "ACTIVE" });
    expect((await svc.recent(A))[0]).toMatchObject({ outcome: "ACTIVE" }); expect(await used()).toBe(1); // refunded
  });
  it("expired: a live check is required (blocking) — nothing stale is shown as a result", async () => {
    const svc = mk(); await svc.verify(A, gst(1), { mode: "auto" });
    advance(8 * D);
    expect(await svc.verify(A, gst(1), { mode: "auto" })).toMatchObject({ freshness: "live" }); expect(provider.verifyCalls).toBe(2);
  });
  it("no mode (bulk, legacy strict): fresh → stored, stale → live, never stale-while-refresh", async () => {
    const svc = mk(); await svc.verify(A, gst(1));
    advance(3 * H); expect((await svc.verify(A, gst(1))).freshness).toBe("cached");
    advance(2 * D); const v = await svc.verify(A, gst(1));
    expect(v.freshness).toBe("live"); expect(v.refreshRecommended).toBeUndefined(); expect(provider.verifyCalls).toBe(2);
  });
  it("explicit live always asks the provider, even for a fresh answer", async () => {
    const svc = mk(); await svc.verify(A, gst(1), { mode: "auto" });
    expect((await svc.verify(A, gst(1), { mode: "live" })).freshness).toBe("live"); expect(provider.verifyCalls).toBe(2);
    expect((await svc.verify(A, gst(1), { force: true })).freshness).toBe("live"); // legacy spelling
  });
  it("the windows are configuration, not constants", async () => {
    const svc = mk({ policy: { ...DEFAULT_VERIFICATION_POLICY, freshMs: H, staleUsableMs: 2 * H } });
    await svc.verify(A, gst(1), { mode: "auto" });
    advance(30 * 60_000); expect((await svc.verify(A, gst(1), { mode: "auto" })).staleness).toBe("fresh");
    advance(60 * 60_000); expect((await svc.verify(A, gst(1), { mode: "auto" })).staleness).toBe("stale");
    advance(2 * H); expect((await svc.verify(A, gst(1), { mode: "auto" })).freshness).toBe("live");
  });
  it("env parsing: defaults, overrides, and stale window never shorter than fresh", () => {
    expect(verificationPolicy({}).freshMs).toBe(24 * H);
    const p = verificationPolicy({ VERIFY_FRESH_MS: String(10 * H), VERIFY_STALE_USABLE_MS: String(H), VERIFY_DOWN_CONSECUTIVE: "3", VERIFY_DEGRADED_FAILURE_RATE: "5" });
    expect(p.staleUsableMs).toBeGreaterThanOrEqual(p.freshMs); expect(p.downConsecutiveFailures).toBe(3); expect(p.degradedFailureRate).toBe(1); expect(p.verified).toBe(false);
    expect(verificationPolicy({ VERIFY_FRESH_MS: "nope" }).freshMs).toBe(24 * H);
  });
  it("NOT_FOUND is never served from storage (always re-asked)", async () => {
    provider.failFor.set(gst(9), new ProviderError("GST_PROVIDER_NOT_FOUND", "x", false));
    const svc = mk(); await svc.verify(A, gst(9), { mode: "auto" }); await svc.verify(A, gst(9), { mode: "auto" });
    expect(provider.verifyCalls).toBe(2);
  });
});

describe("refresh must never break the instant result (quota, subscription)", () => {
  it("stale + quota exhausted: stored answer shown, refresh skipped for quota (not recommended)", async () => {
    await seedOrg(store, "f", "free"); const F = ctxFor("f", "ACCOUNTANT"); const svc = mk();
    await svc.verify(F, gst(1), { mode: "auto" }); for (let i = 2; i <= PLANS.free.monthlyChecks!; i++) await svc.verify(F, gst(i), { mode: "auto" });
    advance(2 * D);
    const v = await svc.verify(F, gst(1), { mode: "auto" });
    expect(v).toMatchObject({ freshness: "cached", staleness: "stale", refreshSkipped: "quota" }); expect(v.refreshRecommended).toBeUndefined();
  });
  it("a refresh request on an exhausted quota returns the stored answer instead of an error; an auto request that needs live still errors", async () => {
    await seedOrg(store, "f", "free"); const F = ctxFor("f", "ACCOUNTANT"); const svc = mk();
    for (let i = 1; i <= PLANS.free.monthlyChecks!; i++) await svc.verify(F, gst(i), { mode: "auto" });
    advance(2 * D);
    const r = await svc.verify(F, gst(1), { mode: "refresh" });
    expect(r).toMatchObject({ freshness: "cached", refreshSkipped: "quota", outcome: "ACTIVE" });
    await expect(svc.verify(F, gst(500), { mode: "auto" })).rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });
  });
  it("stale + read-only subscription: served with refresh skipped", async () => {
    const svc = mk(); await svc.verify(A, gst(1), { mode: "auto" });
    advance(2 * D); await store.updateOrg("a", { subscriptionStatus: "expired" });
    expect(await svc.verify(A, gst(1), { mode: "auto" })).toMatchObject({ staleness: "stale", refreshSkipped: "quota" });
  });
});

describe("ProviderHealth", () => {
  let t = 0; const mkh = (over = {}) => new ProviderHealth({ ...DEFAULT_VERIFICATION_POLICY, ...over }, () => t);
  beforeEach(() => { t = 1_000_000; });
  it("no data is healthy (we do not assume the worst)", () => { expect(mkh().snapshot()).toMatchObject({ state: "healthy", samples: 0, successRate: null }); });
  it("failure share over the threshold degrades; a few failures among many successes do not", () => {
    const h = mkh(); for (let i = 0; i < 7; i++) h.record(true, 500); h.record(false, 500); expect(h.snapshot().state).toBe("healthy");
    h.record(false, 500); h.record(false, 500); expect(h.snapshot()).toMatchObject({ state: "degraded", reason: "failure_rate" });
  });
  it("needs a minimum number of samples before judging", () => { const h = mkh(); h.record(false, 1); h.record(false, 1); expect(h.snapshot().state).toBe("healthy"); });
  it("slow successes degrade", () => { const h = mkh(); for (let i = 0; i < 6; i++) h.record(true, 9000); expect(h.snapshot()).toMatchObject({ state: "degraded", reason: "slow" }); });
  it("consecutive failures mean down, relax to degraded after the hold, and one success resets", () => {
    const h = mkh(); for (let i = 0; i < 5; i++) h.record(false, 100);
    expect(h.snapshot()).toMatchObject({ state: "down", reason: "consecutive_failures", consecutiveFailures: 5 });
    t += 31_000; expect(h.snapshot()).toMatchObject({ state: "degraded", reason: "recovering" });
    h.record(true, 100); expect(h.snapshot().consecutiveFailures).toBe(0); expect(h.snapshot().state).not.toBe("down");
  });
  it("an open breaker is down regardless of samples", () => {
    const h = new ProviderHealth(DEFAULT_VERIFICATION_POLICY, () => t, () => true); expect(h.snapshot()).toMatchObject({ state: "down", reason: "breaker_open" });
  });
  it("old samples fall out of the window", () => {
    const h = mkh(); for (let i = 0; i < 6; i++) h.record(false, 1); t += 6 * 60_000; expect(h.snapshot()).toMatchObject({ samples: 0 });
  });
  it("probes are rate-limited", () => {
    const h = mkh(); expect(h.tryProbe()).toBe(true); expect(h.tryProbe()).toBe(false); t += 10_001; expect(h.tryProbe()).toBe(true);
  });
});

describe("provider health steers what the engine spends", () => {
  const timeout = () => new ProviderError("GST_PROVIDER_TIMEOUT", "x", true);
  async function breakIt(svc: VerificationService) { provider.failAll = timeout(); for (let i = 0; i < 5; i++) await svc.verify(A, gst(100 + i), { mode: "live" }); provider.failAll = null; }

  it("down: auto needing live fails fast with MAINTENANCE and no provider call, no quota", async () => {
    const svc = mk(); await breakIt(svc); expect(svc.providerHealth().state).toBe("down");
    const calls = provider.verifyCalls;
    const v = await svc.verify(A, gst(1), { mode: "auto" });
    expect(v).toMatchObject({ outcome: "MAINTENANCE", retryable: true, providerHealth: "down" }); expect(provider.verifyCalls).toBe(calls); expect(await used()).toBe(0);
  });
  it("down (just now): stale served with refreshSkipped=provider_down; silent refresh is skipped, not failed", async () => {
    const svc = mk({ policy: { ...DEFAULT_VERIFICATION_POLICY, freshMs: 60_000, staleUsableMs: 7 * D } });
    await svc.verify(A, gst(1), { mode: "auto" }); advance(120_000); await breakIt(svc); expect(svc.providerHealth().state).toBe("down");
    const calls = provider.verifyCalls;
    expect(await svc.verify(A, gst(1), { mode: "auto" })).toMatchObject({ staleness: "stale", refreshSkipped: "provider_down", freshness: "cached" });
    expect(await svc.verify(A, gst(1), { mode: "refresh" })).toMatchObject({ staleness: "stale", refreshSkipped: "provider_down", freshness: "cached" });
    expect(provider.verifyCalls).toBe(calls);
  });
  it("degraded: stale is served but not refreshed; a user who needs a live answer still gets one", async () => {
    const svc = mk({ policy: { ...DEFAULT_VERIFICATION_POLICY, freshMs: 60_000 } });
    await svc.verify(A, gst(1), { mode: "auto" }); advance(120_000);
    for (let i = 0; i < 6; i++) health.record(i % 2 === 0, 200); // 50% failures
    expect(svc.providerHealth().state).toBe("degraded");
    expect(await svc.verify(A, gst(1), { mode: "auto" })).toMatchObject({ staleness: "stale", refreshSkipped: "provider_degraded" });
    expect(await svc.verify(A, gst(2), { mode: "auto" })).toMatchObject({ freshness: "live", providerHealth: "degraded" });
  });
  it("down: an explicit live check may probe at most once per probe interval, and recovery clears the state", async () => {
    const svc = mk(); await breakIt(svc);
    const first = await svc.verify(A, gst(1), { mode: "live" });  // probe allowed → reaches provider (now healthy again)
    expect(first.outcome).toBe("ACTIVE");
    expect(svc.providerHealth().consecutiveFailures).toBe(0);
  });
  it("down: second explicit live inside the probe interval fails fast", async () => {
    const svc = mk(); await breakIt(svc); provider.failAll = timeout();
    await svc.verify(A, gst(1), { mode: "live" });               // probe (fails)
    const calls = provider.verifyCalls;
    expect((await svc.verify(A, gst(2), { mode: "live" })).outcome).toBe("MAINTENANCE"); expect(provider.verifyCalls).toBe(calls);
    advance(10_001); await svc.verify(A, gst(3), { mode: "live" }); expect(provider.verifyCalls).toBeGreaterThan(calls); // next probe allowed
  });
  it("NOT_FOUND counts as a healthy answer; our own rate limiting is not evidence either way", async () => {
    const svc = mk();
    for (let i = 0; i < 6; i++) { provider.failFor.set(gst(200 + i), new ProviderError("GST_PROVIDER_NOT_FOUND", "x", false)); await svc.verify(A, gst(200 + i), { mode: "live" }); }
    expect(svc.providerHealth()).toMatchObject({ state: "healthy", successRate: 1 });
    provider.failAll = new ProviderError("GST_PROVIDER_RATE_LIMITED", "x", false);
    for (let i = 0; i < 8; i++) await svc.verify(A, gst(300 + i), { mode: "live" });
    expect(svc.providerHealth().state).toBe("healthy");
  });
  it("bulk-style callers (held, no mode) also fail fast while the provider is down", async () => {
    const svc = mk(); await breakIt(svc); const calls = provider.verifyCalls;
    const v = await svc.verify(A, gst(1), { held: true }); expect(v.outcome).toBe("MAINTENANCE"); expect(provider.verifyCalls).toBe(calls);
  });
});

describe("in-flight de-duplication", () => {
  beforeEach(() => { provider.delayMs = 25; });
  it("N concurrent requests for the same GSTIN make ONE provider call and use ONE quota unit", async () => {
    const svc = mk();
    const views = await Promise.all(Array.from({ length: 6 }, () => svc.verify(A, gst(1), { mode: "live" })));
    expect(provider.verifyCalls).toBe(1); expect(await used()).toBe(1);
    expect(new Set(views.map((v) => v.outcome)).size).toBe(1);
    expect(views.filter((v) => v.joined).length).toBe(5); expect(views.every((v) => v.freshness === "live")).toBe(true);
    expect(new Set(views.map((v) => v.requestId)).size).toBe(6); // every caller still gets its own reference
    expect(views.every((v) => v.verifiedAt === views[0].verifiedAt)).toBe(true);
  });
  it("different users of the same organization join the same attempt", async () => {
    const svc = mk();
    await Promise.all([svc.verify(ctxFor("a", "ACCOUNTANT"), gst(1), { mode: "live" }), svc.verify(ctxFor("a", "ADMIN"), gst(1), { mode: "auto" }), svc.verify(ctxFor("a", "OWNER"), gst(1), { mode: "auto" })]);
    expect(provider.verifyCalls).toBe(1);
  });
  it("never joins across organizations or across GSTINs", async () => {
    const svc = mk();
    await Promise.all([svc.verify(A, gst(1), { mode: "live" }), svc.verify(ctxFor("b", "ACCOUNTANT"), gst(1), { mode: "live" }), svc.verify(A, gst(2), { mode: "live" })]);
    expect(provider.verifyCalls).toBe(3);
  });
  it("joiners share a failure (one attempt, one refund) and nothing is left stuck afterwards", async () => {
    const svc = mk(); provider.failAll = new ProviderError("GST_PROVIDER_TIMEOUT", "x", true);
    const views = await Promise.all(Array.from({ length: 4 }, () => svc.verify(A, gst(1), { mode: "live" })));
    expect(views.every((v) => v.outcome === "TIMEOUT")).toBe(true); expect(await used()).toBe(0);
    provider.failAll = null; provider.verifyCalls = 0;
    expect((await svc.verify(A, gst(1), { mode: "live" })).outcome).toBe("ACTIVE"); expect(provider.verifyCalls).toBe(1); // a new attempt, not the old flight
  });
  it("quota failure rejects every joiner and clears the flight", async () => {
    await seedOrg(store, "f", "free"); const F = ctxFor("f", "ACCOUNTANT"); const svc = mk();
    provider.delayMs = 0; for (let i = 1; i <= PLANS.free.monthlyChecks!; i++) await svc.verify(F, gst(i), { mode: "live" }); provider.delayMs = 25;
    const settled = await Promise.allSettled(Array.from({ length: 3 }, () => svc.verify(F, gst(900), { mode: "live" })));
    expect(settled.every((s) => s.status === "rejected")).toBe(true);
    const again = await Promise.allSettled([svc.verify(F, gst(900), { mode: "live" })]); expect(again[0].status).toBe("rejected"); // not hung on a dead flight
  });
  it("a bulk joiner (holding its own unit) is told the answer was stored so its unit is released, not consumed", async () => {
    const svc = mk();
    const [lead, bulk] = await Promise.all([svc.verify(A, gst(1), { mode: "live" }), svc.verify(A, gst(1), { held: true })]);
    expect(lead.freshness).toBe("live"); expect(bulk).toMatchObject({ joined: true, freshness: "cached" }); expect(await used()).toBe(1);
  });
  it("metrics show the saving: one provider call, five avoided", async () => {
    const svc = mk(); await Promise.all(Array.from({ length: 6 }, () => svc.verify(A, gst(1), { mode: "live" })));
    expect(svc.health(ctxFor("a", "OWNER"))).toMatchObject({ providerCalls: 1, joined: 5, callsAvoided: 5 });
  });
});

describe("metrics: provider calls vs calls avoided", () => {
  it("counts live calls, stored hits and stale-served separately", async () => {
    const svc = mk(); await svc.verify(A, gst(1), { mode: "auto" }); await svc.verify(A, gst(1), { mode: "auto" });
    advance(2 * D); await svc.verify(A, gst(1), { mode: "auto" });
    expect(svc.health(ctxFor("a", "OWNER"))).toMatchObject({ providerCalls: 1, callsAvoided: 2, staleServed: 1, total: 3 });
  });
});

describe("mode validation", () => {
  it("only the three modes are valid", () => { expect(["auto", "refresh", "live"].every(isVerifyMode)).toBe(true); expect([undefined, "x", 1, null].some(isVerifyMode)).toBe(false); });
});
