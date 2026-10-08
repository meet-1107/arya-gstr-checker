import { query, tenant } from "@/server/api";
import { container } from "@/server/container";

/** `?unread=1&group=status|returns|usage|jobs|system&limit=` (newest first) → `{items, unreadCount, hasMore}`. All roles. */
export const GET = tenant(async ({ req, ctx }) => {
  const q = query(req);
  return container().alerts.list(ctx, { unread: q.unread === "1", group: q.group || undefined, limit: Number(q.limit ?? 30) });
});
