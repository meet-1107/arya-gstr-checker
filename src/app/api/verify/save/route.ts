import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

/** Pin / unpin a previously verified GSTIN: `{gstin, saved}`. */
export const POST = tenant(async ({ req, ctx }) => {
  const body = await readJson(req);
  return container().verification.setSaved(ctx, body.gstin, body.saved);
});
