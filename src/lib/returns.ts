import type { ReturnHistory, ReturnStatus, ReturnType } from "@/providers/types";
import { classifyReturn, type FilingState } from "./compliance";
import { dueDateFor, type FilingFrequency } from "./dates";

/**
 * Stable, provider-independent return record exposed by the application API.
 * Provider-specific payloads never reach this shape; adapters map into ReturnRecord first.
 *
 * `state` is computed when the history is RETRIEVED (as of `retrievedAt`). A PENDING return that
 * becomes overdue is only re-classified on the next check (scheduled monitoring: pending, ISSUE-006).
 */
export interface NormalizedReturn {
  id: string;                 // `${gstin}_${returnType}_${periodSort}` (sortable, unique per org)
  gstin: string;
  clientId?: string;
  returnType: ReturnType;
  financialYear: string;      // "2026-27"
  period: string;             // "MMYYYY"
  periodSort: string;         // "YYYYMM"
  status: ReturnStatus;       // provider-reported: FILED | NOT_FILED | UNKNOWN
  state: FilingState;         // derived: FILED_ON_TIME | FILED_LATE | NOT_FILED | PENDING | UNKNOWN
  filingDate?: string;
  dueDate: string;
  delayDays?: number;         // days late (filed late) or days overdue (not filed)
  arn?: string;
  source: string;             // provider name
  checkedAt: string;          // provider-reported time of the data
  retrievedAt: string;        // when this application stored it
}

export const periodSort = (period: string) => `${period.slice(2)}${period.slice(0, 2)}`;
export const returnId = (gstin: string, type: ReturnType, period: string) => `${gstin}_${type}_${periodSort(period)}`;

const DAY = 86_400_000;

export function normalizeReturns(
  h: ReturnHistory, o: { clientId?: string; freq: FilingFrequency; now: Date },
): NormalizedReturn[] {
  return h.records.map((r) => {
    const due = dueDateFor(r.returnType, r.period, o.freq);
    const state = classifyReturn(r, o.freq, o.now);
    let delayDays: number | undefined;
    if (state === "FILED_LATE" && r.filingDate) delayDays = Math.ceil((new Date(r.filingDate).getTime() - due.getTime()) / DAY);
    if (state === "NOT_FILED") delayDays = Math.ceil((o.now.getTime() - due.getTime()) / DAY);
    return {
      id: returnId(h.gstin, r.returnType, r.period), gstin: h.gstin, clientId: o.clientId,
      returnType: r.returnType, financialYear: r.financialYear, period: r.period, periodSort: periodSort(r.period),
      status: r.status, state, filingDate: r.filingDate, dueDate: due.toISOString(), delayDays, arn: r.arn,
      source: h.source, checkedAt: h.checkedAt, retrievedAt: o.now.toISOString(),
    };
  });
}

export interface ReturnSummary { gstr1Missing: number; gstr1Late: number; gstr3bMissing: number; gstr3bLate: number; states: FilingState[] }

export function summarizeReturns(rs: NormalizedReturn[]): ReturnSummary {
  const n = (t: ReturnType, s: FilingState) => rs.filter((r) => r.returnType === t && r.state === s).length;
  return {
    gstr1Missing: n("GSTR1", "NOT_FILED"), gstr1Late: n("GSTR1", "FILED_LATE"),
    gstr3bMissing: n("GSTR3B", "NOT_FILED"), gstr3bLate: n("GSTR3B", "FILED_LATE"),
    states: rs.map((r) => r.state),
  };
}
