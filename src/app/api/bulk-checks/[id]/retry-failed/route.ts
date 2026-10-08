import { tenant } from "@/server/api";
import { container } from "@/server/container";

export const POST = tenant<{ id: string }>(async ({ ctx, params }) => container().bulk.retryFailed(ctx, params.id));
