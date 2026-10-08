import { z } from "zod";
import { AppError, type Ctx } from "@/lib/errors";
import { validateGstin } from "@/lib/gstin";
import { assertCan } from "@/lib/permissions";
import { clampLimit } from "@/lib/pagination";
import type { NormalizedReturn } from "@/lib/returns";
import type { GstinFilter, GstinRecord, GstinSort, ReturnFilter, Store } from "@/lib/store/types";

type Q = Record<string, string | undefined>;

const INDICATORS = ["Good", "Needs Attention", "High Attention", "Data Unavailable"] as const;
const STATUSES = ["Active", "Suspended", "Cancelled", "Inactive", "Unknown"] as const;
const bool = (v: string | undefined) => (v === "true" ? true : v === "false" ? false : undefined);

function parse<T>(schema: z.ZodType<T>, v: unknown, msg: string): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new AppError("VALIDATION_ERROR", `${msg}: ${r.error.issues[0]?.message ?? "invalid"}`, 400);
  return r.data;
}

/** Fields never exposed through the API (internal provider correlation ids). */
export function publicGstin(r: GstinRecord, now: Date) {
  const { providerRequestId: _p, ...rest } = r;
  void _p;
  return { ...rest, fresh: !!(r.cacheExpiresAt && new Date(r.cacheExpiresAt) > now) };
}

export class GstinQueryService {
  constructor(private store: Store, private now: () => Date = () => new Date()) {}

  /** GET /api/gstins — paginated, filterable, sortable. Reads stored data only (no provider calls). */
  async list(ctx: Ctx, q: Q) {
    assertCan(ctx.role, "clients:read");
    const f: GstinFilter = {};
    if (q.status) f.status = parse(z.enum(STATUSES), q.status, "status");
    if (q.indicator) f.indicators = parse(z.array(z.enum(INDICATORS)).max(4), q.indicator.split(","), "indicator");
    if (q.assignedTo) f.assignedTo = q.assignedTo;
    if (q.q?.trim()) f.search = q.q.trim().slice(0, 100);
    if (q.archived === "true") f.archived = true; // archived clients' GSTINs are hidden unless asked for
    const checked = bool(q.checked);
    if (checked !== undefined) f.checked = checked;
    if (q.needsRefresh === "true") f.refreshBefore = this.now().toISOString();
    if (q.gstr1) f.gstr1Missing = parse(z.enum(["some", "none"]), q.gstr1, "gstr1");
    if (q.gstr3b) f.gstr3bMissing = parse(z.enum(["some", "none"]), q.gstr3b, "gstr3b");
    if (q.late === "gstr1") f.gstr1Late = "some";
    if (q.late === "gstr3b") f.gstr3bLate = "some";
    const sort: GstinSort = {
      by: parse(z.enum(["gstin", "lastCheckedAt"]), q.sort ?? "gstin", "sort"),
      dir: parse(z.enum(["asc", "desc"]), q.dir ?? "asc", "dir"),
    };
    const page = await this.store.listGstins(ctx.orgId, f, { limit: clampLimit(q.limit ? Number(q.limit) : undefined), cursor: q.cursor, sort });
    const now = this.now();
    return { items: page.items.map((r) => publicGstin(r, now)), nextCursor: page.nextCursor };
  }

  private async load(ctx: Ctx, raw: string) {
    assertCan(ctx.role, "clients:read");
    const v = validateGstin(raw);
    if (!v.valid) throw new AppError("INVALID_GSTIN", "Invalid GSTIN.", 400);
    const rec = await this.store.getGstinRecord(ctx.orgId, v.gstin); // org-scoped: foreign GSTINs are simply not found
    if (!rec) throw new AppError("GSTIN_NOT_FOUND", "GSTIN not found.", 404);
    return rec;
  }

  async detail(ctx: Ctx, gstin: string) {
    const rec = await this.load(ctx, gstin);
    const c = await this.store.getClient(ctx.orgId, rec.clientId);
    return {
      gstin: publicGstin(rec, this.now()),
      client: c ? { id: c.id, name: c.name, filingFrequency: c.filingFrequency, assignedTo: c.assignedTo, email: c.email, phone: c.phone, contactPerson: c.contactPerson } : null,
    };
  }

  /** Lightweight status for polling UIs. Never claims "inactive" for Unknown. */
  async status(ctx: Ctx, gstin: string) {
    const r = await this.load(ctx, gstin);
    const p = publicGstin(r, this.now());
    return {
      gstin: r.gstin, status: r.status, indicator: r.indicator, lastCheckedAt: r.lastCheckedAt, cacheExpiresAt: r.cacheExpiresAt,
      fresh: p.fresh, source: r.source, neverChecked: !r.lastCheckedAt, lastError: r.lastError ? { code: r.lastError.code, at: r.lastError.at } : undefined,
    };
  }
}

const periodRe = /^(0[1-9]|1[0-2])\d{4}$/;
const fyRe = /^\d{4}-\d{2}$/;
const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date");
const STATUS_MAP = { filed: "FILED", not_filed: "NOT_FILED", unknown: "UNKNOWN" } as const;

export class ReturnsQueryService {
  constructor(private store: Store) {}

  private filter(q: Q, forced?: ReturnFilter["returnType"]): ReturnFilter {
    const f: ReturnFilter = {};
    const rt = forced ?? (q.returnType ? parse(z.enum(["GSTR1", "GSTR3B"]), q.returnType.toUpperCase().replace("-", ""), "returnType") : undefined);
    if (rt) f.returnType = rt;
    if (q.fy) { if (!fyRe.test(q.fy)) throw new AppError("VALIDATION_ERROR", "fy must look like 2026-27.", 400); f.financialYear = q.fy; }
    if (q.period) { if (!periodRe.test(q.period)) throw new AppError("VALIDATION_ERROR", "period must be MMYYYY.", 400); f.period = q.period; }
    if (q.status) f.status = parse(z.enum(["filed", "not_filed", "unknown"]).transform((s) => STATUS_MAP[s]), q.status, "status");
    if (q.state) f.state = parse(z.enum(["FILED_ON_TIME", "FILED_LATE", "NOT_FILED", "PENDING", "UNKNOWN"]), q.state, "state");
    for (const k of ["dueFrom", "dueTo", "filedFrom", "filedTo"] as const) if (q[k]) f[k] = parse(isoDate, q[k], k);
    if ((f.dueFrom || f.dueTo) && (f.filedFrom || f.filedTo)) {
      throw new AppError("VALIDATION_ERROR", "Use either due-date or filed-date range filters, not both.", 400);
    }
    return f;
  }

  private async withClientNames(orgId: string, items: NormalizedReturn[]) {
    const recs = await this.store.getGstinRecords(orgId, [...new Set(items.map((i) => i.gstin))]); // one batched read, no N+1
    const names = new Map(recs.map((r) => [r.gstin, r.clientName]));
    return items.map((i) => ({ ...i, clientName: names.get(i.gstin) }));
  }

  private async run(ctx: Ctx, f: ReturnFilter, q: Q) {
    const dir = parse(z.enum(["asc", "desc"]), q.dir ?? "desc", "dir");
    const page = await this.store.queryReturns(ctx.orgId, f, { limit: clampLimit(q.limit ? Number(q.limit) : undefined), cursor: q.cursor, dir });
    return {
      items: await this.withClientNames(ctx.orgId, page.items), nextCursor: page.nextCursor,
      // Honest freshness note: states are computed when the history was retrieved.
      note: "Filing state is as of each record's retrievedAt; refresh the GSTIN to update.",
    };
  }

  /** GET /api/gstins/:id/returns */
  async forGstin(ctx: Ctx, rawGstin: string, q: Q) {
    assertCan(ctx.role, "clients:read");
    const v = validateGstin(rawGstin);
    if (!v.valid) throw new AppError("INVALID_GSTIN", "Invalid GSTIN.", 400);
    if (!(await this.store.getGstinRecord(ctx.orgId, v.gstin))) throw new AppError("GSTIN_NOT_FOUND", "GSTIN not found.", 404);
    return this.run(ctx, { ...this.filter(q), gstin: v.gstin }, q);
  }

  /** GET /api/returns/gstr1 | gstr3b — across all GSTINs of the organization. */
  async forType(ctx: Ctx, type: "GSTR1" | "GSTR3B", q: Q) {
    assertCan(ctx.role, "clients:read");
    const f = this.filter(q, type);
    if (q.gstin) {
      const v = validateGstin(q.gstin);
      if (!v.valid) throw new AppError("INVALID_GSTIN", "Invalid GSTIN.", 400);
      f.gstin = v.gstin;
    }
    return this.run(ctx, f, q);
  }
}
