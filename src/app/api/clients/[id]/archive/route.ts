import { tenant } from "@/server/api";
import { container } from "@/server/container";

/** Stop billing/checking a client without deleting it. Idempotent. */
export const POST = tenant<{ id: string }>(async ({ ctx, params }) => ({ client: await container().clients.archive(ctx, params.id) }));
