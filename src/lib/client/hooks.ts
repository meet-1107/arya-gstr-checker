"use client";
import { useCallback } from "react";
import useSWR, { useSWRConfig, type SWRConfiguration } from "swr";
import { useSession } from "@/components/session";
import { api, type ApiError, type ApiOptions } from "./api";

/**
 * GET with caching, keyed by (path, activeOrgId) so switching organization can never show another
 * organization's cached data. Pass `null` to skip fetching.
 */
export function useApi<T>(path: string | null, config?: SWRConfiguration<T, ApiError>) {
  const { activeOrgId } = useSession();
  return useSWR<T, ApiError>(
    path && activeOrgId ? [path, activeOrgId] : null,
    ([p, org]: [string, string]) => api<T>(p, { org }),
    config,
  );
}

/** Imperative calls bound to the active organization (mutations, one-off reads). */
export function useApiCall() {
  const { activeOrgId } = useSession();
  return useCallback(<T,>(path: string, o: Omit<ApiOptions, "org"> = {}) => api<T>(path, { ...o, org: activeOrgId }), [activeOrgId]);
}

/** Revalidate every cached response whose path starts with one of the prefixes. */
export function useInvalidate() {
  const { mutate } = useSWRConfig();
  return useCallback((...prefixes: string[]) => mutate((k) => Array.isArray(k) && typeof k[0] === "string" && prefixes.some((p) => (k[0] as string).startsWith(p))), [mutate]);
}

export const toQuery = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
