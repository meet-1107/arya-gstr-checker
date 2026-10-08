// Shared (server + client) model for GSTIN verification: outcomes, failure classification, user-facing explanations.
// The core rule: a failure of OUR pipeline or the provider must never be presented as a statement about the GSTIN.
import { ProviderError, type GstinResult, type GstinStatus } from "@/providers/types";
import type { GstinValidation } from "./gstin";
import type { ChangeInfo } from "./change-detection";
import type { HealthState } from "./provider-health";

export type VerificationOutcome =
  // Registry answers (the provider responded with a definite answer about this GSTIN)
  | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "INACTIVE" | "NOT_FOUND" | "UNKNOWN"
  // Local validation
  | "INVALID_GSTIN"
  // Pipeline / provider failures — say NOTHING about the GSTIN itself
  | "TIMEOUT" | "MAINTENANCE" | "RATE_LIMITED" | "PROVIDER_ERROR" | "NETWORK_ERROR"
  // Live verification deliberately paused by cost protection (credit budget / daily cap). Says nothing about the GSTIN.
  | "CAPACITY_LIMITED";

/** auto = follow the freshness policy (instant if stored, stale-while-refresh); refresh = silent background refresh of a stale answer; live = the user explicitly wants a live check. */
export type VerifyMode = "auto" | "refresh" | "live";
export const isVerifyMode = (v: unknown): v is VerifyMode => v === "auto" || v === "refresh" || v === "live";

export const REGISTRY_OUTCOMES: readonly VerificationOutcome[] = ["ACTIVE", "SUSPENDED", "CANCELLED", "INACTIVE", "NOT_FOUND", "UNKNOWN"];
/** Outcomes that describe a registration and may be cached / shown as "verified". */
export const STATUS_OUTCOMES: readonly VerificationOutcome[] = ["ACTIVE", "SUSPENDED", "CANCELLED", "INACTIVE", "UNKNOWN"];
export const FAILURE_OUTCOMES: readonly VerificationOutcome[] = ["TIMEOUT", "MAINTENANCE", "RATE_LIMITED", "PROVIDER_ERROR", "NETWORK_ERROR", "CAPACITY_LIMITED"];

export const ALL_OUTCOMES: readonly VerificationOutcome[] = [...REGISTRY_OUTCOMES, "INVALID_GSTIN", ...FAILURE_OUTCOMES];
export const isOutcome = (v: unknown): v is VerificationOutcome => typeof v === "string" && (ALL_OUTCOMES as readonly string[]).includes(v);
export const isFailure = (o: VerificationOutcome) => FAILURE_OUTCOMES.includes(o);
export const isStatus = (o: VerificationOutcome) => STATUS_OUTCOMES.includes(o);

export function outcomeFromStatus(s: GstinStatus): VerificationOutcome {
  switch (s) {
    case "Active": return "ACTIVE";
    case "Suspended": return "SUSPENDED";
    case "Cancelled": return "CANCELLED";
    case "Inactive": return "INACTIVE";
    default: return "UNKNOWN"; // "Unknown" and the legacy "API Error" marker are NOT registry statements
  }
}

export interface FailureClass { outcome: VerificationOutcome; retryable: boolean; billable: boolean; retryAfterMs?: number }

/** Maps any thrown value from the provider pipeline to a deliberate outcome. Unknown errors become PROVIDER_ERROR. */
export function classifyProviderError(e: unknown): FailureClass {
  if (!(e instanceof ProviderError)) return { outcome: "PROVIDER_ERROR", retryable: true, billable: false };
  const base = { billable: e.billable, retryAfterMs: e.retryAfterMs };
  switch (e.code) {
    case "GST_PROVIDER_TIMEOUT": return { ...base, outcome: "TIMEOUT", retryable: true };
    case "GST_PROVIDER_UNAVAILABLE": return { ...base, outcome: "MAINTENANCE", retryable: true };
    case "GST_PROVIDER_RATE_LIMITED": return { ...base, outcome: "RATE_LIMITED", retryable: true };
    case "GST_PROVIDER_NOT_FOUND": return { ...base, outcome: "NOT_FOUND", retryable: false };
    // Auth / configuration problems are ours, not the user's and not the GSTIN's; retrying will not help until fixed.
    case "GST_PROVIDER_AUTH":
    case "GST_PROVIDER_NOT_CONFIGURED": return { ...base, outcome: "PROVIDER_ERROR", retryable: false };
    default: return { ...base, outcome: "PROVIDER_ERROR", retryable: e.retryable };
  }
}

export interface Explanation {
  tone: "success" | "warning" | "danger" | "info" | "neutral";
  title: string;
  /** What the result means. */
  meaning: string;
  /** Mandatory caveat for results that could be misread. */
  caveat?: string;
}

export const EXPLANATIONS: Record<VerificationOutcome, Explanation> = {
  ACTIVE: { tone: "success", title: "Active", meaning: "This GSTIN is currently reported as active by the verification source." },
  SUSPENDED: { tone: "warning", title: "Suspended", meaning: "Registration is currently suspended according to the available GST information.", caveat: "Check the position before relying on this GSTIN for a transaction." },
  CANCELLED: { tone: "danger", title: "Cancelled", meaning: "This GSTIN is reported as cancelled. Do not assume it can currently be used for taxable transactions." },
  INACTIVE: { tone: "warning", title: "Inactive", meaning: "The verification source reports this registration as inactive." },
  UNKNOWN: { tone: "neutral", title: "Status unclear", meaning: "The verification source answered, but did not give a clear registration status.", caveat: "This is not the same as inactive or cancelled. Try again later." },
  NOT_FOUND: {
    tone: "warning", title: "No matching registration found",
    meaning: "The verification source has no registration matching this GSTIN.",
    caveat: "This is not proof of fraud. The GSTIN may have been mistyped, the registration may be missing from the available source, or the service may be having a problem.",
  },
  INVALID_GSTIN: { tone: "danger", title: "Not a valid GSTIN", meaning: "This text is not a correctly formed GSTIN, so no lookup was made." },
  TIMEOUT: { tone: "info", title: "We couldn't verify this right now", meaning: "The GST verification service didn't respond in time.", caveat: "This does not mean the GSTIN is fake." },
  MAINTENANCE: { tone: "info", title: "Verification service unavailable", meaning: "The GST verification service is temporarily unavailable or under maintenance.", caveat: "This does not mean the GSTIN is fake." },
  RATE_LIMITED: { tone: "info", title: "Too many requests right now", meaning: "The verification service is limiting requests. Wait a moment and try again.", caveat: "This does not mean the GSTIN is fake." },
  PROVIDER_ERROR: { tone: "info", title: "We couldn't complete verification", meaning: "The verification service returned an error we couldn't use.", caveat: "This does not mean the GSTIN is fake." },
  CAPACITY_LIMITED: { tone: "info", title: "Live verification is limited right now", meaning: "To protect shared verification capacity, new live checks are temporarily paused. Stored results are still available.", caveat: "This does not mean the GSTIN is fake." },
  NETWORK_ERROR: { tone: "info", title: "Couldn't reach the server", meaning: "Your device couldn't reach our servers.", caveat: "This does not mean the GSTIN is fake." },
};

export const INVALID_REASON_TEXT: Record<Extract<GstinValidation, { valid: false }>["reason"], string> = {
  EMPTY: "Enter a GSTIN to verify.",
  LENGTH: "A GSTIN has exactly 15 characters.",
  FORMAT: "That doesn't look like a GSTIN: 2 digits of state code, 10 characters of PAN, then 3 more characters, ending in Z and a check character.",
  CHECKSUM: "The last character doesn't match — one of the other characters is probably mistyped.",
};

// ---- API shape ---------------------------------------------------------------------------------------

export interface VerifiedDetails {
  legalName?: string; tradeName?: string; taxpayerType?: string; state?: string; registrationDate?: string; cancellationDate?: string;
}

/** How the displayed answer was obtained. LIVE_PROVIDER = paid call made for this request; CACHE = this organization's stored answer;
 *  SHARED_CACHE = another organization's normalized answer (only when sharing is enabled); DEDUPED = joined a concurrent live call;
 *  BATCH is reserved for a provider batch endpoint (none is integrated). */
export type Provenance = "LIVE_PROVIDER" | "CACHE" | "SHARED_CACHE" | "DEDUPED" | "BATCH";

/** Why a request did not do what was literally asked (explicit refresh, or a live call) — always explained to the user. */
export type VerifyNotice = "REFRESH_TOO_SOON" | "CREDIT_PROTECTION";
export const NOTICE_TEXT: Record<VerifyNotice, string> = {
  REFRESH_TOO_SOON: "This GSTIN was verified moments ago, so the stored result is shown. A new live check isn't needed yet.",
  CREDIT_PROTECTION: "Live verification is limited right now, so the most recent stored result is shown. It may be out of date.",
};

export interface LastKnown { outcome: VerificationOutcome; verifiedAt: string; details?: VerifiedDetails }

export interface VerificationView {
  /** Server-generated; quote it when reporting a problem. */
  requestId: string;
  gstin: string;
  outcome: VerificationOutcome;
  /** Only for INVALID_GSTIN. */
  invalidReason?: Extract<GstinValidation, { valid: false }>["reason"];
  /** True when the GSTIN passed local format + checksum validation. */
  formatValid: boolean;
  details?: VerifiedDetails;
  source?: string;
  /** When the registry answer was obtained (not when this response was produced). */
  verifiedAt?: string;
  /** "live" = fetched during this request; "cached" = served from a stored result; "none" = no registry data in this response. */
  freshness: "live" | "cached" | "none";
  ageSeconds?: number;
  retryable: boolean;
  /** How this answer was obtained (see Provenance). Absent when there is no registry answer. */
  provenance?: Provenance;
  /** Set when the request was answered differently from what was asked (see VerifyNotice). */
  notice?: VerifyNotice;
  /** Set when this live answer differs meaningfully from the previously stored one (e.g. ACTIVE → CANCELLED). */
  change?: ChangeInfo;
  /** Whether this GSTIN is pinned in the organization's saved list. */
  saved?: boolean;
  note?: string;
  tags?: string[];
  /** Cached results only: how the stored answer sits against the freshness policy. */
  staleness?: "fresh" | "stale" | "expired";
  /** Stale answers: the client should silently ask for a refresh (mode "refresh"). Absent when a refresh would be pointless (provider unwell, quota). */
  refreshRecommended?: boolean;
  /** Why a refresh was NOT attempted/recommended although the stored answer is stale. */
  refreshSkipped?: "provider_degraded" | "provider_down" | "quota" | "capacity";
  /** This result came from a live check already in progress for the same GSTIN (no extra provider call or quota). */
  joined?: boolean;
  /** Provider health at the time of this response, when it matters (anything other than healthy). */
  providerHealth?: HealthState;
  /** Suggested wait before retrying (ms), when the provider supplied one. */
  retryAfterMs?: number;
  /** Failures only: an older registry result for the same GSTIN, clearly labelled stale. */
  lastKnown?: LastKnown;
  durationMs: number;
}

export function detailsFrom(r: GstinResult): VerifiedDetails {
  return { legalName: r.legalName, tradeName: r.tradeName, taxpayerType: r.taxpayerType, state: r.state, registrationDate: r.registrationDate, cancellationDate: r.cancellationDate };
}

/** "Verified 18 minutes ago" — used by the UI and tests. */
export function ageLabel(seconds: number): string {
  if (seconds < 45) return "just now";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(seconds / 3600);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(seconds / 86400);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/**
 * Runtime shape check for a response from the server. A malformed body, or an outcome this client build does not know (a newer server), must become a
 * clear error state — never a render crash (EXPLANATIONS[unknown] would be undefined).
 */
export function isVerificationView(x: unknown): x is VerificationView {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.gstin === "string" && typeof o.outcome === "string" && Object.prototype.hasOwnProperty.call(EXPLANATIONS, o.outcome) && typeof o.requestId === "string";
}
