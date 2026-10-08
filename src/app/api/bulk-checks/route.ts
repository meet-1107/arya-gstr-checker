import { ok, query, readJson, tenant } from "@/server/api";
import { container } from "@/server/container";
import { publicJob } from "@/services/bulk";

export const GET = tenant(async ({ req, ctx }) => {
  const limit = Number(query(req).limit);
  return { jobs: await container().bulk.list(ctx, Number.isFinite(limit) ? limit : undefined) };
});

/**
 * Starts a bulk GST check. Send `Idempotency-Key` to make retries safe; without it an identical request
 * while a matching job is still active returns that job instead of starting duplicate work.
 * 202 = started, 200 = replay of an existing job.
 */
export const POST = tenant(async ({ req, ctx }) => {
  const { job, replay } = await container().bulk.create(ctx, await readJson(req), req.headers.get("idempotency-key"));
  return ok({ job: publicJob(job, container().limits), replay }, replay ? 200 : 202);
});
