import { ok, readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

export const GET = tenant(async ({ ctx }) => container().team.list(ctx));

/**
 * Creates an invitation and returns the one-time token to the inviter (shown as a copyable link).
 * Email delivery is PENDING (no email provider selected yet).
 */
export const POST = tenant(async ({ req, ctx }) => {
  const body = await readJson(req);
  const { invitation, token } = await container().team.invite(ctx, { email: String(body.email ?? ""), role: String(body.role ?? "") });
  return ok({ invitation, token }, 201);
});
