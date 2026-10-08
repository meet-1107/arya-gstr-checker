import { PLANS } from "@/config/plans";
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { ClientService } from "@/services/clients";
import { CheckService, DEFAULT_CHECK_OPTIONS } from "@/services/checks";
import { GstinQueryService, ReturnsQueryService } from "@/services/queries";
import { DashboardService } from "@/services/dashboard";
import { SubscriptionService } from "@/services/subscription";
import { currentMonthKey } from "@/lib/dates";
import type { GstinStatus, ReturnRecord } from "@/providers/types";
import type { Indicator } from "@/lib/compliance";
import { NOW, StubProvider, ctxFor, gst, seedClients, seedOrg, TRANSIENT } from "./helpers";
import { ProviderError } from "@/providers/types";

const clock = () => NOW;
let store: MemoryStore, gq: GstinQueryService, rq: ReturnsQueryService, clients: ClientService, stub: StubProvider, checks: CheckService;
const A = ctxFor("A", "OWNER"), B = ctxFor("B", "OWNER");

beforeEach(async () => {
  store = new MemoryStore(); stub = new StubProvider();
  gq = new GstinQueryService(store, clock); rq = new ReturnsQueryService(store);
  clients = new ClientService(store, clock); checks = new CheckService(store, stub, DEFAULT_CHECK_OPTIONS, clock);
  await seedOrg(store, "A"); await seedOrg(store, "B");
});

const STATUSES: GstinStatus[] = ["Active", "Active", "Active", "Suspended", "Cancelled", "Unknown"];
const INDS: Indicator[] = ["Good", "Needs Attention", "High Attention", "Data Unavailable"];

describe("GSTIN list / filter / sort / pagination", () => {
  beforeEach(async () => {
    await seedClients(store, "A", 30, 1, (i) => ({
      status: STATUSES[i % STATUSES.length], indicator: INDS[i % INDS.length], assignedTo: i % 2 ? "A-ACCOUNTANT" : "A-ADMIN",
      checked: i % 3 !== 0,
      ...(i % 3 !== 0 ? { lastCheckedAt: new Date(NOW.getTime() - i * 3600e3).toISOString(), cacheExpiresAt: new Date(NOW.getTime() + (i % 2 ? 1 : -1) * 3600e3).toISOString() } : {}),
      gstr1Missing: i % 4 === 0 ? 2 : 0, gstr3bMissing: i % 5 === 0 ? 1 : 0, gstr1Late: i % 7 === 0 ? 1 : 0,
    }));
  });

  it("paginates the whole set without duplicates or gaps and clamps limit", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await gq.list(A, { limit: "8", ...(cursor ? { cursor } : {}) });
      seen.push(...r.items.map((i) => i.gstin)); cursor = r.nextCursor; pages++;
    } while (cursor);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(30);
    expect(new Set(seen).size).toBe(30);
    expect([...seen]).toEqual([...seen].sort());
    expect((await gq.list(A, { limit: "100000" })).items).toHaveLength(30);
    expect((await gq.list(A, { limit: "0" })).items.length).toBeGreaterThan(0);
  });
  it("filters: status, indicator list, assignee, checked, needsRefresh, gstr1/gstr3b, late", async () => {
    const all = (await gq.list(A, { limit: "100" })).items;
    const ids = (q: Record<string, string>) => gq.list(A, { limit: "100", ...q }).then((r) => r.items);
    expect((await ids({ status: "Suspended" })).every((i) => i.status === "Suspended")).toBe(true);
    expect((await ids({ status: "Suspended" })).length).toBe(all.filter((i) => i.status === "Suspended").length);
    expect((await ids({ indicator: "Good,High Attention" })).every((i) => i.indicator === "Good" || i.indicator === "High Attention")).toBe(true);
    expect((await ids({ assignedTo: "A-ADMIN" })).length).toBe(all.filter((i) => i.assignedTo === "A-ADMIN").length);
    expect((await ids({ checked: "false" })).length).toBe(10);
    expect((await ids({ checked: "true" })).length).toBe(20);
    const stale = await ids({ needsRefresh: "true" });
    expect(stale.length).toBeGreaterThan(0);
    expect(stale.every((i) => !i.fresh && !!i.lastCheckedAt)).toBe(true);
    expect((await ids({ gstr1: "some" })).every((i) => (i.gstr1Missing ?? 0) > 0)).toBe(true);
    expect((await ids({ gstr1: "none" })).every((i) => i.gstr1Missing === 0)).toBe(true);
    expect((await ids({ gstr3b: "some" })).length).toBe(all.filter((i) => (i.gstr3bMissing ?? 0) > 0).length);
    expect((await ids({ late: "gstr1" })).every((i) => (i.gstr1Late ?? 0) > 0)).toBe(true);
    expect((await ids({ status: "Active", gstr1: "some" })).every((i) => i.status === "Active" && (i.gstr1Missing ?? 0) > 0)).toBe(true);
  });
  it("sorts by lastCheckedAt (asc/desc) excluding never-checked, with stable cursor paging", async () => {
    const desc: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await gq.list(A, { sort: "lastCheckedAt", dir: "desc", limit: "6", ...(cursor ? { cursor } : {}) });
      desc.push(...r.items.map((i) => i.lastCheckedAt!)); cursor = r.nextCursor;
    } while (cursor);
    expect(desc).toHaveLength(20);
    expect([...desc]).toEqual([...desc].sort().reverse());
    const asc = (await gq.list(A, { sort: "lastCheckedAt", dir: "asc", limit: "100" })).items.map((i) => i.lastCheckedAt!);
    expect(asc).toEqual([...asc].sort());
  });
  it("search by GSTIN prefix or client-name prefix", async () => {
    expect((await gq.list(A, { q: gst(7).slice(0, 12) })).items.some((i) => i.gstin === gst(7))).toBe(true);
    const byName = await gq.list(A, { q: "client 1", limit: "100" });
    expect(byName.items.length).toBeGreaterThan(0);
    expect(byName.items.every((i) => i.clientName!.toLowerCase().startsWith("client 1"))).toBe(true);
    expect((await gq.list(A, { q: "zzzz" })).items).toHaveLength(0);
  });
  it("rejects invalid input with structured validation errors", async () => {
    for (const q of [{ status: "Nope" }, { indicator: "Bad" }, { sort: "name" }, { dir: "sideways" }, { gstr1: "maybe" }]) {
      await expect(gq.list(A, q)).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    }
    await expect(gq.list(A, { cursor: "%%%not-a-cursor" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});

describe("GSTIN detail & status", () => {
  it("detail exposes client + freshness and hides provider request ids", async () => {
    const c = await clients.create(A, { name: "Acme", gstin: gst(1), email: "a@x.com" });
    await checks.checkClient(A, c.id);
    const d = await gq.detail(A, gst(1).toLowerCase());
    expect(d.gstin).toMatchObject({ gstin: gst(1), status: "Active", fresh: true, source: "stub", clientName: "Acme" });
    expect(JSON.stringify(d)).not.toContain("providerRequestId");
    expect(d.client).toMatchObject({ id: c.id, name: "Acme", filingFrequency: "MONTHLY" });
  });
  it("status of a never-checked GSTIN is Unknown/neverChecked — never 'inactive'", async () => {
    await clients.create(A, { name: "Fresh", gstin: gst(2) });
    const s = await gq.status(A, gst(2));
    expect(s).toMatchObject({ status: "Unknown", neverChecked: true, fresh: false });
    expect(s.status).not.toMatch(/inactive/i);
  });
  it("status reports last provider error code without raw text and keeps last known status", async () => {
    const c = await clients.create(A, { name: "Flaky", gstin: gst(3) });
    await checks.checkClient(A, c.id);
    stub.failAll = TRANSIENT();
    await checks.checkClient(A, c.id, { force: true }).catch(() => undefined);
    const s = await gq.status(A, gst(3));
    expect(s.status).toBe("Active");
    expect(s.lastError).toEqual({ code: "GST_PROVIDER_TIMEOUT", at: NOW.toISOString() });
  });
  it("invalid and unknown GSTINs", async () => {
    await expect(gq.detail(A, "bad")).rejects.toMatchObject({ code: "INVALID_GSTIN" });
    await expect(gq.status(A, gst(99))).rejects.toMatchObject({ code: "GSTIN_NOT_FOUND", status: 404 });
  });
  it("tenant isolation: org B cannot see org A's GSTINs", async () => {
    await clients.create(A, { name: "Acme", gstin: gst(1) });
    await expect(gq.detail(B, gst(1))).rejects.toMatchObject({ code: "GSTIN_NOT_FOUND" });
    await expect(gq.status(B, gst(1))).rejects.toMatchObject({ code: "GSTIN_NOT_FOUND" });
    await expect(rq.forGstin(B, gst(1), {})).rejects.toMatchObject({ code: "GSTIN_NOT_FOUND" });
    expect((await gq.list(B, {})).items).toHaveLength(0);
    expect((await rq.forType(B, "GSTR1", {})).items).toHaveLength(0);
  });
  it("all four roles can read; the service does not accept a spoofed role", async () => {
    await clients.create(A, { name: "Acme", gstin: gst(1) });
    for (const role of ["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"] as const) expect((await gq.list(ctxFor("A", role), {})).items).toHaveLength(1);
    await expect(gq.list({ ...A, role: undefined as never }, {})).rejects.toThrow();
  });
});

// ---- returns ---------------------------------------------------------------------------------------
const REC: ReturnRecord[] = [
  { returnType: "GSTR1", period: "082026", financialYear: "2026-27", status: "FILED", filingDate: "2026-09-09T10:00:00.000Z", arn: "ARN-1A" },
  { returnType: "GSTR1", period: "092026", financialYear: "2026-27", status: "NOT_FILED" },                        // due 11 Oct → pending
  { returnType: "GSTR3B", period: "072026", financialYear: "2026-27", status: "FILED", filingDate: "2026-08-25T10:00:00.000Z", arn: "ARN-3B" }, // due 20 Aug → late
  { returnType: "GSTR3B", period: "082026", financialYear: "2026-27", status: "NOT_FILED" },                        // due 20 Sep → missing
  { returnType: "GSTR1", period: "032026", financialYear: "2025-26", status: "FILED", filingDate: "2026-04-10T10:00:00.000Z", arn: "ARN-OLD" },
];

describe("returns queries (normalized model)", () => {
  let clientId: string;
  beforeEach(async () => {
    stub.records = () => REC;
    clientId = (await clients.create(A, { name: "Acme", gstin: gst(1) })).id;
    await checks.checkClient(A, clientId);
  });

  it("stores provider-independent normalized records", async () => {
    const r = await rq.forGstin(A, gst(1), { returnType: "GSTR3B", period: "082026" });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      gstin: gst(1), clientId, returnType: "GSTR3B", financialYear: "2026-27", period: "082026", periodSort: "202608",
      status: "NOT_FILED", state: "NOT_FILED", source: "stub", clientName: "Acme",
    });
    expect(r.items[0].dueDate).toBe("2026-09-20T23:59:59.000Z");
    expect(r.items[0].delayDays).toBe(16);
    expect(r.items[0].checkedAt).toBe(NOW.toISOString());
    expect(r.items[0].retrievedAt).toBe(NOW.toISOString());
    const late = (await rq.forGstin(A, gst(1), { period: "072026", returnType: "GSTR3B" })).items[0];
    expect(late).toMatchObject({ state: "FILED_LATE", arn: "ARN-3B", filingDate: "2026-08-25T10:00:00.000Z", delayDays: 5 });
    expect(r.note).toMatch(/retrievedAt/);
  });
  it("filters by type, financial year, status, state, period", async () => {
    const q = async (x: Record<string, string>) => (await rq.forGstin(A, gst(1), { limit: "100", ...x })).items;
    expect(await q({})).toHaveLength(5);
    expect(await q({ returnType: "GSTR1" })).toHaveLength(3);
    expect(await q({ returnType: "gstr-3b" })).toHaveLength(2);
    expect(await q({ fy: "2025-26" })).toHaveLength(1);
    expect((await q({ status: "not_filed" })).map((r) => r.period).sort()).toEqual(["082026", "092026"]);
    expect((await q({ state: "PENDING" })).map((r) => r.period)).toEqual(["092026"]);
    expect((await q({ state: "FILED_LATE" })).map((r) => r.returnType)).toEqual(["GSTR3B"]);
    expect(await q({ period: "082026" })).toHaveLength(2);
  });
  it("filters by due-date and filed-date ranges; refuses mixing both", async () => {
    const q = async (x: Record<string, string>) => (await rq.forGstin(A, gst(1), { limit: "100", ...x })).items;
    const due = await q({ dueFrom: "2026-09-01", dueTo: "2026-09-30" });
    expect(due.map((r) => r.id).sort()).toEqual([`${gst(1)}_GSTR1_202608`, `${gst(1)}_GSTR3B_202608`]);
    const filed = await q({ filedFrom: "2026-09-01" });
    expect(filed.every((r) => !!r.filingDate && r.filingDate >= "2026-09-01")).toBe(true);
    expect(filed).toHaveLength(1);
    await expect(rq.forGstin(A, gst(1), { dueFrom: "2026-01-01", filedFrom: "2026-01-01" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(rq.forGstin(A, gst(1), { dueFrom: "not-a-date" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("paginates (both directions) and validates params", async () => {
    for (const dir of ["asc", "desc"]) {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const r = await rq.forGstin(A, gst(1), { limit: "2", dir, ...(cursor ? { cursor } : {}) });
        ids.push(...r.items.map((i) => i.id)); cursor = r.nextCursor;
      } while (cursor);
      expect(ids).toHaveLength(5); expect(new Set(ids).size).toBe(5);
      expect(ids).toEqual(dir === "asc" ? [...ids].sort() : [...ids].sort().reverse());
    }
    for (const bad of [{ fy: "2026" }, { period: "132026" }, { period: "8/2026" }, { status: "done" }, { state: "LOST" }, { returnType: "GSTR9" }]) {
      await expect(rq.forGstin(A, gst(1), bad)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
  });
  it("cross-GSTIN GSTR-1 / GSTR-3B listings only contain their own type and carry client names", async () => {
    const c2 = await clients.create(A, { name: "Beta", gstin: gst(2) });
    await checks.checkClient(A, c2.id);
    const g1 = await rq.forType(A, "GSTR1", { limit: "100" });
    expect(g1.items.every((r) => r.returnType === "GSTR1")).toBe(true);
    expect(new Set(g1.items.map((r) => r.clientName))).toEqual(new Set(["Acme", "Beta"]));
    expect((await rq.forType(A, "GSTR3B", { limit: "100", status: "not_filed" })).items.every((r) => r.returnType === "GSTR3B" && r.status === "NOT_FILED")).toBe(true);
    expect((await rq.forType(A, "GSTR1", { gstin: gst(2) })).items.every((r) => r.gstin === gst(2))).toBe(true);
  });
  it("denormalizes compliance summary onto the GSTIN record and raises return alerts once", async () => {
    const rec = (await store.getGstinRecord("A", gst(1)))!;
    expect(rec).toMatchObject({ gstr1Missing: 0, gstr1Late: 0, gstr3bMissing: 1, gstr3bLate: 1, indicator: "Needs Attention", checked: true });
    const types = () => store.listAlerts("A", 50).then((a) => a.map((x) => x.type));
    expect(await types()).toEqual(expect.arrayContaining(["GSTR3B_MISSING", "LATE_RETURN"]));
    const before = (await types()).length;
    await checks.checkClient(A, clientId, { force: true }); // nothing got worse → no new alerts
    expect((await types()).length).toBe(before);
    expect((await store.listReturns("A", gst(1))).length).toBe(5); // upsert, not duplicate
  });
  it("includeReturns=false keeps the previous summary and uses ONE provider request", async () => {
    const calls = stub.returnCalls;
    const v = stub.verifyCalls;
    await checks.checkClient(A, clientId, { force: true, includeReturns: false });
    expect(stub.returnCalls).toBe(calls); expect(stub.verifyCalls).toBe(v + 1);
    expect((await store.getGstinRecord("A", gst(1)))!.gstr3bMissing).toBe(1);
  });
  it("return-history outage still saves verification; indicator is Data Unavailable, never 'bad'", async () => {
    const c2 = await clients.create(A, { name: "NoReturns", gstin: gst(5) });
    stub.records = () => { throw new ProviderError("GST_PROVIDER_UNAVAILABLE", "down", false); };
    const r = await checks.checkClient(A, c2.id);
    expect(r.returnsAvailable).toBe(false);
    const rec = (await store.getGstinRecord("A", gst(5)))!;
    expect(rec).toMatchObject({ status: "Active", indicator: "Data Unavailable" });
    expect(rec.gstr1Missing).toBeUndefined();
  });
});

describe("deleting a client", () => {
  it("removes its GSTIN record, returns and dashboard counts (no orphans); the GSTIN can be re-added", async () => {
    stub.records = () => REC;
    const c = await clients.create(A, { name: "Acme", gstin: gst(1) });
    await checks.checkClient(A, c.id);
    const other = await clients.create(A, { name: "Keeper", gstin: gst(2) });
    await checks.checkClient(A, other.id);
    const dash = new DashboardService(store, new SubscriptionService(store, clock), clock);
    expect((await dash.get(A)).gstins.total).toBe(2);
    await clients.remove(A, c.id);
    await expect(gq.detail(A, gst(1))).rejects.toMatchObject({ code: "GSTIN_NOT_FOUND" });
    expect((await rq.forType(A, "GSTR1", { limit: "100" })).items.every((r) => r.gstin === gst(2))).toBe(true);
    expect(await store.listReturns("A", gst(1))).toEqual([]);
    expect((await gq.list(A, {})).items.map((i) => i.gstin)).toEqual([gst(2)]);
    const d = await dash.get(A);
    expect(d.gstins.total).toBe(1); expect(d.clients.total).toBe(1);
    expect((await clients.create(A, { name: "Acme again", gstin: gst(1) })).gstin).toBe(gst(1));
    expect((await gq.status(A, gst(1))).neverChecked).toBe(true);
  });
});

describe("dashboard aggregation", () => {
  it("is computed from stored data only: zero provider calls, correct counts over 5,000 GSTINs, fast", async () => {
    const N = 5000;
    const over = (i: number) => ({
      status: STATUSES[i % STATUSES.length], indicator: INDS[i % INDS.length], checked: i % 5 !== 0,
      ...(i % 5 !== 0 ? { lastCheckedAt: NOW.toISOString(), cacheExpiresAt: new Date(NOW.getTime() + (i % 2 ? 1 : -1) * 3600e3).toISOString(), gstr1Missing: i % 4 === 0 ? 1 : 0, gstr3bMissing: i % 6 === 0 ? 2 : 0, gstr1Late: i % 7 === 0 ? 1 : 0 } : {}),
    });
    await seedClients(store, "A", N, 1, over);
    const subs = new SubscriptionService(store, clock);
    const dash = new DashboardService(store, subs, clock);
    await store.usage.reserve("A", currentMonthKey(NOW), "professional", PLANS.professional.monthlyChecks!, 100);
    await store.usage.hold("A", currentMonthKey(NOW), "professional", PLANS.professional.monthlyChecks!, 250, false);

    const t0 = performance.now();
    const d = await dash.get(A);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(1500);
    expect(stub.verifyCalls + stub.returnCalls).toBe(0);

    const exp = { total: N, checked: 0, active: 0, susp: 0, canc: 0, unk: 0, refresh: 0, g1none: 0, g1some: 0, g1late: 0, g3none: 0, g3some: 0, att: 0, high: 0 };
    for (let i = 1; i <= N; i++) {
      const o = over(i) as Record<string, unknown>;
      if (o.checked) { exp.checked++; if ((o.cacheExpiresAt as string) <= NOW.toISOString()) exp.refresh++; if (o.gstr1Missing === 0) exp.g1none++; else exp.g1some++; if (o.gstr1Late) exp.g1late++; if (o.gstr3bMissing === 0) exp.g3none++; else exp.g3some++; }
      if (o.status === "Active") exp.active++; if (o.status === "Suspended") exp.susp++; if (o.status === "Cancelled") exp.canc++; if (o.status === "Unknown") exp.unk++;
      if (o.indicator === "Needs Attention" || o.indicator === "High Attention") exp.att++; if (o.indicator === "High Attention") exp.high++;
    }
    expect(d.clients.total).toBe(N);
    expect(d.gstins).toMatchObject({ total: N, active: exp.active, suspended: exp.susp, cancelled: exp.canc, unknown: exp.unk, inactive: 0, inactiveOrCancelled: exp.canc, neverChecked: N - exp.checked, needsRefresh: exp.refresh });
    expect(d.returns.gstr1).toEqual({ compliant: exp.g1none, missing: exp.g1some, late: exp.g1late });
    expect(d.returns.gstr3b).toMatchObject({ compliant: exp.g3none, missing: exp.g3some });
    expect(d.attention).toEqual({ needsAttention: exp.att, highAttention: exp.high });
    expect(d.subscription).toMatchObject({ plan: "professional", status: "active", readOnly: false });
    expect(d.quota).toMatchObject({ limit: PLANS.professional.monthlyChecks, used: 100, reserved: 250, remaining: PLANS.professional.monthlyChecks! - 350, month: "2026-10" });
    expect(d.returns.note).toMatch(/as of/i);
  });
  it("tenant isolation: each org sees only its own numbers", async () => {
    await seedClients(store, "A", 12); await seedClients(store, "B", 3);
    const dash = new DashboardService(store, new SubscriptionService(store, clock), clock);
    expect((await dash.get(A)).gstins.total).toBe(12);
    expect((await dash.get(B)).gstins.total).toBe(3);
  });
  it("recent activity needs audit permission; recent checks visible to all roles", async () => {
    const c = await clients.create(A, { name: "Acme", gstin: gst(1) });
    await checks.checkClient(A, c.id);
    const dash = new DashboardService(store, new SubscriptionService(store, clock), clock);
    for (const role of ["OWNER", "ADMIN"] as const) expect((await dash.get(ctxFor("A", role))).recentActivity.length).toBeGreaterThan(0);
    for (const role of ["ACCOUNTANT", "VIEWER"] as const) {
      const d = await dash.get(ctxFor("A", role));
      expect(d.recentActivity).toEqual([]);
      expect(d.recentChecks).toHaveLength(1);
    }
    expect(JSON.stringify(await dash.get(A))).not.toContain("providerRequestId");
  });
});
