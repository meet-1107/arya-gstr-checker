import { tenant } from "@/server/api";
import { container } from "@/server/container";

export const GET = tenant<{ id: string }>(async ({ ctx, params }) => ({ import: await container().imports.get(ctx, params.id) }));
