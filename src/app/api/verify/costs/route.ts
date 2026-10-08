import { tenant } from "@/server/api";
import { container } from "@/server/container";

/** This organization's verification cost picture: searches → paid provider calls → stored/shared/de-duplicated answers. ADMIN/OWNER. */
export const GET = tenant(async ({ ctx }) => ({ costs: await container().verification.costs(ctx) }));
