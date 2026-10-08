import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

/** `{gstins[], force?}` -> what a run would do. Consumes nothing; invalid lines are reported, never sent to the provider. */
export const POST = tenant(async ({ req, ctx }) => ({ preview: await container().bulk.estimateVerify(ctx, await readJson(req, 3_000_000)) }));
