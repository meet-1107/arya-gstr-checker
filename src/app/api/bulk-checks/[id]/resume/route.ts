import { tenant } from "@/server/api";
import { container } from "@/server/container";

/** Crash recovery for runners that died mid-job (needed until a durable queue such as Cloud Tasks is wired). */
export const POST = tenant<{ id: string }>(async ({ ctx, params }) => container().bulk.resume(ctx, params.id));
