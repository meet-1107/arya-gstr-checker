import { AppError } from "@/lib/errors";
import { authed } from "@/server/api";
import { container } from "@/server/container";

/**
 * Platform-wide provider spend, credit state and limits. There is no platform-admin role, so access is an explicit allow-list of user ids
 * (OPERATOR_UIDS). Everyone else gets the same 404 as a route that does not exist.
 */
export const GET = authed(async ({ user }) => {
  const c = container();
  if (!c.costPolicy.operatorUids.includes(user.uid)) throw new AppError("NOT_FOUND", "Not found.", 404);
  return { provider: await c.verification.guard.platformReport(), health: c.verification.providerHealth() };
});
