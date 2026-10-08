import { PLANS } from "@/config/plans";
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { ClientService } from "@/services/clients";
import { CheckService, DEFAULT_CHECK_OPTIONS } from "@/services/checks";
import { computeGstinChecksum } from "@/lib/gstin";
import { ResilientProvider } from "@/providers/gate";
import { resolveCtx, toErrorBody, AppError, type Ctx } from "@/lib/errors";
import { MockGstProvider } from "@/providers/mock";
import { ProviderError, type GstProvider, type GstinResult, type GstinStatus } from "@/providers/types";
import { currentMonthKey } from "@/lib/dates";
import type { Role } from "@/lib/permissions";
import type { PlanId, SubscriptionStatus } from "@/config/plans";

const NOW = new Date("2026-10-06T05:00:00Z");
const gst = (n: number) => { const b = `24AAAAA${String(n).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };

async function seedOrg(store: MemoryStore, id: string, plan: PlanId = "free", status: SubscriptionStatus = "active") {
  await store.createOrg({ id, name: id, ownerId: `${id}-owner`, plan, subscriptionStatus: status, createdAt: NOW.toISOString(), billingPeriod: "monthly" },
    { uid: `${id}-owner`, email: `${id}@x.com`, role: "OWNER", addedAt: NOW.toISOString() });
  for (const role of ["ADMIN", "ACCOUNTANT", "VIEWER"] as Role[]) {
    await store.putMember(id, { uid: `${id}-${role}`, email: `${role}@${id}.com`, role, addedAt: NOW.toISOString() });
  }
}
const ctx = (org: string, role: Role): Ctx => ({ orgId: org, userId: `${org}-${role}`, role });

class StubProvider implements GstProvider {
  name = "stub"; status: GstinStatus = "Active"; fail: ProviderError | null = null; calls = 0;
  async verifyGstin(g: string): Promise<GstinResult> {
    this.calls++; if (this.fail) throw this.fail;
    return { gstin: g, status: this.status, source: "stub", checkedAt: NOW.toISOString() };
  }
  async getReturnHistory(g: string) { return { gstin: g, records: [], source: "stub", checkedAt: NOW.toISOString() }; }
}

let store: MemoryStore, clients: ClientService, provider: StubProvider, checks: CheckService;
// Throughput control now lives in ResilientProvider (retries/limiter/timeout); CheckService only does cache/quota/persistence.
const LIMITS = { requestsPerMinute: 100000, maxConcurrent: 5, timeoutMs: 15000, retries: 1, backoffBaseMs: 1, backoffMaxMs: 1, breakerFailureThreshold: 5, breakerCooldownMs: 30000, bulkConcurrency: 5, verified: false as const };
const build = (p: GstProvider = provider) => new CheckService(store, new ResilientProvider(p, LIMITS, { sleep: async () => {} }), DEFAULT_CHECK_OPTIONS, () => NOW);

beforeEach(async () => {
  store = new MemoryStore(); provider = new StubProvider();
  clients = new ClientService(store, () => NOW); checks = build();
  await seedOrg(store, "A"); await seedOrg(store, "B");
});

describe("tenant isolation", () => {
  it("org B cannot read/update/delete/check org A clients", async () => {
    const c = await clients.create(ctx("A", "OWNER"), { name: "Acme", gstin: gst(1) });
    await expect(clients.get(ctx("B", "OWNER"), c.id)).rejects.toMatchObject({ code: "CLIENT_NOT_FOUND" });
    await expect(clients.update(ctx("B", "OWNER"), c.id, { name: "x" })).rejects.toMatchObject({ code: "CLIENT_NOT_FOUND" });
    await expect(clients.remove(ctx("B", "OWNER"), c.id)).rejects.toMatchObject({ code: "CLIENT_NOT_FOUND" });
    await expect(checks.checkClient(ctx("B", "OWNER"), c.id)).rejects.toMatchObject({ code: "CLIENT_NOT_FOUND" });
    expect((await clients.list(ctx("B", "OWNER"))).items).toHaveLength(0);
    expect((await clients.list(ctx("A", "OWNER"))).items).toHaveLength(1);
    expect(provider.calls).toBe(0);
  });
  it("same GSTIN can exist in two orgs; usage is per-org", async () => {
    const a = await clients.create(ctx("A", "OWNER"), { name: "Acme", gstin: gst(1) });
    const b = await clients.create(ctx("B", "OWNER"), { name: "Acme", gstin: gst(1) });
    await checks.checkClient(ctx("A", "OWNER"), a.id);
    expect((await store.usage.get("A", currentMonthKey(NOW)))?.used).toBe(1);
    expect(await store.usage.get("B", currentMonthKey(NOW))).toBeNull();
    expect(b.id).not.toBe(a.id);
  });
  it("tenant is derived from membership, not input", async () => {
    expect(await resolveCtx(store, "A-VIEWER")).toEqual({ orgId: "A", userId: "A-VIEWER", role: "VIEWER" });
    await expect(resolveCtx(store, undefined)).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    await expect(resolveCtx(store, "stranger")).rejects.toMatchObject({ code: "NO_ORGANIZATION" });
  });
});

describe("role enforcement", () => {
  it("viewer is read-only", async () => {
    const c = await clients.create(ctx("A", "ACCOUNTANT"), { name: "Acme", gstin: gst(1) });
    await expect(clients.create(ctx("A", "VIEWER"), { name: "x", gstin: gst(2) })).rejects.toThrow();
    await expect(clients.update(ctx("A", "VIEWER"), c.id, { name: "x" })).rejects.toThrow();
    await expect(clients.remove(ctx("A", "VIEWER"), c.id)).rejects.toThrow();
    await expect(checks.checkClient(ctx("A", "VIEWER"), c.id)).rejects.toThrow();
    expect((await clients.get(ctx("A", "VIEWER"), c.id)).name).toBe("Acme");
  });
});

describe("client management", () => {
  it("validates GSTIN, rejects duplicates, enforces assignee and plan limit", async () => {
    const o = ctx("A", "OWNER");
    await expect(clients.create(o, { name: "x", gstin: "BAD" })).rejects.toMatchObject({ code: "INVALID_GSTIN" });
    await clients.create(o, { name: "x", gstin: gst(1).toLowerCase() });
    await expect(clients.create(o, { name: "y", gstin: gst(1) })).rejects.toMatchObject({ code: "DUPLICATE_GSTIN" });
    await expect(clients.create(o, { name: "y", gstin: gst(2), assignedTo: "B-OWNER" })).rejects.toMatchObject({ code: "INVALID_ASSIGNEE" });
    const cap = PLANS.free.clientLimit!; // Free is the only plan with a tight cap now; paid plans bill extra clients instead
    for (let i = 2; i <= cap; i++) await clients.create(o, { name: `c${i}`, gstin: gst(i) });
    await expect(clients.create(o, { name: "over", gstin: gst(cap + 1) })).rejects.toMatchObject({ code: "CLIENT_LIMIT_REACHED" });
  });
  it("GSTIN is immutable on update; paginates", async () => {
    const o = ctx("A", "OWNER");
    await store.updateOrg("A", { plan: "starter" }); // more than the Free cap of clients
    const c = await clients.create(o, { name: "x", gstin: gst(1) });
    await clients.update(o, c.id, { name: "renamed", gstin: gst(9) } as never);
    const got = await clients.get(o, c.id);
    expect(got.name).toBe("renamed"); expect(got.gstin).toBe(gst(1));
    for (let i = 2; i <= 7; i++) await clients.create(o, { name: `c${i}`, gstin: gst(i) });
    const p1 = await clients.list(o, { limit: 5 });
    expect(p1.items).toHaveLength(5); expect(p1.nextCursor).toBeTruthy();
    const p2 = await clients.list(o, { limit: 5, cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(2); expect(p2.nextCursor).toBeUndefined();
  });
  it("read-only when subscription cancelled; data retained", async () => {
    const c = await clients.create(ctx("A", "OWNER"), { name: "x", gstin: gst(1) });
    await store.updateOrg("A", { subscriptionStatus: "cancelled" });
    await expect(clients.create(ctx("A", "OWNER"), { name: "y", gstin: gst(2) })).rejects.toMatchObject({ code: "SUBSCRIPTION_INACTIVE" });
    await expect(checks.checkClient(ctx("A", "OWNER"), c.id)).rejects.toMatchObject({ code: "SUBSCRIPTION_INACTIVE" });
    expect((await clients.get(ctx("A", "VIEWER"), c.id)).id).toBe(c.id);
  });
});

describe("GST checks", () => {
  it("uses cache, consumes quota only for live calls, force refreshes", async () => {
    const c = await clients.create(ctx("A", "OWNER"), { name: "x", gstin: gst(1) });
    const o = ctx("A", "ACCOUNTANT"), m = currentMonthKey(NOW);
    const r1 = await checks.checkClient(o, c.id);
    expect(r1.cached).toBe(false); expect(r1.record.status).toBe("Active"); expect(r1.record.lastCheckedAt).toBeTruthy();
    const calls = provider.calls;
    const r2 = await checks.checkClient(o, c.id);
    expect(r2.cached).toBe(true); expect(provider.calls).toBe(calls);
    expect(await store.usage.get("A", m)).toMatchObject({ used: 1, cachedChecks: 1 });
    await checks.checkClient(o, c.id, { force: true });
    expect((await store.usage.get("A", m))?.used).toBe(2);
    expect((await store.getClient("A", c.id))?.lastCheckedAt).toBeTruthy();
  });
  it("cache expires", async () => {
    const c = await clients.create(ctx("A", "OWNER"), { name: "x", gstin: gst(1) });
    await checks.checkClient(ctx("A", "OWNER"), c.id);
    const later = new CheckService(store, provider, DEFAULT_CHECK_OPTIONS, () => new Date(NOW.getTime() + 25 * 3600e3));
    expect((await later.checkClient(ctx("A", "OWNER"), c.id)).cached).toBe(false);
  });
  it("quota cannot be bypassed, even with concurrency", async () => {
    const o = ctx("A", "OWNER");
    const list: { id: string }[] = [];
    const quota = PLANS.free.monthlyChecks!, n = PLANS.free.clientLimit!;
    for (let i = 1; i <= n; i++) list.push(await clients.create(o, { name: `c${i}`, gstin: gst(i) }));
    const res = await Promise.allSettled(Array.from({ length: quota + 30 }, (_, i) => checks.checkClient(o, list[i % n].id, { force: true })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(quota);
    expect(res.filter((r) => r.status === "rejected" && (r.reason as { code: string }).code === "QUOTA_EXHAUSTED")).toHaveLength(30);
    expect((await store.usage.get("A", currentMonthKey(NOW)))?.used).toBe(quota);
    expect((await store.listAlerts("A", 100)).some((a) => a.type === "QUOTA_EXHAUSTED")).toBe(true);
    expect(provider.calls).toBe(PLANS.free.monthlyChecks);
  });
  it("provider failure: refund, keep prior status, alert, structured error", async () => {
    const c = await clients.create(ctx("A", "OWNER"), { name: "x", gstin: gst(1) });
    await checks.checkClient(ctx("A", "OWNER"), c.id);
    provider.fail = new ProviderError("GST_PROVIDER_TIMEOUT", "GST provider did not respond in time.", true);
    const err = await checks.checkClient(ctx("A", "OWNER"), c.id, { force: true }).catch((e) => e);
    expect(err.code).toBe("GST_PROVIDER_TIMEOUT");
    const u = await store.usage.get("A", currentMonthKey(NOW));
    expect(u).toMatchObject({ used: 1, failedRequests: 1 });
    const rec = await store.getGstinRecord("A", gst(1));
    expect(rec?.status).toBe("Active"); expect(rec?.lastError?.code).toBe("GST_PROVIDER_TIMEOUT");
    expect((await store.listAlerts("A", 10)).some((a) => a.type === "API_FAILURE")).toBe(true);
    expect(toErrorBody(err)).toEqual({ status: 502, body: { success: false, error: { code: "GST_PROVIDER_TIMEOUT", message: "GST provider did not respond in time." } } });
  });
  it("retries transient failure then succeeds, consuming one unit", async () => {
    const c = await clients.create(ctx("A", "OWNER"), { name: "x", gstin: gst(1) });
    let n = 0;
    const flaky: GstProvider = {
      name: "flaky",
      verifyGstin: async (g) => { if (n++ === 0) throw new ProviderError("GST_PROVIDER_UNAVAILABLE", "down", true); return provider.verifyGstin(g); },
      getReturnHistory: (g) => provider.getReturnHistory(g),
    };
    const r = await build(flaky).checkClient(ctx("A", "OWNER"), c.id);
    expect(r.record.status).toBe("Active");
    expect((await store.usage.get("A", currentMonthKey(NOW)))?.used).toBe(1);
  });
  it("status change creates alerts; Unknown first result does not", async () => {
    const c = await clients.create(ctx("A", "OWNER"), { name: "x", gstin: gst(1) });
    await checks.checkClient(ctx("A", "OWNER"), c.id);
    expect(await store.listAlerts("A", 10)).toHaveLength(0);
    provider.status = "Suspended";
    await checks.checkClient(ctx("A", "OWNER"), c.id, { force: true });
    const types = (await store.listAlerts("A", 10)).map((a) => a.type);
    expect(types).toContain("GSTIN_STATUS_CHANGED"); expect(types).toContain("GSTIN_SUSPENDED");
  });
  it("works end-to-end with the mock provider and writes audit log", async () => {
    const c = await clients.create(ctx("A", "OWNER"), { name: "x", gstin: gst(1) });
    const svc = build(new MockGstProvider({ now: () => NOW }));
    const r = await svc.checkClient(ctx("A", "OWNER"), c.id);
    expect(r.record.source).toBe("mock");
    expect((await store.listReturns("A", gst(1))).length).toBeGreaterThan(0);
    expect((await store.listAudit("A", 10)).map((a) => a.action)).toEqual(expect.arrayContaining(["CLIENT_CREATED", "GST_CHECK"]));
  });
});

describe("error mapping", () => {
  it("never leaks internals", () => {
    const r = toErrorBody(new Error("secret db password at /srv/app.js:12"));
    expect(r.status).toBe(500); expect(JSON.stringify(r.body)).not.toMatch(/secret|srv|password/);
    expect(toErrorBody(new AppError("X", "m", 418)).status).toBe(418);
  });
});
