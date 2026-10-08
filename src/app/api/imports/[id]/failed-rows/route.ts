import { toErrorBody } from "@/lib/errors";
import { resolveCtx } from "@/lib/errors";
import { ORG_HEADER } from "@/server/api";
import { container } from "@/server/container";

/** CSV download of rows that were not imported (formula-injection-safe). Not a JSON envelope on success. */
export async function GET(req: Request, extra: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const c = container();
    const user = await c.auth.verify(req.headers.get("authorization"));
    const ctx = await resolveCtx(c.store, user.uid, req.headers.get(ORG_HEADER));
    const { id } = await extra.params;
    const { csv, truncated } = await c.imports.failedRowsCsv(ctx, id);
    // UTF-8 BOM like every other CSV export, so Excel reads non-ASCII client names correctly.
    return new Response(`﻿${csv}`, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="import-${id.slice(0, 8)}-failed-rows.csv"`, "cache-control": "no-store", "x-content-type-options": "nosniff", ...(truncated ? { "x-failed-rows-truncated": "true" } : {}) } });
  } catch (e) {
    const { status, body } = toErrorBody(e);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
}
