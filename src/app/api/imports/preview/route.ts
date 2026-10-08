import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";
import { MAX_IMPORT_BODY_BYTES } from "@/services/imports";

/** Validates and previews a CSV. Stores nothing, consumes nothing. */
export const POST = tenant(async ({ req, ctx }) => ({ preview: await container().imports.preview(ctx, await readJson(req, MAX_IMPORT_BODY_BYTES)) }));
