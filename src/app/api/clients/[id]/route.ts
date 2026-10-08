import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";
import type { ClientInput } from "@/services/clients";

type P = { id: string };

export const GET = tenant<P>(async ({ ctx, params }) => ({ client: await container().clients.get(ctx, params.id) }));

export const PATCH = tenant<P>(async ({ req, ctx, params }) => {
  await container().clients.update(ctx, params.id, (await readJson(req)) as Partial<ClientInput>);
  return { client: await container().clients.get(ctx, params.id) };
});

export const DELETE = tenant<P>(async ({ ctx, params }) => {
  await container().clients.remove(ctx, params.id);
  return { deleted: true };
});
