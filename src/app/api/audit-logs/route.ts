import { query, tenant } from "@/server/api";
import { container } from "@/server/container";

/** Newest first. `?action=` and `?limit=` (max 500). Owners and admins only. */
export const GET = tenant(async ({ req, ctx }) => ({ items: await container().audit.list(ctx, query(req)) }));
