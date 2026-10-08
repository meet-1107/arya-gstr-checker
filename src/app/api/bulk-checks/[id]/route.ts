import { tenant } from "@/server/api";
import { container } from "@/server/container";

export const GET = tenant<{ id: string }>(async ({ ctx, params }) => ({ job: await container().bulk.get(ctx, params.id) }));
