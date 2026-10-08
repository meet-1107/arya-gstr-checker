// Pure (React-free) client state machine for one GSTIN verification. Everything time- or network-related that the UI needs
// to avoid an endless spinner is decided here so it can be unit-tested without a browser.
import { validateGstin } from "@/lib/gstin";
import type { VerificationOutcome, VerificationView } from "@/lib/verification";

/** Time budget (ms since the request started). The UI never shows an unexplained wait past SLOW_MS. */
export const BUDGET = { connectingAt: 300, fetchingAt: 1_500, processingAt: 3_000, slowAt: 5_000,
  /** Server deadline is 20s; the client gives up slightly later so the server's own TIMEOUT answer normally wins. */
  giveUpAt: 25_000 } as const;

export type RunStage = "connecting" | "fetching" | "processing";

export interface Progress { stage: RunStage; slow: boolean; giveUp: boolean }

export function progressAt(elapsedMs: number): Progress {
  const stage: RunStage = elapsedMs < BUDGET.fetchingAt ? "connecting" : elapsedMs < BUDGET.processingAt ? "fetching" : "processing";
  return { stage, slow: elapsedMs >= BUDGET.slowAt, giveUp: elapsedMs >= BUDGET.giveUpAt };
}

export const STAGE_LABEL: Record<RunStage, string> = {
  connecting: "Connecting to the GST verification service",
  fetching: "Retrieving registration details",
  processing: "Confirming GST status",
};

// ---- network ---------------------------------------------------------------------------------------------

export type NetworkState = "online" | "weak" | "offline";

export interface NetworkInfo { onLine?: boolean; effectiveType?: string; rtt?: number; downlink?: number; saveData?: boolean }

/** "weak" is a hint only (the Network Information API is not available everywhere); it never blocks a request. */
export function classifyNetwork(n: NetworkInfo): NetworkState {
  if (n.onLine === false) return "offline";
  if (n.effectiveType === "slow-2g" || n.effectiveType === "2g") return "weak";
  if ((n.rtt ?? 0) >= 1_500 || (n.downlink !== undefined && n.downlink > 0 && n.downlink < 0.15)) return "weak";
  return "online";
}

// ---- state -----------------------------------------------------------------------------------------------

export type ClientFailure =
  | { kind: "offline" }
  | { kind: "network" }                       // fetch failed although the browser believed it was online
  | { kind: "give_up" }                       // the client-side ceiling was reached
  | { kind: "http"; status: number; code: string; message: string }; // auth / permission / quota / malformed

export type VerifyState =
  | { status: "idle" }
  | { status: "running"; gstin: string; force: boolean; startedAt: number; elapsedMs: number; slowDismissed: boolean }
  /** refresh: stale-while-refresh follow-up. running = silently revalidating a stale stored answer; updated = replaced by a live answer; failed = live refresh unavailable, the stored answer stays. */
  | { status: "done"; view: VerificationView; clientSide?: boolean; refresh?: "running" | "updated" | "failed" }
  | { status: "failed"; gstin: string; failure: ClientFailure };

export type VerifyAction =
  | { type: "START"; gstin: string; force: boolean; now: number }
  | { type: "TICK"; now: number }
  | { type: "KEEP_WAITING" }
  | { type: "RESULT"; view: VerificationView }
  | { type: "FAIL"; gstin: string; failure: ClientFailure }
  | { type: "REFRESH_START" }
  | { type: "REFRESH_OK"; view: VerificationView }
  | { type: "REFRESH_FAIL" }
  | { type: "RESET" };

export const initialVerifyState: VerifyState = { status: "idle" };

export function verifyReducer(s: VerifyState, a: VerifyAction): VerifyState {
  switch (a.type) {
    case "START": return { status: "running", gstin: a.gstin, force: a.force, startedAt: a.now, elapsedMs: 0, slowDismissed: false };
    case "TICK": return s.status === "running" ? { ...s, elapsedMs: Math.max(0, a.now - s.startedAt) } : s;
    case "KEEP_WAITING": return s.status === "running" ? { ...s, slowDismissed: true } : s;
    case "RESULT": return { status: "done", view: a.view };
    // Refresh transitions only apply to a settled result: a late response can never resurrect or overwrite a newer state.
    case "REFRESH_START": return s.status === "done" ? { ...s, refresh: "running" } : s;
    case "REFRESH_OK": return s.status === "done" && s.refresh === "running" ? { status: "done", view: a.view, refresh: "updated" } : s;
    case "REFRESH_FAIL": return s.status === "done" && s.refresh === "running" ? { ...s, refresh: "failed" } : s;
    case "FAIL": return { status: "failed", gstin: a.gstin, failure: a.failure };
    case "RESET": return initialVerifyState;
  }
}

/** Local result for text that fails validation: instant, no network, no quota. Same shape as the server's. */
export function localInvalidView(input: string): VerificationView | null {
  const v = validateGstin(input);
  if (v.valid) return null;
  return { requestId: "local", gstin: v.gstin.slice(0, 20), outcome: "INVALID_GSTIN", invalidReason: v.reason, formatValid: false, freshness: "none", retryable: false, durationMs: 0 };
}

/**
 * What a client-side failure means for the user. NONE of these says anything about the GSTIN: the format was valid
 * (that is checked before any request is made) and we simply could not get an answer.
 */
export function failureOutcome(f: ClientFailure): VerificationOutcome {
  switch (f.kind) {
    case "offline":
    case "network": return "NETWORK_ERROR";
    case "give_up": return "TIMEOUT";
    case "http": return "PROVIDER_ERROR";
  }
}

/** "Why did this happen?" checklist: what we know to be true / false at the point of failure. */
export function failureChecklist(f: ClientFailure, network: NetworkState): { label: string; ok: boolean }[] {
  const base = [{ label: "Your GSTIN format is valid", ok: true }];
  switch (f.kind) {
    case "offline": return [...base, { label: "Your internet connection is available", ok: false }];
    case "network": return [...base, { label: "Your internet connection is available", ok: network !== "offline" }, { label: "Our servers could be reached", ok: false }];
    case "give_up": return [...base, { label: "Your internet connection is available", ok: network !== "offline" }, { label: "The verification service answered in time", ok: false }];
    case "http": return [...base, { label: "The request was accepted", ok: false }];
  }
}
