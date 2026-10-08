import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { CheckService, DEFAULT_CHECK_OPTIONS } from "@/services/checks";
import { BulkService, InProcessQueue } from "@/services/bulk";
import { VerificationService, DEFAULT_VERIFY_OPTIONS } from "@/services/verification";
import { PortfolioService } from "@/services/portfolio";
import { AlertService } from "@/services/alerts";
import { ReportService } from "@/services/reports";
import { VerificationMetrics } from "@/lib/metrics";
import { ResilientProvider } from "@/providers/gate";
import { ForbiddenError } from "@/lib/permissions";
import { DEFAULT_VERIFICATION_POLICY } from "@/config/verification-policy";
import { ALERT_GROUPS, ALERT_LABEL, ALERT_SEVERITY } from "@/lib/alerts";
import type { Alert, AlertType, Client } from "@/lib/store/types";
import type { NormalizedReturn } from "@/lib/returns";
import { ctxFor, FAST_LIMITS, gst, NOW, seedOrg, StubProvider } from "./helpers";

const D = 86_400_000;
class ManualQueue extends InProcessQueue { enqueue() { /* tests drive processJob */ } }
let store: MemoryStore, stub: StubProvider, clock: Date, verification: VerificationService, portfolio: PortfolioService, alerts: AlertService, reports: ReportService;
const A = ctxFor("A", "ACCOUNTANT");
const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
const client = (n: number, o: Partial<Client> = {}): Client => ({ id: `c${n}`, name: `Client ${String(n).padStart(2, "0")}`, gstin: gst(n), filingFrequency: "MONTHLY", status: "active", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...o });
const alert = (id: string, type: AlertType, at: string, o: Partial<Alert> = {}): Alert => ({ id, type, message: `m-${id}`, at, read: false, ...o });
const ret = (g: string, type: "GSTR1" | "GSTR3B", period: string, o: Partial<NormalizedReturn> = {}): NormalizedReturn => ({
  id: `${g}_${type}_${period.slice(2)}${period.slice(0, 2)}`, gstin: g, returnType: type, financialYear: "2026-27", period, periodSort: `${period.slice(2)}${period.slice(0, 2)}`, status: "FILED", state: "FILED_ON_TIME",
  filingDate: "2026-07-10T00:00:00.000Z", dueDate: "2026-07-20T00:00:00.000Z", source: "t", checkedAt: NOW.toISOString(), retrievedAt: NOW.toISOString(), ...o,
});

beforeEach(async () => {
  store = new MemoryStore(); stub = new StubProvider(() => clock); clock = new Date(NOW);
  await seedOrg(store, "A", "firm"); await seedOrg(store, "B", "firm"); await seedOrg(store, "S", "starter");
  const gate = new ResilientProvider(stub, FAST_LIMITS, { sleep: async () => {} });
  verification = new VerificationService(store, gate, new VerificationMetrics(), DEFAULT_VERIFY_OPTIONS, () => clock);
  const bulk = new BulkService(store, new CheckService(store, gate, DEFAULT_CHECK_OPTIONS, () => clock), new ManualQueue(), FAST_LIMITS, () => clock, verification);
  portfolio = new PortfolioService(store, bulk, { freshMs: DEFAULT_VERIFICATION_POLICY.freshMs, staleUsableMs: DEFAULT_VERIFICATION_POLICY.staleUsableMs }, () => clock);
  alerts = new AlertService(store); reports = new ReportService(store, portfolio, () => clock);
});

describe("alert model", () => {
  it("every alert type has a label, severity and belongs to exactly one group", () => {
    const grouped = Object.values(ALERT_GROUPS).flatMap((g) => g.types);
    expect(new Set(grouped).size).toBe(grouped.length);
    for (const t of Object.keys(ALERT_LABEL) as AlertType[]) { expect(grouped).toContain(t); expect(ALERT_SEVERITY[t]).toBeDefined(); }
  });
});

describe("AlertService", () => {
  beforeEach(async () => {
    for (let i = 1; i <= 5; i++) await store.addAlert("A", alert(`a${i}`, i % 2 ? "GSTIN_CANCELLED" : "IMPORT_COMPLETED", new Date(NOW.getTime() + i * 1000).toISOString()));
    await store.addAlert("B", alert("b1", "GSTIN_CANCELLED", NOW.toISOString()));
  });
  it("lists newest first with the unread count; limit and hasMore; organization-scoped; every role can read", async () => {
    const r = await alerts.list(ctxFor("A", "VIEWER"), { limit: 3 });
    expect(r.items.map((a) => a.id)).toEqual(["a5", "a4", "a3"]); expect(r).toMatchObject({ unreadCount: 5, hasMore: true });
    expect((await alerts.list(A, { limit: 50 })).hasMore).toBe(false);
    expect((await alerts.list(ctxFor("B", "OWNER"))).items.map((a) => a.id)).toEqual(["b1"]);
  });
  it("filters by group and by unread; rejects an unknown group", async () => {
    expect((await alerts.list(A, { group: "status" })).items.map((a) => a.id)).toEqual(["a5", "a3", "a1"]);
    expect((await alerts.list(A, { group: "jobs" })).items.map((a) => a.id)).toEqual(["a4", "a2"]);
    expect((await alerts.list(A, { group: "returns" })).items).toEqual([]);
    await alerts.markRead(A, { ids: ["a5", "a4"] });
    expect((await alerts.list(A, { unread: true })).items.map((a) => a.id)).toEqual(["a3", "a2", "a1"]);
    await expect(alerts.list(A, { group: "nope" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("marks read / unread by ids or all; returns what changed; ignores other organizations' ids; is idempotent", async () => {
    expect(await alerts.markRead(A, { ids: ["a1", "a2", "b1", "ghost"] })).toEqual({ changed: 2, unreadCount: 3 });
    expect(await alerts.markRead(A, { ids: ["a1"] })).toEqual({ changed: 0, unreadCount: 3 });
    expect((await store.listAlerts("B", 10))[0].read).toBe(false);                       // untouched
    expect(await alerts.markRead(A, { all: true })).toEqual({ changed: 3, unreadCount: 0 });
    expect(await alerts.markRead(A, { ids: ["a1"], read: false })).toEqual({ changed: 1, unreadCount: 1 });
    expect(await alerts.markRead(A, { all: true, read: false })).toEqual({ changed: 4, unreadCount: 5 });
  });
  it("validates input and needs checks:run to change the shared inbox", async () => {
    for (const bad of [{}, { ids: [] }, { ids: [1] }, { ids: "a1" }, { all: "yes" }, { ids: ["a1"], read: "yes" }]) await expect(alerts.markRead(A, bad)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(alerts.markRead(ctxFor("A", "VIEWER"), { all: true })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await alerts.unreadCount(ctxFor("A", "VIEWER"))).toBe(5);
  });
  it("addAlert is an upsert by id (an event can be re-recorded without a duplicate)", async () => {
    await store.addAlert("A", alert("a1", "GSTIN_CANCELLED", NOW.toISOString(), { message: "updated" }));
    expect((await store.listAlerts("A", 50)).filter((a) => a.id === "a1")).toHaveLength(1); expect(await store.countUnreadAlerts("A")).toBe(5);
  });
});

describe("status-change alerts", () => {
  const flip = async (n: number, to: "Cancelled" | "Suspended" | "Active") => { advance(2 * D); stub.status = to; return verification.verify(A, gst(n), { mode: "live" }); };
  it("a client whose GSTIN got worse raises one alert naming the client; the type reflects the new status", async () => {
    await store.createClient("A", client(1)); await store.createClient("A", client(2));
    stub.status = "Active"; await verification.verify(A, gst(1)); await verification.verify(A, gst(2));
    await flip(1, "Cancelled"); await flip(2, "Suspended");
    const list = (await alerts.list(A)).items;
    expect(list).toHaveLength(2);
    expect(list.find((a) => a.gstin === gst(1))).toMatchObject({ type: "GSTIN_CANCELLED", message: `Client 01 (${gst(1)}): status changed from Active to Cancelled.`, read: false });
    expect(list.find((a) => a.gstin === gst(2))?.type).toBe("GSTIN_SUSPENDED");
  });
  it("is idempotent for the same change, silent for improvements, for non-client unsaved GSTINs, and works for saved non-clients", async () => {
    await store.createClient("A", client(1));
    stub.status = "Active"; await verification.verify(A, gst(1)); await verification.verify(A, gst(3)); await verification.verify(A, gst(4)); await verification.setSaved(A, gst(4), true);
    await flip(1, "Cancelled"); await flip(3, "Cancelled"); await flip(4, "Cancelled");
    expect((await alerts.list(A)).items.map((a) => a.gstin).sort()).toEqual([gst(1), gst(4)].sort());
    await store.addAlert("A", { ...(await store.listAlerts("A", 1))[0] });                      // re-recording the same event
    expect((await alerts.list(A)).items).toHaveLength(2);
    await flip(1, "Active"); expect((await alerts.list(A)).items).toHaveLength(2);              // improvement: no alert
  });
});

describe("ReportService: portfolio reports", () => {
  beforeEach(async () => {
    await store.createClient("A", client(1, { name: "=HYPERLINK(\"http://evil\")" })); await store.createClient("A", client(2)); await store.createClient("A", client(3));
    stub.status = "Active"; await verification.verify(A, gst(1)); await verification.verify(A, gst(2));
    advance(D); stub.status = "Cancelled"; await verification.verify(A, gst(2), { mode: "live" });
  });
  it("clients report: one row per client with status, source, freshness and change; never-verified clients are included", async () => {
    const r = await reports.build(A, "clients");
    expect(r.columns).toEqual(["Client", "GSTIN", "Legal name", "Latest status", "Answer from", "Last verified (UTC)", "Freshness", "Recent change", "Schedule"]);
    expect(r.total).toBe(3);
    const by = Object.fromEntries(r.rows.map((x) => [x[1], x]));
    expect(by[gst(2)]).toMatchObject({ 0: "Client 02", 3: "Cancelled", 4: "Verification", 6: "Fresh", 7: "Active → Cancelled", 8: "" });
    expect(by[gst(2)][2]).toBe(""); /* the stub provider returns no legal name */ expect(by[gst(2)][5]).toBe(new Date(clock).toISOString());
    expect(by[gst(3)]).toMatchObject({ 3: "Not verified", 4: "", 6: "Never verified" });
    expect(r.notes.join(" ")).toMatch(/latest stored answers, not a live check/);
  });
  it("attention report = suspended / cancelled / inactive / not found, worst first; changes report = recent changes only", async () => {
    expect((await reports.build(A, "attention")).rows.map((x) => x[0])).toEqual(["Client 02"]);
    const c = await reports.build(A, "changes");
    expect(c.columns[2]).toBe("Change"); expect(c.rows).toHaveLength(1); expect(c.rows[0]).toMatchObject({ 0: "Client 02", 2: "Active → Cancelled", 4: "Yes" });
  });
  it("CSV: UTF-8 content is formula-safe, quoted, CRLF, audited; the filename carries the date", async () => {
    const r = await reports.csv(A, "clients");
    expect(r.filename).toBe(`clients-report-${clock.toISOString().slice(0, 10)}.csv`); expect(r.rows).toBe(3);
    const lines = r.csv.split("\r\n");
    expect(lines[0]).toBe('"Client","GSTIN","Legal name","Latest status","Answer from","Last verified (UTC)","Freshness","Recent change","Schedule"');
    expect(lines.find((l) => l.includes(gst(1)))!.startsWith('"\'=HYPERLINK(""http://evil"")"')).toBe(true);        // neutralised, quote-escaped
    expect((await store.listAudit("A", 5))[0]).toMatchObject({ action: "REPORT_GENERATED", target: "clients", metadata: { rows: 3, format: "csv" } });
  });
  it("roles: viewers may preview but not download; unknown kind is a 404; other organizations see only their own clients", async () => {
    await expect(reports.csv(ctxFor("A", "VIEWER"), "clients")).rejects.toBeInstanceOf(ForbiddenError);
    expect((await reports.build(ctxFor("A", "VIEWER"), "clients")).total).toBe(3);
    await expect(reports.build(A, "bogus")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect((await reports.build(ctxFor("B", "OWNER"), "clients")).total).toBe(0);
  });
});

describe("ReportService: returns report", () => {
  beforeEach(async () => {
    await store.createClient("A", client(1)); await store.createClient("A", client(2));
    await store.putGstinRecord("A", { gstin: gst(1), clientId: "c1", status: "Active", clientName: "Client 01", checked: true });
    await store.putGstinRecord("A", { gstin: gst(2), clientId: "c2", status: "Active", clientName: "Client 02", checked: true });
    await store.putReturns("A", gst(1), [
      ret(gst(1), "GSTR1", "062026"), ret(gst(1), "GSTR3B", "062026", { state: "NOT_FILED", status: "NOT_FILED", filingDate: undefined, delayDays: 40, dueDate: "2026-07-20T00:00:00.000Z" }),
      ret(gst(1), "GSTR1", "072026", { state: "FILED_LATE", delayDays: 5, arn: "AA123", dueDate: "2026-08-11T00:00:00.000Z", filingDate: "2026-08-16T00:00:00.000Z" }),
    ]);
    await store.putReturns("A", gst(2), [ret(gst(2), "GSTR3B", "062026", { financialYear: "2025-26", state: "NOT_FILED", status: "NOT_FILED", filingDate: undefined, delayDays: 90, dueDate: "2026-04-20T00:00:00.000Z" })]);
  });
  it("defaults to problems only (not filed / filed late), newest due first, with client names and day counts", async () => {
    const r = await reports.build(A, "returns");
    expect(r.columns[0]).toBe("Client"); expect(r.total).toBe(3);
    expect(r.rows.map((x) => [x[0], x[2], x[4], x[7], x[8]])).toEqual([["Client 01", "GSTR-1", "07/2026", "Filed late", "5"], ["Client 01", "GSTR-3B", "06/2026", "Not filed", "40"], ["Client 02", "GSTR-3B", "06/2026", "Not filed", "90"]]);
    expect(r.rows[0][9]).toBe("AA123"); expect(r.notes.join(" ")).toMatch(/as of the last time/);
  });
  it("scope=all includes on-time filings; returnType and fy narrow it; bad values are rejected", async () => {
    expect((await reports.build(A, "returns", { scope: "all" })).total).toBe(4);
    expect((await reports.build(A, "returns", { returnType: "GSTR1" })).total).toBe(1);
    expect((await reports.build(A, "returns", { fy: "2025-26" })).total).toBe(1);
    await expect(reports.build(A, "returns", { returnType: "GSTR9" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(reports.build(A, "returns", { fy: "26" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("is organization-scoped", async () => { expect((await reports.build(ctxFor("B", "OWNER"), "returns")).total).toBe(0); });
});

describe("ReportService: printable monthly summary", () => {
  it("is a plan feature (pdfReports): refused on Starter, available on Firm; counts reflect the portfolio", async () => {
    await expect(reports.summary(ctxFor("S", "OWNER"))).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", status: 403 });
    for (const n of [1, 2, 3]) await store.createClient("A", client(n));
    stub.status = "Active"; await verification.verify(A, gst(1)); advance(D); stub.status = "Cancelled"; await verification.verify(A, gst(1), { mode: "live" });
    await store.putGstinRecord("A", { gstin: gst(2), clientId: "c2", status: "Active", checked: true, gstr1Missing: 2, gstr3bLate: 1 });
    const s = await reports.summary(ctxFor("A", "VIEWER"));
    expect(s).toMatchObject({ organization: "A", portfolio: { total: 3, attention: 1, changedRecently: 1, needsRefresh: 2 }, returns: { gstr1Missing: 1, gstr3bLate: 1, gstr3bMissing: 0 } });
    expect(s.attention).toEqual([{ name: "Client 01", gstin: gst(1), status: "Cancelled", verifiedAt: expect.any(String) }]);
    expect(s.changes[0]).toMatchObject({ name: "Client 01", change: "Active → Cancelled", deteriorated: true });
    expect(s.notes.join(" ")).toMatch(/not a live check/); expect(s.notes.join(" ")).toMatch(/not a statement by or on behalf of the GST authorities/);
  });
});
