import { randomUUID } from "node:crypto";
import { AppError, type Ctx } from "@/lib/errors";
import { assertCan } from "@/lib/permissions";
import { validateGstin } from "@/lib/gstin";
import { toCsv } from "@/lib/csv";
import { AUDIT_ACTIONS, auditLabel } from "@/lib/audit-labels";
import {
  CONCERN_IDS, CONCERN_STATUSES, MAX_CONCERNS_PER_USER_PER_DAY, MAX_DESCRIPTION, MAX_RESOLUTION, MIN_DESCRIPTION,
} from "@/lib/concerns";
import type { AuditAction, AuditEntry, Concern, ConcernCategory, ConcernStatus, Store } from "@/lib/store/types";

const DAY = 24 * 3600 * 1000;
const plain = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim(); // strip control characters; React escapes the rest on output

/** "Report a concern": an internal, organization-only record. See CONCERN_DISCLAIMER — nothing here contacts anyone outside the organization. */
export class ConcernService {
  constructor(private store: Store, private now: () => Date = () => new Date()) {}

  private audit(ctx: Ctx, action: AuditAction, target: string, metadata: Record<string, string | number | boolean>) {
    return this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action, target, at: this.now().toISOString(), metadata });
  }

  async create(ctx: Ctx, raw: { gstin?: unknown; category?: unknown; description?: unknown }): Promise<{ concern: Concern; duplicate: boolean }> {
    assertCan(ctx.role, "checks:run");
    if (typeof raw.gstin !== "string" || typeof raw.category !== "string" || typeof raw.description !== "string") throw new AppError("VALIDATION_ERROR", "gstin, category and description are required.");
    const v = validateGstin(raw.gstin);
    if (!v.valid) throw new AppError("INVALID_GSTIN", "That is not a valid GSTIN.");
    if (!CONCERN_IDS.includes(raw.category as ConcernCategory)) throw new AppError("VALIDATION_ERROR", "Choose what looks wrong.");
    const description = plain(raw.description);
    if (description.length < MIN_DESCRIPTION) throw new AppError("VALIDATION_ERROR", `Describe the concern in at least ${MIN_DESCRIPTION} characters so a colleague can act on it.`);
    if (description.length > MAX_DESCRIPTION) throw new AppError("VALIDATION_ERROR", `The description can be at most ${MAX_DESCRIPTION} characters.`);

    const since = this.now().getTime() - DAY;
    const recent = (await this.store.listConcerns(ctx.orgId, { limit: 200 })).filter((c) => c.reportedBy === ctx.userId && new Date(c.createdAt).getTime() > since);
    const dup = recent.find((c) => c.gstin === v.gstin && c.category === raw.category && c.status === "open");
    if (dup) return { concern: dup, duplicate: true }; // a double-click or retry never creates two records
    if (recent.length >= MAX_CONCERNS_PER_USER_PER_DAY) throw new AppError("CONCERN_LIMIT", `You can report at most ${MAX_CONCERNS_PER_USER_PER_DAY} concerns per day.`, 429);

    const rec = await this.store.getVerification(ctx.orgId, v.gstin);
    const concern: Concern = {
      id: randomUUID(), organizationId: ctx.orgId, gstin: v.gstin, category: raw.category as ConcernCategory, description,
      reportedBy: ctx.userId, createdAt: this.now().toISOString(), status: "open",
      ...(rec ? { snapshot: { outcome: rec.outcome, verifiedAt: rec.verifiedAt, source: rec.source, legalName: rec.details?.legalName } } : {}),
    };
    await this.store.createConcern(ctx.orgId, concern);
    await this.audit(ctx, "CONCERN_REPORTED", concern.id, { gstin: v.gstin, category: concern.category });
    return { concern, duplicate: false };
  }

  async list(ctx: Ctx, q: { status?: unknown; gstin?: unknown; limit?: unknown } = {}): Promise<Concern[]> {
    assertCan(ctx.role, "checks:run");
    if (q.status !== undefined && q.status !== "" && !CONCERN_STATUSES.includes(q.status as ConcernStatus)) throw new AppError("VALIDATION_ERROR", "Invalid status filter.");
    const gstin = typeof q.gstin === "string" && q.gstin ? validateGstin(q.gstin) : null;
    if (gstin && !gstin.valid) throw new AppError("INVALID_GSTIN", "That is not a valid GSTIN.");
    const limit = Math.min(Math.max(Math.floor(Number(q.limit)) || 50, 1), 200);
    return this.store.listConcerns(ctx.orgId, { limit, status: (q.status || undefined) as ConcernStatus | undefined, gstin: gstin && gstin.valid ? gstin.gstin : undefined });
  }

  /** Review workflow (admins/owners): open ⇄ reviewed → closed, with an optional resolution note. */
  async update(ctx: Ctx, id: string, patch: { status?: unknown; resolution?: unknown }): Promise<Concern> {
    assertCan(ctx.role, "auditlog:read");
    const c = await this.store.getConcern(ctx.orgId, id);
    if (!c) throw new AppError("CONCERN_NOT_FOUND", "Concern not found.", 404);
    if (!CONCERN_STATUSES.includes(patch.status as ConcernStatus)) throw new AppError("VALIDATION_ERROR", "status must be open, reviewed or closed.");
    let resolution = c.resolution;
    if (patch.resolution !== undefined) {
      if (typeof patch.resolution !== "string") throw new AppError("VALIDATION_ERROR", "resolution must be text.");
      resolution = plain(patch.resolution).slice(0, MAX_RESOLUTION + 1);
      if (resolution.length > MAX_RESOLUTION) throw new AppError("VALIDATION_ERROR", `The resolution can be at most ${MAX_RESOLUTION} characters.`);
      resolution = resolution || undefined;
    }
    const updated = await this.store.updateConcern(ctx.orgId, id, { status: patch.status as ConcernStatus, resolution, reviewedBy: ctx.userId, updatedAt: this.now().toISOString() });
    if (!updated) throw new AppError("CONCERN_NOT_FOUND", "Concern not found.", 404);
    await this.audit(ctx, "CONCERN_UPDATED", id, { status: updated.status });
    return updated;
  }
}

export interface AuditRow { id: string; at: string; action: AuditAction; label: string; who: string; whoUid: string; target?: string; metadata?: AuditEntry["metadata"] }

/** Read-only view of the organization's audit trail for owners/admins. */
export class AuditService {
  constructor(private store: Store) {}

  async list(ctx: Ctx, q: { action?: unknown; limit?: unknown } = {}): Promise<AuditRow[]> {
    assertCan(ctx.role, "auditlog:read");
    if (q.action !== undefined && q.action !== "" && !AUDIT_ACTIONS.includes(q.action as AuditAction)) throw new AppError("VALIDATION_ERROR", "Unknown action filter.");
    const limit = Math.min(Math.max(Math.floor(Number(q.limit)) || 100, 1), 500);
    const members = new Map((await this.store.listMembers(ctx.orgId)).map((m) => [m.uid, m.name ? `${m.name} (${m.email})` : m.email]));
    // Fetch more than asked when filtering, because the store returns the newest entries unfiltered.
    const raw = await this.store.listAudit(ctx.orgId, q.action ? 2000 : limit);
    return raw.filter((e) => !q.action || e.action === q.action).slice(0, limit).map((e) => ({
      id: e.id, at: e.at, action: e.action, label: auditLabel(e.action), who: members.get(e.userId) ?? "Former member or system", whoUid: e.userId, target: e.target, metadata: e.metadata,
    }));
  }

  async exportCsv(ctx: Ctx): Promise<{ csv: string; rows: number }> {
    const rows = await this.list(ctx, { limit: 500 });
    const lines: unknown[][] = [["When (UTC)", "Who", "What", "Target", "Details"]];
    for (const r of rows) lines.push([r.at, r.who, r.label, r.target ?? "", r.metadata ? Object.entries(r.metadata).map(([k, v]) => `${k}=${v}`).join("; ") : ""]);
    return { csv: toCsv(lines), rows: rows.length };
  }
}

/** Privacy controls for verification history: remove one stored lookup, or clear all of the organization's. */
export class VerificationPrivacyService {
  constructor(private store: Store, private now: () => Date = () => new Date()) {}

  private audit(ctx: Ctx, action: AuditAction, target: string | undefined, metadata: Record<string, string | number | boolean>) {
    return this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action, target, at: this.now().toISOString(), metadata });
  }

  async forget(ctx: Ctx, input: unknown): Promise<{ gstin: string; removed: boolean }> {
    assertCan(ctx.role, "checks:run");
    if (typeof input !== "string") throw new AppError("VALIDATION_ERROR", "gstin must be a string.");
    const v = validateGstin(input);
    if (!v.valid) throw new AppError("INVALID_GSTIN", "That is not a valid GSTIN.");
    const had = !!(await this.store.getVerification(ctx.orgId, v.gstin));
    if (had) { await this.store.deleteVerification(ctx.orgId, v.gstin); await this.audit(ctx, "VERIFICATION_DELETED", v.gstin, {}); }
    return { gstin: v.gstin, removed: had };
  }

  /** Owners and admins only (it removes everyone's saved notes, tags and pins too). Returns how many records were removed. */
  async forgetAll(ctx: Ctx): Promise<{ removed: number }> {
    assertCan(ctx.role, "auditlog:read");
    let removed = 0;
    for (let round = 0; round < 200; round++) {
      const batch = await this.store.listVerifications(ctx.orgId, 500);
      if (!batch.length) break;
      for (const r of batch) { await this.store.deleteVerification(ctx.orgId, r.gstin); removed++; }
    }
    await this.audit(ctx, "VERIFICATION_HISTORY_CLEARED", undefined, { removed });
    return { removed };
  }
}
