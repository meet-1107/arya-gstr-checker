import { tenant } from "@/server/api";
import { container } from "@/server/container";

export const GET = tenant<{ gstin: string }>(async ({ ctx, params }) => container().gstins.detail(ctx, params.gstin));
