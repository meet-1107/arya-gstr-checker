import { authed, ORG_HEADER } from "@/server/api";
import { container } from "@/server/container";
import { resolveCtx } from "@/lib/errors";

export const GET = authed<Record<string, never>, Response>(async ({ req, user }) => {
  const c = container();
  const ctx = await resolveCtx(c.store, user.uid, req.headers.get(ORG_HEADER));
  const { csv } = await c.audit.exportCsv(ctx);
  return new Response(`\uFEFF${csv}`, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="audit-log.csv"', "cache-control": "no-store", "x-content-type-options": "nosniff" } });
});
