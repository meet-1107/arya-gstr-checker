/** Human text for the machine reason codes attached to rows that were not imported. Shared by the UI and the failed-rows CSV. */
const REASONS: Record<string, string> = {
  EMPTY: "GSTIN is empty", LENGTH: "GSTIN must be exactly 15 characters", FORMAT: "GSTIN format is invalid",
  CHECKSUM: "GSTIN failed the checksum — probably a typo", DUPLICATE_IN_FILE: "Repeated earlier in this file",
  ALREADY_IN_ORG: "Already a client in this workspace", ALREADY_EXISTS: "Added by someone else while importing",
  MISSING_NAME: "Client name is missing", NAME_TOO_LONG: "Client name is too long (max 200)", INVALID_EMAIL: "Email address is invalid",
  INVALID_PHONE: "Phone number is invalid", PLAN_LIMIT_REACHED: "Over your plan's client limit",
};

export const reasonText = (code?: string) => (code ? REASONS[code] ?? "Row could not be imported" : "");
export const KNOWN_REASON_CODES = Object.keys(REASONS);
