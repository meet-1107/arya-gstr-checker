import { clientGstins } from "@/lib/client-gstins";
import { createHash } from "node:crypto";
import { AppError, type Ctx } from "@/lib/errors";
import { assertCan } from "@/lib/permissions";
import { getPlan } from "@/config/plans";
import { isWritable } from "@/lib/subscription";
import {
  buildRow, mergeGstinRows, filterRows, isSchedule, nextRun, sortRows, summarize, SCHEDULE_MS,
  type FreshnessWindows, type PortfolioFilters, type PortfolioRow, type PortfolioSort, type PortfolioSummary, type VerifySchedule,
} from "@/lib/portfolio";
import type { Client, Store, VerificationRecord } from "@/lib/store/types";
import type { BulkService } from "./bulk";

/** Portfolio views load at most this many clients (one pass). Beyond it results are flagged `truncated`; see README for the cost note. */
export const MAX_PORTFOLIO = 5_000;
const MAX_DUE_PER_RUN = 500;
const SORTS: PortfolioSort[] = ["name", "attention", "oldest"];

export type GstinScope = "needs_refresh" | "attention" | "all" | "selected";

export interface RunDueResult { due: number; started: boolean; jobId?: string; gstins?: number; replay?: boolean }
export interface CronOrgResult { orgId: string; due: number; started: boolean; jobId?: string; skipped?: string }

/**
 * The CA's client portfolio: every client with its latest known GST answer, freshness, and detected changes; refresh planning; and scheduled
 * re-verification. It owns no new entity: clients are the portfolio, answers come from the verification engine (and older full GST checks),
 * and running a refresh is the existing bulk-verification job (so cost control, credit protection, quota and idempotency all apply unchanged).
 */
export class PortfolioService {
  constructor(
    private store: Store, private bulk: BulkService, private windows: FreshnessWindows, private now: () => Date = () => new Date(),
  ) {}

  private async clients(orgId: string): Promise<{ list: Client[]; truncated: boolean }> {
    const list: Client[] = []; let cursor: string | undefined;
    do {
      const page = await this.store.listClients(orgId, { limit: 500, cursor, status: "active" });
      list.push(...page.items); cursor = page.nextCursor;
    } while (cursor && list.length < MAX_PORTFOLIO);
    return { list: list.slice(0, MAX_PORTFOLIO), truncated: !!cursor || list.length > MAX_PORTFOLIO };
  }

  /** All rows (unfiltered, name order). Two reads per organization plus one batched read for clients that only have a full GST check. */
  private async rows(orgId: string): Promise<{ rows: PortfolioRow[]; truncated: boolean }> {
    const { list, truncated } = await this.clients(orgId);
    const recs = new Map<string, VerificationRecord>((await this.store.listVerifications(orgId, MAX_PORTFOLIO)).map((r) => [r.gstin, r]));
    const needG = list.flatMap((c) => clientGstins(c)).filter((g) => !recs.has(g));
    const gmap = new Map<string, Awaited<ReturnType<Store["getGstinRecords"]>>[number]>();
    for (let i = 0; i < needG.length; i += 300) for (const g of await this.store.getGstinRecords(orgId, needG.slice(i, i + 300))) gmap.set(g.gstin, g);
    const nowMs = this.now().getTime();
    // One row per client; a multi-GSTIN firm shows its most serious GSTIN (see mergeGstinRows).
    return { rows: list.map((c) => mergeGstinRows(clientGstins(c).map((g) => buildRow({ ...c, gstin: g }, recs.get(g), gmap.get(g), nowMs, this.windows)))), truncated };
  }

  async list(ctx: Ctx, o: PortfolioFilters & { sort?: string; limit?: number; cursor?: string } = {}) {
    assertCan(ctx.role, "clients:read");
    const sort: PortfolioSort = SORTS.includes(o.sort as PortfolioSort) ? (o.sort as PortfolioSort) : "name";
    const limit = Math.min(Math.max(Math.floor(o.limit ?? 25) || 25, 1), 100);
    const offset = o.cursor !== undefined ? Number(o.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new AppError("VALIDATION_ERROR", "Invalid cursor.", 400);
    const { rows, truncated } = await this.rows(ctx.orgId);
    const nowMs = this.now().getTime();
    const filtered = sortRows(filterRows(rows, o), sort);
    const items = filtered.slice(offset, offset + limit);
    return {
      items, total: filtered.length, nextCursor: offset + limit < filtered.length ? String(offset + limit) : undefined,
      summary: summarize(rows, nowMs), truncated,
    };
  }

  async summary(ctx: Ctx): Promise<{ summary: PortfolioSummary; truncated: boolean }> {
    assertCan(ctx.role, "clients:read");
    const { rows, truncated } = await this.rows(ctx.orgId);
    return { summary: summarize(rows, this.now().getTime()), truncated };
  }

  /** Every row matching the filters (no pagination), for reports. Same cap and cost note as the list. */
  async exportRows(ctx: Ctx, o: PortfolioFilters & { sort?: string } = {}): Promise<{ rows: PortfolioRow[]; summary: PortfolioSummary; truncated: boolean }> {
    assertCan(ctx.role, "clients:read");
    const sort: PortfolioSort = SORTS.includes(o.sort as PortfolioSort) ? (o.sort as PortfolioSort) : "name";
    const { rows, truncated } = await this.rows(ctx.orgId);
    return { rows: sortRows(filterRows(rows, o), sort), summary: summarize(rows, this.now().getTime()), truncated };
  }

  /** The GSTINs a refresh would cover, for the confirmation step (which then uses the bulk-verify preview). Consumes nothing. */
  async gstins(ctx: Ctx, o: { scope: unknown; clientIds?: unknown } & PortfolioFilters): Promise<{ gstins: string[]; count: number; truncated: boolean }> {
    assertCan(ctx.role, "checks:run");
    const scope = o.scope as GstinScope;
    if (!["needs_refresh", "attention", "all", "selected"].includes(scope)) throw new AppError("VALIDATION_ERROR", "scope must be needs_refresh, attention, all or selected.", 400);
    const { rows, truncated } = await this.rows(ctx.orgId);
    let pick: PortfolioRow[];
    if (scope === "selected") {
      if (!Array.isArray(o.clientIds) || o.clientIds.some((x) => typeof x !== "string") || o.clientIds.length === 0 || o.clientIds.length > MAX_PORTFOLIO) throw new AppError("VALIDATION_ERROR", "clientIds must be a non-empty list of ids.", 400);
      const want = new Set(o.clientIds as string[]);
      pick = rows.filter((r) => want.has(r.clientId)); // ids from other organizations simply match nothing
    } else pick = filterRows(rows, { ...o, needsRefresh: scope === "needs_refresh" || o.needsRefresh, attention: scope === "attention" || o.attention });
    const gstins = [...new Set(pick.flatMap((r) => r.gstins ?? [r.gstin]))]; // a multi-GSTIN client contributes every GSTIN (fresh ones are served from storage by the job, at no cost)
    return { gstins, count: gstins.length, truncated };
  }

  // ---- scheduled re-verification -------------------------------------------------------------------------------------------------

  private async orgFor(ctx: Ctx) {
    const org = await this.store.getOrg(ctx.orgId);
    if (!org) throw new AppError("ORG_NOT_FOUND", "Organization not found.", 404);
    return org;
  }

  /** Sets (or clears, with `schedule: null`) the schedule of the chosen clients. Plan feature `scheduledChecks` required to turn one on. */
  async setSchedule(ctx: Ctx, raw: { clientIds?: unknown; all?: unknown; schedule?: unknown }): Promise<{ updated: number; schedule: VerifySchedule | null }> {
    assertCan(ctx.role, "clients:write");
    if (raw.schedule !== null && !isSchedule(raw.schedule)) throw new AppError("VALIDATION_ERROR", "schedule must be daily, weekly, monthly or null.", 400);
    const schedule = raw.schedule as VerifySchedule | null;
    const org = await this.orgFor(ctx);
    if (schedule && !getPlan(org.plan).features.scheduledChecks) throw new AppError("FEATURE_NOT_AVAILABLE", `Scheduled verification is not included in the ${getPlan(org.plan).name} plan.`, 403);
    if (!isWritable(org, this.now())) throw new AppError("SUBSCRIPTION_INACTIVE", "Subscription is not active. Account is read-only.", 403);
    const { rows } = await this.rows(ctx.orgId);
    let targets: PortfolioRow[];
    if (raw.all === true) targets = rows;
    else {
      if (!Array.isArray(raw.clientIds) || raw.clientIds.length === 0 || raw.clientIds.length > MAX_PORTFOLIO || raw.clientIds.some((x) => typeof x !== "string")) throw new AppError("VALIDATION_ERROR", "Provide clientIds (a non-empty list) or all: true.", 400);
      const want = new Set(raw.clientIds as string[]);
      targets = rows.filter((r) => want.has(r.clientId));
    }
    const nowMs = this.now().getTime(), ts = this.now().toISOString();
    for (const r of targets) {
      await this.store.updateClient(ctx.orgId, r.clientId, schedule
        ? { verifySchedule: schedule, nextVerifyAt: nextRun(schedule, r.verifiedAt, nowMs), updatedAt: ts }
        : { verifySchedule: undefined, nextVerifyAt: undefined, updatedAt: ts });
    }
    return { updated: targets.length, schedule };
  }

  /**
   * Verifies this organization's due clients as ONE background job (never a burst from the browser). Fresh answers are served from storage by
   * the job (no paid call), so a short schedule on recently verified clients costs nothing. Throws like a manual bulk run (quota, plan, read-only);
   * on a throw nothing is advanced, so the clients stay due for the next attempt.
   */
  async runDue(ctx: Ctx): Promise<RunDueResult> {
    assertCan(ctx.role, "checks:run");
    const org = await this.orgFor(ctx);
    if (!getPlan(org.plan).features.scheduledChecks) throw new AppError("FEATURE_NOT_AVAILABLE", `Scheduled verification is not included in the ${getPlan(org.plan).name} plan.`, 403);
    const nowMs = this.now().getTime();
    const { rows } = await this.rows(ctx.orgId);
    const due = rows.filter((r) => r.schedule && r.nextVerifyAt && new Date(r.nextVerifyAt).getTime() <= nowMs)
      .sort((a, b) => (a.nextVerifyAt ?? "").localeCompare(b.nextVerifyAt ?? "")).slice(0, MAX_DUE_PER_RUN);
    if (due.length === 0) return { due: 0, started: false };
    const gstins = [...new Set(due.flatMap((r) => r.gstins ?? [r.gstin]))]; // a due client is verified on EVERY GSTIN it holds
    const stamp = this.now().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const key = `sched:${stamp}:${createHash("sha256").update([...gstins].sort().join(",")).digest("hex").slice(0, 16)}`;
    const { job, replay } = await this.bulk.createVerify(ctx, { gstins, force: false, allowPartial: true }, key);
    const ts = this.now().toISOString();
    for (const r of due) {
      await this.store.updateClient(ctx.orgId, r.clientId, { nextVerifyAt: new Date(nowMs + SCHEDULE_MS[r.schedule!]).toISOString(), lastScheduledAt: ts });
    }
    return { due: due.length, started: true, jobId: job.id, gstins: gstins.length, replay };
  }

  /** For an external scheduler (Cloud Scheduler / cron): runs every organization that has due clients. Failures are per organization. */
  async runDueAll(): Promise<CronOrgResult[]> {
    const due = await this.store.listDueClients(this.now().toISOString(), 5_000);
    const orgs = [...new Set(due.map((d) => d.orgId))];
    const out: CronOrgResult[] = [];
    for (const orgId of orgs) {
      try {
        const r = await this.runDue({ orgId, userId: "system:scheduler", role: "OWNER" });
        out.push({ orgId, due: r.due, started: r.started, jobId: r.jobId });
      } catch (e) {
        out.push({ orgId, due: due.filter((d) => d.orgId === orgId).length, started: false, skipped: e instanceof AppError ? e.code : (e as { code?: string })?.code ?? "ERROR" });
      }
    }
    return out;
  }
}
