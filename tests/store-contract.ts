/* Shared Store contract. Run against every implementation (MemoryStore now; FirestoreStore when an emulator is available). */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { BulkJob, BulkJobItem, Store } from "@/lib/store/types";
import type { NormalizedReturn } from "@/lib/returns";
import { gst, NOW } from "./helpers";

const mkOrg = async (s: Store, id: string) =>
  s.createOrg({ id, name: id, ownerId: `${id}-o`, plan: "professional", subscriptionStatus: "active", createdAt: NOW.toISOString(), billingPeriod: "monthly" },
    { uid: `${id}-o`, email: `${id}@x.com`, role: "OWNER", addedAt: NOW.toISOString() });

const ret = (g: string, type: "GSTR1" | "GSTR3B", period: string, over: Partial<NormalizedReturn> = {}): NormalizedReturn => {
  const periodSort = `${period.slice(2)}${period.slice(0, 2)}`;
  return {
    id: `${g}_${type}_${periodSort}`, gstin: g, returnType: type, financialYear: "2026-27", period, periodSort, status: "FILED", state: "FILED_ON_TIME",
    filingDate: `2026-${period.slice(0, 2)}-10T00:00:00.000Z`, dueDate: `2026-${period.slice(0, 2)}-20T23:59:59.000Z`, source: "t", checkedAt: NOW.toISOString(), retrievedAt: NOW.toISOString(), ...over,
  };
};
const mkJob = (org: string, n: number): { job: BulkJob; items: BulkJobItem[] } => {
  const id = randomUUID();
  const items: BulkJobItem[] = Array.from({ length: n }, (_, i) => ({ id: `i${String(i).padStart(3, "0")}`, jobId: id, clientId: `c${i}`, gstin: gst(i + 1), status: "queued", attempts: 0, held: true, settled: false }));
  return {
    items, job: { id, organizationId: org, requestedBy: "u", status: "queued", createdAt: NOW.toISOString(), includeReturns: false, force: false, total: n,
      counts: { queued: n, processing: 0, succeeded: 0, cached: 0, failed: 0, cancelled: 0 }, quota: { requested: n, reserved: n, consumed: 0, released: 0 }, skipped: 0, fingerprint: "fp" },
  };
};

export function storeContract(name: string, make: () => Promise<Store> | Store) {
  describe(`Store contract — ${name}`, () => {
    let s: Store, A: string, B: string;
    beforeEach(async () => {
      s = await make(); A = `A-${randomUUID().slice(0, 8)}`; B = `B-${randomUUID().slice(0, 8)}`;
      await mkOrg(s, A); await mkOrg(s, B);
    });

    it("scopes every collection by organization", async () => {
      await s.createClient(A, { id: "c1", name: "One", gstin: gst(1), filingFrequency: "MONTHLY", status: "active", createdAt: "", updatedAt: "" });
      await s.putGstinRecord(A, { gstin: gst(1), clientId: "c1", status: "Active", checked: true, lastCheckedAt: NOW.toISOString() });
      await s.putReturns(A, gst(1), [ret(gst(1), "GSTR1", "082026")]);
      const j = mkJob(A, 2); await s.createJob(A, j.job, j.items);
      expect(await s.getClient(B, "c1")).toBeNull();
      expect(await s.getClientsByIds(B, ["c1"])).toEqual([]);
      expect(await s.getGstinRecord(B, gst(1))).toBeNull();
      expect(await s.getGstinRecords(B, [gst(1)])).toEqual([]);
      expect((await s.listGstins(B, {}, { limit: 10, sort: { by: "gstin", dir: "asc" } })).items).toEqual([]);
      expect(await s.countGstins(B, {})).toBe(0);
      expect((await s.queryReturns(B, {}, { limit: 10, dir: "asc" })).items).toEqual([]);
      expect(await s.getJob(B, j.job.id)).toBeNull();
      expect(await s.claimJobItems(B, j.job.id, 5, NOW.toISOString())).toEqual([]);
      expect(await s.cancelQueuedItems(B, j.job.id)).toEqual([]);
      expect((await s.getJob(A, j.job.id))?.counts.queued).toBe(2);
      expect(await s.countGstins(A, {})).toBe(1);
    });

    it("deleteGstinData removes only that org's record and returns", async () => {
      const g = gst(1);
      for (const o of [A, B]) { await s.putGstinRecord(o, { gstin: g, clientId: "c", status: "Active" }); await s.putReturns(o, g, [ret(g, "GSTR1", "082026")]); }
      await s.deleteGstinData(A, g);
      expect(await s.getGstinRecord(A, g)).toBeNull();
      expect(await s.listReturns(A, g)).toEqual([]);
      expect(await s.getGstinRecord(B, g)).not.toBeNull();
      expect(await s.listReturns(B, g)).toHaveLength(1);
    });

    it("GSTIN list/count: filters, sort, keyset pagination agree", async () => {
      for (let i = 1; i <= 12; i++) {
        await s.putGstinRecord(A, {
          gstin: gst(i), clientId: `c${i}`, clientName: `Client ${i}`, status: i % 3 === 0 ? "Suspended" : "Active", checked: i > 4,
          assignedTo: i % 2 ? "u1" : "u2", indicator: i % 4 === 0 ? "High Attention" : "Good",
          ...(i > 4 ? { lastCheckedAt: new Date(NOW.getTime() + i * 1000).toISOString(), cacheExpiresAt: new Date(NOW.getTime() + (i % 2 ? 1 : -1) * 3600e3).toISOString(), gstr1Missing: i % 5 === 0 ? 1 : 0, gstr3bMissing: 0, gstr1Late: 0 } : {}),
        });
      }
      const all = (f: object, sort = { by: "gstin" as const, dir: "asc" as const }) => s.listGstins(A, f, { limit: 100, sort }).then((p) => p.items);
      const cases: [object, number][] = [
        [{}, 12], [{ status: "Suspended" }, 4], [{ checked: false }, 4], [{ checked: true }, 8], [{ assignedTo: "u1" }, 6],
        [{ indicators: ["High Attention"] }, 3], [{ gstr1Missing: "some" }, 2], [{ gstr1Missing: "none" }, 6],
      ];
      for (const [f, n] of cases) {
        expect((await all(f)).length, JSON.stringify(f)).toBe(n);
        expect(await s.countGstins(A, f), `count ${JSON.stringify(f)}`).toBe(n);
      }
      const stale = await all({ refreshBefore: new Date(NOW.getTime()).toISOString() });
      expect(stale.every((r) => r.cacheExpiresAt! <= NOW.toISOString())).toBe(true);
      expect(await s.countGstins(A, { refreshBefore: NOW.toISOString() })).toBe(stale.length);

      for (const dir of ["asc", "desc"] as const) {
        const seen: string[] = []; let cursor: string | undefined;
        do { const p = await s.listGstins(A, {}, { limit: 5, cursor, sort: { by: "gstin", dir } }); seen.push(...p.items.map((r) => r.gstin)); cursor = p.nextCursor; } while (cursor);
        expect(seen).toHaveLength(12); expect(new Set(seen).size).toBe(12);
        expect(seen).toEqual(dir === "asc" ? [...seen].sort() : [...seen].sort().reverse());
      }
      const byChecked: string[] = []; let c2: string | undefined;
      do { const p = await s.listGstins(A, {}, { limit: 3, cursor: c2, sort: { by: "lastCheckedAt", dir: "desc" } }); byChecked.push(...p.items.map((r) => r.lastCheckedAt!)); c2 = p.nextCursor; } while (c2);
      expect(byChecked).toHaveLength(8);
      expect(byChecked).toEqual([...byChecked].sort().reverse());
      const hit = await s.listGstins(A, { search: "client 1" }, { limit: 50, sort: { by: "gstin", dir: "asc" } });
      expect(hit.items.length).toBeGreaterThan(0);
      expect(hit.items.every((r) => r.clientName!.toLowerCase().startsWith("client 1"))).toBe(true);
    });

    it("returns: upsert is idempotent; filters, ranges and cursor paging work", async () => {
      const g = gst(1), g2 = gst(2);
      const rows = [ret(g, "GSTR1", "082026"), ret(g, "GSTR1", "092026", { state: "NOT_FILED", status: "NOT_FILED", filingDate: undefined }), ret(g, "GSTR3B", "082026"), ret(g2, "GSTR1", "082026", { financialYear: "2025-26" })];
      await s.putReturns(A, g, rows); await s.putReturns(A, g, rows);
      expect(await s.listReturns(A, g)).toHaveLength(3);
      const q = (f: object, dir: "asc" | "desc" = "asc") => s.queryReturns(A, f, { limit: 50, dir }).then((p) => p.items);
      expect(await q({ returnType: "GSTR1" })).toHaveLength(3);
      expect(await q({ gstin: g, returnType: "GSTR1" })).toHaveLength(2);
      expect(await q({ financialYear: "2025-26" })).toHaveLength(1);
      expect(await q({ period: "082026" })).toHaveLength(3);
      expect(await q({ state: "NOT_FILED" })).toHaveLength(1);
      expect(await q({ status: "FILED", gstin: g })).toHaveLength(2);
      expect((await q({ dueFrom: "2026-09-01T00:00:00.000Z" })).map((r) => r.period)).toEqual(["092026"]);
      expect((await q({ filedFrom: "2026-08-01T00:00:00.000Z", filedTo: "2026-08-31T00:00:00.000Z" })).length).toBe(3);
      const ids: string[] = []; let cursor: string | undefined;
      do { const p = await s.queryReturns(A, { gstin: g }, { limit: 2, cursor, dir: "desc" }); ids.push(...p.items.map((r) => r.id)); cursor = p.nextCursor; } while (cursor);
      expect(ids).toEqual([...ids].sort().reverse()); expect(ids).toHaveLength(3);
    });

    it("usage: hold/settle/reserve keep used+reserved ≤ limit under concurrency and never go negative", async () => {
      const m = "2026-10";
      const holds = await Promise.all(Array.from({ length: 30 }, () => s.usage.hold(A, m, "professional", 10, 1, false)));
      expect(holds.filter((h) => h.ok)).toHaveLength(10);
      expect(await s.usage.reserve(A, m, "professional", 10, 1)).toMatchObject({ ok: false });
      await Promise.all(Array.from({ length: 10 }, (_, i) => s.usage.settle(A, m, i < 7 ? 1 : 0, i < 7 ? 0 : 1)));
      expect(await s.usage.get(A, m)).toMatchObject({ used: 7, reserved: 0 });
      await s.usage.settle(A, m, 5, 5);
      expect(await s.usage.get(A, m)).toMatchObject({ used: 7, reserved: 0 });
      const partial = await s.usage.hold(A, m, "professional", 10, 8, true);
      expect(partial).toEqual({ ok: true, held: 3 });
      expect(await s.usage.hold(A, m, "professional", 10, 1, false)).toMatchObject({ ok: false });
      expect(await s.usage.get(B, m)).toBeNull();
    });

    it("jobs: concurrent claims never hand out an item twice; finish settles exactly once", async () => {
      const { job, items } = mkJob(A, 20); await s.createJob(A, job, items);
      const claims = await Promise.all([s.claimJobItems(A, job.id, 7, NOW.toISOString()), s.claimJobItems(A, job.id, 7, NOW.toISOString()), s.claimJobItems(A, job.id, 7, NOW.toISOString())]);
      const ids = claims.flat().map((i) => i.id);
      expect(ids).toHaveLength(20); expect(new Set(ids).size).toBe(20);
      expect(claims.flat().every((i) => i.status === "processing" && i.attempts === 1)).toBe(true);
      let j = (await s.getJob(A, job.id))!;
      expect(j.counts).toMatchObject({ queued: 0, processing: 20 }); expect(j.status).toBe("running"); expect(j.startedAt).toBeTruthy();

      const wins = await Promise.all(Array.from({ length: 5 }, () => s.finishJobItem(A, job.id, ids[0], { status: "succeeded", completedAt: NOW.toISOString() })));
      expect(wins.filter(Boolean)).toHaveLength(1);
      await Promise.all(ids.slice(1, 4).map((id) => s.finishJobItem(A, job.id, id, { status: "failed", errorCode: "GST_PROVIDER_TIMEOUT", retryable: true })));
      j = (await s.getJob(A, job.id))!;
      expect(j.counts).toMatchObject({ processing: 16, succeeded: 1, failed: 3 });

      const rq = await s.requeueFailedItems(A, job.id);
      expect(rq).toHaveLength(3);
      expect(rq.every((i) => i.status === "queued" && i.held === false && i.settled === false)).toBe(true);
      expect((await s.getJob(A, job.id))!.counts).toMatchObject({ failed: 0, queued: 3, processing: 16 });
      const inc = await s.incrementJob(A, job.id, { consumed: 1, released: 2, reserved: 3, skipped: 4 }, { status: "running" });
      expect(inc!.quota).toMatchObject({ consumed: 1, released: 2, reserved: 23 }); expect(inc!.skipped).toBe(4);
      expect(await s.incrementJob(B, job.id, { consumed: 1 })).toBeNull();
    });

    it("jobs: cancel moves queued → cancelled once; stale processing items are re-queued or abandoned", async () => {
      const { job, items } = mkJob(A, 10); await s.createJob(A, job, items);
      await s.claimJobItems(A, job.id, 4, "2026-10-06T00:00:00.000Z");
      const cancelled = await s.cancelQueuedItems(A, job.id);
      expect(cancelled).toHaveLength(6); expect(cancelled.every((i) => i.status === "cancelled")).toBe(true);
      expect(await s.cancelQueuedItems(A, job.id)).toHaveLength(0);
      expect((await s.getJob(A, job.id))!.counts).toMatchObject({ queued: 0, processing: 4, cancelled: 6 });

      const first = await s.requeueStaleItems(A, job.id, "2026-10-07T00:00:00.000Z", 3);
      expect(first).toMatchObject({ requeued: 4, failed: [] });
      await s.claimJobItems(A, job.id, 4, "2026-10-06T00:00:00.000Z"); await s.requeueStaleItems(A, job.id, "2026-10-07T00:00:00.000Z", 3);
      await s.claimJobItems(A, job.id, 4, "2026-10-06T00:00:00.000Z");
      const last = await s.requeueStaleItems(A, job.id, "2026-10-07T00:00:00.000Z", 3);
      expect(last.requeued).toBe(0); expect(last.failed).toHaveLength(4);
      expect((await s.getJob(A, job.id))!.counts).toMatchObject({ queued: 0, processing: 0, failed: 4, cancelled: 6 });
      const page = await s.listJobItems(A, job.id, { status: "failed", limit: 3 });
      expect(page.items).toHaveLength(3); expect(page.nextCursor).toBeTruthy();
      expect((await s.listJobItems(A, job.id, { limit: 100 })).items.every((i) => i.jobId === job.id)).toBe(true);
    });

    it("imports: record + chunked rows, atomic counters, capped failed rows, org scoping", async () => {
      const row = (n: number) => ({ line: n + 2, name: `C${n}`, gstin: gst(n + 1) });
      const chunks = [[row(0), row(1)], [row(2)]];
      const rec = {
        id: "imp-1", organizationId: A, createdBy: "u", fileName: "f.csv", status: "queued" as const, createdAt: "2026-10-06T00:00:00.000Z", totalRows: 3,
        counts: { valid: 3, invalid: 0, duplicate: 0, existing: 0, skippedPlanLimit: 0, imported: 0, failedToCreate: 0 }, toCreate: 3, processed: 0, chunks: 2, nextChunk: 0,
        failedRows: [], failedRowsTruncated: false, fingerprint: "fp",
      };
      await s.putImport(A, rec, chunks);
      await s.putImport(A, { ...rec, id: "imp-2", createdAt: "2026-10-07T00:00:00.000Z" });
      expect((await s.listImports(A, 10)).map((r) => r.id)).toEqual(["imp-2", "imp-1"]);
      expect(await s.getImportChunk(A, "imp-1", 0)).toEqual(chunks[0]);
      expect(await s.getImportChunk(A, "imp-1", 1)).toEqual(chunks[1]);
      expect(await s.getImportChunk(A, "imp-1", 2)).toBeNull();
      await Promise.all(Array.from({ length: 10 }, () => s.incrementImport(A, "imp-1", { imported: 1, processed: 1 })));
      const failed = Array.from({ length: 1005 }, (_, i) => ({ line: i, name: "x", gstin: "g", email: "", phone: "", reason: "R" }));
      const r = (await s.incrementImport(A, "imp-1", { skippedPlanLimit: 2 }, { status: "processing", nextChunk: 1 }, failed))!;
      expect(r).toMatchObject({ processed: 10, status: "processing", nextChunk: 1, failedRowsTruncated: true, counts: { imported: 10, skippedPlanLimit: 2 } });
      expect(r.failedRows).toHaveLength(1000);
      expect(await s.getImport(B, "imp-1")).toBeNull();
      expect(await s.listImports(B, 10)).toEqual([]);
      expect(await s.getImportChunk(B, "imp-1", 0)).toBeNull();
      expect(await s.incrementImport(B, "imp-1", { imported: 1 })).toBeNull();
      await expect(s.putImport(B, rec)).rejects.toThrow();            // cannot write another org's record into this org
    });

    it("verifications: one record per GSTIN (upsert), newest first, org-scoped, isolated from caller mutation", async () => {
      const rec = (g: string, at: string, outcome: "ACTIVE" | "CANCELLED" = "ACTIVE") =>
        ({ gstin: g, outcome, details: { legalName: "X LTD" }, source: "t", verifiedAt: at, by: "u", requestId: `r-${g}-${at}` });
      await s.putVerification(A, rec(gst(1), "2026-10-06T01:00:00.000Z"));
      await s.putVerification(A, rec(gst(2), "2026-10-06T03:00:00.000Z"));
      await s.putVerification(A, rec(gst(1), "2026-10-06T02:00:00.000Z", "CANCELLED")); // upsert replaces gst(1)
      const list = await s.listVerifications(A, 10);
      expect(list.map((r) => [r.gstin, r.outcome])).toEqual([[gst(2), "ACTIVE"], [gst(1), "CANCELLED"]]);
      expect((await s.listVerifications(A, 1)).map((r) => r.gstin)).toEqual([gst(2)]);
      expect(await s.getVerification(A, gst(1))).toMatchObject({ outcome: "CANCELLED", details: { legalName: "X LTD" } });
      expect(await s.getVerification(A, gst(99))).toBeNull();
      expect(await s.getVerification(B, gst(1))).toBeNull();           // org scoping
      expect(await s.listVerifications(B, 10)).toEqual([]);
      // saved filter
      await s.putVerification(A, { ...rec(gst(2), "2026-10-06T03:00:00.000Z"), saved: true });
      await s.putVerification(A, { ...rec(gst(3), "2026-10-06T04:00:00.000Z"), saved: false });
      expect((await s.listVerifications(A, 10, { saved: true })).map((r) => r.gstin)).toEqual([gst(2)]);
      expect((await s.listVerifications(A, 10)).map((r) => r.gstin)).toEqual([gst(3), gst(2), gst(1)]);
      expect(await s.listVerifications(B, 10, { saved: true })).toEqual([]);
      await s.putVerification(A, rec(gst(2), "2026-10-06T03:00:00.000Z")); // restore for the mutation check below
      const got = await s.getVerification(A, gst(2)); got!.outcome = "CANCELLED"; got!.details!.legalName = "MUTATED";
      expect(await s.getVerification(A, gst(2))).toMatchObject({ outcome: "ACTIVE", details: { legalName: "X LTD" } });
    });

    it("cost counters: atomic increments per scope+period; shared results are global and isolated from callers", async () => {
      const zero = { searches: 0, paidCalls: 0, cacheHits: 0, sharedHits: 0, cacheMisses: 0, deduped: 0, failures: 0, credits: 0 };
      expect(await s.getCost(`org:${A}`, "day:2026-10-06")).toEqual(zero);
      await Promise.all(Array.from({ length: 20 }, () => s.bumpCost(`org:${A}`, "day:2026-10-06", { searches: 1, paidCalls: 1, credits: 2 })));
      await s.bumpCost(`org:${A}`, "day:2026-10-06", { cacheHits: 3 });
      await s.bumpCost(`org:${B}`, "day:2026-10-06", { searches: 5 });
      await s.bumpCost(`org:${A}`, "day:2026-10-07", { searches: 7 });
      expect(await s.getCost(`org:${A}`, "day:2026-10-06")).toEqual({ ...zero, searches: 20, paidCalls: 20, credits: 40, cacheHits: 3 });
      expect((await s.getCost(`org:${B}`, "day:2026-10-06")).searches).toBe(5);
      expect((await s.getCost(`org:${A}`, "day:2026-10-07")).searches).toBe(7);
      await s.bumpCost("global", "month:2026-10", {});                     // empty delta is a no-op
      expect(await s.getCost("global", "month:2026-10")).toEqual(zero);
      expect(await s.getSharedResult(gst(1))).toBeNull();
      const r = { gstin: gst(1), outcome: "ACTIVE" as const, details: { legalName: "X LTD" }, source: "t", verifiedAt: "2026-10-06T01:00:00.000Z", provenance: "LIVE_PROVIDER" as const };
      await s.putSharedResult(r); await s.putSharedResult({ ...r, outcome: "CANCELLED", verifiedAt: "2026-10-06T02:00:00.000Z" }); // upsert
      expect(await s.getSharedResult(gst(1))).toMatchObject({ outcome: "CANCELLED", details: { legalName: "X LTD" } });
      const got = await s.getSharedResult(gst(1)); got!.details!.legalName = "MUTATED";
      expect((await s.getSharedResult(gst(1)))?.details?.legalName).toBe("X LTD");
    });

    it("verifications: deleteVerification removes only that org's record and is a no-op when absent", async () => {
      const rec = (g: string) => ({ gstin: g, outcome: "ACTIVE" as const, source: "t", verifiedAt: "2026-10-06T01:00:00.000Z", by: "u", requestId: "r", saved: true, note: "n", tags: ["t"] });
      await s.putVerification(A, rec(gst(1))); await s.putVerification(B, rec(gst(1))); await s.putVerification(A, rec(gst(2)));
      await s.deleteVerification(A, gst(1));
      expect(await s.getVerification(A, gst(1))).toBeNull();
      expect(await s.getVerification(B, gst(1))).not.toBeNull();
      expect((await s.listVerifications(A, 10)).map((r) => r.gstin)).toEqual([gst(2)]);
      await s.deleteVerification(A, gst(99));                                    // absent: no error
    });

    it("verifications: getVerifications returns exactly the records that exist, per org, de-duplicated, safe from caller mutation", async () => {
      const rec = (g: string) => ({ gstin: g, outcome: "ACTIVE" as const, details: { legalName: "X" }, source: "t", verifiedAt: "2026-10-06T01:00:00.000Z", by: "u", requestId: "r" });
      await s.putVerification(A, rec(gst(1))); await s.putVerification(A, rec(gst(2))); await s.putVerification(B, rec(gst(3)));
      const got = await s.getVerifications(A, [gst(1), gst(2), gst(2), gst(3), gst(99)]);
      expect(got.map((r) => r.gstin).sort()).toEqual([gst(1), gst(2)].sort());
      expect(await s.getVerifications(A, [])).toEqual([]);
      expect(await s.getVerifications(B, [gst(1), gst(2)])).toEqual([]);                           // org scoping
      got[0].details!.legalName = "MUTATED";
      expect((await s.getVerification(A, got[0].gstin))!.details!.legalName).toBe("X");
      const many = Array.from({ length: 650 }, (_, i) => gst(1000 + i));                          // spans several Firestore getAll chunks
      for (const g of many.slice(0, 5)) await s.putVerification(A, rec(g));
      expect((await s.getVerifications(A, many)).length).toBe(5);
    });

    it("concerns: create/get/list (newest first, filters)/update, org-scoped, isolated from caller mutation", async () => {
      const mk = (id: string, at: string, g = gst(1), status: "open" | "reviewed" | "closed" = "open") =>
        ({ id, organizationId: A, gstin: g, category: "OTHER" as const, description: "something odd about this one", reportedBy: "u", createdAt: at, status, snapshot: { outcome: "ACTIVE" as const, verifiedAt: at, source: "t" } });
      await s.createConcern(A, mk("c1", "2026-10-06T01:00:00.000Z"));
      await s.createConcern(A, mk("c2", "2026-10-06T02:00:00.000Z", gst(2)));
      await s.createConcern(A, mk("c3", "2026-10-06T03:00:00.000Z", gst(1), "closed"));
      expect((await s.listConcerns(A, { limit: 10 })).map((c) => c.id)).toEqual(["c3", "c2", "c1"]);
      expect((await s.listConcerns(A, { limit: 2 })).map((c) => c.id)).toEqual(["c3", "c2"]);
      expect((await s.listConcerns(A, { limit: 10, status: "open" })).map((c) => c.id)).toEqual(["c2", "c1"]);
      expect((await s.listConcerns(A, { limit: 10, gstin: gst(1) })).map((c) => c.id)).toEqual(["c3", "c1"]);
      expect(await s.listConcerns(B, { limit: 10 })).toEqual([]);
      expect(await s.getConcern(B, "c1")).toBeNull();
      const u = await s.updateConcern(A, "c1", { status: "reviewed", resolution: "ok", reviewedBy: "admin", updatedAt: "2026-10-06T04:00:00.000Z" });
      expect(u).toMatchObject({ id: "c1", status: "reviewed", resolution: "ok", reviewedBy: "admin" });
      expect(await s.updateConcern(A, "nope", { status: "closed" })).toBeNull();
      expect(await s.updateConcern(B, "c1", { status: "closed" })).toBeNull();     // another org's id
      const got = await s.getConcern(A, "c2"); got!.status = "closed"; got!.snapshot!.source = "MUTATED";
      expect(await s.getConcern(A, "c2")).toMatchObject({ status: "open", snapshot: { source: "t" } });
    });

    it("multi-GSTIN clients: every GSTIN is found, listed in allGstins, and searchable; scoped per organization", async () => {
      const c = { id: "m1", name: "Multi Co", gstin: gst(1), gstins: [gst(1), gst(2), gst(3)], filingFrequency: "MONTHLY" as const, status: "active" as const, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
      await s.createClient(A, c); await s.createClient(B, { ...c, id: "m2", gstin: gst(9), gstins: undefined });
      for (const g of [1, 2, 3]) expect((await s.findClientByGstin(A, gst(g)))?.id).toBe("m1");
      expect(await s.findClientByGstin(A, gst(9))).toBeNull(); expect(await s.findClientByGstin(B, gst(2))).toBeNull();
      expect(await s.allGstins(A)).toEqual(new Set([gst(1), gst(2), gst(3)])); expect(await s.allGstins(B)).toEqual(new Set([gst(9)]));
      expect(await s.countClients(A)).toBe(1);                                    // one client, three GSTINs
      await s.updateClient(A, "m1", { gstins: [gst(1), gst(3)] });
      expect(await s.findClientByGstin(A, gst(2))).toBeNull(); expect((await s.getClient(A, "m1"))!.gstins).toEqual([gst(1), gst(3)]);
    });

    it("archived clients: counted, listed and filtered separately; archived GSTIN records are hidden unless asked for; org-scoped", async () => {
      const mkc = (id: string, g: string, status: "active" | "archived") => ({ id, name: id, gstin: g, filingFrequency: "MONTHLY" as const, status, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
      await s.createClient(A, mkc("c1", gst(1), "active")); await s.createClient(A, mkc("c2", gst(2), "archived")); await s.createClient(A, mkc("c3", gst(3), "active")); await s.createClient(B, mkc("b1", gst(9), "active"));
      for (const [i, arch] of [[1, false], [2, true], [3, false]] as const) await s.putGstinRecord(A, { gstin: gst(i), clientId: `c${i}`, status: "Unknown", checked: false, ...(arch ? { archived: true } : {}) });
      expect(await s.countClients(A)).toBe(2); expect(await s.countClients(A, "archived")).toBe(1); expect(await s.countClients(B)).toBe(1);
      expect((await s.listClients(A, { limit: 10 })).items.map((c) => c.id).sort()).toEqual(["c1", "c3"]);
      expect((await s.listClients(A, { limit: 10, status: "archived" })).items.map((c) => c.id)).toEqual(["c2"]);
      expect((await s.listClients(A, { limit: 10, status: "all" })).items).toHaveLength(3);
      expect(await s.countGstins(A, {})).toBe(2); expect(await s.countGstins(A, { archived: true })).toBe(1);
      expect((await s.listGstins(A, {}, { limit: 10, sort: { by: "gstin", dir: "asc" } })).items.map((r) => r.gstin)).toEqual([gst(1), gst(3)]);
      expect((await s.listGstins(A, { archived: true }, { limit: 10, sort: { by: "gstin", dir: "asc" } })).items.map((r) => r.gstin)).toEqual([gst(2)]);
    });

    it("due clients: scheduled + active + due, across organizations, soonest first; clearing a schedule removes it", async () => {
      const mk = (org: string, id: string, g: number, over: Record<string, unknown> = {}) =>
        s.createClient(org, { id, name: id, gstin: gst(g), filingFrequency: "MONTHLY", status: "active", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...over } as never);
      await mk(A, "a-late", 1, { verifySchedule: "daily", nextVerifyAt: "2026-10-06T03:00:00.000Z" });
      await mk(A, "a-early", 2, { verifySchedule: "weekly", nextVerifyAt: "2026-10-06T01:00:00.000Z" });
      await mk(A, "a-future", 3, { verifySchedule: "daily", nextVerifyAt: "2026-10-09T00:00:00.000Z" });
      await mk(A, "a-none", 4);
      await mk(A, "a-arch", 5, { verifySchedule: "daily", nextVerifyAt: "2026-10-06T00:00:00.000Z", status: "archived" });
      await mk(B, "b-due", 6, { verifySchedule: "monthly", nextVerifyAt: "2026-10-06T02:00:00.000Z" });
      const due = (await s.listDueClients("2026-10-06T12:00:00.000Z", 10)).filter((d) => d.orgId === A || d.orgId === B);
      expect(due.map((d) => `${d.orgId === A ? "A" : "B"}:${d.clientId}`)).toEqual(["A:a-early", "B:b-due", "A:a-late"]);
      expect(due[0]).toMatchObject({ gstin: gst(2), nextVerifyAt: "2026-10-06T01:00:00.000Z" });
      expect((await s.listDueClients("2026-10-06T12:00:00.000Z", 1)).length).toBe(1);
      await s.updateClient(A, "a-early", { verifySchedule: undefined, nextVerifyAt: undefined });
      expect((await s.listDueClients("2026-10-06T12:00:00.000Z", 10)).filter((d) => d.orgId === A).map((d) => d.clientId)).toEqual(["a-late"]);
    });

    it("alerts: upsert by id, newest first, unread filter, mark read/unread by ids or all, counts, org-scoped", async () => {
      const al = (id: string, at: string, read = false) => ({ id, type: "GSTIN_CANCELLED" as const, message: id, at, read });
      await s.addAlert(A, al("x1", "2026-10-06T01:00:00.000Z")); await s.addAlert(A, al("x2", "2026-10-06T03:00:00.000Z")); await s.addAlert(A, al("x3", "2026-10-06T02:00:00.000Z"));
      await s.addAlert(A, { ...al("x1", "2026-10-06T01:00:00.000Z"), message: "again" });               // upsert, not a duplicate
      await s.addAlert(B, al("y1", "2026-10-06T09:00:00.000Z"));
      expect((await s.listAlerts(A, 10)).map((a) => a.id)).toEqual(["x2", "x3", "x1"]); expect((await s.listAlerts(A, 10)).find((a) => a.id === "x1")?.message).toBe("again");
      expect((await s.listAlerts(A, 2)).map((a) => a.id)).toEqual(["x2", "x3"]); expect(await s.countUnreadAlerts(A)).toBe(3);
      expect(await s.markAlerts(A, { ids: ["x2", "y1", "nope"] }, true)).toBe(1);                       // another org's id is ignored
      expect((await s.listAlerts(A, 10, { unread: true })).map((a) => a.id)).toEqual(["x3", "x1"]); expect(await s.countUnreadAlerts(B)).toBe(1);
      expect(await s.markAlerts(A, { ids: ["x2"] }, true)).toBe(0);                                      // already read
      expect(await s.markAlerts(A, { all: true }, true)).toBe(2); expect(await s.countUnreadAlerts(A)).toBe(0);
      expect(await s.markAlerts(A, { ids: ["x1"] }, false)).toBe(1); expect(await s.markAlerts(A, { all: true }, false)).toBe(2); expect(await s.countUnreadAlerts(A)).toBe(3);
    });

    it("idempotency: first claim wins; release is compare-and-delete", async () => {
      expect(await s.claimIdempotency(A, "k", "job1", "fp", NOW.toISOString())).toBeNull();
      expect(await s.claimIdempotency(A, "k", "job2", "fp2", NOW.toISOString())).toMatchObject({ jobId: "job1", fingerprint: "fp" });
      await s.releaseIdempotency(A, "k", "job2");                       // not the owner ⇒ no effect
      expect(await s.claimIdempotency(A, "k", "job3", "fp", NOW.toISOString())).toMatchObject({ jobId: "job1" });
      await s.releaseIdempotency(A, "k", "job1");
      expect(await s.claimIdempotency(A, "k", "job4", "fp", NOW.toISOString())).toBeNull();
      expect(await s.claimIdempotency(B, "k", "jobB", "fp", NOW.toISOString())).toBeNull(); // keys are per-organization
      const winners = await Promise.all(Array.from({ length: 8 }, (_, i) => s.claimIdempotency(A, "race", `j${i}`, "fp", NOW.toISOString())));
      expect(winners.filter((w) => w === null)).toHaveLength(1);
    });
  });
}
