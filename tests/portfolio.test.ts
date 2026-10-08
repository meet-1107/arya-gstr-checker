import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { CheckService, DEFAULT_CHECK_OPTIONS } from "@/services/checks";
import { BulkService, InProcessQueue } from "@/services/bulk";
import { VerificationService, DEFAULT_VERIFY_OPTIONS } from "@/services/verification";
import { PortfolioService } from "@/services/portfolio";
import { VerificationMetrics } from "@/lib/metrics";
import { ResilientProvider } from "@/providers/gate";
import { ForbiddenError } from "@/lib/permissions";
import { DEFAULT_VERIFICATION_POLICY } from "@/config/verification-policy";
import {
  buildRow, classifyFreshness, filterRows, nextRun, RECENT_CHANGE_MS, SCHEDULE_MS, sortRows, summarize, type PortfolioRow,
} from "@/lib/portfolio";
import type { Client, GstinRecord, VerificationRecord } from "@/lib/store/types";
import { ctxFor, FAST_LIMITS, gst, NOW, seedOrg, StubProvider } from "./helpers";

const H = 3600_000, D = 24 * H;
const W = { freshMs: DEFAULT_VERIFICATION_POLICY.freshMs, staleUsableMs: DEFAULT_VERIFICATION_POLICY.staleUsableMs };
const nowMs = NOW.getTime();
const ago = (ms: number) => new Date(nowMs - ms).toISOString();

describe("classifyFreshness / nextRun", () => {
  it("never / fresh / stale / expired by the policy windows; a future timestamp is not old", () => {
    expect(classifyFreshness(undefined, nowMs, W)).toBe("never");
    expect(classifyFreshness(ago(2 * H), nowMs, W)).toBe("fresh");
    expect(classifyFreshness(ago(3 * D), nowMs, W)).toBe("stale");
    expect(classifyFreshness(ago(30 * D), nowMs, W)).toBe("expired");
    expect(classifyFreshness(new Date(nowMs + D).toISOString(), nowMs, W)).toBe("fresh");
    expect(classifyFreshness("not a date", nowMs, W)).toBe("fresh");
  });
  it("a schedule runs one interval after the latest answer, or immediately if that has passed / there is none", () => {
    expect(nextRun("weekly", ago(2 * D), nowMs)).toBe(new Date(nowMs + 5 * D).toISOString());
    expect(nextRun("daily", ago(3 * D), nowMs)).toBe(new Date(nowMs).toISOString());
    expect(nextRun("monthly", undefined, nowMs)).toBe(new Date(nowMs).toISOString());
    expect(SCHEDULE_MS.monthly).toBe(30 * D);
  });
});

const client = (n: number, o: Partial<Client> = {}): Client => ({ id: `c${n}`, name: `Client ${String(n).padStart(2, "0")}`, gstin: gst(n), filingFrequency: "MONTHLY", status: "active", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...o });
const vrec = (n: number, o: Partial<VerificationRecord> = {}): VerificationRecord => ({ gstin: gst(n), outcome: "ACTIVE", details: { legalName: `LEGAL ${n}` }, source: "t", verifiedAt: ago(H), by: "u", requestId: "r", ...o });
const grec = (n: number, o: Partial<GstinRecord> = {}): GstinRecord => ({ gstin: gst(n), clientId: `c${n}`, status: "Active", checked: true, lastCheckedAt: ago(2 * H), ...o });

describe("buildRow: which answer a client shows", () => {
  it("uses the verification answer, with legal name and freshness", () => {
    expect(buildRow(client(1), vrec(1), null, nowMs, W)).toMatchObject({ status: "ACTIVE", statusSource: "verification", legalName: "LEGAL 1", freshness: "fresh" });
  });
  it("falls back to a full GST check when there is no verification answer", () => {
    expect(buildRow(client(1), null, grec(1, { status: "Cancelled", legalName: "FROM CHECK" }), nowMs, W)).toMatchObject({ status: "CANCELLED", statusSource: "check", legalName: "FROM CHECK" });
  });
  it("when both exist the NEWER one wins (and says which)", () => {
    const row = buildRow(client(1), vrec(1, { outcome: "ACTIVE", verifiedAt: ago(5 * D) }), grec(1, { status: "Suspended", lastCheckedAt: ago(H) }), nowMs, W);
    expect(row).toMatchObject({ status: "SUSPENDED", statusSource: "check", freshness: "fresh" });
    expect(buildRow(client(1), vrec(1, { verifiedAt: ago(H) }), grec(1, { status: "Cancelled", lastCheckedAt: ago(5 * D) }), nowMs, W).statusSource).toBe("verification");
  });
  it("an unchecked / unknown record is NOT an answer: the client is 'never verified'", () => {
    expect(buildRow(client(1), null, grec(1, { status: "Unknown", checked: false, lastCheckedAt: undefined }), nowMs, W)).toMatchObject({ status: null, freshness: "never" });
    expect(buildRow(client(1), null, grec(1, { status: "API Error" }), nowMs, W).status).toBeNull();
    expect(buildRow(client(1), null, null, nowMs, W)).toMatchObject({ status: null, statusSource: null, freshness: "never" });
  });
  it("NOT_FOUND on a client's GSTIN is a shown answer; recent changes surface, old ones do not", () => {
    expect(buildRow(client(1), vrec(1, { outcome: "NOT_FOUND" }), null, nowMs, W).status).toBe("NOT_FOUND");
    const change = (at: string) => ({ from: "ACTIVE" as const, to: "CANCELLED" as const, at, fields: ["status"], deteriorated: true });
    expect(buildRow(client(1), vrec(1, { outcome: "CANCELLED", change: change(ago(2 * D)) }), null, nowMs, W).change).toMatchObject({ from: "ACTIVE", to: "CANCELLED", deteriorated: true });
    expect(buildRow(client(1), vrec(1, { change: change(new Date(nowMs - RECENT_CHANGE_MS - D).toISOString()) }), null, nowMs, W).change).toBeUndefined();
  });
});

describe("filter / sort / summarize", () => {
  const rows: PortfolioRow[] = [
    buildRow(client(1), vrec(1, { outcome: "ACTIVE", tags: ["gold"] }), null, nowMs, W),
    buildRow(client(2, { assignedTo: "u2", verifySchedule: "weekly", nextVerifyAt: ago(H) }), vrec(2, { outcome: "CANCELLED", verifiedAt: ago(3 * D), change: { from: "ACTIVE", to: "CANCELLED", at: ago(3 * D), fields: ["status"], deteriorated: true } }), null, nowMs, W),
    buildRow(client(3), null, null, nowMs, W),
    buildRow(client(4, { verifySchedule: "daily", nextVerifyAt: new Date(nowMs + D).toISOString() }), vrec(4, { outcome: "SUSPENDED", verifiedAt: ago(40 * D) }), null, nowMs, W),
    buildRow(client(5), vrec(5, { outcome: "NOT_FOUND", verifiedAt: ago(2 * H) }), null, nowMs, W),
  ];
  it("filters", () => {
    const f = (o: Parameters<typeof filterRows>[1]) => filterRows(rows, o).map((r) => r.clientId);
    expect(f({ q: "client 02" })).toEqual(["c2"]); expect(f({ q: gst(3).slice(0, 6).toLowerCase() })).toEqual(["c1", "c2", "c3", "c4", "c5"]); expect(f({ q: "legal 4" })).toEqual(["c4"]);
    expect(f({ status: "CANCELLED" })).toEqual(["c2"]); expect(f({ status: "never" })).toEqual(["c3"]);
    expect(f({ freshness: "expired" })).toEqual(["c4"]); expect(f({ needsRefresh: true })).toEqual(["c2", "c3", "c4"]);
    expect(f({ changed: true })).toEqual(["c2"]); expect(f({ tag: "gold" })).toEqual(["c1"]); expect(f({ assignedTo: "u2" })).toEqual(["c2"]);
    expect(f({ scheduled: true })).toEqual(["c2", "c4"]); expect(f({ scheduled: false })).toEqual(["c1", "c3", "c5"]);
    expect(f({ attention: true })).toEqual(["c2", "c4", "c5"]); expect(f({ attention: true, needsRefresh: true })).toEqual(["c2", "c4"]);
  });
  it("sorts by name, by attention (worst first), and by oldest verification (never first)", () => {
    expect(sortRows(rows, "name").map((r) => r.clientId)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(sortRows(rows, "attention").map((r) => r.clientId).slice(0, 3)).toEqual(["c2", "c4", "c5"]);
    expect(sortRows(rows, "oldest").map((r) => r.clientId).slice(0, 2)).toEqual(["c3", "c4"]);
  });
  it("summarizes the whole portfolio", () => {
    expect(summarize(rows, nowMs)).toEqual({
      total: 5, byStatus: { ACTIVE: 1, CANCELLED: 1, never: 1, SUSPENDED: 1, NOT_FOUND: 1 }, byFreshness: { fresh: 2, stale: 1, expired: 1, never: 1 },
      attention: 3, changedRecently: 1, needsRefresh: 3, scheduled: 2, due: 1,
    });
  });
});

class ManualQueue extends InProcessQueue { enqueue() { /* the tests drive processJob */ } }
let store: MemoryStore, stub: StubProvider, clock: Date, verification: VerificationService, bulk: BulkService, portfolio: PortfolioService;
const A = ctxFor("A", "ACCOUNTANT");
const addClients = async (org: string, n: number, from = 1) => { for (let i = from; i < from + n; i++) await store.createClient(org, client(i)); };
const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

beforeEach(async () => {
  store = new MemoryStore(); stub = new StubProvider(() => clock); clock = new Date(NOW);
  await seedOrg(store, "A", "firm"); await seedOrg(store, "B", "firm"); await seedOrg(store, "S", "starter");
  const gate = new ResilientProvider(stub, FAST_LIMITS, { sleep: async () => {} });
  verification = new VerificationService(store, gate, new VerificationMetrics(), DEFAULT_VERIFY_OPTIONS, () => clock);
  bulk = new BulkService(store, new CheckService(store, gate, DEFAULT_CHECK_OPTIONS, () => clock), new ManualQueue(), FAST_LIMITS, () => clock, verification);
  portfolio = new PortfolioService(store, bulk, W, () => clock);
});

describe("PortfolioService.list / summary", () => {
  it("joins clients with their answers, filters, sorts and paginates; the summary covers the whole portfolio", async () => {
    await addClients("A", 7);
    for (const n of [1, 2, 3]) await verification.verify(A, gst(n));
    const all = await portfolio.list(A, { limit: 3 });
    expect(all.total).toBe(7); expect(all.items.map((r) => r.name)).toEqual(["Client 01", "Client 02", "Client 03"]); expect(all.nextCursor).toBe("3");
    expect(all.summary).toMatchObject({ total: 7, needsRefresh: 4, byFreshness: { fresh: 3, never: 4 } });
    const p2 = await portfolio.list(A, { limit: 3, cursor: all.nextCursor }); expect(p2.items.map((r) => r.name)).toEqual(["Client 04", "Client 05", "Client 06"]);
    const last = await portfolio.list(A, { limit: 3, cursor: p2.nextCursor }); expect(last.items).toHaveLength(1); expect(last.nextCursor).toBeUndefined();
    expect((await portfolio.list(A, { status: "never" })).total).toBe(4);
    expect((await portfolio.list(A, { q: "client 05" })).items.map((r) => r.clientId)).toEqual(["c5"]);
    expect((await portfolio.summary(A)).summary.total).toBe(7);
  });
  it("rejects a bad cursor, clamps the limit, and shows archived clients nowhere", async () => {
    await addClients("A", 2); await store.updateClient("A", "c2", { status: "archived" });
    await expect(portfolio.list(A, { cursor: "abc" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await portfolio.list(A, { limit: 99999 })).total).toBe(1);
  });
  it("is organization-scoped and readable by every role", async () => {
    await addClients("A", 3); await addClients("B", 1, 50);
    expect((await portfolio.list(ctxFor("B", "VIEWER"))).items.map((r) => r.clientId)).toEqual(["c50"]);
    expect((await portfolio.list(ctxFor("A", "VIEWER"))).total).toBe(3);
  });
  it("a client's answer is the one for ITS GSTIN even when another client shares an answer elsewhere", async () => {
    await addClients("A", 2); await verification.verify(A, gst(1));
    const r = await portfolio.list(A); expect(r.items.find((x) => x.clientId === "c1")!.freshness).toBe("fresh"); expect(r.items.find((x) => x.clientId === "c2")!.freshness).toBe("never");
  });
  it("shows a recently detected change and ages the answer as time passes", async () => {
    await addClients("A", 1); stub.status = "Active"; await verification.verify(A, gst(1));
    advance(2 * D); stub.status = "Cancelled"; await verification.verify(A, gst(1), { mode: "live" });
    const row = (await portfolio.list(A)).items[0];
    expect(row).toMatchObject({ status: "CANCELLED", freshness: "fresh", change: { from: "ACTIVE", to: "CANCELLED", deteriorated: true } });
    advance(4 * D); expect((await portfolio.list(A)).items[0]).toMatchObject({ freshness: "stale", change: expect.anything() });
    advance(10 * D); expect((await portfolio.list(A)).items[0].change).toBeUndefined(); // older than the recent-change window
  });
});

describe("PortfolioService.gstins (refresh planning)", () => {
  it("needs_refresh returns only never-verified and out-of-date clients; all and selected work; foreign ids match nothing", async () => {
    await addClients("A", 5); await addClients("B", 1, 90);
    await verification.verify(A, gst(1)); await verification.verify(A, gst(2)); advance(3 * D);       // c1, c2 now stale
    await verification.verify(A, gst(3), { mode: "live" });                                            // c3 fresh
    const need = await portfolio.gstins(A, { scope: "needs_refresh" });
    expect(need.gstins.sort()).toEqual([gst(1), gst(2), gst(4), gst(5)].sort()); expect(need.count).toBe(4);
    expect((await portfolio.gstins(A, { scope: "all" })).count).toBe(5);
    expect((await portfolio.gstins(A, { scope: "selected", clientIds: ["c1", "c3", "c90"] })).gstins.sort()).toEqual([gst(1), gst(3)].sort());
    await expect(portfolio.gstins(A, { scope: "selected", clientIds: [] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(portfolio.gstins(A, { scope: "nope" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(portfolio.gstins(ctxFor("A", "VIEWER"), { scope: "all" })).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("feeds the bulk preview so the user sees exactly what will be paid for: 'N already fresh, M need verification'", async () => {
    await addClients("A", 10);
    for (let n = 1; n <= 7; n++) await verification.verify(A, gst(n));
    const { gstins } = await portfolio.gstins(A, { scope: "all" });
    expect(await bulk.estimateVerify(A, { gstins })).toMatchObject({ valid: 10, servedFromCache: 7, needsLiveCheck: 3, providerRequests: 3 });
    const need = await portfolio.gstins(A, { scope: "needs_refresh" });
    expect(need.count).toBe(3);
  });
});

describe("scheduled verification", () => {
  it("setSchedule: needs clients:write and the plan feature; sets next run from the latest answer; null clears", async () => {
    await addClients("A", 3); await verification.verify(A, gst(1));
    await expect(portfolio.setSchedule(ctxFor("A", "VIEWER"), { all: true, schedule: "daily" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(portfolio.setSchedule(A, { all: true, schedule: "hourly" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(portfolio.setSchedule(A, { schedule: "daily" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await portfolio.setSchedule(A, { clientIds: ["c1", "c2", "c99"], schedule: "weekly" })).toEqual({ updated: 2, schedule: "weekly" });
    const c1 = (await store.listClients("A", { limit: 10 })).items.find((c) => c.id === "c1")!, c2 = (await store.listClients("A", { limit: 10 })).items.find((c) => c.id === "c2")!;
    expect(c1.nextVerifyAt).toBe(new Date(nowMs + 7 * D).toISOString());           // verified now → one week out
    expect(c2.nextVerifyAt).toBe(new Date(nowMs).toISOString());                    // never verified → due now
    expect(await portfolio.setSchedule(A, { all: true, schedule: null })).toEqual({ updated: 3, schedule: null });
    expect((await portfolio.summary(A)).summary.scheduled).toBe(0);
  });
  it("is a plan feature: refused on Starter, allowed to switch OFF anywhere, refused when read-only", async () => {
    const S = ctxFor("S", "ACCOUNTANT"); await addClients("S", 1);
    await expect(portfolio.setSchedule(S, { all: true, schedule: "daily" })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", status: 403 });
    await expect(portfolio.setSchedule(S, { all: true, schedule: null })).resolves.toMatchObject({ updated: 1 });
    await expect(portfolio.runDue(S)).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    await store.updateOrg("A", { subscriptionStatus: "expired" }); await addClients("A", 1);
    await expect(portfolio.setSchedule(A, { all: true, schedule: "daily" })).rejects.toMatchObject({ code: "SUBSCRIPTION_INACTIVE" });
  });
  it("runDue: one background job for the due clients only; fresh ones cost nothing; schedules advance; a second run does nothing", async () => {
    await addClients("A", 6);
    for (const n of [1, 2]) await verification.verify(A, gst(n));                           // fresh already
    await portfolio.setSchedule(A, { clientIds: ["c1", "c2", "c3", "c4"], schedule: "daily" });
    expect(await portfolio.runDue(A)).toEqual({ due: 2, started: true, jobId: expect.any(String), gstins: 2, replay: false }); // only c3, c4 are due now (c1, c2 verified just now)
    const job = (await store.listJobs("A", 5))[0];
    expect(job).toMatchObject({ kind: "verify", total: 2, quota: { requested: 2, reserved: 2 } });
    await bulk.processJob("A", job.id);
    expect((await store.getVerification("A", gst(3)))?.outcome).toBeDefined();
    const clients = (await store.listClients("A", { limit: 10 })).items;
    expect(clients.find((c) => c.id === "c3")!.nextVerifyAt).toBe(new Date(nowMs + D).toISOString());
    expect(clients.find((c) => c.id === "c3")!.lastScheduledAt).toBe(NOW.toISOString());
    expect(await portfolio.runDue(A)).toEqual({ due: 0, started: false });
    // a day later everyone is due again; fresh-by-policy answers are served from storage (no paid call for c3/c4 if still fresh)
    advance(D + H); const calls = stub.verifyCalls;
    const again = await portfolio.runDue(A); expect(again.due).toBe(4);
    await bulk.processJob("A", (await store.listJobs("A", 5))[0].id);
    expect(stub.verifyCalls - calls).toBe(4);                                                  // all four were past the 24h freshness window
  });
  it("a failed start (quota exhausted) leaves clients due; the next attempt can still run", async () => {
    await addClients("A", 2); await portfolio.setSchedule(A, { all: true, schedule: "daily" });
    const free = await store.usage.get("A", "2026-10"); void free;
    const spy = bulk.createVerify.bind(bulk); let fail = true;
    bulk.createVerify = (async (...a: Parameters<typeof spy>) => { if (fail) throw Object.assign(new Error("Monthly GST check quota exhausted."), { code: "QUOTA_EXHAUSTED" }); return spy(...a); }) as typeof bulk.createVerify;
    await expect(portfolio.runDue(A)).rejects.toThrow(/quota/i);
    expect((await portfolio.summary(A)).summary.due).toBe(2);
    fail = false; expect((await portfolio.runDue(A)).started).toBe(true);
  });
  it("runDueAll (scheduler): runs every organization with due clients, isolates failures, reports skips", async () => {
    await addClients("A", 2); await addClients("B", 1, 40); await addClients("S", 1, 70);
    await portfolio.setSchedule(A, { all: true, schedule: "daily" }); await portfolio.setSchedule(ctxFor("B", "OWNER"), { all: true, schedule: "weekly" });
    await store.updateClient("S", "c70", { verifySchedule: "daily", nextVerifyAt: NOW.toISOString() });   // Starter: schedule set before a downgrade
    const res = await portfolio.runDueAll();
    const by = Object.fromEntries(res.map((r) => [r.orgId, r]));
    expect(by.A).toMatchObject({ due: 2, started: true }); expect(by.B).toMatchObject({ due: 1, started: true });
    expect(by.S).toMatchObject({ started: false, skipped: "FEATURE_NOT_AVAILABLE" });
    expect(await store.listJobs("A", 5)).toHaveLength(1); expect(await store.listJobs("B", 5)).toHaveLength(1);
    expect((await store.listJobs("A", 1))[0].requestedBy).toBe("system:scheduler");
    expect(await portfolio.runDueAll()).toEqual([{ orgId: "S", due: 1, started: false, skipped: "FEATURE_NOT_AVAILABLE" }]); // A and B advanced; S still due
  });
  it("archived clients are never scheduled", async () => {
    await addClients("A", 1); await portfolio.setSchedule(A, { all: true, schedule: "daily" }); await store.updateClient("A", "c1", { status: "archived" });
    expect(await store.listDueClients(NOW.toISOString(), 10)).toEqual([]); expect(await portfolio.runDue(A)).toEqual({ due: 0, started: false });
  });
});
