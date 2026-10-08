import { tenant } from "@/server/api";
import { container } from "@/server/container";

/** Process-local verification metrics for the active organization (admins/owners). */
export const GET = tenant(async ({ ctx }) => ({ metrics: container().verification.health(ctx), provider: container().gate.stats(), providerHealth: container().verification.providerHealth() }));
