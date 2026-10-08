import { tenant } from "@/server/api";
import { container } from "@/server/container";

/** Aggregated from stored data only (indexed counts). Never calls the GST provider. */
export const GET = tenant(async ({ ctx }) => ({ dashboard: await container().dashboard.get(ctx) }));
