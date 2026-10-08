import { AppError } from "@/lib/errors";
import { readJson, tenant } from "@/server/api";
import { container } from "@/server/container";

/** Runs one GST check for a client of the active organization. Quota is org-wide and enforced server-side. */
export const POST = tenant(async ({ req, ctx }) => {
  const body = await readJson(req);
  if (typeof body.clientId !== "string" || !body.clientId) throw new AppError("VALIDATION_ERROR", "clientId is required.");
  if (body.gstin !== undefined && typeof body.gstin !== "string") throw new AppError("VALIDATION_ERROR", "gstin must be a string.");
  const r = await container().checks.checkClient(ctx, body.clientId, { force: body.force === true, gstin: body.gstin as string | undefined }); // gstin: a specific GSTIN of a multi-GSTIN client (default: primary)
  return { gstin: r.record, cached: r.cached, returnsAvailable: r.returnsAvailable };
});
