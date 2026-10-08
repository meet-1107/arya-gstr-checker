import { tenant } from "@/server/api";
import { container } from "@/server/container";

/** Reactivate an archived client (counts toward billing again; subject to the plan cap). Idempotent. */
export const POST = tenant<{ id: string }>(async ({ ctx, params }) => ({ client: await container().clients.restore(ctx, params.id) }));
