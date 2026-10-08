import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

/** `{status, resolution?}` — review workflow for owners/admins. */
export const PATCH = tenant<{ id: string }>(async ({ req, ctx, params }) => ({ concern: await container().concerns.update(ctx, params.id, await readJson(req)) }));
