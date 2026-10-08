"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useSWRConfig } from "swr";
import { api, ApiError, UNAUTHORIZED_EVENT } from "@/lib/client/api";
import { getAuthClient, type ClientUser } from "@/lib/client/auth-client";
import type { MeData, OrgSummary } from "@/lib/client/types";
import { can, type Permission, type Role } from "@/lib/permissions";

export type SessionStatus = "loading" | "signedOut" | "needsOrg" | "ready" | "error";

interface SessionValue {
  status: SessionStatus;
  user: ClientUser | null;
  orgs: OrgSummary[];
  activeOrg: OrgSummary | null;
  activeOrgId: string | null;
  role: Role | null;
  authMode: "dev" | "firebase" | "unconfigured";
  error: string | null;
  can: (p: Permission) => boolean;
  switchOrg: (id: string) => void;
  /** Reload identity + organizations (e.g. after creating one). Optionally select an org afterwards. */
  refresh: (selectOrgId?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);
export const useSession = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession must be used inside <SessionProvider>");
  return v;
};

const STORE_KEY = "ca.activeOrg";
const STORE_EVENT = "ca:activeOrg";
const readStored = () => { try { return localStorage.getItem(STORE_KEY); } catch { return null; } };
const subscribeStored = (cb: () => void) => {
  window.addEventListener("storage", cb); window.addEventListener(STORE_EVENT, cb);
  return () => { window.removeEventListener("storage", cb); window.removeEventListener(STORE_EVENT, cb); };
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const auth = useMemo(() => getAuthClient(), []);
  const { mutate } = useSWRConfig();
  const [user, setUser] = useState<ClientUser | null | undefined>(undefined); // undefined = auth state not known yet
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);
  // Active organization id persisted in localStorage (SSR-safe: null on the server).
  const stored = useSyncExternalStore(subscribeStored, readStored, () => null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => auth.subscribe((u) => setUser(u)), [auth]);

  const load = useCallback(async () => {
    try {
      const me = await api<MeData>("/api/me");
      setOrgs(me.organizations);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // handled by the unauthorized listener
      setError(e instanceof ApiError ? e.message : "We couldn't load your account.");
    }
  }, []);

  // Load organizations whenever the signed-in identity changes.
  const uid = user?.uid;
  const verified = user?.emailVerified;
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    void (async () => { if (alive) await load(); })();
    return () => { alive = false; };
  }, [uid, verified, load]);

  const signOut = useCallback(async () => {
    await auth.signOut();
    setOrgs(null); setError(null);
    await mutate(() => true, undefined, { revalidate: false }); // drop every cached response
  }, [auth, mutate]);

  useEffect(() => {
    const h = () => { void signOut(); };
    window.addEventListener(UNAUTHORIZED_EVENT, h);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, h);
  }, [signOut]);

  const activeOrg = useMemo(() => orgs?.find((o) => o.id === stored) ?? orgs?.[0] ?? null, [orgs, stored]);

  const switchOrg = useCallback((id: string) => {
    try { localStorage.setItem(STORE_KEY, id); } catch { /* private mode */ }
    window.dispatchEvent(new Event(STORE_EVENT));
  }, []);

  const refresh = useCallback(async (selectOrgId?: string) => {
    if (selectOrgId) switchOrg(selectOrgId);
    await load();
  }, [load, switchOrg]);

  let status: SessionStatus;
  if (user === undefined) status = "loading";
  else if (user === null) status = "signedOut";
  else if (error && !orgs) status = "error";
  else if (orgs === null) status = "loading";
  else status = orgs.length === 0 ? "needsOrg" : "ready";

  const role = (activeOrg?.role as Role | undefined) ?? null;
  const value: SessionValue = {
    status, user: user ?? null, orgs: orgs ?? [], activeOrg, activeOrgId: activeOrg?.id ?? null, role,
    authMode: auth.mode, error, can: (p) => can(role, p), switchOrg, refresh, signOut,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
