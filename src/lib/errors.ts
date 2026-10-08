import { ForbiddenError } from "./permissions";
import { ProviderError } from "@/providers/types";
import { UsageError } from "./usage";

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export interface ErrorBody { success: false; error: { code: string; message: string } }

/** Maps any thrown value to a safe, structured error. Never leaks stack traces or internals. */
export function toErrorBody(e: unknown): { status: number; body: ErrorBody } {
  const mk = (status: number, code: string, message: string) => ({ status, body: { success: false as const, error: { code, message } } });
  if (e instanceof AppError) return mk(e.status, e.code, e.message);
  if (e instanceof ForbiddenError) return mk(403, "FORBIDDEN", "You do not have permission to perform this action.");
  if (e instanceof UsageError) return mk(e.code === "QUOTA_EXHAUSTED" ? 402 : 403, e.code, e.message);
  if (e instanceof ProviderError) return mk(e.code === "GST_PROVIDER_RATE_LIMITED" ? 429 : e.code === "GST_PROVIDER_NOT_FOUND" ? 404 : 502, e.code, e.message);
  return mk(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
}

export interface Ctx { orgId: string; userId: string; role: import("./permissions").Role }

/**
 * Derive tenant + role from the authenticated uid. The requested org id (from the X-Organization-Id
 * header / session) is only a *selector*: membership is always verified server-side and role is read
 * from the membership record, never from the request.
 */
export async function resolveCtx(
  store: Pick<import("./store/types").Store, "listMemberships">, uid: string | undefined, requestedOrgId?: string | null,
): Promise<Ctx> {
  if (!uid) throw new AppError("UNAUTHENTICATED", "Please sign in.", 401);
  const all = await store.listMemberships(uid);
  if (all.length === 0) throw new AppError("NO_ORGANIZATION", "You do not belong to an organization.", 403);
  if (requestedOrgId) {
    const hit = all.find((m) => m.organization.id === requestedOrgId);
    // Same error whether the org does not exist or the user is not a member: no existence oracle.
    if (!hit) throw new AppError("NOT_A_MEMBER", "You do not have access to this organization.", 403);
    return { orgId: hit.organization.id, userId: uid, role: hit.member.role };
  }
  if (all.length > 1) throw new AppError("ORG_REQUIRED", "Select an organization to continue.", 400);
  return { orgId: all[0].organization.id, userId: uid, role: all[0].member.role };
}
