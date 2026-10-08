import { ok, readJson, tenant } from "@/server/api";
import { container } from "@/server/container";
import type { ClientInput } from "@/services/clients";

export const GET = tenant(async ({ req, ctx }) => {
  const u = new URL(req.url);
  const limit = Number(u.searchParams.get("limit") ?? 25);
  return container().clients.list(ctx, {
    limit: Number.isFinite(limit) ? limit : 25,
    cursor: u.searchParams.get("cursor") ?? undefined,
    search: u.searchParams.get("q") ?? undefined,
    status: u.searchParams.get("status") ?? undefined, // active (default) | archived | all
  });
});

export const POST = tenant(async ({ req, ctx }) => {
  const client = await container().clients.create(ctx, (await readJson(req)) as ClientInput);
  return ok({ client }, 201);
});
