import { ok, readJson, tenant } from "@/server/api";
import { container } from "@/server/container";
import { publicJob } from "@/services/bulk";

/** Starts a bulk GSTIN verification (no client records). `Idempotency-Key` makes retries safe. 202 = started, 200 = replay. */
export const POST = tenant(async ({ req, ctx }) => {
  const { job, replay, rejected } = await container().bulk.createVerify(ctx, await readJson(req, 3_000_000), req.headers.get("idempotency-key"));
  return ok({ job: publicJob(job, container().limits), replay, rejected }, replay ? 200 : 202);
});
