import { authed } from "@/server/api";
import { container } from "@/server/container";

/** Identity + the organizations this user can switch between. */
export const GET = authed(async ({ user }) => {
  const c = container();
  const organizations = await c.orgs.listForUser(user.uid);
  return {
    user: { uid: user.uid, email: user.email, name: user.name, emailVerified: user.emailVerified },
    organizations,
  };
});
