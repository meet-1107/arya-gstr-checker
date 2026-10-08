import { tenant } from "@/server/api";
import { container } from "@/server/container";

export const GET = tenant<{ gstin: string }>(async ({ ctx, params }) => container().gstins.status(ctx, params.gstin));
