import { tenant } from "@/server/api";
import { container } from "@/server/container";

export const DELETE = tenant<{ id: string }>(async ({ ctx, params }) => {
  await container().team.revokeInvitation(ctx, params.id);
  return { revoked: true };
});
