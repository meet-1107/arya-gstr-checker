import { PLANS } from "@/config/plans";
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { OrganizationService } from "@/services/organizations";
import { TeamService } from "@/services/team";
import { SubscriptionService } from "@/services/subscription";
import { ClientService } from "@/services/clients";
import { CheckService, DEFAULT_CHECK_OPTIONS } from "@/services/checks";
import { DevAuthVerifier, FirebaseAuthVerifier, type AuthUser } from "@/lib/auth";
import { resolveCtx, type Ctx } from "@/lib/errors";
import { MockGstProvider } from "@/providers/mock";
import { computeGstinChecksum } from "@/lib/gstin";
import { currentMonthKey } from "@/lib/dates";
import { annualSavingsPercent, effectiveStatus } from "@/lib/subscription";
import { UsageService } from "@/lib/usage";

let NOW = new Date("2026-10-06T05:00:00Z");
const clock = () => NOW;
const user = (uid: string, over: Partial<AuthUser> = {}): AuthUser => ({ uid, email: `${uid}@x.com`, emailVerified: true, name: uid, ...over });
const gst = (n: number) => { const b = `24AAAAA${String(n).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };

let store: MemoryStore, orgs: OrganizationService, team: TeamService, subs: SubscriptionService, clients: ClientService;
let meet: Ctx; let orgId: string;

async function join(uid: string, role: "ADMIN" | "ACCOUNTANT" | "VIEWER"): Promise<Ctx> {
  const { token } = await team.invite(meet, { email: `${uid}@x.com`, role });
  await team.accept(user(uid), token);
  return { orgId, userId: uid, role };
}

beforeEach(async () => {
  NOW = new Date("2026-10-06T05:00:00Z");
  store = new MemoryStore();
  orgs = new OrganizationService(store, clock); team = new TeamService(store, clock);
  subs = new SubscriptionService(store, clock); clients = new ClientService(store, clock);
  const org = await orgs.create(user("meet"), { name: "Shah & Co.", plan: "firm" }); // Firm: 2,000 checks and 10 seats, like the old Professional numbers these tests were written around
  orgId = org.id; meet = { orgId, userId: "meet", role: "OWNER" };
});

describe("organization creation", () => {
  it("requires verified email, validates input, blocks enterprise self-signup", async () => {
    await expect(orgs.create(user("u", { emailVerified: false }), { name: "Firm" })).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    await expect(orgs.create(user("u"), { name: "x" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(orgs.create(user("u"), { name: "Firm", plan: "enterprise" })).rejects.toMatchObject({ code: "CONTACT_SALES" });
  });
  it("paid plan starts a 14-day trial; free is active", async () => {
    const o = await store.getOrg(orgId);
    expect(o).toMatchObject({ plan: "firm", subscriptionStatus: "trialing", ownerId: "meet" });
    expect(new Date(o!.trialEndsAt!).getTime() - NOW.getTime()).toBe(14 * 864e5);
    expect((await orgs.create(user("zed"), { name: "Free Firm" })).subscriptionStatus).toBe("active");
  });
  it("trial end makes workspace read-only but keeps data", async () => {
    const c = await clients.create(meet, { name: "A", gstin: gst(1) });
    NOW = new Date("2026-10-21T00:00:00Z");
    expect(effectiveStatus((await store.getOrg(orgId))!, NOW)).toBe("expired");
    await expect(clients.create(meet, { name: "B", gstin: gst(2) })).rejects.toMatchObject({ code: "SUBSCRIPTION_INACTIVE" });
    await expect(team.invite(meet, { email: "n@x.com", role: "VIEWER" })).rejects.toMatchObject({ code: "SUBSCRIPTION_INACTIVE" });
    expect((await clients.get({ ...meet, role: "VIEWER" }, c.id)).id).toBe(c.id);
    expect((await subs.overview(meet)).readOnly).toBe(true);
  });
  it("cancelled subscription stays usable until paid period ends", () => {
    const base = { plan: "starter" as const, subscriptionStatus: "cancelled" as const, currentPeriodEnd: "2026-11-01T00:00:00Z" };
    expect(effectiveStatus(base, NOW)).toBe("active");
    expect(effectiveStatus(base, new Date("2026-11-02"))).toBe("cancelled");
  });
});

describe("multiple organizations and active-org selection", () => {
  it("requires selection when ambiguous; membership verified; forged org id rejected", async () => {
    const other = await orgs.create(user("someone"), { name: "Other Firm" });
    await expect(resolveCtx(store, "meet", other.id)).rejects.toMatchObject({ code: "NOT_A_MEMBER" });
    await expect(resolveCtx(store, "meet", "does-not-exist")).rejects.toMatchObject({ code: "NOT_A_MEMBER" }); // no existence oracle
    const second = await orgs.create(user("meet"), { name: "Meet Tax Consulting" });
    await expect(resolveCtx(store, "meet")).rejects.toMatchObject({ code: "ORG_REQUIRED" });
    expect(await resolveCtx(store, "meet", second.id)).toMatchObject({ orgId: second.id, role: "OWNER" });
    expect((await orgs.listForUser("meet")).map((o) => o.name).sort()).toEqual(["Meet Tax Consulting", "Shah & Co."]);
  });
  it("same user has different roles per org; data is per-org", async () => {
    const acct = await join("priya", "ACCOUNTANT");
    const her = await orgs.create(user("priya"), { name: "Priya Practice" });
    expect(await resolveCtx(store, "priya", orgId)).toMatchObject({ role: "ACCOUNTANT" });
    expect(await resolveCtx(store, "priya", her.id)).toMatchObject({ role: "OWNER" });
    await clients.create(acct, { name: "Shah client", gstin: gst(1) });
    expect((await clients.list(await resolveCtx(store, "priya", her.id))).items).toHaveLength(0);
  });
});

describe("team & roles", () => {
  it("invitation flow creates membership with the invited role only", async () => {
    const { token, invitation } = await team.invite(meet, { email: "priya@x.com", role: "ACCOUNTANT" });
    expect(invitation.id).not.toBe(token); // only a hash is stored
    expect(JSON.stringify(await store.listInvitations(orgId))).not.toContain(token);
    const r = await team.accept(user("priya"), token);
    expect(r).toEqual({ organizationId: orgId, role: "ACCOUNTANT" });
    await expect(team.accept(user("priya"), token)).rejects.toMatchObject({ code: "INVITATION_INVALID" }); // single use
  });
  it("invitee must match email and be verified; expired/forged tokens fail", async () => {
    const { token } = await team.invite(meet, { email: "priya@x.com", role: "VIEWER" });
    await expect(team.accept(user("eve", { email: "eve@x.com" }), token)).rejects.toMatchObject({ code: "INVITATION_EMAIL_MISMATCH" });
    await expect(team.accept(user("priya", { emailVerified: false }), token)).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    await expect(team.accept(user("priya"), "forged")).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    NOW = new Date("2026-10-14T00:00:00Z");
    await expect(team.accept(user("priya"), token)).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });
  it("nobody can be invited or promoted to OWNER", async () => {
    await expect(team.invite(meet, { email: "a@x.com", role: "OWNER" })).rejects.toMatchObject({ code: "OWNER_PROTECTED" });
    const rahul = await join("rahul", "ADMIN");
    await join("priya", "ACCOUNTANT");
    await expect(team.changeRole(meet, "priya", "OWNER")).rejects.toMatchObject({ code: "OWNER_PROTECTED" });
    await expect(team.changeRole(rahul, "priya", "OWNER")).rejects.toMatchObject({ code: "OWNER_PROTECTED" });
  });
  it("accountant/viewer cannot manage team, subscription data is read-only for them", async () => {
    const priya = await join("priya", "ACCOUNTANT");
    const viewer = await join("vik", "VIEWER");
    for (const c of [priya, viewer]) {
      await expect(team.invite(c, { email: "n@x.com", role: "VIEWER" })).rejects.toThrow();
      await expect(team.changeRole(c, "vik", "ADMIN")).rejects.toThrow();
      await expect(team.remove(c, "meet")).rejects.toThrow();
      await expect(team.list(c)).rejects.toThrow();
      await expect(team.transferOwnership(c, "priya")).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
  it("admin cannot touch owner or other admins, cannot promote to admin", async () => {
    const rahul = await join("rahul", "ADMIN");
    await join("sam", "ADMIN");
    await join("priya", "ACCOUNTANT");
    await expect(team.remove(rahul, "meet")).rejects.toMatchObject({ code: "OWNER_PROTECTED" });
    await expect(team.changeRole(rahul, "meet", "VIEWER")).rejects.toMatchObject({ code: "OWNER_PROTECTED" });
    await expect(team.remove(rahul, "sam")).rejects.toThrow();
    await expect(team.changeRole(rahul, "priya", "ADMIN")).rejects.toThrow();
    await expect(team.invite(rahul, { email: "z@x.com", role: "ADMIN" })).rejects.toThrow();
    await team.changeRole(rahul, "priya", "VIEWER");
    await team.remove(rahul, "priya");
    expect(await store.getMember(orgId, "priya")).toBeNull();
    expect(await resolveCtx(store, "priya").catch((e) => e.code)).toBe("NO_ORGANIZATION");
  });
  it("owner transfer keeps exactly one owner", async () => {
    await join("rahul", "ADMIN");
    await team.transferOwnership(meet, "rahul");
    const roles = (await store.listMembers(orgId)).map((m) => m.role).sort();
    expect(roles).toEqual(["ADMIN", "OWNER"]);
    expect((await store.getOrg(orgId))!.ownerId).toBe("rahul");
    await expect(team.transferOwnership(meet, "rahul")).rejects.toMatchObject({ code: "FORBIDDEN" }); // meet is no longer owner
  });
  it("owner cannot leave without transferring; self role change blocked", async () => {
    await expect(team.remove(meet, "meet")).rejects.toMatchObject({ code: "OWNER_PROTECTED" });
    await expect(team.changeRole(meet, "meet", "VIEWER")).rejects.toThrow();
  });
  it("seat limit counts members + pending invites (Professional = 3)", async () => {
    await store.updateOrg(orgId, { plan: "professional" });
    const seats = PLANS.professional.userLimit!; expect(seats).toBe(3);
    await join("a", "ACCOUNTANT"); // owner + 1 = 2
    await team.invite(meet, { email: "d@x.com", role: "VIEWER" }); // 3rd seat held by invite
    await expect(team.invite(meet, { email: "e@x.com", role: "VIEWER" })).rejects.toMatchObject({ code: "USER_LIMIT_REACHED" });
    expect((await subs.overview(meet)).seats).toEqual({ used: seats, limit: seats });
  });
  it("duplicate members/invites rejected", async () => {
    await join("priya", "ACCOUNTANT");
    await expect(team.invite(meet, { email: "priya@x.com", role: "VIEWER" })).rejects.toMatchObject({ code: "ALREADY_MEMBER" });
    await team.invite(meet, { email: "n@x.com", role: "VIEWER" });
    await expect(team.invite(meet, { email: "N@x.com", role: "VIEWER" })).rejects.toMatchObject({ code: "ALREADY_INVITED" });
  });
  it("invitation of another org cannot be revoked from this org", async () => {
    const other = await orgs.create(user("zed"), { name: "Zed Firm", plan: "firm" });
    const zed: Ctx = { orgId: other.id, userId: "zed", role: "OWNER" };
    const { invitation } = await team.invite(zed, { email: "q@x.com", role: "VIEWER" });
    await expect(team.revokeInvitation(meet, invitation.id)).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });
  });
});

describe("subscription belongs to the organization (shared quota)", () => {
  it("Shah & Co.: 1,274 used + Priya runs 100 checks => 1,374 org-wide, not per user", async () => {
    const priya = await join("priya", "ACCOUNTANT");
    const month = currentMonthKey(NOW);
    expect((await store.usage.reserve(orgId, month, "firm", 2000, 1274)).ok).toBe(true);
    for (let i = 1; i <= 100; i++) await clients.create(meet, { name: `c${i}`, gstin: gst(i) });
    const svc = new CheckService(store, new MockGstProvider({ now: clock }), DEFAULT_CHECK_OPTIONS, clock);
    const list = (await clients.list(priya, { limit: 100 })).items;
    for (const c of list) await svc.checkClient(priya, c.id);
    const o = await subs.overview(meet);
    expect(o.usage).toMatchObject({ used: 1374, limit: 2000, remaining: 626 });
    expect((await subs.overview(priya)).usage.used).toBe(1374); // same number for every member
  });
  it("last unit: five simultaneous checks consume exactly one", async () => {
    const month = currentMonthKey(NOW);
    await store.usage.reserve(orgId, month, "firm", 2000, 1999);
    for (let i = 1; i <= 5; i++) await clients.create(meet, { name: `c${i}`, gstin: gst(i) });
    const svc = new CheckService(store, new MockGstProvider({ now: clock }), DEFAULT_CHECK_OPTIONS, clock);
    const items = (await clients.list(meet)).items;
    const res = await Promise.allSettled(items.map((c) => svc.checkClient(meet, c.id)));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.usage.get(orgId, month))!.used).toBe(2000);
  });
  it("UsageService quota is independent of who calls", async () => {
    const u = new UsageService(store.usage);
    const org = { organizationId: orgId, plan: "starter" as const, status: "active" as const };
    await Promise.all(Array.from({ length: 150 }, (_, i) => u.reserveCheck(org, "2026-10").catch(() => i)));
    expect((await store.usage.get(orgId, "2026-10"))!.used).toBe(PLANS.starter.monthlyChecks);
  });
  it("overview exposes plan limits from central config", async () => {
    const o = await subs.overview(meet);
    expect(o.plan.monthlyChecks).toBe(PLANS.firm.monthlyChecks); expect(o.clients.limit).toBe(PLANS.firm.clientLimit); expect(o.seats.limit).toBe(PLANS.firm.userLimit);
    expect(o.status).toBe("trialing");
  });
  it("annual savings computed from config (not hard-coded)", () => {
    expect(annualSavingsPercent("starter")).toBe(17);
    expect(annualSavingsPercent("professional")).toBe(Math.round(((999 * 12 - 9999) / (999 * 12)) * 100));
    expect(annualSavingsPercent("free")).toBeNull();
    expect(annualSavingsPercent("enterprise")).toBeNull();
  });
});

describe("authentication verifiers", () => {
  it("dev verifier parses credential and is refused in production", async () => {
    const v = new DevAuthVerifier({ NODE_ENV: "test" });
    expect(await v.verify("Bearer dev:u1:U1@x.com")).toMatchObject({ uid: "u1", email: "u1@x.com", emailVerified: true });
    expect((await v.verify("Bearer dev:u1:u1@x.com:unverified")).emailVerified).toBe(false);
    await expect(v.verify(null)).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    await expect(v.verify("Bearer garbage")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(() => new DevAuthVerifier({ NODE_ENV: "production" })).toThrow();
  });
  it("firebase verifier maps token claims and hides failure details", async () => {
    const ok = new FirebaseAuthVerifier(() => ({ verifyIdToken: async () => ({ uid: "f1", email: "A@B.com", email_verified: true }) }));
    expect(await ok.verify("Bearer tok")).toMatchObject({ uid: "f1", email: "a@b.com", emailVerified: true });
    const bad = new FirebaseAuthVerifier(() => ({ verifyIdToken: async () => { throw new Error("jwt expired: secret"); } }));
    await expect(bad.verify("Bearer tok")).rejects.toMatchObject({ code: "UNAUTHENTICATED", message: "Please sign in." });
  });
});
