// Detects meaningful differences between two stored registry answers for the same GSTIN. Pure.
import { isStatus, type VerificationOutcome, type VerifiedDetails } from "./verification";

export interface Snapshot { outcome: VerificationOutcome; details?: VerifiedDetails; verifiedAt: string }

export interface ChangeInfo {
  from: VerificationOutcome;
  to: VerificationOutcome;
  /** When the NEW answer was obtained. */
  at: string;
  /** "status" and/or the names of detail fields that differ (legalName, tradeName, taxpayerType, state, registrationDate, cancellationDate). */
  fields: string[];
  /** Status moved to a worse registration state (ACTIVE → SUSPENDED/CANCELLED/INACTIVE, SUSPENDED → CANCELLED). Worth an alert. */
  deteriorated: boolean;
}

const DETAIL_FIELDS = ["legalName", "tradeName", "taxpayerType", "state", "registrationDate", "cancellationDate"] as const;
const RANK: Partial<Record<VerificationOutcome, number>> = { ACTIVE: 0, SUSPENDED: 1, INACTIVE: 1, CANCELLED: 2 };

const norm = (v: string | undefined) => (v ?? "").trim().replace(/\s+/g, " ").toUpperCase();

/**
 * Compares a stored answer with a fresh one. Only registry STATUS answers are compared: NOT_FOUND / UNKNOWN on either side is not a
 * "change in registration" (it is a change in what the source could tell us), so it is never reported.
 * A detail that was absent before is not reported as a change either (the source may simply have started returning it).
 */
export function detectChange(prev: Snapshot | null | undefined, next: Snapshot): ChangeInfo | null {
  if (!prev || !isStatus(prev.outcome) || !isStatus(next.outcome) || prev.outcome === "UNKNOWN" || next.outcome === "UNKNOWN") return null;
  const fields: string[] = [];
  if (prev.outcome !== next.outcome) fields.push("status");
  for (const f of DETAIL_FIELDS) {
    const a = prev.details?.[f], b = next.details?.[f];
    if (a && b && norm(a) !== norm(b)) fields.push(f);
  }
  if (fields.length === 0) return null;
  const deteriorated = prev.outcome !== next.outcome && (RANK[next.outcome] ?? 0) > (RANK[prev.outcome] ?? 0);
  return { from: prev.outcome, to: next.outcome, at: next.verifiedAt, fields, deteriorated };
}
