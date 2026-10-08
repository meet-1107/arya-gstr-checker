import { timingSafeEqual } from "node:crypto";
import { container } from "@/server/container";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * Entry point for an external scheduler (Cloud Scheduler / cron) to run every organization's due scheduled verifications.
 * Disabled (404, indistinguishable from a missing route) unless CRON_SECRET is set; the caller must send `Authorization: Bearer <CRON_SECRET>`.
 * Each organization's run is isolated: a quota or plan problem in one never stops the others.
 */
export const POST = async (req: Request): Promise<Response> => {
  const secret = process.env.CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given), b = Buffer.from(secret ?? "");
  if (!secret || a.length !== b.length || !timingSafeEqual(a, b)) return json(404, { success: false, error: { code: "NOT_FOUND", message: "Not found." } });
  try { return json(200, { success: true, data: { results: await container().portfolio.runDueAll() } }); }
  catch { return json(500, { success: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong." } }); }
};
