"use client";
import { getAuthClient } from "./auth-client";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

export const UNAUTHORIZED_EVENT = "ca:unauthorized";

export interface ApiOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Active organization id; sent as X-Organization-Id (a selector only — the server verifies membership). */
  org?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Calls the backend and unwraps the `{success,data}` / `{success:false,error}` envelope. */
export async function api<T>(path: string, o: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...o.headers };
  const token = await getAuthClient().getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (o.org) headers["x-organization-id"] = o.org;
  if (o.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(path, { method: o.method ?? "GET", headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: o.signal, cache: "no-store" });
  } catch {
    throw new ApiError("NETWORK_ERROR", "Can't reach the server. Check your connection and try again.", 0);
  }
  let json: { success?: boolean; data?: T; error?: { code: string; message: string } } | null = null;
  try { json = await res.json(); } catch { /* non-JSON error page */ }
  if (res.ok && json?.success) return json.data as T;
  if (res.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  throw new ApiError(json?.error?.code ?? "SERVER_ERROR", json?.error?.message ?? "Something went wrong. Please try again.", res.status);
}

/** Authenticated file download (the bearer token cannot be sent by a plain link). Returns the blob; the caller triggers the save. */
export async function apiDownload(path: string, o: { org?: string | null } = {}): Promise<{ blob: Blob; truncated: boolean }> {
  const headers: Record<string, string> = {};
  const token = await getAuthClient().getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (o.org) headers["x-organization-id"] = o.org;
  let res: Response;
  try { res = await fetch(path, { headers, cache: "no-store" }); } catch { throw new ApiError("NETWORK_ERROR", "Can't reach the server. Check your connection and try again.", 0); }
  if (!res.ok) {
    let j: { error?: { code: string; message: string } } | null = null;
    try { j = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError(j?.error?.code ?? "SERVER_ERROR", j?.error?.message ?? "Something went wrong. Please try again.", res.status);
  }
  return { blob: await res.blob(), truncated: res.headers.get("x-failed-rows-truncated") === "true" };
}

/** Saves a blob/text as a file in the browser. */
export function saveFile(data: Blob | string, filename: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(typeof data === "string" ? new Blob([data], { type }) : data);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Friendly message for UI. Never exposes anything beyond the server's already-safe message. */
export const errorMessage = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
