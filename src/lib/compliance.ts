import type { GstinStatus, ReturnRecord } from "@/providers/types";
import { dueDateFor, type FilingFrequency } from "./dates";

export type FilingState = "FILED_ON_TIME" | "FILED_LATE" | "NOT_FILED" | "PENDING" | "UNKNOWN";
export type Indicator = "Good" | "Needs Attention" | "High Attention" | "Data Unavailable";
export const INDICATOR_DISCLAIMER = "This is an internal platform indicator and is not a government rating.";

export function classifyReturn(r: ReturnRecord, freq: FilingFrequency, now = new Date()): FilingState {
  const due = dueDateFor(r.returnType, r.period, freq);
  if (r.status === "UNKNOWN") return "UNKNOWN";
  if (r.status === "FILED") {
    if (!r.filingDate) return "UNKNOWN";
    return new Date(r.filingDate) <= due ? "FILED_ON_TIME" : "FILED_LATE";
  }
  return now > due ? "NOT_FILED" : "PENDING";
}

export function complianceIndicator(input: { gstinStatus: GstinStatus; states: FilingState[] }): Indicator {
  const { gstinStatus, states } = input;
  if (gstinStatus === "Unknown" || gstinStatus === "API Error") return "Data Unavailable";
  if (gstinStatus === "Cancelled" || gstinStatus === "Suspended") return "High Attention";
  if (states.length === 0 || states.every((s) => s === "UNKNOWN")) return "Data Unavailable";
  const missing = states.filter((s) => s === "NOT_FILED").length;
  const late = states.filter((s) => s === "FILED_LATE").length;
  if (missing >= 2) return "High Attention";
  if (missing === 1 || late >= 2) return "Needs Attention";
  if (gstinStatus === "Inactive") return "Needs Attention";
  return "Good";
}
