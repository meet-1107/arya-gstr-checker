import { randomUUID } from "node:crypto";
import { AppError, type Ctx } from "@/lib/errors";
import { clientHasGstin } from "@/lib/client-gstins";
import { assertCan } from "@/lib/permissions";
import { currentMonthKey } from "@/lib/dates";
import { complianceIndicator } from "@/lib/compliance";
import { normalizeReturns, summarizeReturns } from "@/lib/returns";
import type { AlertType, Client, GstinRecord, Store } from "@/lib/store/types";
import { UsageError, UsageService, type OrgBilling } from "@/lib/usage";
import { ProviderError, type GstProvider, type ReturnHistory } from "@/providers/types";
import { getPlan } from "@/config/plans";
import { effectiveStatus, isWritable } from "@/lib/subscription";

export interface CheckOptions { cacheTtlMs: number }
export const DEFAULT_CHECK_OPTIONS: CheckOptions = { cacheTtlMs: 24 * 3600 * 1000 };

export interface CheckResult { record: GstinRecord; cached: boolean; returnsAvailable: boolean }

export interface CheckRunOptions {
  force?: boolean;
  /** Fetch return history too (2 provider requests instead of 1). Default true. */
  includeReturns?: boolean;
  /**
   * Bulk mode: the caller already holds one quota unit for this check and settles it itself from the
   * outcome (success → consume, cached/non-billable failure → release). In this mode this service does
   * NOT reserve, refund, or raise per-item API_FAILURE alerts.
   */
  held?: boolean;
  jobId?: string;
  /** Check this specific GSTIN of the client (must belong to it). Defaults to the primary GSTIN. */
  gstin?: string;
}

/**
 * One "GST check" = GSTIN verification (+ optional return history) = ONE usage unit.
 * (Assumption to re-verify against the chosen provider's billing rules.)
 * Pipeline: permission → cache → quota → provider → store. Provider throughput control (concurrency,
 * rate limit, timeout, retry, circuit breaker) lives ONLY in ResilientProvider (src/providers/gate.ts).
 */
export class CheckService {
  private usage: UsageService;
  constructor(
    private store: Store,
    private provider: GstProvider,
    private opts: CheckOptions = DEFAULT_CHECK_OPTIONS,
    private now: () => Date = () => new Date(),
  ) { this.usage = new UsageService(store.usage); }

  private async alert(ctx: Ctx, type: AlertType, message: string, gstin?: string) {
    await this.store.addAlert(ctx.orgId, { id: randomUUID(), type, message, gstin, at: this.now().toISOString(), read: false });
  }

  async checkClient(ctx: Ctx, clientId: string, o: CheckRunOptions = {}): Promise<CheckResult> {
    assertCan(ctx.role, "checks:run");
    const stored = await this.store.getClient(ctx.orgId, clientId); // org-scoped lookup
    if (!stored) throw new AppError("CLIENT_NOT_FOUND", "Client not found.", 404);
    // Archived clients are not billed, so they are not checked either (otherwise archiving would be a free way to keep using the service).
    if (stored.status === "archived") throw new AppError("CLIENT_ARCHIVED", "This client is archived. Restore it to run GST checks.", 409);
    // A client firm may hold several GSTINs: check the requested one (default: the primary). Below, `client.gstin` is the GSTIN being checked.
    if (o.gstin !== undefined && !clientHasGstin(stored, o.gstin)) throw new AppError("GSTIN_NOT_ON_CLIENT", "This GSTIN is not on this client.", 404);
    const client = { ...stored, gstin: o.gstin ?? stored.gstin };
    const org = await this.store.getOrg(ctx.orgId);
    if (!org) throw new AppError("ORG_NOT_FOUND", "Organization not found.", 404);
    const billing: OrgBilling = { organizationId: org.id, plan: org.plan, status: effectiveStatus(org, this.now()) };
    const month = currentMonthKey(this.now());
    const nowIso = this.now().toISOString();
    const includeReturns = o.includeReturns !== false;

    const prev: GstinRecord = (await this.store.getGstinRecord(ctx.orgId, client.gstin))
      ?? { gstin: client.gstin, clientId, status: "Unknown" };

    // 1. Cache
    if (!o.force && prev.cacheExpiresAt && prev.lastCheckedAt && new Date(prev.cacheExpiresAt) > this.now()) {
      await this.usage.recordCached(billing, month);
      await this.store.addCheck(ctx.orgId, { id: randomUUID(), gstin: client.gstin, at: nowIso, by: ctx.userId, outcome: "CACHED", source: prev.source, status: prev.status, jobId: o.jobId });
      return { record: prev, cached: true, returnsAvailable: prev.lastReturnsAt !== undefined };
    }

    // 2. Quota (atomic; also enforces subscription status). Bulk mode already holds the unit.
    if (o.held) {
      if (!isWritable(org, this.now())) throw new UsageError("SUBSCRIPTION_INACTIVE", "Subscription is not active. Account is read-only.");
    } else {
      try {
        await this.usage.reserveCheck(billing, month);
      } catch (e) {
        if (e instanceof UsageError && e.code === "QUOTA_EXHAUSTED") await this.alert(ctx, "QUOTA_EXHAUSTED", "Monthly GST check quota exhausted.");
        throw e;
      }
    }

    // 3. Provider (already wrapped by ResilientProvider: limiter, concurrency, timeout, retry, breaker)
    try {
      const verified = await this.provider.verifyGstin(client.gstin);
      let history: ReturnHistory | null = null;
      if (includeReturns) {
        try { history = await this.provider.getReturnHistory(client.gstin); } catch { history = null; }
      }
      const checkedAt = verified.checkedAt;
      const base: GstinRecord = {
        ...prev, // keeps previous compliance summary when history is not (re)fetched
        gstin: client.gstin, clientId, status: verified.status, clientName: client.name, assignedTo: client.assignedTo, checked: true,
        legalName: verified.legalName, tradeName: verified.tradeName, taxpayerType: verified.taxpayerType, state: verified.state,
        source: verified.source, providerRequestId: verified.providerRequestId, lastError: undefined,
        lastCheckedAt: checkedAt, cacheExpiresAt: new Date(new Date(checkedAt).getTime() + this.opts.cacheTtlMs).toISOString(),
      };
      const record = history ? await this.applyReturns(ctx, client, base, history, prev) : base;
      if (!history) record.indicator = record.lastReturnsAt ? complianceIndicator({ gstinStatus: record.status, states: await this.storedStates(ctx, client.gstin) }) : complianceIndicator({ gstinStatus: record.status, states: [] });
      await this.store.putGstinRecord(ctx.orgId, record);
      await this.store.updateClient(ctx.orgId, clientId, { lastCheckedAt: checkedAt });

      if (prev.status !== "Unknown" && prev.status !== record.status) {
        await this.alert(ctx, "GSTIN_STATUS_CHANGED", `GSTIN ${client.gstin} changed from ${prev.status} to ${record.status}.`, client.gstin);
      }
      if (record.status === "Suspended" && prev.status !== "Suspended") await this.alert(ctx, "GSTIN_SUSPENDED", `GSTIN ${client.gstin} is suspended.`, client.gstin);
      if (record.status === "Cancelled" && prev.status !== "Cancelled") await this.alert(ctx, "GSTIN_CANCELLED", `GSTIN ${client.gstin} is cancelled.`, client.gstin);

      if (!o.held) {
        const s = await this.usage.summary(billing, month);
        const limit = getPlan(org.plan).monthlyChecks;
        if (limit && s.used >= Math.ceil(limit * 0.8) && s.used - 1 < Math.ceil(limit * 0.8)) {
          await this.alert(ctx, "QUOTA_NEAR_LIMIT", `You have used 80% of this month's GST checks.`);
        }
      }
      await this.store.addCheck(ctx.orgId, { id: randomUUID(), gstin: client.gstin, at: nowIso, by: ctx.userId, outcome: "SUCCESS", source: record.source, status: record.status, jobId: o.jobId });
      await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: "GST_CHECK", target: clientId, at: nowIso, metadata: o.jobId ? { jobId: o.jobId } : undefined });
      return { record, cached: false, returnsAvailable: !!history || record.lastReturnsAt !== undefined };
    } catch (e) {
      // Keep the previous known status (never overwrite it with a guess). Refund unless the provider bills errors.
      const billable = e instanceof ProviderError && e.billable;
      if (!o.held && !billable) await this.usage.refund(billing, month);
      await this.usage.recordFailure(billing, month);
      const code = e instanceof ProviderError ? e.code : "INTERNAL_ERROR";
      await this.store.putGstinRecord(ctx.orgId, { ...prev, clientName: client.name, assignedTo: client.assignedTo, lastError: { code, at: nowIso } });
      await this.store.addCheck(ctx.orgId, { id: randomUUID(), gstin: client.gstin, at: nowIso, by: ctx.userId, outcome: "FAILED", errorCode: code, jobId: o.jobId });
      if (!o.held) await this.alert(ctx, "API_FAILURE", `GST check failed for ${client.gstin} (${code}).`, client.gstin);
      if (e instanceof ProviderError) throw e;
      throw new AppError("INTERNAL_ERROR", "Something went wrong. Please try again.", 500);
    }
  }

  private async storedStates(ctx: Ctx, gstin: string) {
    return (await this.store.listReturns(ctx.orgId, gstin)).map((r) => r.state);
  }

  /** Normalizes + stores returns and fills the denormalized dashboard fields; raises return alerts on increases. */
  private async applyReturns(ctx: Ctx, client: Client, base: GstinRecord, history: ReturnHistory, prev: GstinRecord): Promise<GstinRecord> {
    const now = this.now();
    const normalized = normalizeReturns(history, { clientId: client.id, freq: client.filingFrequency, now });
    await this.store.putReturns(ctx.orgId, client.gstin, normalized);
    const all = await this.store.listReturns(ctx.orgId, client.gstin); // indicator considers every stored period
    const s = summarizeReturns(all);
    const record: GstinRecord = {
      ...base, gstr1Missing: s.gstr1Missing, gstr1Late: s.gstr1Late, gstr3bMissing: s.gstr3bMissing, gstr3bLate: s.gstr3bLate,
      indicator: complianceIndicator({ gstinStatus: base.status, states: s.states }), lastReturnsAt: now.toISOString(),
    };
    const inc = (a: number, b: number | undefined) => a > (b ?? 0);
    if (inc(s.gstr1Missing, prev.gstr1Missing)) await this.alert(ctx, "GSTR1_MISSING", `${client.name} has ${s.gstr1Missing} missing GSTR-1 return(s).`, client.gstin);
    if (inc(s.gstr3bMissing, prev.gstr3bMissing)) await this.alert(ctx, "GSTR3B_MISSING", `${client.name} has ${s.gstr3bMissing} missing GSTR-3B return(s).`, client.gstin);
    if (inc(s.gstr1Late + s.gstr3bLate, (prev.gstr1Late ?? 0) + (prev.gstr3bLate ?? 0))) {
      await this.alert(ctx, "LATE_RETURN", `${client.name} has late-filed returns.`, client.gstin);
    }
    return record;
  }
}
