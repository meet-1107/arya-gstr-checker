import { PLANS } from "@/config/plans";
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { ClientService } from "@/services/clients";
import { CheckService, DEFAULT_CHECK_OPTIONS } from "@/services/checks";
import { BulkService, InProcessQueue } from "@/services/bulk";
import { ImportService, IMPORT_CHUNK_SIZE, importClientId } from "@/services/imports";
import { GstinQueryService } from "@/services/queries";
import { DashboardService } from "@/services/dashboard";
import { SubscriptionService } from "@/services/subscription";
import { ResilientProvider } from "@/providers/gate";
import { currentMonthKey } from "@/lib/dates";
import { MAX_CSV_BYTES } from "@/lib/csv";
import { computeGstinChecksum } from "@/lib/gstin";
import { FAST_LIMITS, NOW, StubProvider, ctxFor, gst, seedOrg } from "./helpers";

const MONTH = currentMonthKey(NOW);
const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (rows: string[][], eol = "\n") => rows.map((r) => r.map(q).join(",")).join(eol) + eol;
const HEAD = ["client_name", "gstin", "email", "phone"];
/** n valid rows starting at GSTIN #start. */
const valid = (n: number, start = 1) => Array.from({ length: n }, (_, i) => [`Client ${start + i}`, gst(start + i), `c${start + i}@x.test`, `98765${String(10000 + start + i).slice(-5)}`]);

class ManualQueue extends InProcessQueue { enqueue() { /* tests drive process() explicitly */ } }

let store: MemoryStore, stub: StubProvider, imports: ImportService, bulk: BulkService, clients: ClientService, queue: InProcessQueue, clock: { now: Date };
const A = () => ctxFor("A", "OWNER");

function build(q: InProcessQueue = new ManualQueue()) {
  queue = q;
  const gate = new ResilientProvider(stub, FAST_LIMITS, { sleep: async () => {} });
  const checks = new CheckService(store, gate, DEFAULT_CHECK_OPTIONS, () => clock.now);
  bulk = new BulkService(store, checks, queue, FAST_LIMITS, () => clock.now);
  imports = new ImportService(store, bulk, queue, FAST_LIMITS, () => clock.now);
  clients = new ClientService(store, () => clock.now);
}
const run = async (ctx = A(), rows: string[][], extra: Record<string, unknown> = {}, key?: string) => {
  const { record } = await imports.start(ctx, { csv: csv(rows), fileName: "clients.csv", ...extra }, key);
  await imports.process(ctx.orgId, record.id);
  return (await store.getImport(ctx.orgId, record.id))!;
};

beforeEach(async () => {
  clock = { now: NOW };
  store = new MemoryStore(); stub = new StubProvider(() => clock.now);
  await seedOrg(store, "A", "firm"); await seedOrg(store, "B", "firm");
  build();
});

describe("preview & validation (server-side, nothing stored)", () => {
  it("classifies valid / invalid / duplicate / existing rows and field problems, reading BOM + CRLF + quoted commas", async () => {
    await clients.create(A(), { name: "Already Here", gstin: gst(5) });
    const text = "﻿" + csv([
      HEAD,
      ["Acme, Traders & Co", gst(1), "Accounts@Acme.TEST", "+91 98765 43210"],      // valid (quoted comma, email lowercased, phone cleaned)
      ["Dup Row", gst(1).toLowerCase(), "", ""],                                     // duplicate in file (case-insensitive)
      ["Bad Gstin", "24AAAAA0002A1Z0", "", ""],                                      // checksum failure
      ["Short", "123", "", ""],                                                      // length
      ["Existing", gst(5), "", ""],                                                  // already in the organization
      ["", gst(6), "", ""],                                                          // missing name
      ["Bad Mail", gst(7), "not-an-email", ""],                                      // invalid email
      ["Bad Phone", gst(8), "", "12ab"],                                             // invalid phone
      ["Fine", gst(9), "", ""],                                                      // valid
    ], "\r\n");
    const p = await imports.preview(A(), { csv: text });
    expect(p.counts).toEqual({ total: 9, valid: 2, invalid: 5, duplicate: 1, existing: 1 });
    expect(p.mapping).toEqual({ name: 0, gstin: 1, email: 2, phone: 3 });
    const why = Object.fromEntries([...p.samples.invalid, ...p.samples.duplicate, ...p.samples.existing].map((r) => [r.line, r.reason]));
    expect(why).toMatchObject({ 4: "CHECKSUM", 5: "LENGTH", 6: "ALREADY_IN_ORG", 7: "MISSING_NAME", 8: "INVALID_EMAIL", 9: "INVALID_PHONE", 3: "DUPLICATE_IN_FILE" });
    expect(p.samples.valid[0]).toMatchObject({ name: "Acme, Traders & Co", email: "accounts@acme.test", phone: "+919876543210" });
    expect(p.capacity).toMatchObject({ fits: true, willImport: 2, willSkip: 0 });
    // preview must not write or consume anything
    expect(await store.listImports("A", 10)).toEqual([]);
    expect(await store.countClients("A")).toBe(1);
    expect(await store.usage.get("A", MONTH)).toBeNull();
  });

  it("rejects bad files and mappings with specific, safe errors", async () => {
    const bad = (raw: unknown) => imports.preview(A(), raw).catch((e) => e);
    expect(await bad({ csv: csv([["name", "email"], ["x", "y@z.com"]]) })).toMatchObject({ code: "MAPPING_REQUIRED" });
    expect(await bad({ csv: csv([HEAD, ...valid(1)]), mapping: { gstin: 9 } })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await bad({ csv: csv([HEAD]) })).toMatchObject({ code: "EMPTY_FILE" });
    expect(await bad({ csv: "" })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await bad({ csv: "a".repeat(MAX_CSV_BYTES + 1) })).toMatchObject({ code: "FILE_TOO_LARGE", status: 413 });
    expect(await bad({ csv: csv([HEAD, ...valid(20001)]) })).toMatchObject({ code: "TOO_MANY_ROWS", status: 413 });
    expect(await bad({ csv: csv([HEAD, ...valid(1)]), mapping: { gstin: -1 } })).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await bad({})).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("honours an explicit mapping and headerless files", async () => {
    const rows = valid(3).map(([n, g]) => [g, n]); // GSTIN first, no header
    const p = await imports.preview(A(), { csv: csv(rows), hasHeader: false, mapping: { gstin: 0, name: 1 } });
    expect(p.counts).toMatchObject({ total: 3, valid: 3 });
    expect(p.samples.valid[0]).toMatchObject({ gstin: gst(1), name: "Client 1", line: 1 });
    await expect(imports.preview(A(), { csv: csv(rows), hasHeader: false })).rejects.toMatchObject({ code: "MAPPING_REQUIRED" });
  });

  it("reports plan capacity and verification estimates", async () => {
    await seedOrg(store, "F", "free");
    const f = ctxFor("F", "OWNER");
    const CAP = PLANS.free.clientLimit!;
    const p = await imports.preview(f, { csv: csv([HEAD, ...valid(CAP + 5)]) });
    expect(p.capacity).toMatchObject({ limit: CAP, used: 0, remaining: CAP, fits: false, willImport: CAP, willSkip: 5 });
    expect(p.verify.bulkAllowed).toBe(false); // Free plan: no bulk checks
    const o = await imports.preview(A(), { csv: csv([HEAD, ...valid(10)]) });
    expect(o.verify).toMatchObject({ checks: 10, remaining: PLANS.firm.monthlyChecks, afterRemaining: PLANS.firm.monthlyChecks! - 10, sufficient: true, bulkAllowed: true });
    // time estimate follows the provider budget: at 60 requests/min, 10 checks = 20 requests (full) or 10 (status only)
    const slow = new ImportService(store, bulk, queue, { ...FAST_LIMITS, requestsPerMinute: 60 }, () => clock.now);
    expect((await slow.preview(A(), { csv: csv([HEAD, ...valid(10)]) })).verify.seconds).toEqual({ full: 20, statusOnly: 10 });
  });
});

describe("import processing", () => {
  it("creates clients + GSTIN records (never checked), audits, alerts, and shows up everywhere", async () => {
    const rec = await run(A(), [HEAD, ...valid(3)]);
    expect(rec).toMatchObject({ status: "completed", totalRows: 3, toCreate: 3, processed: 3, counts: { valid: 3, imported: 3, invalid: 0, failedToCreate: 0, skippedPlanLimit: 0 } });
    expect(rec.startedAt && rec.completedAt).toBeTruthy();
    const list = await new GstinQueryService(store, () => clock.now).list(A(), { limit: "10" });
    expect(list.items.map((i) => i.gstin)).toEqual([gst(1), gst(2), gst(3)]);
    expect(list.items[0]).toMatchObject({ status: "Unknown", checked: false, clientName: "Client 1" });
    const c = await store.getClient("A", importClientId(rec.id, gst(1)));
    expect(c).toMatchObject({ name: "Client 1", email: "c1@x.test", filingFrequency: "MONTHLY", status: "active" });
    expect((await store.listAudit("A", 10)).map((a) => a.action)).toContain("CSV_IMPORTED");
    expect((await store.listAlerts("A", 10)).map((a) => a.type)).toContain("IMPORT_COMPLETED");
    const dash = await new DashboardService(store, new SubscriptionService(store, () => clock.now), () => clock.now).get(A());
    expect(dash.clients.total).toBe(3); expect(dash.gstins.neverChecked).toBe(3);
    // imported clients behave like normal clients afterwards
    await expect(clients.create(A(), { name: "Dup", gstin: gst(1) })).rejects.toMatchObject({ code: "DUPLICATE_GSTIN" });
  });

  it("completed_with_errors keeps failed rows and exports them safely (formula injection neutralised)", async () => {
    const rec = await run(A(), [HEAD, ...valid(2), ["=HYPERLINK(\"http://evil\",\"x\")", "BAD", "", ""], ["+cmd", "24AAAAA0001A1Z0", "", ""], ["@sum", gst(1), "", ""]]);
    expect(rec.status).toBe("completed_with_errors");
    expect(rec.failedRows.map((r) => r.reason)).toEqual(["FORMAT", "CHECKSUM", "DUPLICATE_IN_FILE"].map((x, i) => rec.failedRows[i].reason));
    const { csv: out, truncated } = await imports.failedRowsCsv(A(), rec.id);
    expect(truncated).toBe(false);
    const lines = out.split("\r\n");
    expect(lines[0]).toBe('"line","client_name","gstin","email","phone","reason_code","reason"');
    expect(lines[1]).toMatch(/"(FORMAT|LENGTH)","GSTIN (format is invalid|must be exactly 15 characters)"$/); // machine code + readable reason
    expect(lines).toHaveLength(4);
    for (const l of lines.slice(1)) expect(l.split(",")[1]).toMatch(/^"'[=+@]/); // every dangerous name is prefixed with an apostrophe
  });

  it("handles chunk boundaries exactly (500 / 501 / 1,203 rows) and large files quickly", async () => {
    for (const n of [IMPORT_CHUNK_SIZE, IMPORT_CHUNK_SIZE + 1, 1203]) {
      store = new MemoryStore(); await seedOrg(store, "E", "enterprise"); build();
      const rec = await run(ctxFor("E", "OWNER"), [HEAD, ...valid(n)]);
      expect(rec.chunks).toBe(Math.ceil(n / IMPORT_CHUNK_SIZE));
      expect(rec.counts.imported).toBe(n); expect(rec.processed).toBe(n);
      expect(await store.countClients("E")).toBe(n);
    }
    store = new MemoryStore(); await seedOrg(store, "E", "enterprise"); build();
    const t0 = performance.now();
    const rec = await run(ctxFor("E", "OWNER"), [HEAD, ...valid(5000)]);
    expect(rec.counts.imported).toBe(5000);
    expect(performance.now() - t0).toBeLessThan(8000);
  });

  it("a crash mid-chunk is recoverable: resume creates every client exactly once (deterministic ids)", async () => {
    await seedOrg(store, "E", "enterprise"); const E = ctxFor("E", "OWNER");
    const { record } = await imports.start(E, { csv: csv([HEAD, ...valid(1203)]) });
    // fault injection: the 4th createClient call explodes mid-chunk
    const orig = store.createClient.bind(store); let n = 0;
    store.createClient = async (...a: Parameters<typeof orig>) => { if (++n === 4) throw new Error("boom"); return orig(...a); };
    await expect(imports.process("E", record.id)).rejects.toThrow("boom");
    await new Promise((r) => setTimeout(r, 20)); // let in-flight creations settle
    store.createClient = orig;
    const mid = (await store.getImport("E", record.id))!;
    expect(mid.status).toBe("processing"); expect(mid.nextChunk).toBe(0); expect(mid.counts.imported).toBe(0); // counters only move after a chunk completes
    expect(await store.countClients("E")).toBeGreaterThan(0);
    await imports.process("E", record.id); // resume
    const done = (await store.getImport("E", record.id))!;
    expect(done).toMatchObject({ status: "completed", counts: { imported: 1203, failedToCreate: 0 }, processed: 1203 });
    expect(await store.countClients("E")).toBe(1203);                                       // no duplicates
    expect((await store.listAudit("E", 20)).filter((a) => a.action === "CSV_IMPORTED")).toHaveLength(1);
  });

  it("partial progress is visible and resumable chunk by chunk", async () => {
    await seedOrg(store, "E", "enterprise"); const E = ctxFor("E", "OWNER");
    const { record } = await imports.start(E, { csv: csv([HEAD, ...valid(1203)]) });
    await imports.process("E", record.id, { maxChunks: 1 });
    let r = (await store.getImport("E", record.id))!;
    expect(r).toMatchObject({ status: "processing", nextChunk: 1, processed: 500, counts: { imported: 500 } });
    await expect(imports.get(E, record.id)).resolves.toMatchObject({ progress: { percent: 42 } });
    await imports.process("E", record.id);
    r = (await store.getImport("E", record.id))!;
    expect(r).toMatchObject({ status: "completed", processed: 1203 });
    await imports.process("E", record.id); // terminal: no-op
    expect((await store.getImport("E", record.id))!.counts.imported).toBe(1203);
  });

  it("normalizes names, emails and phone numbers", async () => {
    const rec = await run(A(), [HEAD, ["  Spaced Name  ", gst(1), "  UPPER@X.TEST ", "98 765-43210"]]);
    expect(await store.getClient("A", importClientId(rec.id, gst(1)))).toMatchObject({ name: "Spaced Name", email: "upper@x.test", phone: "9876543210" });
  });

  it("InProcessQueue runs the import in the background to completion", async () => {
    const q = new InProcessQueue();
    build(q); q.setHandler((o, id, kind) => (kind === "import" ? imports.process(o, id) : bulk.processJob(o, id)));
    const { record } = await imports.start(A(), { csv: csv([HEAD, ...valid(40)]) });
    expect(record.status).toBe("queued");
    await q.idle();
    expect((await store.getImport("A", record.id))!).toMatchObject({ status: "completed", counts: { imported: 40 } });
  });

  it("failed-row storage is capped at 1,000 and says so", async () => {
    const bad = Array.from({ length: 1500 }, (_, i) => [`Bad ${i}`, "NOPE", "", ""]);
    const rec = await run(A(), [HEAD, ...valid(2), ...bad]);
    expect(rec.failedRows).toHaveLength(1000); expect(rec.failedRowsTruncated).toBe(true);
    expect(rec.counts.invalid).toBe(1500);
    const { csv: out, truncated } = await imports.failedRowsCsv(A(), rec.id);
    expect(truncated).toBe(true); expect(out.split("\r\n")).toHaveLength(1001);
  });
});

describe("plan limits, subscription and permissions", () => {
  beforeEach(async () => { await seedOrg(store, "F", "free"); });
  const F = () => ctxFor("F", "OWNER");

  it("refuses files that exceed the client limit unless the user opts into a partial import", async () => {
    const CAP = PLANS.free.clientLimit!;
    await expect(imports.start(F(), { csv: csv([HEAD, ...valid(CAP + 5)]) })).rejects.toMatchObject({ code: "CLIENT_LIMIT_REACHED", status: 402 });
    expect(await store.listImports("F", 10)).toEqual([]); expect(await store.countClients("F")).toBe(0);
    const rec = await run(F(), [HEAD, ...valid(CAP + 5)], { allowPartialClients: true });
    expect(rec).toMatchObject({ status: "completed_with_errors", counts: { imported: CAP, skippedPlanLimit: 5 }, toCreate: CAP });
    expect(await store.countClients("F")).toBe(CAP);
    expect(rec.failedRows.filter((r) => r.reason === "PLAN_LIMIT_REACHED")).toHaveLength(5);
  });
  it("a full plan cannot start an import at all, even with the partial option (nothing to create)", async () => {
    for (let i = 1; i <= PLANS.free.clientLimit!; i++) await clients.create(F(), { name: `Old ${i}`, gstin: gst(100 + i) });
    await expect(imports.start(F(), { csv: csv([HEAD, ...valid(5)]), allowPartialClients: true })).rejects.toMatchObject({ code: "CLIENT_LIMIT_REACHED", status: 402 });
    expect(await store.listImports("F", 10)).toEqual([]);
    expect((await imports.preview(F(), { csv: csv([HEAD, ...valid(5)]) })).capacity).toMatchObject({ remaining: 0, willImport: 0, willSkip: 5 });
  });
  it("accounts for existing clients, and re-checks the limit at processing time (no bypass via concurrent adds)", async () => {
    const CAP = PLANS.free.clientLimit!; // 5
    for (let i = 1; i <= CAP - 2; i++) await clients.create(F(), { name: `Old ${i}`, gstin: gst(100 + i) });   // 3 existing, room for 2
    await expect(imports.start(F(), { csv: csv([HEAD, ...valid(5)]) })).rejects.toMatchObject({ code: "CLIENT_LIMIT_REACHED" });
    store = new MemoryStore(); await seedOrg(store, "F", "free"); build();
    const { record } = await imports.start(F(), { csv: csv([HEAD, ...valid(CAP - 1)]) });          // fits at start (0 + 4 ≤ 5)
    for (let i = 1; i <= 2; i++) await clients.create(F(), { name: `Manual ${i}`, gstin: gst(200 + i) }); // sneak in 2 more: room is now 3
    await imports.process("F", record.id);
    const r = (await store.getImport("F", record.id))!;
    expect(r.counts).toMatchObject({ imported: CAP - 2, skippedPlanLimit: 1 });
    expect(await store.countClients("F")).toBe(CAP);                                                 // never above the plan limit
  });
  it("blocks read-only subscriptions at start and mid-flight (nothing is created)", async () => {
    await store.updateOrg("A", { subscriptionStatus: "cancelled" });
    await expect(imports.start(A(), { csv: csv([HEAD, ...valid(2)]) })).rejects.toMatchObject({ code: "SUBSCRIPTION_INACTIVE" });
    await store.updateOrg("A", { subscriptionStatus: "active" });
    const { record } = await imports.start(A(), { csv: csv([HEAD, ...valid(2)]) });
    await store.updateOrg("A", { subscriptionStatus: "expired" });
    await imports.process("A", record.id);
    expect(await store.getImport("A", record.id)).toMatchObject({ status: "failed", errorCode: "SUBSCRIPTION_INACTIVE" });
    expect(await store.countClients("A")).toBe(0);
  });
  it("RBAC: viewers can read imports but not preview/start/resume; other write roles can", async () => {
    const v = ctxFor("A", "VIEWER");
    await expect(imports.preview(v, { csv: csv([HEAD, ...valid(1)]) })).rejects.toThrow();
    await expect(imports.start(v, { csv: csv([HEAD, ...valid(1)]) })).rejects.toThrow();
    const rec = await run(ctxFor("A", "ACCOUNTANT"), [HEAD, ...valid(2)]);
    await expect(imports.resume(v, rec.id)).rejects.toThrow();
    expect((await imports.get(v, rec.id)).id).toBe(rec.id);
    expect(await imports.list(v)).toHaveLength(1);
    expect((await imports.failedRowsCsv(v, rec.id)).count).toBe(0);
    for (const role of ["OWNER", "ADMIN"] as const) expect((await run(ctxFor("A", role), [HEAD, ...valid(1, 50 + (role === "OWNER" ? 0 : 1))])).status).toBe("completed");
  });
  it("authorization is re-checked when the worker runs (requester demoted → nothing created)", async () => {
    const { record } = await imports.start(A(), { csv: csv([HEAD, ...valid(3)]) });
    await store.putMember("A", { uid: "A-owner", email: "o@x.com", role: "VIEWER", addedAt: NOW.toISOString() });
    await imports.process("A", record.id);
    expect(await store.getImport("A", record.id)).toMatchObject({ status: "failed", errorCode: "FORBIDDEN" });
    expect(await store.countClients("A")).toBe(0);
  });
});

describe("tenant isolation", () => {
  it("organization B cannot read, export or resume organization A's imports; the same GSTINs import fine in both", async () => {
    const rec = await run(A(), [HEAD, ...valid(3)]);
    const b = ctxFor("B", "OWNER");
    for (const op of [() => imports.get(b, rec.id), () => imports.failedRowsCsv(b, rec.id), () => imports.resume(b, rec.id)]) {
      await expect(op()).rejects.toMatchObject({ code: "IMPORT_NOT_FOUND", status: 404 });
    }
    expect(await imports.list(b)).toEqual([]);
    const recB = await run(b, [HEAD, ...valid(3)]);
    expect(recB.counts.imported).toBe(3);                                  // GSTINs already in org A are not "existing" for org B
    expect(await store.countClients("A")).toBe(3); expect(await store.countClients("B")).toBe(3);
  });
});

describe("idempotency", () => {
  const body = () => ({ csv: csv([HEAD, ...valid(5)]) });
  it("same Idempotency-Key ⇒ one import and one set of clients", async () => {
    const a = await imports.start(A(), body(), "import-key-0001");
    const b = await imports.start(A(), body(), "import-key-0001");
    expect(b.replay).toBe(true); expect(b.record.id).toBe(a.record.id);
    await imports.process("A", a.record.id);
    expect((await imports.start(A(), body(), "import-key-0001")).record.id).toBe(a.record.id); // still a replay after completion
    expect(await store.countClients("A")).toBe(5); expect(await store.listImports("A", 10)).toHaveLength(1);
  });
  it("reusing a key with different content is rejected", async () => {
    await imports.start(A(), body(), "import-key-0002");
    await expect(imports.start(A(), { csv: csv([HEAD, ...valid(4)]) }, "import-key-0002")).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 422 });
  });
  it("10 simultaneous identical submissions ⇒ exactly one import", async () => {
    const res = await Promise.all(Array.from({ length: 10 }, () => imports.start(A(), body(), "import-key-0003")));
    expect(new Set(res.map((r) => r.record.id)).size).toBe(1);
    expect(res.filter((r) => !r.replay)).toHaveLength(1);
    expect(await store.listImports("A", 10)).toHaveLength(1);
  });
  it("keyless double-click while active replays; re-importing a finished file finds nothing new", async () => {
    const a = await imports.start(A(), body());
    expect((await imports.start(A(), body())).record.id).toBe(a.record.id);
    await imports.process("A", a.record.id);
    await expect(imports.start(A(), body())).rejects.toMatchObject({ code: "NO_VALID_ROWS" }); // all rows now exist: cannot double-import
    expect(await store.countClients("A")).toBe(5);
  });
  it("a failed start releases its key, and malformed keys are rejected", async () => {
    await seedOrg(store, "F", "free");
    await expect(imports.start(ctxFor("F", "OWNER"), { csv: csv([HEAD, ...valid(30)]) }, "import-key-0004")).rejects.toMatchObject({ code: "CLIENT_LIMIT_REACHED" });
    expect((await imports.start(ctxFor("F", "OWNER"), { csv: csv([HEAD, ...valid(PLANS.free.clientLimit!)]) }, "import-key-0004")).replay).toBe(false); // key was free again
    await expect(imports.start(A(), body(), "short")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("optional GST verification reuses the bulk machinery", () => {
  it("creates ONE bulk job for the imported clients and holds quota (no second pipeline)", async () => {
    const rec = await run(A(), [HEAD, ...valid(12)], { verify: { includeReturns: false } });
    expect(rec.verify).toMatchObject({ requested: true, includeReturns: false });
    const jobId = rec.verify!.jobId!;
    const job = (await store.getJob("A", jobId))!;
    expect(job).toMatchObject({ total: 12, status: "queued", includeReturns: false, requestedBy: "A-owner", quota: { requested: 12, reserved: 12 } });
    expect(await store.usage.get("A", MONTH)).toMatchObject({ reserved: 12, used: 0 });
    // …and the existing worker finishes it with exact accounting
    await bulk.processJob("A", jobId);
    expect(await store.usage.get("A", MONTH)).toMatchObject({ used: 12, reserved: 0 });
    expect((await store.getGstinRecord("A", gst(1)))).toMatchObject({ checked: true, status: "Active" });
  });
  it("verification problems never undo the import and are reported with a safe code", async () => {
    await seedOrg(store, "F", "free");
    const free = await run(ctxFor("F", "OWNER"), [HEAD, ...valid(5)], { verify: { includeReturns: true } });
    expect(free.status).toBe("completed"); expect(free.verify).toMatchObject({ errorCode: "FEATURE_NOT_AVAILABLE" }); expect(free.verify!.jobId).toBeUndefined();
    expect(await store.countClients("F")).toBe(5);

    await store.usage.reserve("A", MONTH, "firm", 2000, 1995);
    const low = await run(A(), [HEAD, ...valid(10, 300)], { verify: { includeReturns: true } });
    expect(low.counts.imported).toBe(10); expect(low.verify).toMatchObject({ errorCode: "QUOTA_EXHAUSTED" });
    const part = await run(A(), [HEAD, ...valid(10, 400)], { verify: { includeReturns: true, allowPartial: true } });
    expect((await store.getJob("A", part.verify!.jobId!))).toMatchObject({ total: 5, skipped: 5 });
  });
  it("files too large for one verification run import fine and say so", async () => {
    await seedOrg(store, "E", "enterprise");
    const big = (n: number) => { const b = `24AAAA${String.fromCharCode(65 + Math.floor(n / 10000))}${String(n % 10000).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };
    const rows = Array.from({ length: 10_001 }, (_, i) => [`Big ${i}`, big(i), "", ""]);
    const rec = await run(ctxFor("E", "OWNER"), [HEAD, ...rows], { verify: { includeReturns: false } });
    expect(rec.counts.imported).toBe(10_001);
    expect(rec.verify).toMatchObject({ errorCode: "TOO_MANY_ITEMS" });
  }, 60_000);
  it("no verification unless requested", async () => {
    const rec = await run(A(), [HEAD, ...valid(3)]);
    expect(rec.verify).toBeUndefined();
    expect(await store.listJobs("A", 10)).toEqual([]);
    expect(await store.usage.get("A", MONTH)).toBeNull();
  });
});

describe("shape of API-facing data", () => {
  it("never exposes the fingerprint or the full failed-row list in get/list", async () => {
    const rec = await run(A(), [HEAD, ...valid(2), ["Bad", "NOPE", "", ""]]);
    const g = (await imports.get(A(), rec.id)) as Record<string, unknown>;
    expect(g).not.toHaveProperty("fingerprint"); expect(g).not.toHaveProperty("failedRows");
    expect(g).toMatchObject({ failedRowsCount: 1, progress: { percent: 100 }, status: "completed_with_errors" });
    expect(JSON.stringify(await imports.list(A()))).not.toContain("fingerprint");
  });
});
