import { ok, tenant } from "@/server/api";
import { container } from "@/server/container";

/** Runs this organization's due scheduled verifications now, as one background job (202 when a job started). */
export const POST = tenant(async ({ ctx }) => {
  const r = await container().portfolio.runDue(ctx);
  return ok(r, r.started && !r.replay ? 202 : 200);
});
