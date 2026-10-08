// Human wording for audit entries (server + client). Audit metadata never carries free text from users (notes, descriptions, names):
// only codes, counts and ids, so the audit log can be shown to admins and exported without leaking content.
import type { AuditAction } from "./store/types";

export const AUDIT_LABEL: Record<AuditAction, string> = {
  LOGIN: "Signed in", CLIENT_CREATED: "Added a client", CLIENT_UPDATED: "Edited a client", CLIENT_DELETED: "Deleted a client", CLIENT_ARCHIVED: "Archived a client", CLIENT_RESTORED: "Restored a client",
  GST_CHECK: "Ran a GST check", CSV_IMPORTED: "Imported clients from CSV", CSV_EXPORT: "Exported a CSV", REPORT_GENERATED: "Generated a report",
  TEAM_MEMBER_ADDED: "Added a team member", TEAM_MEMBER_REMOVED: "Removed a team member", ROLE_CHANGED: "Changed a role",
  SUBSCRIPTION_CHANGED: "Changed the subscription", BILLING_EVENT: "Billing event", BULK_CHECK_STARTED: "Started a bulk run", BULK_CHECK_CANCELLED: "Cancelled a bulk run",
  GST_VERIFY: "Verified a GSTIN", VERIFICATION_SAVED: "Saved or unsaved a GSTIN", VERIFICATION_ANNOTATED: "Edited notes or tags on a GSTIN",
  VERIFICATION_DELETED: "Removed a GSTIN from verification history", VERIFICATION_HISTORY_CLEARED: "Cleared the verification history",
  CONCERN_REPORTED: "Reported a concern about a GSTIN", CONCERN_UPDATED: "Updated a concern",
};
export const AUDIT_ACTIONS = Object.keys(AUDIT_LABEL) as AuditAction[];
export const auditLabel = (a: string) => AUDIT_LABEL[a as AuditAction] ?? a;
