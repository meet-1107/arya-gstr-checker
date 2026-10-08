import { getPlan, WRITABLE_STATUSES, type PlanId, type SubscriptionStatus } from "@/config/plans";

export interface UsageDoc {
  organizationId: string; month: string; plan: PlanId;
  limit: number | null;
  /** Consumed checks (final). */
  used: number;
  /** Held for in-flight bulk jobs; not yet consumed or released. remaining = limit - used - reserved. */
  reserved: number;
  cachedChecks: number; failedRequests: number;
}

/**
 * Persistence contract for usage. `reserve` MUST be atomic (Firestore transaction / increment
 * guarded by a limit check) so N concurrent workers can never exceed the quota.
 */
export interface UsageStore {
  reserve(orgId: string, month: string, plan: PlanId, limit: number | null, n: number): Promise<{ ok: boolean; used: number }>;
  release(orgId: string, month: string, n: number): Promise<void>;
  /**
   * Bulk quota hold: atomically reserves up to `n` units without consuming them.
   * Fails (ok=false) if used + reserved + n would exceed the limit. Returns units actually held.
   */
  hold(orgId: string, month: string, plan: PlanId, limit: number | null, n: number, allowPartial: boolean): Promise<{ ok: boolean; held: number }>;
  /** Atomically convert held units: `consume` become used, `release` return to the pool. Never negative. */
  settle(orgId: string, month: string, consume: number, release: number): Promise<void>;
  bump(orgId: string, month: string, field: "cachedChecks" | "failedRequests", n: number): Promise<void>;
  get(orgId: string, month: string): Promise<UsageDoc | null>;
}

export class MemoryUsageStore implements UsageStore {
  private docs = new Map<string, UsageDoc>();
  private key = (o: string, m: string) => `${o}/${m}`;
  private ensure(orgId: string, month: string, plan: PlanId, limit: number | null): UsageDoc {
    const k = this.key(orgId, month);
    let d = this.docs.get(k);
    if (!d) { d = { organizationId: orgId, month, plan, limit, used: 0, reserved: 0, cachedChecks: 0, failedRequests: 0 }; this.docs.set(k, d); }
    d.plan = plan; d.limit = limit;
    return d;
  }
  async reserve(orgId: string, month: string, plan: PlanId, limit: number | null, n: number) {
    const d = this.ensure(orgId, month, plan, limit); // single synchronous section == atomic
    if (limit !== null && d.used + d.reserved + n > limit) return { ok: false, used: d.used };
    d.used += n;
    return { ok: true, used: d.used };
  }
  async hold(orgId: string, month: string, plan: PlanId, limit: number | null, n: number, allowPartial: boolean) {
    const d = this.ensure(orgId, month, plan, limit);
    const free = limit === null ? n : Math.max(0, limit - d.used - d.reserved);
    const held = allowPartial ? Math.min(n, free) : free >= n ? n : 0;
    if (held <= 0 && n > 0) return { ok: false, held: 0 };
    d.reserved += held;
    return { ok: true, held };
  }
  async settle(orgId: string, month: string, consume: number, release: number) {
    const d = this.docs.get(this.key(orgId, month));
    if (!d) return;
    const total = Math.min(d.reserved, consume + release);
    const c = Math.min(consume, total);
    d.reserved -= total;
    d.used += c;
  }
  async release(orgId: string, month: string, n: number) {
    const d = this.docs.get(this.key(orgId, month));
    if (d) d.used = Math.max(0, d.used - n);
  }
  async bump(orgId: string, month: string, field: "cachedChecks" | "failedRequests", n: number) {
    const d = this.docs.get(this.key(orgId, month));
    if (d) d[field] += n;
  }
  async get(orgId: string, month: string) { return this.docs.get(this.key(orgId, month)) ?? null; }
}

export type UsageDenial = "SUBSCRIPTION_INACTIVE" | "QUOTA_EXHAUSTED";
export class UsageError extends Error {
  constructor(public code: UsageDenial, message: string) { super(message); }
}

export interface OrgBilling { organizationId: string; plan: PlanId; status: SubscriptionStatus }

export class UsageService {
  constructor(private store: UsageStore) {}

  /** Reserve one billable check before calling the provider. Throws UsageError if not allowed. */
  async reserveCheck(org: OrgBilling, month: string): Promise<void> {
    if (!WRITABLE_STATUSES.includes(org.status)) {
      throw new UsageError("SUBSCRIPTION_INACTIVE", "Subscription is not active. Account is read-only.");
    }
    const limit = getPlan(org.plan).monthlyChecks;
    const r = await this.store.reserve(org.organizationId, month, org.plan, limit, 1);
    if (!r.ok) throw new UsageError("QUOTA_EXHAUSTED", "Monthly GST check quota exhausted.");
  }
  /**
   * Bulk: hold `n` units up front (atomic). Returns units actually held (== n unless allowPartial).
   * Throws SUBSCRIPTION_INACTIVE / QUOTA_EXHAUSTED. Held units cannot be spent by anyone else.
   */
  async holdChecks(org: OrgBilling, month: string, n: number, allowPartial: boolean): Promise<number> {
    if (!WRITABLE_STATUSES.includes(org.status)) {
      throw new UsageError("SUBSCRIPTION_INACTIVE", "Subscription is not active. Account is read-only.");
    }
    if (n <= 0) return 0;
    const limit = getPlan(org.plan).monthlyChecks;
    const r = await this.store.hold(org.organizationId, month, org.plan, limit, n, allowPartial);
    if (!r.ok) throw new UsageError("QUOTA_EXHAUSTED", "Not enough GST checks remaining this month.");
    return r.held;
  }
  /** Convert held units into consumed / released. Idempotency is the caller's job (settle each unit once). */
  settle(org: OrgBilling, month: string, consume: number, release: number) {
    return this.store.settle(org.organizationId, month, consume, release);
  }
  /** Refund a reservation when the provider call failed in a non-billable way. */
  refund(org: OrgBilling, month: string) { return this.store.release(org.organizationId, month, 1); }
  recordCached(org: OrgBilling, month: string) { return this.store.bump(org.organizationId, month, "cachedChecks", 1); }
  recordFailure(org: OrgBilling, month: string) { return this.store.bump(org.organizationId, month, "failedRequests", 1); }

  async summary(org: OrgBilling, month: string) {
    const limit = getPlan(org.plan).monthlyChecks;
    const d = await this.store.get(org.organizationId, month);
    const used = d?.used ?? 0;
    const reserved = d?.reserved ?? 0;
    return {
      organizationId: org.organizationId, month, plan: org.plan, limit, used, reserved,
      remaining: limit === null ? null : Math.max(0, limit - used - reserved),
      percent: limit ? Math.round((used / limit) * 100) : null,
    };
  }
}
