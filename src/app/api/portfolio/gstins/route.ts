import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

/** `{scope: needs_refresh|attention|all|selected, clientIds?}` → the GSTINs a refresh would cover (feed them to /api/bulk-verify/preview). */
export const POST = tenant(async ({ req, ctx }) => {
  const b = await readJson(req, 1_000_000);
  return container().portfolio.gstins(ctx, { scope: b.scope, clientIds: b.clientIds });
});
