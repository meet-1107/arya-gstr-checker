import { computeGstinChecksum } from "@/lib/gstin";
import type { ProviderLimits } from "@/config/provider";
import type { PlanId, SubscriptionStatus } from "@/config/plans";
import type { Role } from "@/lib/permissions";
import type { Ctx } from "@/lib/errors";
import type { Store } from "@/lib/store/types";
import { ProviderError, type GstProvider, type GstinResult, type GstinStatus, type ReturnHistory, type ReturnRecord } from "@/providers/types";

export const NOW = new Date("2026-10-06T05:00:00Z");
export const gst = (n: number) => { const b = `24AAAAA${String(n).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };

export const FAST_LIMITS: ProviderLimits = {
  requestsPerMinute: 1_000_000, maxConcurrent: 5, timeoutMs: 15_000, retries: 1, backoffBaseMs: 1, backoffMaxMs: 1,
  breakerFailureThreshold: 5, breakerCooldownMs: 30_000, bulkConcurrency: 5, verified: false,
};

export async function seedOrg(store: Store, id: string, plan: PlanId = "professional", status: SubscriptionStatus = "active") {
  await store.createOrg(
    { id, name: id, ownerId: `${id}-owner`, plan, subscriptionStatus: status, createdAt: NOW.toISOString(), billingPeriod: "monthly" },
    { uid: `${id}-owner`, email: `${id}-owner@x.com`, role: "OWNER", addedAt: NOW.toISOString() },
  );
  for (const role of ["ADMIN", "ACCOUNTANT", "VIEWER"] as Role[]) {
    await store.putMember(id, { uid: `${id}-${role}`, email: `${role}@${id}.com`, role, addedAt: NOW.toISOString() });
  }
}
export const ctxFor = (org: string, role: Role | "OWNER"): Ctx => ({ orgId: org, userId: role === "OWNER" ? `${org}-owner` : `${org}-${role}`, role });

/** Directly seeds clients + gstin records (fast path for large-N tests). Returns client ids. */
export async function seedClients(store: Store, org: string, n: number, start = 1, over: (i: number) => Partial<import("@/lib/store/types").GstinRecord> = () => ({})) {
  const ids: string[] = [];
  for (let i = start; i < start + n; i++) {
    const id = `c${String(i).padStart(5, "0")}`;
    await store.createClient(org, { id, name: `Client ${i}`, gstin: gst(i), filingFrequency: "MONTHLY", status: "active", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });
    await store.putGstinRecord(org, { gstin: gst(i), clientId: id, status: "Unknown", clientName: `Client ${i}`, checked: false, ...over(i) });
    ids.push(id);
  }
  return ids;
}

/** Configurable fake provider (call counting, per-GSTIN failure injection, hooks). */
export class StubProvider implements GstProvider {
  name = "stub";
  verifyCalls = 0;
  returnCalls = 0;
  inFlight = 0;
  peak = 0;
  status: GstinStatus = "Active";
  failFor = new Map<string, ProviderError>();
  failAll: ProviderError | null = null;
  delayMs = 0;
  onVerify?: (n: number, gstin: string) => Promise<void> | void;
  records: (g: string) => ReturnRecord[] = () => [];
  constructor(private now: () => Date = () => NOW) {}
  async verifyGstin(g: string): Promise<GstinResult> {
    const n = ++this.verifyCalls;
    this.inFlight++; this.peak = Math.max(this.peak, this.inFlight);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      await this.onVerify?.(n, g);
      const f = this.failFor.get(g) ?? this.failAll;
      if (f) throw f;
      return { gstin: g, status: this.status, source: "stub", providerRequestId: `req-${n}`, checkedAt: this.now().toISOString() };
    } finally { this.inFlight--; }
  }
  async getReturnHistory(g: string): Promise<ReturnHistory> {
    this.returnCalls++;
    return { gstin: g, records: this.records(g), source: "stub", checkedAt: this.now().toISOString() };
  }
}

export const PERMANENT = () => new ProviderError("GST_PROVIDER_BAD_RESPONSE", "bad", false);
export const TRANSIENT = () => new ProviderError("GST_PROVIDER_TIMEOUT", "slow", true);
