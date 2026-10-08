import { query, tenant } from "@/server/api";
import { container } from "@/server/container";

/** GSTR-1 across the organization. ?fy&period&status&state&gstin&dueFrom&dueTo&filedFrom&filedTo&dir&limit&cursor */
export const GET = tenant(async ({ req, ctx }) => container().returns.forType(ctx, "GSTR1", query(req)));
