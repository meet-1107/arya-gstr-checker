import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

/** Removes one stored verification answer (with its notes, tags and pin) from this organization's history. `{gstin}` */
export const POST = tenant(async ({ req, ctx }) => container().privacy.forget(ctx, (await readJson(req)).gstin));
