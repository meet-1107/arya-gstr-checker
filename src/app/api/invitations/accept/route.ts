import { authed, readJson } from "@/server/api";
import { container } from "@/server/container";

/** The signed-in user (verified email must match the invite) redeems an invitation token. */
export const POST = authed(async ({ req, user }) => {
  const body = await readJson(req);
  return container().team.accept(user, String(body.token ?? ""));
});
