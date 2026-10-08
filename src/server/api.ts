// SERVER ONLY. Route wrappers implementing the request security chain:
//   authenticate (Firebase ID token) → uid → active organization → membership → role (in service) →
//   subscription/feature/quota (in service) → execute.
// organizationId / role / plan are NEVER read from the body or query; only X-Organization-Id is read,
// and only as a selector that is verified against the user's memberships.
import { AppError, resolveCtx, toErrorBody, type Ctx } from "@/lib/errors";
import type { AuthUser } from "@/lib/auth";
import { container } from "./container";

export const ORG_HEADER = "x-organization-id";
const MAX_BODY_BYTES = 1_000_000;

export interface RouteArgs<P> { req: Request; user: AuthUser; params: P }
export interface TenantArgs<P> extends RouteArgs<P> { ctx: Ctx }

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const ok = (data: unknown, status = 200) => json(status, { success: true, data });

/** Query string as a flat record (first value wins). Values are validated by the services. */
export function query(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(req.url).searchParams) if (!(k in out)) out[k] = v;
  return out;
}

export async function readJson(req: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new AppError("PAYLOAD_TOO_LARGE", "Request body is too large.", 413);
  let text: string;
  try { text = await req.text(); } catch { throw new AppError("VALIDATION_ERROR", "Request body could not be read.", 400); }
  if (text.length > maxBytes) throw new AppError("PAYLOAD_TOO_LARGE", "Request body is too large.", 413); // also covers chunked bodies without Content-Length
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object.", 400);
  }
}

function fail(e: unknown): Response {
  const { status, body } = toErrorBody(e);
  if (status >= 500) console.error("[api] unhandled error", e instanceof Error ? e.name : typeof e); // never log bodies/secrets
  return json(status, body);
}

type Handler<A, R> = (a: A) => Promise<R>;
type Params<P> = { params: Promise<P> };

/** Authenticated, but not tied to an organization (profile, create org, accept invitation). */
export function authed<P = Record<string, never>, R = unknown>(h: Handler<RouteArgs<P>, R | Response>) {
  return async (req: Request, extra?: Params<P>): Promise<Response> => {
    try {
      const user = await container().auth.verify(req.headers.get("authorization"));
      const params = (await extra?.params) as P;
      const r = await h({ req, user, params });
      return r instanceof Response ? r : ok(r);
    } catch (e) { return fail(e); }
  };
}

/** Authenticated + active organization resolved and membership verified server-side. */
export function tenant<P = Record<string, never>, R = unknown>(h: Handler<TenantArgs<P>, R | Response>) {
  return async (req: Request, extra?: Params<P>): Promise<Response> => {
    try {
      const c = container();
      const user = await c.auth.verify(req.headers.get("authorization"));
      const ctx = await resolveCtx(c.store, user.uid, req.headers.get(ORG_HEADER));
      const params = (await extra?.params) as P;
      const r = await h({ req, user, ctx, params });
      return r instanceof Response ? r : ok(r);
    } catch (e) { return fail(e); }
  };
}
