import { authed, ok, readJson } from "@/server/api";
import { container } from "@/server/container";
import type { PlanId } from "@/config/plans";

export const GET = authed(async ({ user }) => ({ organizations: await container().orgs.listForUser(user.uid) }));

export const POST = authed(async ({ req, user }) => {
  const body = await readJson(req);
  const org = await container().orgs.create(user, { name: String(body.name ?? ""), plan: body.plan as PlanId | undefined });
  return ok({ organization: { id: org.id, name: org.name, role: "OWNER", plan: org.plan, status: org.subscriptionStatus, trialEndsAt: org.trialEndsAt } }, 201);
});
