import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PLAN_IDS, type PlanId } from "@/config/plans";
import type { AuthUser } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import type { Organization, Store } from "@/lib/store/types";
import { TRIAL_DAYS, effectiveStatus } from "@/lib/subscription";

const MAX_OWNED_ORGS = 10;

const createInput = z.object({
  name: z.string().trim().min(2, "Firm name is too short.").max(100, "Firm name is too long."),
  plan: z.enum(PLAN_IDS as [PlanId, ...PlanId[]]).default("free"),
});

export interface OrgSummary {
  id: string; name: string; role: string; plan: PlanId; status: string;
}

export class OrganizationService {
  constructor(private store: Store, private now: () => Date = () => new Date()) {}

  /**
   * Creates a firm. The creator becomes its only OWNER. Paid plans start as a card-less trial
   * (TRIAL_DAYS); after that the workspace turns read-only until a payment succeeds (billing: pending).
   */
  async create(user: AuthUser, raw: { name: string; plan?: PlanId }): Promise<Organization> {
    if (!user.emailVerified) throw new AppError("EMAIL_NOT_VERIFIED", "Verify your email before creating a firm.", 403);
    const parsed = createInput.safeParse(raw);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input.");
    const { name, plan } = parsed.data;
    if (plan === "enterprise") throw new AppError("CONTACT_SALES", "Enterprise plans are arranged with our team.", 400);
    const owned = (await this.store.listMemberships(user.uid)).filter((m) => m.member.role === "OWNER").length;
    if (owned >= MAX_OWNED_ORGS) throw new AppError("ORG_LIMIT_REACHED", "Organization limit reached.", 403);

    const ts = this.now();
    const paid = plan !== "free";
    const org: Organization = {
      id: randomUUID(), name, ownerId: user.uid, plan,
      subscriptionStatus: paid ? "trialing" : "active", billingPeriod: "monthly",
      trialEndsAt: paid ? new Date(ts.getTime() + TRIAL_DAYS * 864e5).toISOString() : undefined,
      createdAt: ts.toISOString(),
    };
    await this.store.putUser({ uid: user.uid, email: user.email, name: user.name, createdAt: ts.toISOString() });
    await this.store.createOrg(org, { uid: user.uid, email: user.email, name: user.name, role: "OWNER", addedAt: ts.toISOString(), lastActiveAt: ts.toISOString() });
    return org;
  }

  async listForUser(uid: string): Promise<OrgSummary[]> {
    const all = await this.store.listMemberships(uid);
    return all.map(({ organization: o, member }) => ({
      id: o.id, name: o.name, role: member.role, plan: o.plan, status: effectiveStatus(o, this.now()),
    }));
  }

  /** Called when the app loads; keeps "last active" fresh without a write on every request. */
  async touch(uid: string, orgId: string): Promise<void> {
    const m = await this.store.getMember(orgId, uid);
    if (!m) return;
    const last = m.lastActiveAt ? new Date(m.lastActiveAt).getTime() : 0;
    if (this.now().getTime() - last > 5 * 60_000) await this.store.putMember(orgId, { ...m, lastActiveAt: this.now().toISOString() });
  }
}
