import { authed } from "@/server/api";
import { container } from "@/server/container";
import { resolveCtx } from "@/lib/errors";
import { ORG_HEADER } from "@/server/api";

/** CSV download of a GSTIN verification run (formula-safe). */
export const GET = authed<{ id: string }, Response>(async ({ req, user, params }) => {
  const c = container();
  const ctx = await resolveCtx(c.store, user.uid, req.headers.get(ORG_HEADER));
  const r = await c.bulk.exportVerify(ctx, params.id);
  return new Response(`\uFEFF${r.csv}`, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="gstin-verification-${params.id.slice(0, 8)}.csv"`,
      "cache-control": "no-store", "x-content-type-options": "nosniff", ...(r.truncated ? { "x-failed-rows-truncated": "true" } : {}),
    },
  });
});
