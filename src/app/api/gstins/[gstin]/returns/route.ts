import { query, tenant } from "@/server/api";
import { container } from "@/server/container";

/** ?returnType&fy&period&status&state&dueFrom&dueTo&filedFrom&filedTo&dir&limit&cursor */
export const GET = tenant<{ gstin: string }>(async ({ req, ctx, params }) => container().returns.forGstin(ctx, params.gstin, query(req)));
