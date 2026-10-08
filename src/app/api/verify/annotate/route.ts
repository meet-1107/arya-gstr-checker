import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

/** `{gstin, note?, tags?}` on a previously verified GSTIN. Omitted fields are unchanged; "" / [] clear. */
export const POST = tenant(async ({ req, ctx }) => {
  const body = await readJson(req);
  return container().verification.annotate(ctx, body.gstin, { note: body.note, tags: body.tags });
});
