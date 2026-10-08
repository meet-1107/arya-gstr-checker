import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

export const POST = tenant(async ({ req, ctx }) => {
  const body = await readJson(req);
  await container().team.transferOwnership(ctx, String(body.uid ?? ""));
  return { transferred: true };
});
