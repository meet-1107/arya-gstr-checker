import { AppError } from "@/lib/errors";
import { isVerifyMode } from "@/lib/verification";
import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

/**
 * Quick-verify one GSTIN. Every registry answer AND every classified failure (timeout, maintenance, not found, invalid format...)
 * is returned as a 200 with a typed `outcome`; only auth, permission, quota and malformed-request problems use HTTP errors.
 * `mode`: "auto" (default: follow the freshness policy, stale-while-refresh), "refresh" (silent revalidation of a stale answer; never errors on quota),
 * "live" (explicit live check). `force: true` is the legacy spelling of "live".
 */
export const POST = tenant(async ({ req, ctx }) => {
  const body = await readJson(req);
  if (body.mode !== undefined && !isVerifyMode(body.mode)) throw new AppError("VALIDATION_ERROR", "mode must be auto, refresh or live.");
  const mode = body.mode ?? (body.force === true ? "live" : "auto");
  return { verification: await container().verification.verify(ctx, body.gstin, { mode }) };
});
