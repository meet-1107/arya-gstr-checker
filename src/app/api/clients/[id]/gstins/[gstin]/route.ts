import { tenant } from "@/server/api";
import { container } from "@/server/container";

/** Remove an additional GSTIN (the primary cannot be removed; delete the client instead). */
export const DELETE = tenant<{ id: string; gstin: string }>(async ({ ctx, params }) => {
  const client = await container().clients.removeGstin(ctx, params.id, decodeURIComponent(params.gstin));
  return { client, gstins: await container().clients.listGstins(ctx, params.id) };
});
