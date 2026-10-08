// Alert presentation model shared by the API and the UI. Pure.
import type { AlertType } from "./store/types";

export type AlertGroup = "status" | "returns" | "usage" | "jobs" | "system";
export const ALERT_GROUPS: Record<AlertGroup, { label: string; types: readonly AlertType[] }> = {
  status: { label: "GSTIN status", types: ["GSTIN_STATUS_CHANGED", "GSTIN_SUSPENDED", "GSTIN_CANCELLED"] },
  returns: { label: "Returns", types: ["GSTR1_MISSING", "GSTR3B_MISSING", "LATE_RETURN"] },
  usage: { label: "Usage & billing", types: ["QUOTA_NEAR_LIMIT", "QUOTA_EXHAUSTED", "SUBSCRIPTION_EXPIRING", "PAYMENT_FAILURE"] },
  jobs: { label: "Runs & imports", types: ["BULK_CHECK_COMPLETED", "IMPORT_COMPLETED"] },
  system: { label: "Service", types: ["API_FAILURE"] },
};
export const isAlertGroup = (v: unknown): v is AlertGroup => typeof v === "string" && v in ALERT_GROUPS;

export type AlertSeverity = "critical" | "warning" | "info";
/** Severity drives the icon/colour (always with text, never colour alone). */
export const ALERT_SEVERITY: Record<AlertType, AlertSeverity> = {
  GSTIN_STATUS_CHANGED: "warning", GSTIN_SUSPENDED: "warning", GSTIN_CANCELLED: "critical", GSTR1_MISSING: "warning", GSTR3B_MISSING: "warning",
  LATE_RETURN: "info", API_FAILURE: "info", QUOTA_NEAR_LIMIT: "warning", QUOTA_EXHAUSTED: "critical", SUBSCRIPTION_EXPIRING: "warning",
  PAYMENT_FAILURE: "critical", BULK_CHECK_COMPLETED: "info", IMPORT_COMPLETED: "info",
};
export const ALERT_LABEL: Record<AlertType, string> = {
  GSTIN_STATUS_CHANGED: "Status changed", GSTIN_SUSPENDED: "GSTIN suspended", GSTIN_CANCELLED: "GSTIN cancelled", GSTR1_MISSING: "GSTR-1 missing", GSTR3B_MISSING: "GSTR-3B missing",
  LATE_RETURN: "Late return", API_FAILURE: "Check failed", QUOTA_NEAR_LIMIT: "Checks running low", QUOTA_EXHAUSTED: "No checks left", SUBSCRIPTION_EXPIRING: "Plan expiring",
  PAYMENT_FAILURE: "Payment failed", BULK_CHECK_COMPLETED: "Run finished", IMPORT_COMPLETED: "Import finished",
};
