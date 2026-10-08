import type { CostCounters, Store } from "@/lib/store/types";
import type { CostPolicy } from "@/config/cost-policy";

export type CreditState = "ok" | "low" | "critical" | "exhausted";

export interface CreditStatus {
  state: CreditState;
  /** Credits used this calendar month (counted by this system, not read from the provider). */
  used: number;
  /** Operator-configured monthly budget; null when not configured (protection is then disabled). */
  budget: number | null;
  remaining: number | null;
  fractionRemaining: number | null;
}

export type Admission = { ok: true } | { ok: false; reason: "ORG_PER_MINUTE" | "ORG_PER_DAY" | "GLOBAL_PER_DAY"; retryAfterMs: number };

export interface CostReport {
  period: string;
  searches: number; paidCalls: number; cacheHits: number; sharedHits: number; cacheMisses: number; deduped: number; failures: number; credits: number;
  /** (cacheHits + sharedHits + deduped) ÷ searches — the share of searches that did NOT cause their own paid call. null with no searches. */
  avoidedCallRate: number | null;
  estimatedCostInr: number | null;
}

const ZERO: CostCounters = { searches: 0, paidCalls: 0, cacheHits: 0, sharedHits: 0, cacheMisses: 0, deduped: 0, failures: 0, credits: 0 };

/**
 * Cost control around the paid provider: credit-budget state, per-organization and global call limits, and the counters behind the cost
 * dashboard. Counters are durable (Store.bumpCost); the per-minute window is in-process (one instance). Credits are what THIS system
 * counted against an operator-configured budget — the provider's own balance is not read (no real provider is integrated).
 */
export class CostGuard {
  private minute = new Map<string, number[]>();
  constructor(private store: Pick<Store, "bumpCost" | "getCost">, readonly policy: CostPolicy, private now: () => Date = () => new Date()) {}

  private day = () => `day:${this.now().toISOString().slice(0, 10)}`;
  private month = () => `month:${this.now().toISOString().slice(0, 7)}`;

  async record(orgId: string, d: Partial<CostCounters>): Promise<void> {
    await Promise.all([`global`, `org:${orgId}`].flatMap((scope) => [this.day(), this.month()].map((p) => this.store.bumpCost(scope, p, d))));
  }

  async creditStatus(): Promise<CreditStatus> {
    const budget = this.policy.monthlyCreditBudget;
    const used = (await this.store.getCost("global", this.month())).credits;
    if (budget === null) return { state: "ok", used, budget: null, remaining: null, fractionRemaining: null };
    const remaining = Math.max(0, budget - used);
    const fraction = budget === 0 ? 0 : remaining / budget;
    const state: CreditState = remaining < this.policy.creditsPerCall ? "exhausted" : fraction <= this.policy.criticalFraction ? "critical" : fraction <= this.policy.lowFraction ? "low" : "ok";
    return { state, used, budget, remaining, fractionRemaining: fraction };
  }

  /** Per-organization (minute, day) and global (day) call limits. Reserves a per-minute slot when it admits. Checked immediately before a paid call. */
  async admit(orgId: string, o: { skipMinute?: boolean } = {}): Promise<Admission> {
    const nowMs = this.now().getTime();
    const stamps = (this.minute.get(orgId) ?? []).filter((t) => nowMs - t < 60_000);
    if (!o.skipMinute && stamps.length >= this.policy.orgPerMinute) {
      this.minute.set(orgId, stamps);
      return { ok: false, reason: "ORG_PER_MINUTE", retryAfterMs: Math.max(1000, 60_000 - (nowMs - stamps[0])) };
    }
    const untilMidnight = () => { const d = new Date(nowMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - nowMs; };
    const today = this.day();
    const [orgDay, globalDay] = await Promise.all([this.store.getCost(`org:${orgId}`, today), this.policy.globalPerDay > 0 ? this.store.getCost("global", today) : Promise.resolve(null)]); // one round trip
    if (orgDay.paidCalls >= this.policy.orgPerDay) return { ok: false, reason: "ORG_PER_DAY", retryAfterMs: untilMidnight() };
    if (globalDay && globalDay.paidCalls >= this.policy.globalPerDay) return { ok: false, reason: "GLOBAL_PER_DAY", retryAfterMs: untilMidnight() };
    if (!o.skipMinute) { stamps.push(nowMs); this.minute.set(orgId, stamps); }
    return { ok: true };
  }

  private report(period: string, c: CostCounters): CostReport {
    const avoided = c.cacheHits + c.sharedHits + c.deduped;
    return {
      period, ...c,
      avoidedCallRate: c.searches === 0 ? null : Math.min(1, Math.round((avoided / c.searches) * 10_000) / 10_000),
      estimatedCostInr: this.policy.costPerCreditInr === null ? null : Math.round(c.credits * this.policy.costPerCreditInr * 100) / 100,
    };
  }

  async orgReport(orgId: string): Promise<{ today: CostReport; month: CostReport }> {
    const [t, m] = await Promise.all([this.store.getCost(`org:${orgId}`, this.day()), this.store.getCost(`org:${orgId}`, this.month())]);
    return { today: this.report(this.day(), { ...ZERO, ...t }), month: this.report(this.month(), { ...ZERO, ...m }) };
  }

  async platformReport(): Promise<{ today: CostReport; month: CostReport; credits: CreditStatus; limits: { orgPerMinute: number; orgPerDay: number; globalPerDay: number }; sharedCache: boolean }> {
    const [t, m, credits] = await Promise.all([this.store.getCost("global", this.day()), this.store.getCost("global", this.month()), this.creditStatus()]);
    return {
      today: this.report(this.day(), { ...ZERO, ...t }), month: this.report(this.month(), { ...ZERO, ...m }), credits,
      limits: { orgPerMinute: this.policy.orgPerMinute, orgPerDay: this.policy.orgPerDay, globalPerDay: this.policy.globalPerDay }, sharedCache: this.policy.sharedCache,
    };
  }
}
