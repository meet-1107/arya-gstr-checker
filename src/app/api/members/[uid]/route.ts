import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

type P = { uid: string };

export const PATCH = tenant<P>(async ({ req, ctx, params }) => {
  const body = await readJson(req);
  await container().team.changeRole(ctx, params.uid, String(body.role ?? ""));
  return { updated: true };
});

export const DELETE = tenant<P>(async ({ ctx, params }) => {
  await container().team.remove(ctx, params.uid);
  return { removed: true };
});
