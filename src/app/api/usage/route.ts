import { tenant } from "@/server/api";
import { container } from "@/server/container";

/** Organization-wide GST check usage (shared by all members). */
export const GET = tenant(async ({ ctx }) => {
  const o = await container().subs.overview(ctx);
  return { usage: o.usage, seats: o.seats, clients: o.clients, plan: o.plan.id, status: o.status };
});
