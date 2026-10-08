import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

/** `{ids[] | all:true, read?: boolean}` — mark alerts read (default) or unread. The inbox is shared by the whole organization. */
export const POST = tenant(async ({ req, ctx }) => container().alerts.markRead(ctx, await readJson(req)));
