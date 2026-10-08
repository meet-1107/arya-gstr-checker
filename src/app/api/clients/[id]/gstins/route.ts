import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

type P = { id: string };

/** Every GSTIN of the client firm with its latest stored status. */
export const GET = tenant<P>(async ({ ctx, params }) => ({ gstins: await container().clients.listGstins(ctx, params.id) }));

/** Add another GSTIN (state registration) to the client firm: `{gstin}`. Same PAN, within the plan's GSTINs-per-client limit. */
export const POST = tenant<P>(async ({ req, ctx, params }) => {
  const body = await readJson(req);
  const client = await container().clients.addGstin(ctx, params.id, body.gstin);
  return new Response(JSON.stringify({ success: true, data: { client, gstins: await container().clients.listGstins(ctx, params.id) } }), { status: 201, headers: { "content-type": "application/json", "cache-control": "no-store" } });
});
