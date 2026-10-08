import { ok, query, readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

/** Internal, organization-only concerns about a GSTIN (see CONCERN_DISCLAIMER). Nothing is sent outside the organization. */
export const GET = tenant(async ({ req, ctx }) => ({ items: await container().concerns.list(ctx, query(req)) }));

/** 201 new, 200 when an identical open concern from the same person in the last 24 h already exists (double-click / retry safe). */
export const POST = tenant(async ({ req, ctx }) => {
  const r = await container().concerns.create(ctx, await readJson(req));
  return ok({ concern: r.concern, duplicate: r.duplicate }, r.duplicate ? 200 : 201);
});
