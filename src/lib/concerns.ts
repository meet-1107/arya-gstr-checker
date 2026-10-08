// Shared (server + client) vocabulary for the "report a concern" workflow.
import type { ConcernCategory, ConcernStatus } from "./store/types";

export const CONCERN_CATEGORIES: { id: ConcernCategory; label: string; hint: string }[] = [
  { id: "NOT_EXIST", label: "The GSTIN doesn't exist", hint: "A counterparty gave you this GSTIN but it does not match any registration." },
  { id: "NAME_MISMATCH", label: "The business name doesn't match", hint: "The registered name differs from the name on the invoice or agreement." },
  { id: "ADDRESS_SUSPICIOUS", label: "The address looks suspicious", hint: "For example a residential or non-existent address for a trading business." },
  { id: "DETAILS_INCONSISTENT", label: "GST details look inconsistent", hint: "Status, type or state doesn't fit what you know about the business." },
  { id: "FAKE_DOCUMENT", label: "I suspect a fake document", hint: "A registration certificate, invoice or e-way bill that may have been forged." },
  { id: "OTHER", label: "Something else", hint: "Anything else your team should know about this GSTIN." },
];
export const CONCERN_LABEL = Object.fromEntries(CONCERN_CATEGORIES.map((c) => [c.id, c.label])) as Record<ConcernCategory, string>;
export const CONCERN_IDS = CONCERN_CATEGORIES.map((c) => c.id);
export const CONCERN_STATUSES: ConcernStatus[] = ["open", "reviewed", "closed"];
export const MIN_DESCRIPTION = 10, MAX_DESCRIPTION = 1000, MAX_RESOLUTION = 500, MAX_CONCERNS_PER_USER_PER_DAY = 20;

/** The one sentence that must accompany every place a concern can be created. It is a statement about what the feature does NOT do. */
export const CONCERN_DISCLAIMER =
  "This is an internal note for your organization. It is not sent to the GST authorities or anyone else, and it is not a finding that the GSTIN is fake. To report suspected fraud, use the official GST portal's grievance channels.";
