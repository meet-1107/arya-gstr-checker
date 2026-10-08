import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

/** Confirmation-modal data: how many checks will be consumed and how long it will take. Consumes nothing. */
export const POST = tenant(async ({ req, ctx }) => ({ estimate: await container().bulk.estimate(ctx, await readJson(req)) }));
