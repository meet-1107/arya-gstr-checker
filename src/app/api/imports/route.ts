import { ok, query, readJson, tenant } from "@/server/api";
import { container } from "@/server/container";
import { MAX_IMPORT_BODY_BYTES, publicImport } from "@/services/imports";

export const GET = tenant(async ({ req, ctx }) => {
  const limit = Number(query(req).limit);
  return { imports: await container().imports.list(ctx, Number.isFinite(limit) ? limit : undefined) };
});

/**
 * Starts a CSV import (validated again server-side). Send `Idempotency-Key` to make retries safe.
 * 202 = started (clients are created in the background), 200 = replay of an existing import.
 */
export const POST = tenant(async ({ req, ctx }) => {
  const { record, replay } = await container().imports.start(ctx, await readJson(req, MAX_IMPORT_BODY_BYTES), req.headers.get("idempotency-key"));
  return ok({ import: publicImport(record), replay }, replay ? 200 : 202);
});
