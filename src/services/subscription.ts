import { getPlan, type PlanConfig, type SubscriptionStatus } from "@/config/plans";
import { currentMonthKey } from "@/lib/dates";
import { AppError, type Ctx } from "@/lib/errors";
import type { Store } from "@/lib/store/types";
import { effectiveStatus } from "@/lib/subscription";
import { UsageService } from "@/lib/usage";
import { cheapestPlan, computeBill, previewAddClient, type AddClientPreview, type Bill, type BillingPeriod } from "@/lib/pricing";
import type { PlanId } from "@/config/plans";

export interface SubscriptionOverview {
  organizationId: string;
  plan: PlanConfig;
  status: SubscriptionStatus;
  billingPeriod: "monthly" | "annual";
  trialEndsAt?: string;
  currentPeriodEnd?: string;
  readOnly: boolean;
  usage: { month: string; used: number; reserved: number; limit: number | null; remaining: number | null; percent: number | null; cachedChecks: number; failedRequests: number };
  seats: { used: number; limit: number | null };
  /** used = ACTIVE (billable) client firms; archived ones are not billed. limit = hard ceiling (Free: the plan cap; paid: a safety ceiling). */
  clients: { used: number; archived: number; included: number | null; limit: number | null };
  /** What the pricing model says this organization owes for its current active clients. Display only: there is no payment provider yet. */
  pricing: {
    period: BillingPeriod;
    bill: Bill;
    /** What adding one more active client would do to the bill. */
    nextClient: AddClientPreview;
    /** A plan that costs less for this client count, if one exists (price only; plans also differ in users and features). */
    cheaper?: { planId: PlanId; totalInr: number; savingInr: number };
  };
}

/** The subscription is looked up through the *organization*, never through the user. */
export class SubscriptionService {
  private usage: UsageService;
  constructor(private store: Store, private now: () => Date = () => new Date()) { this.usage = new UsageService(store.usage); }

  async overview(ctx: Ctx): Promise<SubscriptionOverview> {
    const org = await this.store.getOrg(ctx.orgId);
    if (!org) throw new AppError("ORG_NOT_FOUND", "Organization not found.", 404);
    const plan = getPlan(org.plan);
    const status = effectiveStatus(org, this.now());
    const month = currentMonthKey(this.now());
    const [s, doc, members, invites, clients, archived] = await Promise.all([
      this.usage.summary({ organizationId: org.id, plan: org.plan, status }, month),
      this.store.usage.get(org.id, month),
      this.store.listMembers(org.id),
      this.store.listInvitations(org.id),
      this.store.countClients(org.id),
      this.store.countClients(org.id, "archived"),
    ]);
    const period: BillingPeriod = org.billingPeriod;
    const bill = computeBill(org.plan, clients, period);
    const best = cheapestPlan(clients, period);
    const cheaper = best && best.planId !== org.plan && bill.totalInr !== null && best.bill.totalInr! < bill.totalInr
      ? { planId: best.planId, totalInr: best.bill.totalInr!, savingInr: bill.totalInr - best.bill.totalInr! } : undefined;
    const pending = invites.filter((i) => i.status === "pending" && new Date(i.expiresAt) > this.now()).length;
    return {
      organizationId: org.id, plan, status, billingPeriod: org.billingPeriod,
      trialEndsAt: org.trialEndsAt, currentPeriodEnd: org.currentPeriodEnd,
      readOnly: !["trialing", "active", "past_due"].includes(status),
      usage: { month, used: s.used, reserved: s.reserved, limit: s.limit, remaining: s.remaining, percent: s.percent, cachedChecks: doc?.cachedChecks ?? 0, failedRequests: doc?.failedRequests ?? 0 },
      seats: { used: members.length + pending, limit: plan.userLimit },
      clients: { used: clients, archived, included: plan.includedClients, limit: plan.clientLimit },
      pricing: { period, bill, nextClient: previewAddClient(org.plan, clients, period), cheaper },
    };
  }
}
