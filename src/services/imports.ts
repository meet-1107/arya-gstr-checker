import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getPlan } from "@/config/plans";
import { estimateSeconds } from "@/config/provider";
import type { ProviderLimits } from "@/config/provider";
import { currentMonthKey } from "@/lib/dates";
import { analyzeImport, guessMapping, MAX_CSV_BYTES, MAX_CSV_ROWS, parseCsv, toCsv, type ColumnMapping, type ImportRow } from "@/lib/csv";
import { AppError, type Ctx } from "@/lib/errors";
import { reasonText } from "@/lib/import-reasons";
import { acquireIdempotent } from "@/lib/idempotency";
import { assertCan, can } from "@/lib/permissions";
import { clampLimit } from "@/lib/pagination";
import { runWithConcurrency } from "@/lib/resilience";
import { effectiveStatus, isWritable } from "@/lib/subscription";
import type { Client, ImportFailedRow, ImportRecord, ImportRowData, Store } from "@/lib/store/types";
import { UsageError, UsageService } from "@/lib/usage";
import { ProviderError } from "@/providers/types";
import { MAX_JOB_ITEMS, type BulkService, type JobQueue } from "./bulk";

export const IMPORT_CHUNK_SIZE = 500;
export const MAX_IMPORT_BODY_BYTES = 6_000_000; // CSV (≤5 MB) + JSON envelope
const CREATE_CONCURRENCY = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9]{6,15}$/;
const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TERMINAL: ImportRecord["status"][] = ["completed", "completed_with_errors", "failed"];

const idx = z.number().int().min(0).max(500);
const input = z.object({
  csv: z.string().min(1, "The file is empty.").max(MAX_CSV_BYTES * 2),
  fileName: z.string().trim().max(200).default("clients.csv"),
  hasHeader: z.boolean().default(true),
  mapping: z.object({ gstin: idx, name: idx.optional(), email: idx.optional(), phone: idx.optional() }).optional(),
  verify: z.object({ includeReturns: z.boolean().default(true), allowPartial: z.boolean().default(false) }).optional(),
  allowPartialClients: z.boolean().default(false),
});
type Input = z.output<typeof input>;

/** Deterministic id ⇒ re-processing a chunk after a crash can never create a duplicate client. */
export const importClientId = (importId: string, gstin: string) => `c_${sha(`${importId}:${gstin}`).slice(0, 24)}`;

export interface Analysis {
  rows: ImportRow[];
  counts: { total: number; valid: number; invalid: number; duplicate: number; existing: number };
  mapping: ColumnMapping;
  hasHeader: boolean;
  header: string[];
}

export function publicImport(r: ImportRecord) {
  const { fingerprint: _f, failedRows, ...rest } = r;
  void _f;
  return {
    ...rest,
    failedRowsCount: failedRows.length,
    progress: { percent: r.toCreate > 0 ? Math.min(100, Math.round((r.processed / r.toCreate) * 100)) : TERMINAL.includes(r.status) ? 100 : 0 },
  };
}

export class ImportService {
  constructor(
    private store: Store, private bulk: BulkService, private queue: JobQueue, private limits: ProviderLimits,
    private now: () => Date = () => new Date(),
  ) {}

  // ---- validation (always server-side; the browser's analysis is never trusted) --------------------
  private parse(raw: unknown): Input {
    const p = input.safeParse(raw);
    if (!p.success) throw new AppError("VALIDATION_ERROR", p.error.issues[0]?.message ?? "Invalid request.", 400);
    if (Buffer.byteLength(p.data.csv, "utf8") > MAX_CSV_BYTES) throw new AppError("FILE_TOO_LARGE", `The file is larger than ${MAX_CSV_BYTES / 1024 / 1024} MB.`, 413);
    return p.data;
  }

  async analyze(orgId: string, i: Input): Promise<Analysis> {
    const data = parseCsv(i.csv);
    if (data.length === 0) throw new AppError("EMPTY_FILE", "The file has no rows.", 400);
    const header = data[0];
    const cols = Math.max(...data.slice(0, 50).map((r) => r.length));
    const mapping = (i.mapping ?? (i.hasHeader ? guessMapping(header) : undefined)) as Partial<ColumnMapping> | undefined;
    if (!mapping || mapping.gstin === undefined) throw new AppError("MAPPING_REQUIRED", "Choose which column contains the GSTIN.", 400);
    for (const [k, v] of Object.entries(mapping)) if (v !== undefined && v >= cols) throw new AppError("VALIDATION_ERROR", `Column for ${k} does not exist in this file.`, 400);
    if (data.length - (i.hasHeader ? 1 : 0) > MAX_CSV_ROWS) throw new AppError("TOO_MANY_ROWS", `A file can contain at most ${MAX_CSV_ROWS.toLocaleString("en-IN")} rows.`, 413);
    if (data.length - (i.hasHeader ? 1 : 0) <= 0) throw new AppError("EMPTY_FILE", "The file has a header but no data rows.", 400);

    const base = analyzeImport(data, mapping as ColumnMapping, await this.store.allGstins(orgId), i.hasHeader);
    const rows = base.rows.map((r): ImportRow => {
      if (r.status !== "valid") return r;
      const email = r.email.trim().toLowerCase(), phone = r.phone.replace(/[\s-]/g, "");
      if (!r.name.trim()) return { ...r, status: "invalid", reason: "MISSING_NAME" };
      if (r.name.length > 200) return { ...r, status: "invalid", reason: "NAME_TOO_LONG" };
      if (email && !EMAIL.test(email)) return { ...r, status: "invalid", reason: "INVALID_EMAIL" };
      if (phone && !PHONE.test(phone)) return { ...r, status: "invalid", reason: "INVALID_PHONE" };
      return { ...r, name: r.name.trim(), email, phone };
    });
    const c = (s: ImportRow["status"]) => rows.filter((r) => r.status === s).length;
    return { rows, mapping: mapping as ColumnMapping, hasHeader: i.hasHeader, header, counts: { total: rows.length, valid: c("valid"), invalid: c("invalid"), duplicate: c("duplicate"), existing: c("existing") } };
  }

  private async capacity(orgId: string) {
    const org = await this.store.getOrg(orgId);
    if (!org) throw new AppError("ORG_NOT_FOUND", "Organization not found.", 404);
    const limit = getPlan(org.plan).clientLimit;
    const used = await this.store.countClients(orgId);
    return { org, limit, used, remaining: limit === null ? Infinity : Math.max(0, limit - used) };
  }

  // ---- preview: nothing is stored or consumed -----------------------------------------------------
  async preview(ctx: Ctx, raw: unknown) {
    assertCan(ctx.role, "imports:run");
    const i = this.parse(raw);
    const a = await this.analyze(ctx.orgId, i);
    const cap = await this.capacity(ctx.orgId);
    const v = a.counts.valid;
    const willImport = Math.min(v, cap.remaining);
    const status = effectiveStatus(cap.org, this.now());
    const usage = await new UsageService(this.store.usage).summary({ organizationId: ctx.orgId, plan: cap.org.plan, status }, currentMonthKey(this.now()));
    const remaining = usage.remaining;
    const pick = (s: ImportRow["status"], n: number) => a.rows.filter((r) => r.status === s).slice(0, n);
    return {
      totalRows: a.counts.total, counts: a.counts, mapping: a.mapping, hasHeader: a.hasHeader, header: a.header,
      samples: { valid: pick("valid", 20), invalid: pick("invalid", 100), duplicate: pick("duplicate", 100), existing: pick("existing", 100) },
      capacity: { limit: cap.limit, used: cap.used, remaining: cap.limit === null ? null : cap.remaining, fits: v <= cap.remaining, willImport, willSkip: v - willImport },
      readOnly: !isWritable(cap.org, this.now()),
      verify: {
        checks: willImport, remaining, afterRemaining: remaining === null ? null : Math.max(0, remaining - willImport), sufficient: remaining === null || remaining >= willImport,
        bulkAllowed: willImport <= 1 || getPlan(cap.org.plan).features.bulkChecks, tooManyForOneRun: willImport > MAX_JOB_ITEMS,
        seconds: { full: estimateSeconds(willImport, true, this.limits), statusOnly: estimateSeconds(willImport, false, this.limits) },
      },
    };
  }

  // ---- start ---------------------------------------------------------------------------------------
  async start(ctx: Ctx, raw: unknown, idempotencyKey?: string | null): Promise<{ record: ImportRecord; replay: boolean }> {
    assertCan(ctx.role, "imports:run");
    if (idempotencyKey && !KEY_RE.test(idempotencyKey)) throw new AppError("VALIDATION_ERROR", "Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 _ . : -", 400);
    const i = this.parse(raw);

    // The idempotency key is acquired BEFORE any state-dependent rejection, so a client retrying a request that already
    // completed (timeout, double-click, flaky network) gets the original import back instead of a confusing error.
    const fingerprint = sha(JSON.stringify([i.csv, i.mapping ?? null, i.hasHeader, i.verify ?? null, i.allowPartialClients]));
    const key = idempotencyKey ? `imp:k:${sha(idempotencyKey)}` : `imp:auto:${fingerprint}`;
    const importId = randomUUID();
    const replay = await acquireIdempotent<ImportRecord>(this.store, {
      orgId: ctx.orgId, key, id: importId, fingerprint, explicit: !!idempotencyKey, now: this.now,
      load: (id) => this.store.getImport(ctx.orgId, id), isTerminal: (r) => TERMINAL.includes(r.status),
    });
    if (replay) return { record: replay, replay: true };

    try {
      const cap = await this.capacity(ctx.orgId);
      if (!isWritable(cap.org, this.now())) throw new UsageError("SUBSCRIPTION_INACTIVE", "Subscription is not active. Account is read-only.");
      const a = await this.analyze(ctx.orgId, i);
      if (a.counts.valid === 0) throw new AppError("NO_VALID_ROWS", "No rows can be imported. Check the column mapping and the failed-row reasons.", 400);

      const valid = a.rows.filter((r) => r.status === "valid");
      if (valid.length > cap.remaining && !i.allowPartialClients) {
        throw new AppError("CLIENT_LIMIT_REACHED", `Your ${getPlan(cap.org.plan).name} plan has room for ${cap.remaining} more client${cap.remaining === 1 ? "" : "s"}, but this file has ${valid.length} importable rows. Upgrade, or import only what fits.`, 402);
      }
      const keep = valid.slice(0, Number.isFinite(cap.remaining) ? cap.remaining : valid.length);
      if (keep.length === 0) {
        throw new AppError("CLIENT_LIMIT_REACHED", `Your ${getPlan(cap.org.plan).name} plan's client limit (${cap.limit}) is already reached. Upgrade your plan to add more clients.`, 402);
      }
      const skipped = valid.slice(keep.length);

      const toFailed = (r: ImportRow, reason: string): ImportFailedRow => ({ line: r.line, name: r.name, gstin: r.gstin, email: r.email, phone: r.phone, reason });
      const failed = [
        ...a.rows.filter((r) => r.status !== "valid").map((r) => toFailed(r, r.reason ?? r.status.toUpperCase())),
        ...skipped.map((r) => toFailed(r, "PLAN_LIMIT_REACHED")),
      ].sort((x, y) => x.line - y.line);
      const chunks: ImportRowData[][] = [];
      for (let n = 0; n < keep.length; n += IMPORT_CHUNK_SIZE) {
        chunks.push(keep.slice(n, n + IMPORT_CHUNK_SIZE).map((r) => ({ line: r.line, name: r.name, gstin: r.gstin, ...(r.email ? { email: r.email } : {}), ...(r.phone ? { phone: r.phone } : {}) })));
      }
      const record: ImportRecord = {
        id: importId, organizationId: ctx.orgId, createdBy: ctx.userId, fileName: i.fileName, status: "queued", createdAt: this.now().toISOString(),
        totalRows: a.counts.total,
        counts: { valid: a.counts.valid, invalid: a.counts.invalid, duplicate: a.counts.duplicate, existing: a.counts.existing, skippedPlanLimit: skipped.length, imported: 0, failedToCreate: 0 },
        toCreate: keep.length, processed: 0, chunks: chunks.length, nextChunk: 0,
        ...(i.verify ? { verify: { requested: true, includeReturns: i.verify.includeReturns, allowPartial: i.verify.allowPartial } } : {}),
        failedRows: failed.slice(0, 1000), failedRowsTruncated: failed.length > 1000, fingerprint,
      };
      await this.store.putImport(ctx.orgId, record, chunks);
      this.queue.enqueue({ orgId: ctx.orgId, jobId: importId, kind: "import" });
      return { record, replay: false };
    } catch (e) {
      await this.store.releaseIdempotency(ctx.orgId, key, importId).catch(() => undefined); // compare-and-delete: only our own claim
      throw e;
    }
  }

  // ---- worker (idempotent + resumable via nextChunk and deterministic client ids) --------------------
  async process(orgId: string, importId: string, o: { maxChunks?: number } = {}): Promise<void> {
    let rec = await this.store.getImport(orgId, importId);
    if (!rec || TERMINAL.includes(rec.status)) return;
    const member = await this.store.getMember(orgId, rec.createdBy);
    if (!member || !can(member.role, "imports:run")) return void (await this.finish(orgId, importId, "FORBIDDEN"));
    if (rec.status === "queued") rec = (await this.store.incrementImport(orgId, importId, {}, { status: "processing", startedAt: this.now().toISOString() })) ?? rec;

    const existing = await this.store.allGstins(orgId);
    let doneChunks = 0;
    for (let c = rec.nextChunk; c < rec.chunks; c++) {
      if (o.maxChunks !== undefined && doneChunks >= o.maxChunks) return; // test hook: simulate a worker crash
      const rows = (await this.store.getImportChunk(orgId, importId, c)) ?? [];
      const org = await this.store.getOrg(orgId);
      if (!org || !isWritable(org, this.now())) return void (await this.finish(orgId, importId, "SUBSCRIPTION_INACTIVE"));
      const limit = getPlan(org.plan).clientLimit;
      let room = limit === null ? Infinity : Math.max(0, limit - (await this.store.countClients(orgId))); // re-checked per chunk
      const already = new Set((await this.store.getClientsByIds(orgId, rows.map((r) => importClientId(importId, r.gstin)))).map((x) => x.id));

      let imported = 0, skipped = 0, failedToCreate = 0;
      const failed: ImportFailedRow[] = [];
      const todo: ImportRowData[] = [];
      for (const r of rows) {
        const row = { line: r.line, name: r.name, gstin: r.gstin, email: r.email ?? "", phone: r.phone ?? "" };
        if (already.has(importClientId(importId, r.gstin))) imported++;                       // created before a crash: idempotent
        else if (existing.has(r.gstin)) { failedToCreate++; failed.push({ ...row, reason: "ALREADY_EXISTS" }); }
        else if (room <= 0) { skipped++; failed.push({ ...row, reason: "PLAN_LIMIT_REACHED" }); }
        else { room--; todo.push(r); }
      }
      const ts = this.now().toISOString();
      await runWithConcurrency(todo, CREATE_CONCURRENCY, async (r) => {
        const client: Client = { id: importClientId(importId, r.gstin), name: r.name, gstin: r.gstin, ...(r.email ? { email: r.email } : {}), ...(r.phone ? { phone: r.phone } : {}), filingFrequency: "MONTHLY", status: "active", createdAt: ts, updatedAt: ts };
        try {
          await this.store.createClient(orgId, client);
        } catch (e) {
          if (!/CLIENT_EXISTS|ALREADY_EXISTS|already exists/i.test(String((e as Error)?.message))) throw e;
        }
        await this.store.putGstinRecord(orgId, { gstin: r.gstin, clientId: client.id, status: "Unknown", checked: false, clientName: r.name });
        existing.add(r.gstin);
        imported++;
      });
      await this.store.incrementImport(orgId, importId, { imported, failedToCreate, skippedPlanLimit: skipped, processed: rows.length }, { nextChunk: c + 1 }, failed);
      doneChunks++;
    }
    await this.finish(orgId, importId);
  }

  private async finish(orgId: string, importId: string, stop?: string) {
    let rec = await this.store.getImport(orgId, importId);
    if (!rec || TERMINAL.includes(rec.status)) return;
    const c = rec.counts;
    const problems = c.invalid + c.duplicate + c.existing + c.skippedPlanLimit + c.failedToCreate;
    const status: ImportRecord["status"] = stop || c.imported === 0 ? "failed" : problems > 0 ? "completed_with_errors" : "completed";
    rec = (await this.store.incrementImport(orgId, importId, {}, { status, completedAt: this.now().toISOString(), ...(stop ? { errorCode: stop } : {}) })) ?? rec;
    await this.store.addAudit({ id: randomUUID(), organizationId: orgId, userId: rec.createdBy, action: "CSV_IMPORTED", target: importId, at: this.now().toISOString(), metadata: { imported: c.imported, rejected: problems, rows: rec.totalRows } });
    await this.store.addAlert(orgId, { id: randomUUID(), type: "IMPORT_COMPLETED", at: this.now().toISOString(), read: false, message: stop ? `CSV import stopped (${stop}).` : `CSV import finished: ${c.imported} client${c.imported === 1 ? "" : "s"} added, ${problems} row${problems === 1 ? "" : "s"} skipped.` });
    if (rec.verify?.requested && c.imported > 0 && !stop) await this.verify(orgId, rec);
  }

  /** Optional GST verification of the newly imported clients — through the EXISTING bulk machinery (quota hold, gating, rate limits). */
  private async verify(orgId: string, rec: ImportRecord) {
    const v = rec.verify!;
    let outcome: NonNullable<ImportRecord["verify"]> = { ...v };
    try {
      const member = await this.store.getMember(orgId, rec.createdBy);
      if (!member) throw new AppError("FORBIDDEN", "Requester is no longer a member.", 403);
      const ids: string[] = [];
      for (let c = 0; c < rec.chunks; c++) {
        const rows = (await this.store.getImportChunk(orgId, rec.id, c)) ?? [];
        for (const cl of await this.store.getClientsByIds(orgId, rows.map((r) => importClientId(rec.id, r.gstin)))) ids.push(cl.id);
      }
      if (ids.length > MAX_JOB_ITEMS) throw new AppError("TOO_MANY_ITEMS", "Too many clients for one verification run.", 400);
      const { job } = await this.bulk.create({ orgId, userId: rec.createdBy, role: member.role }, { clientIds: ids, includeReturns: v.includeReturns, allowPartial: v.allowPartial }, `import-${rec.id}`);
      outcome = { ...v, jobId: job.id };
    } catch (e) {
      // The import itself succeeded; only the follow-up verification could not start. Report a safe code, never raw text.
      outcome = { ...v, errorCode: e instanceof AppError || e instanceof UsageError || e instanceof ProviderError ? e.code : "INTERNAL_ERROR" };
    }
    await this.store.incrementImport(orgId, rec.id, {}, { verify: outcome });
  }

  // ---- reads / controls ----------------------------------------------------------------------------
  private async load(ctx: Ctx, id: string) {
    const r = await this.store.getImport(ctx.orgId, id); // org-scoped: another org's id is simply "not found"
    if (!r) throw new AppError("IMPORT_NOT_FOUND", "Import not found.", 404);
    return r;
  }
  async get(ctx: Ctx, id: string) { assertCan(ctx.role, "clients:read"); return publicImport(await this.load(ctx, id)); }
  async list(ctx: Ctx, limit?: number) { assertCan(ctx.role, "clients:read"); return (await this.store.listImports(ctx.orgId, clampLimit(limit, 20, 50))).map(publicImport); }

  /** CSV of rows that were not imported. Spreadsheet-formula-safe (toCsv neutralises =, +, -, @). */
  async failedRowsCsv(ctx: Ctx, id: string) {
    assertCan(ctx.role, "clients:read");
    const r = await this.load(ctx, id);
    const csv = toCsv([["line", "client_name", "gstin", "email", "phone", "reason_code", "reason"], ...r.failedRows.map((f) => [f.line, f.name, f.gstin, f.email, f.phone, f.reason, reasonText(f.reason)])]);
    return { csv, truncated: r.failedRowsTruncated, count: r.failedRows.length };
  }

  /** Crash recovery: restarts the worker from the next unprocessed chunk. */
  async resume(ctx: Ctx, id: string) {
    assertCan(ctx.role, "imports:run");
    const r = await this.load(ctx, id);
    if (!TERMINAL.includes(r.status)) this.queue.enqueue({ orgId: ctx.orgId, jobId: id, kind: "import" });
    return publicImport(r);
  }
}
