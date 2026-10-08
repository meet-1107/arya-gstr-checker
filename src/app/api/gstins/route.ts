import { query, tenant } from "@/server/api";
import { container } from "@/server/container";

/** ?q&status&indicator&assignedTo&checked&needsRefresh&gstr1&gstr3b&late&sort&dir&limit&cursor */
export const GET = tenant(async ({ req, ctx }) => container().gstins.list(ctx, query(req)));
