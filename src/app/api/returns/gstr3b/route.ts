import { query, tenant } from "@/server/api";
import { container } from "@/server/container";

/** GSTR-3B across the organization. Same filters as GSTR-1. */
export const GET = tenant(async ({ req, ctx }) => container().returns.forType(ctx, "GSTR3B", query(req)));
