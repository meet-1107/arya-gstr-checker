import { tenant } from "@/server/api";
import { container } from "@/server/container";

/** Subscription of the ACTIVE ORGANIZATION (never of the user). Readable by every member. */
export const GET = tenant(async ({ ctx }) => ({ subscription: await container().subs.overview(ctx), role: ctx.role }));
