import { tenant } from "@/server/api";
import { container } from "@/server/container";

/** Crash recovery: restarts the worker from the next unprocessed chunk (needed until a durable queue exists). */
export const POST = tenant<{ id: string }>(async ({ ctx, params }) => ({ import: await container().imports.resume(ctx, params.id) }));
