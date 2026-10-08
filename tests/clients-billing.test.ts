import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { ClientService } from "@/services/clients";
import { SubscriptionService } from "@/services/subscription";
import { CheckService } from "@/services/checks";
import { GstinQueryService } from "@/services/queries";
import { PLANS } from "@/config/plans";
import { ForbiddenError } from "@/lib/permissions";
import { MockGstProvider } from "@/providers/mock";
import { ctxFor, gst, NOW, seedOrg } from "./helpers";

let store: MemoryStore, clients: ClientService, subs: SubscriptionService;
const O = (org: string) => ctxFor(org, "OWNER");
const add = (org: string, n: number, start = 1) => Promise.all(Array.from({ length: n }, (_, i) => clients.create(O(org), { name: `C${start + i}`, gstin: gst(start + i) })));
const seq = async (org: string, n: number, start = 1) => { const out = []; for (let i = 0; i < n; i++) out.push(await clients.create(O(org), { name: `C${start + i}`, gstin: gst(start + i) })); return out; };

beforeEach(async () => {
  store = new MemoryStore(); clients = new ClientService(store, () => NOW); subs = new SubscriptionService(store, () => NOW);
  await seedOrg(store, "free", "free"); await seedOrg(store, "st", "starter"); await seedOrg(store, "pro", "professional"); await seedOrg(store, "other", "starter");
});

describe("archive / restore: archived clients are not billed, listed, checked or counted", () => {
  it("archiving drops the client from the active count, the default list and the GSTIN views, but keeps all data", async () => {
    const [a, b, c] = await seq("st", 3);
    const archived = await clients.archive(O("st"), b.id);
    expect(archived.status).toBe("archived");
    expect(await store.countClients("st")).toBe(2); expect(await store.countClients("st", "archived")).toBe(1);
    expect((await clients.list(O("st"))).items.map((x) => x.id).sort()).toEqual([a.id, c.id].sort());
    expect((await clients.list(O("st"), { status: "archived" })).items.map((x) => x.id)).toEqual([b.id]);
    expect((await clients.list(O("st"), { status: "all" })).items).toHaveLength(3);
    expect((await clients.get(O("st"), b.id)).name).toBe("C2");                   // nothing deleted
    const q = new GstinQueryService(store);
    expect((await q.list(O("st"), {})).items.map((x) => x.gstin)).not.toContain(gst(2));
    expect(await store.countGstins("st", {})).toBe(2); expect(await store.countGstins("st", { archived: true })).toBe(1);
    expect((await store.getGstinRecord("st", gst(2)))).toMatchObject({ archived: true });
  });
  it("archive and restore are idempotent, audited, and restore brings everything back", async () => {
    const [a] = await seq("st", 1);
    await clients.archive(O("st"), a.id); await clients.archive(O("st"), a.id);
    expect(await store.countClients("st", "archived")).toBe(1);
    await clients.restore(O("st"), a.id); await clients.restore(O("st"), a.id);
    expect(await store.countClients("st")).toBe(1); expect(await store.countGstins("st", {})).toBe(1);
    expect((await store.getGstinRecord("st", gst(1)))!.archived).toBeUndefined();
    const actions = (await store.listAudit("st", 20)).map((e) => e.action);
    expect(actions.filter((x) => x === "CLIENT_ARCHIVED")).toHaveLength(1); expect(actions.filter((x) => x === "CLIENT_RESTORED")).toHaveLength(1);
  });
  it("an archived client cannot be checked (otherwise archiving would be a free way to keep using the service)", async () => {
    const [a] = await seq("st", 1);
    const checks = new CheckService(store, new MockGstProvider({ now: () => NOW }), undefined, () => NOW);
    await checks.checkClient(O("st"), a.id);
    await clients.archive(O("st"), a.id);
    await expect(checks.checkClient(O("st"), a.id)).rejects.toMatchObject({ code: "CLIENT_ARCHIVED", status: 409 });
    await clients.restore(O("st"), a.id);
    await expect(checks.checkClient(O("st"), a.id, { force: true })).resolves.toBeTruthy();
  });
  it("needs clients:write, a writable subscription, and stays inside the organization", async () => {
    const [a] = await seq("st", 1); const o = await seq("other", 1, 50);
    await expect(clients.archive(ctxFor("st", "VIEWER"), a.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(clients.archive(O("st"), o[0].id)).rejects.toMatchObject({ code: "CLIENT_NOT_FOUND" });          // another org's client
    await store.updateOrg("st", { subscriptionStatus: "cancelled" });
    await expect(clients.archive(O("st"), a.id)).rejects.toMatchObject({ code: "SUBSCRIPTION_INACTIVE" });
  });
  it("Free: archiving frees a slot (only active clients count), and restore respects the cap", async () => {
    const cap = PLANS.free.clientLimit!;
    const made = await seq("free", cap);
    await expect(clients.create(O("free"), { name: "over", gstin: gst(100) })).rejects.toMatchObject({ code: "CLIENT_LIMIT_REACHED", status: 402 });
    await clients.archive(O("free"), made[0].id);
    const extra = await clients.create(O("free"), { name: "fits now", gstin: gst(100) });     // total records = cap + 1, active = cap
    expect(await store.countClients("free")).toBe(cap);
    await expect(clients.restore(O("free"), made[0].id)).rejects.toMatchObject({ code: "CLIENT_LIMIT_REACHED" });
    await clients.archive(O("free"), extra.id);
    await expect(clients.restore(O("free"), made[0].id)).resolves.toMatchObject({ status: "active" });
  });
  it("archived GSTINs still block duplicates (the GSTIN exists in this organization)", async () => {
    const [a] = await seq("st", 1); await clients.archive(O("st"), a.id);
    await expect(clients.create(O("st"), { name: "again", gstin: gst(1) })).rejects.toMatchObject({ code: "DUPLICATE_GSTIN" });
  });
});

describe("paid plans bill extra clients instead of blocking them", () => {
  it("Starter keeps accepting clients past the 25 included; the bill follows the ACTIVE count", async () => {
    const made = await seq("st", 30);
    const o1 = await subs.overview(O("st"));
    expect(o1.clients).toMatchObject({ used: 30, archived: 0, included: 25 });
    expect(o1.pricing.bill).toMatchObject({ planId: "starter", totalInr: 499 + 5 * 18, extraClients: 5, period: "monthly" });
    for (const c of made.slice(0, 10)) await clients.archive(O("st"), c.id);                // 20 active left
    const o2 = await subs.overview(O("st"));
    expect(o2.clients).toMatchObject({ used: 20, archived: 10 }); expect(o2.pricing.bill).toMatchObject({ totalInr: 499, extraClients: 0 });
  });
  it("Professional: the bill, the 'next client' preview, and the annual period", async () => {
    await add("pro", 55);                                                                   // 5 above the 50 included
    const o = await subs.overview(O("pro"));
    expect(o.pricing.bill.totalInr).toBe(999 + 5 * 12);
    expect(o.pricing.nextClient).toEqual({ deltaInr: 12, newTotalInr: 999 + 6 * 12, blocked: false });
    await store.updateOrg("pro", { billingPeriod: "annual" });
    const a = await subs.overview(O("pro"));
    expect(a.pricing.period).toBe("annual"); expect(a.pricing.bill).toMatchObject({ totalInr: 9999 + 5 * 12 * 10, annualSavingInr: expect.any(Number) });
    expect(a.pricing.nextClient.deltaInr).toBe(120);
  });
  it("Free: bill is ₹0 and the next client is blocked at the cap", async () => {
    await seq("free", PLANS.free.clientLimit!);
    const o = await subs.overview(O("free"));
    expect(o.pricing.bill).toMatchObject({ totalInr: 0, overCap: false }); expect(o.pricing.nextClient).toMatchObject({ blocked: true, blockedBy: "plan_cap" });
  });
  it("points out a cheaper plan when one exists for the current count (price only)", async () => {
    await add("pro", 40);                                                                   // Professional 999 vs Starter 499 + 15*18 = 769
    const o = await subs.overview(O("pro"));
    expect(o.pricing.cheaper).toEqual({ planId: "starter", totalInr: 769, savingInr: 230 });
    await add("st", 10);
    expect((await subs.overview(O("st"))).pricing.cheaper).toBeUndefined();                 // already the cheapest
  });
  it("the dashboard-facing client count is the active count", async () => {
    const made = await seq("st", 4); await clients.archive(O("st"), made[0].id);
    expect((await subs.overview(O("st"))).clients.used).toBe(3);
  });
});

describe("store contract-ish: counts and filters", () => {
  it("countClients / listClients default to active; archived and all on request; org-scoped", async () => {
    const made = await seq("st", 3); await seq("other", 2, 80);
    await clients.archive(O("st"), made[1].id);
    expect(await store.countClients("st")).toBe(2); expect(await store.countClients("st", "archived")).toBe(1); expect(await store.countClients("other")).toBe(2);
    expect((await store.listClients("st", { limit: 10 })).items).toHaveLength(2);
    expect((await store.listClients("st", { limit: 10, status: "all" })).items).toHaveLength(3);
    expect((await store.listClients("st", { limit: 10, status: "archived" })).items.map((c) => c.id)).toEqual([made[1].id]);
  });
});
