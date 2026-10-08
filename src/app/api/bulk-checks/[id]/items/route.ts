import { query, tenant } from "@/server/api";
import { container } from "@/server/container";

/** ?status&limit&cursor — per-GSTIN results; error codes only, never raw provider text. */
export const GET = tenant<{ id: string }>(async ({ req, ctx, params }) => {
  const q = query(req);
  return container().bulk.items(ctx, params.id, { status: q.status, limit: q.limit ? Number(q.limit) : undefined, cursor: q.cursor });
});
