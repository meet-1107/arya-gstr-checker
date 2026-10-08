"use client";
import { useCallback, useEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { normalizeGstin } from "@/lib/gstin";
import { isFailure, isVerificationView, type VerificationView } from "@/lib/verification";
import { ApiError } from "./api";
import { useApiCall, useInvalidate } from "./hooks";
import { BUDGET, classifyNetwork, initialVerifyState, localInvalidView, verifyReducer, type NetworkState } from "./verify-machine";

type Conn = { effectiveType?: string; rtt?: number; downlink?: number; saveData?: boolean; addEventListener?: (t: string, cb: () => void) => void; removeEventListener?: (t: string, cb: () => void) => void };
const conn = (): Conn | undefined => (typeof navigator === "undefined" ? undefined : (navigator as unknown as { connection?: Conn }).connection);

const subscribe = (cb: () => void) => {
  window.addEventListener("online", cb); window.addEventListener("offline", cb);
  conn()?.addEventListener?.("change", cb);
  return () => { window.removeEventListener("online", cb); window.removeEventListener("offline", cb); conn()?.removeEventListener?.("change", cb); };
};
const snapshot = (): NetworkState => { const c = conn(); return classifyNetwork({ onLine: navigator.onLine, effectiveType: c?.effectiveType, rtt: c?.rtt, downlink: c?.downlink }); };

/** online | weak | offline. "weak" is advisory only (Network Information API support varies); it never blocks a request. */
export function useNetworkState(): NetworkState {
  return useSyncExternalStore(subscribe, snapshot, () => "online" as NetworkState);
}

/**
 * One GSTIN verification at a time. Guarantees (see verify-machine.ts for the pure parts):
 *  - invalid format is answered locally and instantly (no request, no quota)
 *  - offline is detected before any request is made
 *  - the wait is never unbounded: slow state after 5s, hard stop at 25s
 *  - a stale response from a superseded request is ignored
 */
export function useGstinVerification() {
  const call = useApiCall();
  const invalidate = useInvalidate();
  const [state, dispatch] = useReducer(verifyReducer, initialVerifyState);
  const network = useNetworkState();
  const ctl = useRef<{ abort: AbortController; seq: number; timer?: ReturnType<typeof setInterval>; ours: boolean; key: string } | null>(null);
  const seq = useRef(0);
  const refreshCtl = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    const c = ctl.current;
    if (c) { c.ours = true; clearInterval(c.timer); c.abort.abort(); ctl.current = null; }
    refreshCtl.current?.abort(); refreshCtl.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const refresh = useCallback(async (gstin: string, mine: number) => {
    const abort = new AbortController(); refreshCtl.current = abort;
    dispatch({ type: "REFRESH_START" });
    const giveUp = setTimeout(() => abort.abort(), BUDGET.giveUpAt);
    try {
      const r = await call<{ verification: VerificationView }>("/api/verify", { method: "POST", body: { gstin, mode: "refresh" }, signal: abort.signal });
      if (seq.current !== mine || abort.signal.aborted) return;
      const v = r?.verification;
      if (!isVerificationView(v)) { dispatch({ type: "REFRESH_FAIL" }); return; }
      // Only a live registry answer replaces the stored one. A skipped refresh (provider unwell, quota) or any failure keeps it.
      if (v.freshness === "live" && !isFailure(v.outcome) && v.outcome !== "INVALID_GSTIN") { dispatch({ type: "REFRESH_OK", view: v }); void invalidate("/api/verify/recent", "/api/subscription", "/api/dashboard", "/api/usage"); }
      else dispatch({ type: "REFRESH_FAIL" });
    } catch { if (seq.current === mine && !abort.signal.aborted) dispatch({ type: "REFRESH_FAIL" }); }
    finally { clearTimeout(giveUp); if (refreshCtl.current === abort) refreshCtl.current = null; }
  }, [call, invalidate]);

  const start = useCallback(async (input: string, o: { force?: boolean } = {}) => {
    // A double-click / double-Enter on the SAME request while it is already running is ignored (no abort-and-resend churn, no extra server call).
    // A different GSTIN, or force vs not, still replaces the running one.
    const key = `${normalizeGstin(input)}|${o.force ? "live" : "auto"}`;
    if (ctl.current && !ctl.current.ours && ctl.current.key === key) return;
    stop();
    const bad = localInvalidView(input);
    if (bad) { dispatch({ type: "RESULT", view: bad }); return; }
    const gstin = normalizeGstin(input);
    if (typeof navigator !== "undefined" && navigator.onLine === false) { dispatch({ type: "FAIL", gstin, failure: { kind: "offline" } }); return; }

    const mine = ++seq.current;
    const abort = new AbortController();
    const c = { abort, seq: mine, ours: false, key, timer: undefined as ReturnType<typeof setInterval> | undefined };
    ctl.current = c;
    dispatch({ type: "START", gstin, force: !!o.force, now: Date.now() });
    const t0 = Date.now();
    c.timer = setInterval(() => {
      const now = Date.now();
      dispatch({ type: "TICK", now });
      if (now - t0 >= BUDGET.giveUpAt && ctl.current === c) { stop(); dispatch({ type: "FAIL", gstin, failure: { kind: "give_up" } }); }
    }, 250);

    try {
      const r = await call<{ verification: VerificationView }>("/api/verify", { method: "POST", body: { gstin, mode: o.force ? "live" : "auto" }, signal: abort.signal });
      if (c.ours || seq.current !== mine) return;
      clearInterval(c.timer); ctl.current = null;
      if (!isVerificationView(r?.verification)) { dispatch({ type: "FAIL", gstin, failure: { kind: "http", status: 502, code: "BAD_RESPONSE", message: "The server sent an answer we couldn't read. Please try again." } }); return; }
      dispatch({ type: "RESULT", view: r.verification });
      void invalidate("/api/verify/recent", "/api/subscription", "/api/dashboard", "/api/usage");
      // Stale-while-refresh: the stored answer is already on screen; quietly ask for a live one. Failure here never replaces what the user is looking at.
      if (r.verification.refreshRecommended && typeof navigator !== "undefined" && navigator.onLine !== false) void refresh(gstin, mine);
    } catch (e) {
      if (c.ours || seq.current !== mine) return; // cancelled / superseded / given up: someone else already set the state
      clearInterval(c.timer); ctl.current = null;
      if (e instanceof ApiError && e.status === 0) dispatch({ type: "FAIL", gstin, failure: navigator.onLine === false ? { kind: "offline" } : { kind: "network" } });
      else if (e instanceof ApiError) dispatch({ type: "FAIL", gstin, failure: { kind: "http", status: e.status, code: e.code, message: e.message } });
      else dispatch({ type: "FAIL", gstin, failure: { kind: "network" } });
    }
  }, [call, invalidate, stop, refresh]);

  const cancel = useCallback(() => { stop(); dispatch({ type: "RESET" }); }, [stop]);
  const keepWaiting = useCallback(() => dispatch({ type: "KEEP_WAITING" }), []);
  return { state, network, start, cancel, keepWaiting };
}
