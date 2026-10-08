import { AppError, type Ctx } from "@/lib/errors";
import { assertCan, can } from "@/lib/permissions";
import type { Store } from "@/lib/store/types";
import type { SubscriptionService } from "./subscription";

/**
 * Dashboard = ~15 indexed COUNT queries + two small "recent" reads, all against stored data.
 * It never calls the GST provider and never scans GSTIN documents, so cost is independent of org size
 * (Firestore bills count aggregations at ~1 read per 1,000 index entries).
 * Compliance numbers are "as of each GSTIN's last check" (see ISSUE-006).
 */
export class DashboardService {
  constructor(private store: Store, private subs: SubscriptionService, private now: () => Date = () => new Date()) {}

  async get(ctx: Ctx) {
    assertCan(ctx.role, "dashboard:read");
    const id = ctx.orgId;
    const s = this.store;
    const nowIso = this.now().toISOString();
    const c = (f: Parameters<Store["countGstins"]>[1]) => s.countGstins(id, f);
    const [
      clients, total, checked, active, suspended, cancelled, inactive, unknown, needsRefresh,
      g1None, g1Some, g1Late, g3None, g3Some, g3Late, attention, high, recentChecks, recentActivity, overview,
    ] = await Promise.all([
      s.countClients(id), c({}), c({ checked: true }),
      c({ status: "Active" }), c({ status: "Suspended" }), c({ status: "Cancelled" }), c({ status: "Inactive" }), c({ status: "Unknown" }),
      c({ refreshBefore: nowIso }),
      c({ gstr1Missing: "none" }), c({ gstr1Missing: "some" }), c({ gstr1Late: "some" }),
      c({ gstr3bMissing: "none" }), c({ gstr3bMissing: "some" }), c({ gstr3bLate: "some" }),
      c({ indicators: ["Needs Attention", "High Attention"] }), c({ indicators: ["High Attention"] }),
      s.listChecks(id, 10),
      can(ctx.role, "auditlog:read") ? s.listAudit(id, 10) : Promise.resolve([]),
      this.subs.overview(ctx),
    ]);
    if (!overview) throw new AppError("ORG_NOT_FOUND", "Organization not found.", 404);
    const u = overview.usage;
    return {
      asOf: nowIso,
      clients: { total: clients },
      gstins: {
        total, active, suspended, cancelled, inactive, unknown,
        inactiveOrCancelled: inactive + cancelled, neverChecked: total - checked, needsRefresh,
      },
      returns: {
        gstr1: { compliant: g1None, missing: g1Some, late: g1Late },
        gstr3b: { compliant: g3None, missing: g3Some, late: g3Late },
        note: "Compliance counts cover GSTINs whose return history has been retrieved, as of their last check.",
      },
      attention: { needsAttention: attention, highAttention: high },
      recentChecks: recentChecks.map((r) => ({ id: r.id, gstin: r.gstin, at: r.at, outcome: r.outcome, status: r.status, errorCode: r.errorCode, jobId: r.jobId })),
      recentActivity: recentActivity.map((a) => ({ id: a.id, action: a.action, userId: a.userId, target: a.target, at: a.at })),
      subscription: { plan: overview.plan.id, planName: overview.plan.name, status: overview.status, readOnly: overview.readOnly },
      quota: { limit: u.limit, used: u.used, reserved: u.reserved, remaining: u.remaining, percent: u.percent, month: u.month },
    };
  }
}
