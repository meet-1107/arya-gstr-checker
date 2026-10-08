import { authed, ORG_HEADER, ok, query } from "@/server/api";
import { container } from "@/server/container";
import { resolveCtx } from "@/lib/errors";

/**
 * `GET /api/reports/{clients|attention|changes|returns}` → JSON preview `{kind,title,description,generatedAt,columns,rows(first 100),total,truncated,notes}`.
 * Add `?format=csv` for the download (UTF-8 with BOM, formula-safe; `reports:generate`; audited). `returns` also takes returnType, fy, scope=all.
 */
export const GET = authed<{ kind: string }, Response>(async ({ req, user, params }) => {
  const c = container();
  const ctx = await resolveCtx(c.store, user.uid, req.headers.get(ORG_HEADER));
  const q = query(req);
  if (q.format === "csv") {
    const r = await c.reports.csv(ctx, params.kind, q);
    return new Response(`\uFEFF${r.csv}`, { status: 200, headers: {
      "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${r.filename}"`, "cache-control": "no-store", "x-content-type-options": "nosniff",
      "x-report-truncated": String(r.truncated), "x-report-rows": String(r.rows),
    } });
  }
  const r = await c.reports.build(ctx, params.kind, q);
  return ok({ ...r, rows: r.rows.slice(0, 100) });
});
