import { randomUUID } from "node:crypto";
import { type Ctx, AppError } from "@/lib/errors";
import { assertCan } from "@/lib/permissions";
import { currentMonthKey } from "@/lib/dates";
import { validateGstin } from "@/lib/gstin";
import { withTimeout } from "@/lib/resilience";
import { UsageError, UsageService, type OrgBilling } from "@/lib/usage";
import { effectiveStatus, isWritable } from "@/lib/subscription";
import { DEFAULT_VERIFICATION_POLICY, type VerificationPolicy } from "@/config/verification-policy";
import type { MetricsSnapshot, VerificationMetrics } from "@/lib/metrics";
import { ProviderHealth, type HealthSnapshot } from "@/lib/provider-health";
import type { SharedResult, Store, VerificationRecord } from "@/lib/store/types";
import { DEFAULT_COST_POLICY } from "@/config/cost-policy";
import { detectChange, type ChangeInfo } from "@/lib/change-detection";
import { CostGuard } from "./cost-guard";
import type { GstProvider } from "@/providers/types";
import {
  classifyProviderError, detailsFrom, isStatus, outcomeFromStatus, type FailureClass, type LastKnown, type Provenance, type VerificationOutcome, type VerificationView, type VerifyMode,
} from "@/lib/verification";

export interface VerifyOptions {
  /** Hard ceiling on one live verification (all provider attempts included). The user never waits longer than this. */
  deadlineMs: number;
  /** Freshness + provider-health policy (configuration; see src/config/verification-policy.ts). */
  policy: VerificationPolicy;
}
export const DEFAULT_VERIFY_OPTIONS: VerifyOptions = { deadlineMs: 20_000, policy: DEFAULT_VERIFICATION_POLICY };

export const MAX_NOTE = 500, MAX_TAGS = 5, MAX_TAG_LEN = 24;

export interface RecentVerification { note?: string; tags?: string[]; saved: boolean; gstin: string; outcome: VerificationOutcome; details?: VerificationRecord["details"]; verifiedAt: string; ageSeconds: number; source: string }

type Draft = Omit<VerificationView, "requestId" | "durationMs" | "formatValid"> & { formatValid?: boolean };
interface Flags { staleServed?: boolean; joined?: boolean; providerCalled?: boolean }

/** What one live provider attempt came to. Shared by every caller that joined it. */
type Live =
  | { kind: "ok"; rec: VerificationRecord; org: string; change?: ChangeInfo }
  | { kind: "not_found"; rec: VerificationRecord; org: string }
  | { kind: "fail"; f: FailureClass }
  | { kind: "limited"; reason: "ORG_PER_MINUTE" | "ORG_PER_DAY" | "GLOBAL_PER_DAY"; retryAfterMs: number };

/**
 * Smart verification of ANY GSTIN (no client record required).
 *   permission → local validation (free) → stored answer by freshness policy → provider health → in-flight de-duplication →
 *   quota → provider (via ResilientProvider) under a hard deadline → classify → store → view.
 * Modes: `auto` (default for the UI) follows the policy: fresh → instant; stale → instant + "refresh recommended" (stale-while-refresh);
 * expired/none → live. `refresh` is the silent follow-up that revalidates a stale answer and is SKIPPED (not failed) when the provider is
 * unwell or quota is short. `live` is an explicit user request. No mode = legacy strict (bulk): fresh → stored, otherwise live.
 * Every outcome is a deliberate, typed result; only auth/quota/permission problems are thrown (and never from a `refresh`).
 * One live verification = one usage unit; stored answers, joined requests, NOT_FOUND and non-billable failures consume none.
 */
export class VerificationService {
  private usage: UsageService;
  /** Live checks in progress, per organization + GSTIN. In-process only: another server instance would not see these. */
  private flights = new Map<string, Promise<Live>>();
  constructor(
    private store: Store,
    private provider: GstProvider,
    private metrics: VerificationMetrics,
    private opts: VerifyOptions = DEFAULT_VERIFY_OPTIONS,
    private now: () => Date = () => new Date(),
    private mono: () => number = Date.now,
    private provHealth: ProviderHealth = new ProviderHealth(opts.policy, mono),
    /** Paid-call cost control: credit budget, call limits, counters, optional cross-organization sharing. Defaults are permissive and share nothing. */
    readonly guard: CostGuard = new CostGuard(store, DEFAULT_COST_POLICY, now),
  ) { this.usage = new UsageService(store.usage); }

  /**
   * `held` (bulk mode): the caller already holds one quota unit for this call and settles it from the outcome
   * (live registry status → consume; cached / NOT_FOUND / failure → release). This service then neither reserves nor refunds.
   */
  async verify(ctx: Ctx, input: unknown, o: { force?: boolean; held?: boolean; mode?: VerifyMode } = {}): Promise<VerificationView> {
    assertCan(ctx.role, "checks:run");
    const requestId = randomUUID();
    const t0 = this.mono();
    const hs0 = this.provHealth.snapshot();
    const finish = (v: Draft, flags: Flags = {}): VerificationView => {
      const view: VerificationView = { formatValid: true, saved: false, ...(hs0.state !== "healthy" ? { providerHealth: hs0.state } : {}), ...v, requestId, durationMs: Math.max(0, this.mono() - t0) };
      this.metrics.record(ctx.orgId, { outcome: view.outcome, durationMs: view.durationMs, cached: view.freshness === "cached", at: this.now().getTime(), ...flags });
      return view;
    };

    if (typeof input !== "string") throw new AppError("VALIDATION_ERROR", "gstin must be a string.");
    const v = validateGstin(input);
    if (!v.valid) return finish({ gstin: v.gstin.slice(0, 20), outcome: "INVALID_GSTIN", invalidReason: v.reason, formatValid: false, freshness: "none", retryable: false });
    const gstin = v.gstin;

    // Independent reads go out together (latency: one round trip, not two).
    const [org, prev] = await Promise.all([this.store.getOrg(ctx.orgId), this.store.getVerification(ctx.orgId, gstin)]);
    if (!org) throw new AppError("ORG_NOT_FOUND", "Organization not found.", 404);
    const billing: OrgBilling = { organizationId: org.id, plan: org.plan, status: effectiveStatus(org, this.now()) };
    const month = currentMonthKey(this.now());
    const ann = { saved: prev?.saved === true, note: prev?.note, tags: prev?.tags };
    const keep = { saved: prev?.saved, note: prev?.note, tags: prev?.tags };
    const mode: VerifyMode | undefined = o.mode ?? (o.force ? "live" : undefined);
    const p = this.opts.policy;
    const cp = this.guard.policy;

    // Stored answer: this organization's own, or (only when cross-organization sharing is enabled) the newer shared one.
    type Src = { outcome: VerificationOutcome; details?: VerificationRecord["details"]; source: string; verifiedAt: string };
    const [, sharedRec, credit]: [void, SharedResult | null, Awaited<ReturnType<CostGuard["creditStatus"]>>] = await Promise.all([
      this.guard.record(ctx.orgId, { searches: 1 }), cp.sharedCache ? this.store.getSharedResult(gstin) : Promise.resolve(null), this.guard.creditStatus(),
    ]);
    const useShared = !!sharedRec && isStatus(sharedRec.outcome) && (!prev || !isStatus(prev.outcome) || sharedRec.verifiedAt > prev.verifiedAt);
    const src: Src | null = useShared ? sharedRec : prev;
    const provenance: Provenance = useShared ? "SHARED_CACHE" : "CACHE";

    // Stored answer vs the freshness policy. Only registry STATUS answers are ever served from storage; NOT_FOUND is always re-asked.
    const usable = !!src && isStatus(src.outcome);
    const ageMs = usable ? this.now().getTime() - new Date(src.verifiedAt).getTime() : -1;
    const staleness: VerificationView["staleness"] = usable && ageMs >= 0 ? (ageMs < p.freshMs ? "fresh" : ageMs < p.staleUsableMs ? "stale" : "expired") : undefined;

    const serveStored = async (extra: Partial<Draft>, flags: Flags = {}) => {
      await Promise.all([this.usage.recordCached(billing, month), this.guard.record(ctx.orgId, useShared ? { sharedHits: 1 } : { cacheHits: 1 })]);
      if (useShared) await this.adopt(ctx, gstin, src!, prev, requestId, keep); // copy into this organization's own store: the next lookup is a plain own-store hit
      return finish({
        gstin, outcome: src!.outcome, details: src!.details, source: src!.source, verifiedAt: src!.verifiedAt, freshness: "cached",
        ageSeconds: Math.round(ageMs / 1000), retryable: false, staleness, provenance, ...ann, ...extra,
      }, flags);
    };
    const providerSkip = (): "provider_down" | "provider_degraded" | undefined => (hs0.state === "down" ? "provider_down" : hs0.state === "degraded" ? "provider_degraded" : undefined);

    // 1. Fresh: instant, no refresh needed. (Explicit live and silent refresh never take this path.)
    if (staleness === "fresh" && mode !== "live" && mode !== "refresh") return serveStored({});

    // 2. Stale (auto only): instant, and recommend a silent refresh unless it would be pointless right now.
    if (staleness === "stale" && mode === "auto") {
      let skip: "provider_down" | "provider_degraded" | "quota" | "capacity" | undefined = providerSkip();
      if (!skip && credit.state !== "ok") skip = "capacity";
      if (!skip && !isWritable(org, this.now())) skip = "quota";
      if (!skip && !o.held && (await this.usage.summary(billing, month)).remaining === 0) skip = "quota";
      return serveStored(skip ? { refreshSkipped: skip } : { refreshRecommended: true }, { staleServed: true });
    }

    // 2b. An explicit live refresh of an answer that is only moments old is pointless: say so and serve it. (Stops refresh-button hammering.)
    if (mode === "live" && usable && staleness === "fresh" && ageMs < cp.minRefreshMs) return serveStored({ notice: "REFRESH_TOO_SOON" });

    // 2c. Credit protection: when the provider budget runs low, stop spending it on anything but first-time lookups.
    //     low → serve a usable stored answer instead of refreshing; critical → serve any stored answer; exhausted → no live calls at all.
    if (credit.state !== "ok") {
      if (usable && (credit.state !== "low" || ageMs < p.staleUsableMs)) {
        return serveStored(mode === "refresh" ? { refreshSkipped: "capacity" } : { notice: "CREDIT_PROTECTION", refreshSkipped: "capacity" }, { staleServed: staleness !== "fresh" });
      }
      if (credit.state === "exhausted" || (credit.state === "critical" && usable)) {
        return finish({ gstin, outcome: "CAPACITY_LIMITED", freshness: "none", retryable: true, ...ann, lastKnown: this.lastKnown(prev) });
      }
    }

    // 3. A live check is needed. Do not spend it on work nobody is waiting for while the provider is unwell.
    if (mode === "refresh" && usable && hs0.state !== "healthy") return serveStored({ refreshSkipped: providerSkip() }, { staleServed: staleness === "stale" });
    const failFast = mode === "live" ? hs0.state === "down" && !this.provHealth.tryProbe() : hs0.state === "down";
    if (failFast) {
      return finish({ gstin, outcome: "MAINTENANCE", freshness: "none", retryable: true, ...ann, lastKnown: this.lastKnown(prev) });
    }

    // 4. De-duplicate: if this organization is already verifying this GSTIN, wait for THAT attempt instead of making another.
    const key = cp.sharedCache ? gstin : `${ctx.orgId}|${gstin}`;
    const running = this.flights.get(key);
    let live: Live;
    let joined = false;
    if (running) {
      joined = true;
      live = await running;
    } else {
      // The flight is registered synchronously (below), BEFORE any await, so concurrent callers always find it. Admission runs inside the attempt.
      const attempt: Promise<Live> = (async () => {
        // Per-organization and global paid-call limits (separate from the customer's billing quota). Bulk jobs skip the per-minute cap: the provider gate paces them.
        const adm = await this.guard.admit(ctx.orgId, { skipMinute: !!o.held });
        if (!adm.ok) return { kind: "limited", reason: adm.reason, retryAfterMs: adm.retryAfterMs } as const;
        return this.runLive(ctx, gstin, { org, billing, month, held: !!o.held, requestId, keep, prev });
      })();
      this.flights.set(key, attempt);
      const clear = () => { if (this.flights.get(key) === attempt) this.flights.delete(key); };
      attempt.then(clear, clear);
      try { live = await attempt; }
      catch (e) {
        // A silent refresh must never turn a good stored answer into an error.
        if (mode === "refresh" && usable && e instanceof UsageError) return serveStored({ refreshSkipped: "quota" });
        throw e;
      }
    }
    if (live.kind === "limited") {
      if (mode === "refresh" && usable) return serveStored({ refreshSkipped: "capacity" });
      return finish({ gstin, outcome: live.reason === "GLOBAL_PER_DAY" ? "CAPACITY_LIMITED" : "RATE_LIMITED", freshness: "none", retryable: true, retryAfterMs: live.retryAfterMs, ...ann, lastKnown: this.lastKnown(prev) });
    }
    if (joined) await this.guard.record(ctx.orgId, { deduped: 1, cacheMisses: 1 });
    // A joiner from ANOTHER organization (only possible with sharing on) gets the answer copied into its own store.
    if (joined && live.kind === "ok" && live.org !== ctx.orgId) await this.adopt(ctx, gstin, live.rec, prev, requestId, keep, "LIVE_PROVIDER");
    const flags: Flags = joined ? { joined: true } : { providerCalled: true };
    const hsNow = this.provHealth.snapshot();
    const tag = hsNow.state !== "healthy" ? { providerHealth: hsNow.state } : {};

    if (live.kind === "fail") {
      return finish({ gstin, outcome: live.f.outcome, freshness: "none", retryable: live.f.retryable, retryAfterMs: live.f.retryAfterMs, ...ann, ...tag, lastKnown: this.lastKnown(prev), ...(joined ? { joined: true } : {}) }, flags);
    }
    const r = live.rec;
    // A joiner that holds its own quota unit (bulk) must not be billed for a call it did not make: report it as stored so the caller releases the unit.
    const freshness = joined && o.held ? "cached" : "live";
    return finish({
      gstin, outcome: r.outcome, ...(live.kind === "ok" ? { details: r.details } : {}), source: r.source, verifiedAt: r.verifiedAt, freshness, ageSeconds: 0, retryable: false,
      provenance: joined ? "DEDUPED" : "LIVE_PROVIDER", ...(live.kind === "ok" && live.change ? { change: live.change } : {}),
      ...ann, ...tag, ...(live.kind === "not_found" ? { lastKnown: this.lastKnown(prev) } : {}), ...(joined ? { joined: true } : {}),
    }, flags);
  }

  /** One real attempt: quota, provider (deadline), store. Throws UsageError for quota/subscription problems; everything else is a Live. */
  private async runLive(
    ctx: Ctx, gstin: string, c: { org: NonNullable<Awaited<ReturnType<Store["getOrg"]>>>; billing: OrgBilling; month: string; held: boolean; requestId: string; keep: Pick<VerificationRecord, "saved" | "note" | "tags">; prev: VerificationRecord | null },
  ): Promise<Live> {
    if (c.held) {
      if (!isWritable(c.org, this.now())) throw new UsageError("SUBSCRIPTION_INACTIVE", "Subscription is not active. Account is read-only.");
    } else try { await this.usage.reserveCheck(c.billing, c.month); }
    catch (e) {
      if (e instanceof UsageError && e.code === "QUOTA_EXHAUSTED") {
        await this.store.addAlert(ctx.orgId, { id: randomUUID(), type: "QUOTA_EXHAUSTED", message: "Monthly GST check quota exhausted.", at: this.now().toISOString(), read: false });
      }
      throw e;
    }

    const t = this.mono();
    const cp = this.guard.policy;
    try {
      const r = await withTimeout(this.provider.verifyGstin(gstin), this.opts.deadlineMs);
      this.provHealth.record(true, this.mono() - t);
      const counted = this.guard.record(ctx.orgId, { cacheMisses: 1, paidCalls: 1, credits: cp.creditsPerCall }); // independent of the writes below
      const outcome = outcomeFromStatus(r.status);
      const rec: VerificationRecord = { gstin, outcome, details: detailsFrom(r), source: r.source, providerRequestId: r.providerRequestId, verifiedAt: r.checkedAt, by: ctx.userId, requestId: c.requestId, provenance: "LIVE_PROVIDER", ...c.keep };
      // Change detection against the previous stored answer (ACTIVE → CANCELLED, changed legal name...). The previous snapshot is kept on the record.
      const change = detectChange(c.prev && isStatus(c.prev.outcome) ? c.prev : null, { outcome, details: rec.details, verifiedAt: rec.verifiedAt }) ?? undefined;
      if (change && c.prev) { rec.previous = { outcome: c.prev.outcome, details: c.prev.details, verifiedAt: c.prev.verifiedAt }; rec.change = change; }
      await Promise.all([
        counted,
        this.store.putVerification(ctx.orgId, rec),
        cp.sharedCache && isStatus(outcome) ? this.store.putSharedResult({ gstin, outcome, details: rec.details, source: rec.source, verifiedAt: rec.verifiedAt, provenance: "LIVE_PROVIDER" }) : undefined,
        this.audit(ctx, gstin, outcome, c.requestId),
      ]);
      if (change?.deteriorated) {
        // Alert for a saved GSTIN or any client's GSTIN. A deterministic id makes it idempotent: the same change is never listed twice.
        const client = await this.store.findClientByGstin(ctx.orgId, gstin);
        if (c.keep.saved || client) {
          const word = (o: string) => o.charAt(0) + o.slice(1).toLowerCase();
          const who = client ? `${client.name} (${gstin})` : `Saved GSTIN ${gstin}`;
          await this.store.addAlert(ctx.orgId, { id: `chg:${gstin}:${change.from}:${change.to}:${rec.verifiedAt}`, type: change.to === "CANCELLED" ? "GSTIN_CANCELLED" : change.to === "SUSPENDED" ? "GSTIN_SUSPENDED" : "GSTIN_STATUS_CHANGED",
            message: `${who}: status changed from ${word(change.from)} to ${word(change.to)}.`, gstin, at: this.now().toISOString(), read: false });
        }
      }
      return { kind: "ok", rec, org: ctx.orgId, change };
    } catch (e) {
      const f = classifyProviderError(e);
      // Health learns from the provider's behaviour: a definite "no such registration" is a healthy answer; our own rate limiter is not evidence either way.
      if (f.outcome === "NOT_FOUND") this.provHealth.record(true, this.mono() - t);
      else if (f.outcome !== "RATE_LIMITED") this.provHealth.record(false, this.mono() - t);
      // A definite NOT_FOUND is a completed (normally billed) lookup; timeouts/outages cost credits only if the provider says they do.
      const settle: Promise<unknown>[] = [this.guard.record(ctx.orgId, { cacheMisses: 1, paidCalls: 1, failures: f.outcome === "NOT_FOUND" ? 0 : 1, credits: f.outcome === "NOT_FOUND" || f.billable ? cp.creditsPerCall : 0 })];
      if (!f.billable && !c.held) settle.push(this.usage.refund(c.billing, c.month));
      if (f.outcome === "NOT_FOUND") {
        // A definite registry answer: remember it in history, but it is not served from storage later and consumes no quota.
        const rec: VerificationRecord = { gstin, outcome: "NOT_FOUND", source: this.provider.name, verifiedAt: this.now().toISOString(), by: ctx.userId, requestId: c.requestId, ...c.keep };
        settle.push(this.store.putVerification(ctx.orgId, { ...rec, provenance: "LIVE_PROVIDER" }), this.audit(ctx, gstin, "NOT_FOUND", c.requestId));
        await Promise.all(settle);
        return { kind: "not_found", rec, org: ctx.orgId };
      }
      if (!c.held) settle.push(this.usage.recordFailure(c.billing, c.month));
      await Promise.all(settle);
      return { kind: "fail", f };
    }
  }

  /** Copies an answer obtained elsewhere (shared cache / another organization's live call) into this organization's store, keeping its notes/tags/saved. */
  private async adopt(
    ctx: Ctx, gstin: string, a: { outcome: VerificationOutcome; details?: VerificationRecord["details"]; source: string; verifiedAt: string }, prev: VerificationRecord | null,
    requestId: string, keep: Pick<VerificationRecord, "saved" | "note" | "tags">, provenance: Provenance = "SHARED_CACHE",
  ) {
    const change = detectChange(prev && isStatus(prev.outcome) ? prev : null, { outcome: a.outcome, details: a.details, verifiedAt: a.verifiedAt });
    const rec: VerificationRecord = { gstin, outcome: a.outcome, details: a.details, source: a.source, verifiedAt: a.verifiedAt, by: ctx.userId, requestId, provenance, ...keep };
    if (change && prev) { rec.previous = { outcome: prev.outcome, details: prev.details, verifiedAt: prev.verifiedAt }; rec.change = change; }
    await this.store.putVerification(ctx.orgId, rec);
  }

  private lastKnown(prev: VerificationRecord | null): LastKnown | undefined {
    return prev && isStatus(prev.outcome) ? { outcome: prev.outcome, verifiedAt: prev.verifiedAt, details: prev.details } : undefined;
  }

  private audit(ctx: Ctx, gstin: string, outcome: VerificationOutcome, requestId: string) {
    return this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: "GST_VERIFY", target: gstin, at: this.now().toISOString(), metadata: { outcome, requestId } });
  }

  /** True when a stored registry STATUS answer is young enough to be served without a provider call. */
  isFresh(r: VerificationRecord | null | undefined): boolean {
    if (!r || !isStatus(r.outcome)) return false;
    const age = this.now().getTime() - new Date(r.verifiedAt).getTime();
    return age >= 0 && age < this.opts.policy.freshMs;
  }

  /** Recent registry answers for this organization (newest first). */
  async recent(ctx: Ctx, limit = 10, o: { saved?: boolean; tag?: string } = {}): Promise<RecentVerification[]> {
    assertCan(ctx.role, "dashboard:read");
    const n = Math.min(Math.max(Math.floor(limit) || 10, 1), 50);
    const now = this.now().getTime();
    return (await this.store.listVerifications(ctx.orgId, n, o)).map((r) => ({
      saved: r.saved === true, note: r.note, tags: r.tags, gstin: r.gstin, outcome: r.outcome, details: r.details, verifiedAt: r.verifiedAt, source: r.source,
      ageSeconds: Math.max(0, Math.round((now - new Date(r.verifiedAt).getTime()) / 1000)),
    }));
  }

  /** Pin / unpin a previously verified GSTIN (organization-wide). The record must exist: you save what you have looked up. */
  async setSaved(ctx: Ctx, input: unknown, saved: unknown): Promise<{ gstin: string; saved: boolean }> {
    assertCan(ctx.role, "checks:run");
    if (typeof input !== "string" || typeof saved !== "boolean") throw new AppError("VALIDATION_ERROR", "gstin (string) and saved (boolean) are required.");
    const v = validateGstin(input);
    if (!v.valid) throw new AppError("INVALID_GSTIN", "That is not a valid GSTIN.");
    const rec = await this.store.getVerification(ctx.orgId, v.gstin);
    if (!rec) throw new AppError("VERIFICATION_NOT_FOUND", "Verify this GSTIN first, then save it.", 404);
    await this.store.putVerification(ctx.orgId, { ...rec, saved });
    await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: "VERIFICATION_SAVED", target: v.gstin, at: this.now().toISOString(), metadata: { saved } });
    return { gstin: v.gstin, saved };
  }

  /** Note and tags on a previously verified GSTIN (organization-wide). Omit a field to leave it unchanged; "" / [] clears it. */
  async annotate(ctx: Ctx, input: unknown, patch: { note?: unknown; tags?: unknown }): Promise<{ gstin: string; note?: string; tags: string[] }> {
    assertCan(ctx.role, "checks:run");
    if (typeof input !== "string") throw new AppError("VALIDATION_ERROR", "gstin must be a string.");
    const v = validateGstin(input);
    if (!v.valid) throw new AppError("INVALID_GSTIN", "That is not a valid GSTIN.");
    const rec = await this.store.getVerification(ctx.orgId, v.gstin);
    if (!rec) throw new AppError("VERIFICATION_NOT_FOUND", "Verify this GSTIN first, then add notes.", 404);
    const next = { ...rec };
    if (patch.note !== undefined) {
      if (typeof patch.note !== "string") throw new AppError("VALIDATION_ERROR", "note must be text.");
      const n = patch.note.trim();
      if (n.length > MAX_NOTE) throw new AppError("VALIDATION_ERROR", `Notes can be at most ${MAX_NOTE} characters.`);
      next.note = n || undefined;
    }
    if (patch.tags !== undefined) {
      if (!Array.isArray(patch.tags) || patch.tags.some((t) => typeof t !== "string")) throw new AppError("VALIDATION_ERROR", "tags must be a list of text.");
      const tags = [...new Set((patch.tags as string[]).map((t) => t.trim().replace(/\s+/g, " ")).filter(Boolean))];
      if (tags.length > MAX_TAGS) throw new AppError("VALIDATION_ERROR", `Use at most ${MAX_TAGS} tags.`);
      if (tags.some((t) => t.length > MAX_TAG_LEN)) throw new AppError("VALIDATION_ERROR", `Tags can be at most ${MAX_TAG_LEN} characters.`);
      next.tags = tags.length ? tags : undefined;
    }
    await this.store.putVerification(ctx.orgId, next);
    // Audit records THAT something changed, never the text (notes are free text and may hold client details).
    await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: "VERIFICATION_ANNOTATED", target: v.gstin, at: this.now().toISOString(), metadata: { noteChanged: patch.note !== undefined, tagCount: next.tags?.length ?? 0 } });
    return { gstin: v.gstin, note: next.note, tags: next.tags ?? [] };
  }

  /** This organization's cost counters (today and this month). ADMIN/OWNER. */
  async costs(ctx: Ctx) {
    assertCan(ctx.role, "auditlog:read");
    return { ...(await this.guard.orgReport(ctx.orgId)), sharedCache: this.guard.policy.sharedCache, costKnown: this.guard.policy.costPerCreditInr !== null };
  }

  /** Current provider health as learned from recent verification attempts (process-wide, not per organization). */
  providerHealth(): HealthSnapshot { return this.provHealth.snapshot(); }

  /** Operational metrics for this organization's verifications (process-local; see src/lib/metrics.ts). */
  health(ctx: Ctx): MetricsSnapshot {
    assertCan(ctx.role, "auditlog:read");
    return this.metrics.snapshot(ctx.orgId);
  }
}
