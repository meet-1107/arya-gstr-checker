import { tenant } from "@/server/api";
import { container } from "@/server/container";

/** Clears the organization's whole verification history. Owners and admins only. */
export const DELETE = tenant(async ({ ctx }) => container().privacy.forgetAll(ctx));
