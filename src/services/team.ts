import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { getPlan } from "@/config/plans";
import type { AuthUser } from "@/lib/auth";
import { AppError, type Ctx } from "@/lib/errors";
import { assertCan, type Role } from "@/lib/permissions";
import type { Invitation, Member, Store } from "@/lib/store/types";
import { isWritable } from "@/lib/subscription";

const INVITE_TTL_MS = 7 * 864e5;
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const inviteInput = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(200),
  role: z.enum(["ADMIN", "ACCOUNTANT", "VIEWER"]),
});

export class TeamService {
  constructor(private store: Store, private now: () => Date = () => new Date()) {}

  private async org(ctx: Ctx) {
    const org = await this.store.getOrg(ctx.orgId);
    if (!org) throw new AppError("ORG_NOT_FOUND", "Organization not found.", 404);
    return org;
  }
  private async audit(ctx: Ctx, action: "TEAM_MEMBER_ADDED" | "TEAM_MEMBER_REMOVED" | "ROLE_CHANGED", target: string, metadata?: Record<string, string>) {
    await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action, target, at: this.now().toISOString(), metadata });
  }
  /** OWNER may manage anyone below OWNER; ADMIN may only manage ACCOUNTANT/VIEWER. Nobody manages OWNER. */
  private assertCanManage(actor: Role, target: Role) {
    if (target === "OWNER") throw new AppError("OWNER_PROTECTED", "The organization owner cannot be modified.", 403);
    if (actor === "ADMIN" && target === "ADMIN") throw new AppError("FORBIDDEN", "Admins cannot manage other admins.", 403);
  }
  private async seatsUsed(orgId: string) {
    const [m, inv] = await Promise.all([this.store.listMembers(orgId), this.store.listInvitations(orgId)]);
    const now = this.now();
    return m.length + inv.filter((i) => i.status === "pending" && new Date(i.expiresAt) > now).length;
  }
  private async assertSeat(ctx: Ctx, plan: Parameters<typeof getPlan>[0]) {
    const limit = getPlan(plan).userLimit;
    if (limit !== null && (await this.seatsUsed(ctx.orgId)) >= limit) {
      throw new AppError("USER_LIMIT_REACHED", `Your ${getPlan(plan).name} plan allows ${limit} team member${limit === 1 ? "" : "s"}.`, 402);
    }
  }

  async list(ctx: Ctx) {
    assertCan(ctx.role, "team:manage");
    const now = this.now();
    const [members, invitations] = await Promise.all([this.store.listMembers(ctx.orgId), this.store.listInvitations(ctx.orgId)]);
    return {
      members,
      invitations: invitations.filter((i) => i.status === "pending").map((i) => ({ ...i, expired: new Date(i.expiresAt) <= now })),
    };
  }

  /** Returns the one-time token. It is never stored in plaintext and cannot be retrieved again. */
  async invite(ctx: Ctx, raw: { email: string; role: string }): Promise<{ invitation: Invitation; token: string }> {
    assertCan(ctx.role, "team:manage");
    const org = await this.org(ctx);
    if (!isWritable(org, this.now())) throw new AppError("SUBSCRIPTION_INACTIVE", "Subscription is not active. Account is read-only.", 403);
    const parsed = inviteInput.safeParse(raw);
    if (!parsed.success) {
      // "OWNER" is not an invitable role; surface a precise message
      if (raw.role === "OWNER") throw new AppError("OWNER_PROTECTED", "Ownership cannot be granted by invitation.", 403);
      throw new AppError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid input.");
    }
    const { email, role } = parsed.data;
    this.assertCanManage(ctx.role, role);
    const [members, invites] = await Promise.all([this.store.listMembers(ctx.orgId), this.store.listInvitations(ctx.orgId)]);
    if (members.some((m) => m.email.toLowerCase() === email)) throw new AppError("ALREADY_MEMBER", "This person is already on your team.", 409);
    const now = this.now();
    if (invites.some((i) => i.email === email && i.status === "pending" && new Date(i.expiresAt) > now)) {
      throw new AppError("ALREADY_INVITED", "An invitation is already pending for this email.", 409);
    }
    await this.assertSeat(ctx, org.plan);
    const token = randomBytes(32).toString("base64url");
    const invitation: Invitation = {
      id: hashToken(token), organizationId: ctx.orgId, email, role, invitedBy: ctx.userId,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(), status: "pending",
    };
    await this.store.putInvitation(invitation);
    return { invitation, token };
  }

  async revokeInvitation(ctx: Ctx, invitationId: string): Promise<void> {
    assertCan(ctx.role, "team:manage");
    const inv = await this.store.getInvitation(invitationId);
    if (!inv || inv.organizationId !== ctx.orgId) throw new AppError("INVITATION_NOT_FOUND", "Invitation not found.", 404);
    await this.store.putInvitation({ ...inv, status: "revoked" });
  }

  /** The invitee must be signed in with a verified email equal to the invited address. */
  async accept(user: AuthUser, token: string): Promise<{ organizationId: string; role: Role }> {
    const inv = await this.store.getInvitation(hashToken(token));
    const bad = () => new AppError("INVITATION_INVALID", "This invitation is invalid or has expired.", 400);
    if (!inv || inv.status !== "pending" || new Date(inv.expiresAt) <= this.now()) throw bad();
    if (!user.emailVerified) throw new AppError("EMAIL_NOT_VERIFIED", "Verify your email to accept this invitation.", 403);
    if (user.email.toLowerCase() !== inv.email) throw new AppError("INVITATION_EMAIL_MISMATCH", "This invitation was sent to a different email address.", 403);
    if (await this.store.getMember(inv.organizationId, user.uid)) throw new AppError("ALREADY_MEMBER", "You are already a member.", 409);
    const org = await this.store.getOrg(inv.organizationId);
    if (!org) throw bad();
    // The pending invite itself holds a seat, so only members count here.
    const limit = getPlan(org.plan).userLimit;
    if (limit !== null && (await this.store.listMembers(org.id)).length >= limit) {
      throw new AppError("USER_LIMIT_REACHED", "This team has reached its member limit.", 402);
    }
    const ts = this.now().toISOString();
    const member: Member = { uid: user.uid, email: user.email, name: user.name, role: inv.role, addedAt: ts, lastActiveAt: ts };
    await this.store.putUser({ uid: user.uid, email: user.email, name: user.name, createdAt: ts });
    await this.store.putMember(org.id, member);
    await this.store.putInvitation({ ...inv, status: "accepted" });
    await this.store.addAudit({ id: randomUUID(), organizationId: org.id, userId: user.uid, action: "TEAM_MEMBER_ADDED", target: user.uid, at: ts, metadata: { role: inv.role } });
    return { organizationId: org.id, role: inv.role };
  }

  async changeRole(ctx: Ctx, targetUid: string, newRole: string): Promise<void> {
    assertCan(ctx.role, "team:manage");
    const parsed = z.enum(["ADMIN", "ACCOUNTANT", "VIEWER"]).safeParse(newRole);
    if (!parsed.success) {
      if (newRole === "OWNER") throw new AppError("OWNER_PROTECTED", "Use ownership transfer to assign a new owner.", 403);
      throw new AppError("VALIDATION_ERROR", "Invalid role.");
    }
    if (targetUid === ctx.userId) throw new AppError("FORBIDDEN", "You cannot change your own role.", 403);
    const target = await this.store.getMember(ctx.orgId, targetUid);
    if (!target) throw new AppError("MEMBER_NOT_FOUND", "Member not found.", 404);
    this.assertCanManage(ctx.role, target.role);
    this.assertCanManage(ctx.role, parsed.data); // ADMIN cannot promote to ADMIN
    await this.store.putMember(ctx.orgId, { ...target, role: parsed.data });
    await this.audit(ctx, "ROLE_CHANGED", targetUid, { from: target.role, to: parsed.data });
  }

  async remove(ctx: Ctx, targetUid: string): Promise<void> {
    const target = await this.store.getMember(ctx.orgId, targetUid);
    if (!target) throw new AppError("MEMBER_NOT_FOUND", "Member not found.", 404);
    if (targetUid !== ctx.userId) { // anyone may leave; removing others needs team:manage
      assertCan(ctx.role, "team:manage");
      this.assertCanManage(ctx.role, target.role);
    } else if (target.role === "OWNER") {
      throw new AppError("OWNER_PROTECTED", "Transfer ownership before leaving.", 403);
    }
    await this.store.removeMember(ctx.orgId, targetUid);
    await this.audit(ctx, "TEAM_MEMBER_REMOVED", targetUid);
  }

  /** Owner-only. Target becomes OWNER, previous owner becomes ADMIN. Exactly one owner at all times. */
  async transferOwnership(ctx: Ctx, targetUid: string): Promise<void> {
    // Re-read the actor from the store: this operation must not depend on a possibly stale ctx.
    const [target, me] = await Promise.all([this.store.getMember(ctx.orgId, targetUid), this.store.getMember(ctx.orgId, ctx.userId)]);
    if (me?.role !== "OWNER") throw new AppError("FORBIDDEN", "Only the owner can transfer ownership.", 403);
    if (targetUid === ctx.userId) throw new AppError("VALIDATION_ERROR", "You are already the owner.");
    if (!target) throw new AppError("MEMBER_NOT_FOUND", "Member not found.", 404);
    await this.store.putMember(ctx.orgId, { ...target, role: "OWNER" });
    await this.store.putMember(ctx.orgId, { ...me, role: "ADMIN" });
    await this.store.updateOrg(ctx.orgId, { ownerId: targetUid });
    await this.audit(ctx, "ROLE_CHANGED", targetUid, { from: target.role, to: "OWNER", transfer: "true" });
  }
}
