import { clientGstins } from "@/lib/client-gstins";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { getPlan } from "@/config/plans";
import { estimateSeconds, providerRequestsPerCheck, type ProviderLimits } from "@/config/provider";
import { currentMonthKey } from "@/lib/dates";
import { AppError, type Ctx } from "@/lib/errors";
import { acquireIdempotent } from "@/lib/idempotency";
import { assertCan, can } from "@/lib/permissions";
import { clampLimit } from "@/lib/pagination";
import { runWithConcurrency } from "@/lib/resilience";
import { effectiveStatus, isWritable } from "@/lib/subscription";
import type { BulkJob, BulkJobItem, GstinFilter, GstinRecord, JobItemStatus, Store, VerificationRecord } from "@/lib/store/types";
import { UsageError, UsageService, type OrgBilling } from "@/lib/usage";
import { ProviderError } from "@/providers/types";
import { validateGstin, normalizeGstin } from "@/lib/gstin";
import { EXPLANATIONS, isFailure, type VerificationOutcome } from "@/lib/verification";
import { toCsv } from "@/lib/csv";
import type { VerificationService } from "./verification";
import type { CheckService } from "./checks";

export const MAX_JOB_ITEMS = 10_000;
export const STALE_ITEM_MS = 5 * 60_000;
export const MAX_ITEM_ATTEMPTS = 3;
export { IDEMPOTENCY_CLAIM_TTL_MS } from "@/lib/idempotency";
const CHUNK = 300;

/** Queue abstraction. In-process today; Cloud Tasks (task per job/chunk → internal endpoint) when GCP is available. */
export type QueueKind = "bulk" | "import";
export interface QueueRef { orgId: string; jobId: string; kind?: QueueKind }
export interface JobQueue { enqueue(ref: QueueRef): void }

/** Dev/test queue. NOT safe for serverless (work after the response is not guaranteed) — see ISSUE-006. */
export class InProcessQueue implements JobQueue {
  private active = new Map<string, Promise<void>>();
  private handler?: (orgId: string, jobId: string, kind: QueueKind) => Promise<void>;
  setHandler(h: (orgId: string, jobId: string, kind: QueueKind) => Promise<void>) { this.handler = h; }
  enqueue({ orgId, jobId, kind = "bulk" }: QueueRef) {
    const key = `${kind}/${orgId}/${jobId}`;
    if (this.active.has(key) || !this.handler) return; // one runner per job; resumable via claim semantics
    const h = this.handler;
    const p = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => h(orgId, jobId, kind))
      .catch((e) => console.error(`[${kind}] worker error`, e instanceof Error ? e.name : typeof e))
      .finally(() => { this.active.delete(key); });
    this.active.set(key, p);
  }
  /** Await all running jobs (tests, graceful shutdown). */
  async idle() { while (this.active.size) await Promise.all([...this.active.values()]); }
}

const selection = z.object({
  clientIds: z.array(z.string().min(1).max(100)).max(MAX_JOB_ITEMS).optional(),
  mode: z.enum(["all", "never_checked", "needs_refresh", "needs_attention"]).optional(),
  force: z.boolean().default(false),
  includeReturns: z.boolean().default(true),
  allowPartial: z.boolean().default(false),
}).refine((v) => !!v.clientIds?.length !== !!v.mode, { message: "Provide either clientIds or mode." });
export type BulkRequest = z.input<typeof selection>;

const verifySelection = z.object({
  gstins: z.array(z.string().max(64)).min(1).max(MAX_JOB_ITEMS * 2),
  force: z.boolean().default(false),
  allowPartial: z.boolean().default(false),
});
const INVALID_SAMPLE_CAP = 200;
/** Item error codes for pipeline failures of a verification (same vocabulary the provider gate uses). */
const OUTCOME_CODE: Partial<Record<VerificationOutcome, string>> = {
  TIMEOUT: "GST_PROVIDER_TIMEOUT", MAINTENANCE: "GST_PROVIDER_UNAVAILABLE", RATE_LIMITED: "GST_PROVIDER_RATE_LIMITED", PROVIDER_ERROR: "GST_PROVIDER_BAD_RESPONSE",
};

const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TERMINAL: BulkJob["status"][] = ["completed", "completed_with_errors", "failed", "cancelled"];

export function publicJob(j: BulkJob, l?: ProviderLimits) {
  const done = j.counts.succeeded + j.counts.cached + j.counts.failed + j.counts.cancelled;
  const remainingLive = Math.max(0, j.counts.queued + j.counts.processing);
  return {
    id: j.id, kind: j.kind ?? "check", status: j.status, requestedBy: j.requestedBy, createdAt: j.createdAt, startedAt: j.startedAt, completedAt: j.completedAt,
    total: j.total, counts: j.counts, quota: j.quota, skipped: j.skipped, includeReturns: j.includeReturns, force: j.force, errorCode: j.errorCode,
    progress: { done, percent: j.total ? Math.round((done / j.total) * 100) : 100 },
    estimatedSecondsRemaining: l && remainingLive ? estimateSeconds(remainingLive, j.includeReturns, l) : 0,
  };
}
export const publicItem = (i: BulkJobItem, v?: VerificationRecord | null) => ({
  id: i.id, clientId: i.clientId, gstin: i.gstin, status: i.status, attempts: i.attempts, errorCode: i.errorCode, retryable: i.retryable, completedAt: i.completedAt,
  verification: v ? { outcome: v.outcome, details: v.details, verifiedAt: v.verifiedAt, saved: v.saved === true, note: v.note, tags: v.tags } : undefined,
});

interface Resolved { items: { clientId: string; gstin: string }[]; records: Map<string, GstinRecord>; skipped: number }

export class BulkService {
  private usage: UsageService;
  constructor(
    private store: Store, private checks: CheckService, private queue: JobQueue, private limits: ProviderLimits,
    private now: () => Date = () => new Date(),
    private verification?: VerificationService,
  ) { this.usage = new UsageService(store.usage); }

  // ---- selection ---------------------------------------------------------------------------------
  private async resolve(ctx: Ctx, req: z.output<typeof selection>): Promise<Resolved> {
    const records = new Map<string, GstinRecord>();
    const items: Resolved["items"] = [];
    let skipped = 0;
    if (req.clientIds) {
      const ids = [...new Set(req.clientIds)];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const clients = await this.store.getClientsByIds(ctx.orgId, slice); // org-scoped: foreign ids are absent
        skipped += slice.length - clients.length;
        // A client firm may hold several GSTINs: selecting the client checks every one of them.
        const active = clients.filter((c) => c.status === "active");
        for (const r of await this.store.getGstinRecords(ctx.orgId, active.flatMap((c) => clientGstins(c)))) records.set(r.gstin, r);
        for (const c of active) for (const g of clientGstins(c)) items.push({ clientId: c.id, gstin: g });
      }
    } else {
      const f: GstinFilter = {
        all: {}, never_checked: { checked: false }, needs_refresh: { refreshBefore: this.now().toISOString() },
        needs_attention: { indicators: ["Needs Attention", "High Attention"] },
      }[req.mode!] as GstinFilter;
      let cursor: string | undefined;
      do {
        const page = await this.store.listGstins(ctx.orgId, f, { limit: 500, cursor, sort: { by: "gstin", dir: "asc" } });
        for (const r of page.items) { records.set(r.gstin, r); items.push({ clientId: r.clientId, gstin: r.gstin }); }
        cursor = page.nextCursor;
        if (items.length > MAX_JOB_ITEMS) break;
      } while (cursor);
    }
    if (items.length > MAX_JOB_ITEMS) throw new AppError("TOO_MANY_ITEMS", `A bulk check can include at most ${MAX_JOB_ITEMS.toLocaleString("en-IN")} GSTINs.`, 400);
    if (items.length === 0) throw new AppError("NO_CLIENTS", "No eligible clients were selected.", 400);
    return { items, records, skipped };
  }

  private fresh(r: GstinRecord | undefined) { return !!(r?.cacheExpiresAt && r.lastCheckedAt && new Date(r.cacheExpiresAt) > this.now()); }

  private async orgBilling(ctx: Ctx) {
    const org = await this.store.getOrg(ctx.orgId);
    if (!org) throw new AppError("ORG_NOT_FOUND", "Organization not found.", 404);
    const billing: OrgBilling = { organizationId: org.id, plan: org.plan, status: effectiveStatus(org, this.now()) };
    return { org, billing, month: currentMonthKey(this.now()) };
  }

  private parse(raw: unknown): z.output<typeof selection> {
    const p = selection.safeParse(raw);
    if (!p.success) throw new AppError("VALIDATION_ERROR", p.error.issues[0]?.message ?? "Invalid request.", 400);
    return p.data;
  }

  // ---- preview (confirmation modal data; consumes nothing) ------------------------------------------
  async estimate(ctx: Ctx, raw: unknown) {
    assertCan(ctx.role, "checks:run");
    const req = this.parse(raw);
    const { org, billing, month } = await this.orgBilling(ctx);
    const r = await this.resolve(ctx, req);
    const needsLive = req.force ? r.items.length : r.items.filter((i) => !this.fresh(r.records.get(i.gstin))).length;
    const s = await this.usage.summary(billing, month);
    const remaining = s.remaining;
    return {
      requested: r.items.length, skipped: r.skipped, needsLiveCheck: needsLive, servedFromCache: r.items.length - needsLive,
      quota: {
        limit: s.limit, used: s.used, reserved: s.reserved, remaining,
        afterRemaining: remaining === null ? null : Math.max(0, remaining - needsLive),
        sufficient: remaining === null || remaining >= needsLive,
      },
      providerRequests: needsLive * providerRequestsPerCheck(req.includeReturns),
      estimatedSeconds: estimateSeconds(needsLive, req.includeReturns, this.limits),
      bulkAllowed: r.items.length <= 1 || getPlan(org.plan).features.bulkChecks,
    };
  }

  // ---- create ------------------------------------------------------------------------------------
  async create(ctx: Ctx, raw: unknown, idempotencyKey?: string | null): Promise<{ job: BulkJob; replay: boolean }> {
    assertCan(ctx.role, "checks:run");
    const req = this.parse(raw);
    if (idempotencyKey && !KEY_RE.test(idempotencyKey)) throw new AppError("VALIDATION_ERROR", "Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 _ . : -", 400);
    const { org, billing, month } = await this.orgBilling(ctx);

    // Idempotency: explicit key, else a fingerprint of the REQUEST (order-insensitive; protects double-clicks / retries).
    // The key is claimed BEFORE any state-dependent rejection (read-only, empty selection, plan gating), so a client
    // retrying a request that already completed gets the original job back instead of a confusing error.
    const fingerprint = sha(JSON.stringify({ ids: req.clientIds ? [...new Set(req.clientIds)].sort() : null, mode: req.mode ?? null, force: req.force, ir: req.includeReturns, ap: req.allowPartial }));
    const key = idempotencyKey ? `k:${sha(idempotencyKey)}` : `auto:${fingerprint}`;
    const jobId = randomUUID();
    const acquired = await this.acquireKey(ctx.orgId, key, jobId, fingerprint, !!idempotencyKey);
    if (acquired) return { job: acquired, replay: true };

    const releaseKey = () => this.store.releaseIdempotency(ctx.orgId, key, jobId).catch(() => undefined);
    let held = 0;
    try {
      if (!isWritable(org, this.now())) throw new UsageError("SUBSCRIPTION_INACTIVE", "Subscription is not active. Account is read-only.");
      const r = await this.resolve(ctx, req);
      if (r.items.length > 1 && !getPlan(org.plan).features.bulkChecks) {
        throw new AppError("FEATURE_NOT_AVAILABLE", `Bulk checks are not included in the ${getPlan(org.plan).name} plan.`, 403);
      }
      const live = req.force ? r.items : r.items.filter((i) => !this.fresh(r.records.get(i.gstin)));
      held = await this.usage.holdChecks(billing, month, live.length, req.allowPartial); // atomic; throws QUOTA_EXHAUSTED
      const heldGstins = new Set(live.slice(0, held).map((i) => i.gstin));
      const liveGstins = new Set(live.map((i) => i.gstin));
      // allowPartial shortfall: drop the live items that did not get a unit
      const kept = r.items.filter((i) => !liveGstins.has(i.gstin) || heldGstins.has(i.gstin));
      const dropped = r.items.length - kept.length;
      const ts = this.now().toISOString();
      const items: BulkJobItem[] = kept.map((i) => ({
        id: randomUUID(), jobId, clientId: i.clientId, gstin: i.gstin, status: "queued", attempts: 0, held: heldGstins.has(i.gstin), settled: false,
      }));
      const job: BulkJob = {
        id: jobId, organizationId: ctx.orgId, requestedBy: ctx.userId, status: "queued", createdAt: ts,
        includeReturns: req.includeReturns, force: req.force, total: items.length,
        counts: { queued: items.length, processing: 0, succeeded: 0, cached: 0, failed: 0, cancelled: 0 },
        quota: { requested: live.length, reserved: held, consumed: 0, released: 0 },
        skipped: r.skipped + dropped, fingerprint,
      };
      await this.store.createJob(ctx.orgId, job, items);
      await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: "BULK_CHECK_STARTED", target: jobId, at: ts, metadata: { total: items.length, reserved: held } });
      this.queue.enqueue({ orgId: ctx.orgId, jobId });
      return { job, replay: false };
    } catch (e) {
      // Nothing was started: give the held units back and free the idempotency key.
      if (held > 0) await this.usage.settle(billing, month, 0, held);
      await releaseKey();
      if (e instanceof UsageError && e.code === "QUOTA_EXHAUSTED") {
        await this.store.addAlert(ctx.orgId, { id: randomUUID(), type: "QUOTA_EXHAUSTED", message: "A bulk GST check was blocked: not enough checks remaining.", at: this.now().toISOString(), read: false });
      }
      throw e;
    }
  }

  private acquireKey(orgId: string, key: string, jobId: string, fingerprint: string, explicit: boolean): Promise<BulkJob | null> {
    return acquireIdempotent<BulkJob>(this.store, {
      orgId, key, id: jobId, fingerprint, explicit, now: this.now,
      load: (id) => this.store.getJob(orgId, id), isTerminal: (j) => TERMINAL.includes(j.status),
    });
  }

  // ---- bulk verification of an ad-hoc GSTIN list (no client records; registry status only) ------------------------
  /** Splits raw input into valid (normalized, de-duplicated), invalid (with reason; capped sample) and duplicate counts. Never trusts the caller. */
  private analyze(raw: string[]) {
    const valid: string[] = [], seen = new Set<string>();
    const invalid: { input: string; reason: string }[] = [];
    let invalidCount = 0, duplicates = 0;
    for (const input of raw) {
      const v = validateGstin(input);
      if (!v.valid) { invalidCount++; if (invalid.length < INVALID_SAMPLE_CAP) invalid.push({ input: normalizeGstin(input).slice(0, 40), reason: v.reason }); continue; }
      if (seen.has(v.gstin)) { duplicates++; continue; }
      seen.add(v.gstin); valid.push(v.gstin);
    }
    return { valid, invalid, invalidCount, duplicates };
  }

  private verifier() {
    if (!this.verification) throw new AppError("INTERNAL_ERROR", "Verification is not configured.", 500);
    return this.verification;
  }

  private parseVerify(raw: unknown): z.output<typeof verifySelection> {
    const p = verifySelection.safeParse(raw);
    if (!p.success) throw new AppError("VALIDATION_ERROR", p.error.issues[0]?.message ?? "Invalid request.", 400);
    return p.data;
  }

  private async liveNeeded(ctx: Ctx, valid: string[], force: boolean): Promise<Set<string>> {
    if (force) return new Set(valid);
    const v = this.verifier();
    const stored = new Map((await this.store.getVerifications(ctx.orgId, valid)).map((r) => [r.gstin, r])); // batched reads, not one per GSTIN
    return new Set(valid.filter((g) => !v.isFresh(stored.get(g))));
  }

  /** Preview for the confirmation step. Consumes nothing. Invalid lines are reported, never sent to the provider. */
  async estimateVerify(ctx: Ctx, raw: unknown) {
    assertCan(ctx.role, "checks:run");
    const req = this.parseVerify(raw);
    const { org, billing, month } = await this.orgBilling(ctx);
    const a = this.analyze(req.gstins);
    if (a.valid.length > MAX_JOB_ITEMS) throw new AppError("TOO_MANY_ITEMS", `A bulk run can include at most ${MAX_JOB_ITEMS.toLocaleString("en-IN")} GSTINs.`, 400);
    const live = await this.liveNeeded(ctx, a.valid, req.force);
    const s = await this.usage.summary(billing, month);
    return {
      lines: req.gstins.length, valid: a.valid.length, invalid: a.invalid, invalidCount: a.invalidCount, duplicates: a.duplicates,
      needsLiveCheck: live.size, servedFromCache: a.valid.length - live.size,
      quota: { limit: s.limit, used: s.used, reserved: s.reserved, remaining: s.remaining, afterRemaining: s.remaining === null ? null : Math.max(0, s.remaining - live.size), sufficient: s.remaining === null || s.remaining >= live.size },
      providerRequests: live.size, estimatedSeconds: estimateSeconds(live.size, false, this.limits),
      bulkAllowed: a.valid.length <= 1 || getPlan(org.plan).features.bulkChecks,
    };
  }

  async createVerify(ctx: Ctx, raw: unknown, idempotencyKey?: string | null): Promise<{ job: BulkJob; replay: boolean; rejected: { invalidCount: number; duplicates: number } }> {
    assertCan(ctx.role, "checks:run");
    const req = this.parseVerify(raw);
    if (idempotencyKey && !KEY_RE.test(idempotencyKey)) throw new AppError("VALIDATION_ERROR", "Idempotency-Key must be 8-128 characters of A-Z a-z 0-9 _ . : -", 400);
    const { org, billing, month } = await this.orgBilling(ctx);
    const a = this.analyze(req.gstins);
    const rejected = { invalidCount: a.invalidCount, duplicates: a.duplicates };
    const fingerprint = sha(JSON.stringify({ verify: [...a.valid].sort(), force: req.force, ap: req.allowPartial }));
    const key = idempotencyKey ? `k:${sha(idempotencyKey)}` : `auto:${fingerprint}`;
    const jobId = randomUUID();
    const acquired = await this.acquireKey(ctx.orgId, key, jobId, fingerprint, !!idempotencyKey);
    if (acquired) return { job: acquired, replay: true, rejected };

    const releaseKey = () => this.store.releaseIdempotency(ctx.orgId, key, jobId).catch(() => undefined);
    let held = 0;
    try {
      if (!isWritable(org, this.now())) throw new UsageError("SUBSCRIPTION_INACTIVE", "Subscription is not active. Account is read-only.");
      if (a.valid.length === 0) throw new AppError("NO_VALID_GSTINS", "None of the entries is a valid GSTIN.", 400);
      if (a.valid.length > MAX_JOB_ITEMS) throw new AppError("TOO_MANY_ITEMS", `A bulk run can include at most ${MAX_JOB_ITEMS.toLocaleString("en-IN")} GSTINs.`, 400);
      if (a.valid.length > 1 && !getPlan(org.plan).features.bulkChecks) throw new AppError("FEATURE_NOT_AVAILABLE", `Bulk checks are not included in the ${getPlan(org.plan).name} plan.`, 403);
      const liveSet = await this.liveNeeded(ctx, a.valid, req.force);
      const live = a.valid.filter((g) => liveSet.has(g));
      held = await this.usage.holdChecks(billing, month, live.length, req.allowPartial);
      const heldSet = new Set(live.slice(0, held));
      const kept = a.valid.filter((g) => !liveSet.has(g) || heldSet.has(g));
      const ts = this.now().toISOString();
      const items: BulkJobItem[] = kept.map((g) => ({ id: randomUUID(), jobId, clientId: "", gstin: g, status: "queued", attempts: 0, held: heldSet.has(g), settled: false }));
      const job: BulkJob = {
        id: jobId, kind: "verify", organizationId: ctx.orgId, requestedBy: ctx.userId, status: "queued", createdAt: ts, includeReturns: false, force: req.force, total: items.length,
        counts: { queued: items.length, processing: 0, succeeded: 0, cached: 0, failed: 0, cancelled: 0 }, quota: { requested: live.length, reserved: held, consumed: 0, released: 0 },
        skipped: a.invalidCount + a.duplicates + (a.valid.length - kept.length), fingerprint,
      };
      await this.store.createJob(ctx.orgId, job, items);
      await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: "BULK_CHECK_STARTED", target: jobId, at: ts, metadata: { total: items.length, reserved: held, kind: "verify" } });
      this.queue.enqueue({ orgId: ctx.orgId, jobId });
      return { job, replay: false, rejected };
    } catch (e) {
      if (held > 0) await this.usage.settle(billing, month, 0, held);
      await releaseKey();
      if (e instanceof UsageError && e.code === "QUOTA_EXHAUSTED") {
        await this.store.addAlert(ctx.orgId, { id: randomUUID(), type: "QUOTA_EXHAUSTED", message: "A bulk GSTIN verification was blocked: not enough checks remaining.", at: this.now().toISOString(), read: false });
      }
      throw e;
    }
  }

  /** CSV of a verification run (formula-safe). Verification jobs only. */
  async exportVerify(ctx: Ctx, id: string): Promise<{ csv: string; rows: number; truncated: boolean }> {
    assertCan(ctx.role, "clients:read");
    const job = await this.load(ctx, id);
    if (job.kind !== "verify") throw new AppError("NOT_A_VERIFY_JOB", "Only GSTIN verification runs can be exported here.", 400);
    const header = ["GSTIN", "Result", "Source of answer", "Legal name", "Trade name", "Taxpayer type", "State", "Registration date", "Answer obtained at", "Error", "Tags", "Note", "Saved"];
    const rows: unknown[][] = [header];
    let cursor: string | undefined;
    do {
      const page = await this.store.listJobItems(ctx.orgId, id, { limit: 200, cursor });
      const byGstin = new Map((await this.store.getVerifications(ctx.orgId, page.items.map((i) => i.gstin))).map((r) => [r.gstin, r]));
      const recs = page.items.map((i) => byGstin.get(i.gstin) ?? null);
      page.items.forEach((i, n) => {
        const answered = i.status === "succeeded" || i.status === "cached";
        const r = answered ? recs[n] : null;
        rows.push([
          i.gstin, r ? EXPLANATIONS[r.outcome].title : i.status === "failed" ? "Could not verify" : i.status === "cancelled" ? "Cancelled" : "Not done",
          r ? (i.status === "cached" ? "Stored result" : "Live") : "", r?.details?.legalName ?? "", r?.details?.tradeName ?? "", r?.details?.taxpayerType ?? "", r?.details?.state ?? "",
          r?.details?.registrationDate ?? "", r?.verifiedAt ?? "", i.errorCode ?? "", (recs[n]?.tags ?? []).join("; "), recs[n]?.note ?? "", recs[n]?.saved ? "yes" : "",
        ]);
      });
      cursor = page.nextCursor;
    } while (cursor && rows.length <= MAX_JOB_ITEMS);
    return { csv: toCsv(rows), rows: rows.length - 1, truncated: !!cursor };
  }

  // ---- worker ------------------------------------------------------------------------------------
  /** Idempotent and resumable: only claims `queued` items, so duplicate/parallel invocations never double-process. */
  async processJob(orgId: string, jobId: string, o: { concurrency?: number; claimBatch?: number } = {}): Promise<void> {
    const job = await this.store.getJob(orgId, jobId);
    if (!job || (TERMINAL.includes(job.status) && job.counts.queued === 0 && job.counts.processing === 0)) return;
    const concurrency = Math.max(1, Math.min(o.concurrency ?? this.limits.bulkConcurrency, this.limits.maxConcurrent));
    for (;;) {
      const batch = await this.store.claimJobItems(orgId, jobId, o.claimBatch ?? concurrency * 2, this.now().toISOString());
      if (!batch.length) break;
      await runWithConcurrency(batch, concurrency, (it) => this.processItem(job, it));
    }
    await this.finalize(orgId, jobId);
  }

  private async processItem(job: BulkJob, item: BulkJobItem): Promise<void> {
    const orgId = job.organizationId;
    const { billing, month } = await this.orgBilling({ orgId } as Ctx);
    let heldNow = item.held;
    let status: JobItemStatus = "failed";
    let errorCode: string | undefined;
    let retryable = false;
    let consume = false;
    try {
      // Authorization is re-evaluated per item: the requester may have been demoted/removed since queuing.
      const m = await this.store.getMember(orgId, job.requestedBy);
      if (!m || !can(m.role, "checks:run")) throw new AppError("FORBIDDEN", "Requester no longer has permission.", 403);
      const ctx: Ctx = { orgId, userId: job.requestedBy, role: m.role };
      const isVerify = job.kind === "verify";
      const rec = isVerify ? null : await this.store.getGstinRecord(orgId, item.gstin);
      const cachedNow = !job.force && (isVerify ? this.verifier().isFresh(await this.store.getVerification(orgId, item.gstin)) : this.fresh(rec ?? undefined));
      if (!cachedNow && !heldNow) {
        await this.usage.holdChecks(billing, month, 1, false); // lazy hold (retries / items that expected cache)
        await this.store.incrementJob(orgId, job.id, { reserved: 1 });
        heldNow = true;
      }
      if (isVerify) {
        const v = await this.verifier().verify(ctx, item.gstin, { force: job.force, held: heldNow });
        if (isFailure(v.outcome) || v.outcome === "INVALID_GSTIN") {
          status = "failed"; errorCode = OUTCOME_CODE[v.outcome] ?? "INVALID_GSTIN"; retryable = v.retryable; consume = false;
        } else {
          status = v.freshness === "cached" ? "cached" : "succeeded";
          consume = v.freshness === "live" && v.outcome !== "NOT_FOUND"; // NOT_FOUND is an answer but is not billed
        }
      } else {
        const r = await this.checks.checkClient(ctx, item.clientId, { gstin: item.gstin, force: job.force, includeReturns: job.includeReturns, held: heldNow, jobId: job.id });
        status = r.cached ? "cached" : "succeeded";
        consume = !r.cached;
      }
    } catch (e) {
      if (e instanceof ProviderError) {
        errorCode = e.code;
        retryable = e.retryable || ["GST_PROVIDER_TIMEOUT", "GST_PROVIDER_UNAVAILABLE", "GST_PROVIDER_RATE_LIMITED"].includes(e.code);
        consume = e.billable; // only if the provider bills failed calls
      } else if (e instanceof UsageError || e instanceof AppError) {
        errorCode = e.code;
      } else errorCode = "INTERNAL_ERROR";
      status = "failed";
    }
    // Finish FIRST (transitions settled false→true exactly once), then settle quota only if we won that transition.
    // A crash in between leaks a hold toward UNDER-charging; finalize() reconciles it. Never toward double charge.
    const won = await this.store.finishJobItem(orgId, job.id, item.id, { status, errorCode, retryable: status === "failed" ? retryable : undefined, completedAt: this.now().toISOString() });
    if (won && heldNow) {
      await this.usage.settle(billing, month, consume ? 1 : 0, consume ? 0 : 1);
      await this.store.incrementJob(orgId, job.id, consume ? { consumed: 1 } : { released: 1 });
    }
  }

  /** Terminal bookkeeping: reconcile leaked holds, set final status, notify. Safe to call repeatedly. */
  private async finalize(orgId: string, jobId: string): Promise<void> {
    let job = await this.store.getJob(orgId, jobId);
    if (!job || job.counts.queued > 0 || job.counts.processing > 0) return;
    const { billing, month } = await this.orgBilling({ orgId } as Ctx);
    const leftover = job.quota.reserved - job.quota.consumed - job.quota.released;
    if (leftover > 0) {
      await this.usage.settle(billing, month, 0, leftover);
      job = (await this.store.incrementJob(orgId, jobId, { released: leftover })) ?? job;
    }
    const wasDone = !!job.completedAt;
    const c = job.counts;
    const status: BulkJob["status"] = job.status === "cancelled" ? "cancelled"
      : c.failed > 0 && c.succeeded + c.cached === 0 ? "failed"
      : c.failed > 0 ? "completed_with_errors" : "completed";
    job = (await this.store.incrementJob(orgId, jobId, {}, { status, completedAt: job.completedAt ?? this.now().toISOString() })) ?? job;
    if (!wasDone) {
      await this.store.addAlert(orgId, {
        id: randomUUID(), type: "BULK_CHECK_COMPLETED", at: this.now().toISOString(), read: false,
        message: `Bulk GST check ${status.replace(/_/g, " ")}: ${c.succeeded} checked, ${c.cached} from cache, ${c.failed} failed, ${c.cancelled} cancelled.`,
      });
      if (c.failed > 0) {
        await this.store.addAlert(orgId, { id: randomUUID(), type: "API_FAILURE", at: this.now().toISOString(), read: false, message: `${c.failed} GST check(s) failed in a bulk run.` });
      }
    }
  }

  // ---- reads / controls --------------------------------------------------------------------------
  private async load(ctx: Ctx, id: string): Promise<BulkJob> {
    const j = await this.store.getJob(ctx.orgId, id); // org-scoped: another org's job id is simply "not found"
    if (!j) throw new AppError("JOB_NOT_FOUND", "Bulk job not found.", 404);
    return j;
  }
  async get(ctx: Ctx, id: string) { assertCan(ctx.role, "clients:read"); return publicJob(await this.load(ctx, id), this.limits); }
  async list(ctx: Ctx, limit?: number) { assertCan(ctx.role, "clients:read"); return (await this.store.listJobs(ctx.orgId, clampLimit(limit, 20, 50))).map((j) => publicJob(j, this.limits)); }
  async items(ctx: Ctx, id: string, q: { status?: string; limit?: number; cursor?: string }) {
    assertCan(ctx.role, "clients:read");
    await this.load(ctx, id);
    const st = q.status ? z.enum(["queued", "processing", "succeeded", "cached", "failed", "cancelled"]).safeParse(q.status) : undefined;
    if (st && !st.success) throw new AppError("VALIDATION_ERROR", "Invalid status filter.", 400);
    const p = await this.store.listJobItems(ctx.orgId, id, { status: st?.data, limit: clampLimit(q.limit, 50, 200), cursor: q.cursor });
    const job = await this.load(ctx, id);
    if (job.kind !== "verify") return { items: p.items.map((i) => publicItem(i)), nextCursor: p.nextCursor };
    const byGstin = new Map((await this.store.getVerifications(ctx.orgId, p.items.filter((i) => i.status === "succeeded" || i.status === "cached").map((i) => i.gstin))).map((r) => [r.gstin, r]));
    const recs = p.items.map((i) => byGstin.get(i.gstin) ?? null);
    return { items: p.items.map((i, n) => publicItem(i, recs[n])), nextCursor: p.nextCursor };
  }

  /** Cancels queued items and returns their held units. Items already in flight finish normally. */
  async cancel(ctx: Ctx, id: string) {
    assertCan(ctx.role, "checks:run");
    const job = await this.load(ctx, id);
    if (TERMINAL.includes(job.status) && job.counts.queued === 0 && job.counts.processing === 0) return publicJob(job, this.limits);
    const cancelled = await this.store.cancelQueuedItems(ctx.orgId, id);
    const heldUnits = cancelled.filter((i) => i.held).length;
    if (heldUnits > 0) {
      const { billing, month } = await this.orgBilling(ctx);
      await this.usage.settle(billing, month, 0, heldUnits);
    }
    await this.store.incrementJob(ctx.orgId, id, heldUnits ? { released: heldUnits } : {}, { status: "cancelled" });
    await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: "BULK_CHECK_CANCELLED", target: id, at: this.now().toISOString(), metadata: { cancelled: cancelled.length } });
    await this.finalize(ctx.orgId, id);
    return publicJob(await this.load(ctx, id), this.limits);
  }

  /** Re-queues failed items that are safe to retry (provider outage/timeout). Quota is held lazily per item. */
  async retryFailed(ctx: Ctx, id: string) {
    assertCan(ctx.role, "checks:run");
    const job = await this.load(ctx, id);
    if (job.status === "cancelled") throw new AppError("JOB_CANCELLED", "A cancelled job cannot be retried.", 409);
    if (job.counts.processing > 0) throw new AppError("JOB_RUNNING", "Wait for in-flight checks to finish.", 409);
    const items = await this.store.requeueFailedItems(ctx.orgId, id);
    if (items.length) this.queue.enqueue({ orgId: ctx.orgId, jobId: id });
    return { requeued: items.length, job: publicJob(await this.load(ctx, id), this.limits) };
  }

  /** Crash recovery: puts stuck `processing` items back in the queue and restarts the worker. */
  async resume(ctx: Ctx, id: string) {
    assertCan(ctx.role, "checks:run");
    await this.load(ctx, id);
    const cutoff = new Date(this.now().getTime() - STALE_ITEM_MS).toISOString();
    const { requeued, failed } = await this.store.requeueStaleItems(ctx.orgId, id, cutoff, MAX_ITEM_ATTEMPTS);
    const heldUnits = failed.filter((i) => i.held).length;
    if (heldUnits > 0) {
      const { billing, month } = await this.orgBilling(ctx);
      await this.usage.settle(billing, month, 0, heldUnits); // outcome unknown ⇒ release (never overcharge)
      await this.store.incrementJob(ctx.orgId, id, { released: heldUnits });
    }
    this.queue.enqueue({ orgId: ctx.orgId, jobId: id });
    return { requeued, abandoned: failed.length, job: publicJob(await this.load(ctx, id), this.limits) };
  }
}
