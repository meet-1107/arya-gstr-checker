import { query, tenant } from "@/server/api";
import { container } from "@/server/container";

/** `?limit=` (max 50) and `?saved=1` for the saved list only. */
export const GET = tenant(async ({ req, ctx }) => {
  const q = query(req);
  return { items: await container().verification.recent(ctx, Number(q.limit ?? 10), { saved: q.saved === "1", tag: q.tag || undefined }) };
});
