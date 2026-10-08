export type GstinStatus = "Active" | "Suspended" | "Cancelled" | "Inactive" | "Unknown" | "API Error";
export type ReturnType = "GSTR1" | "GSTR3B";
export type ReturnStatus = "FILED" | "NOT_FILED" | "UNKNOWN";

export interface GstinResult {
  gstin: string;
  status: GstinStatus;
  legalName?: string;
  tradeName?: string;
  taxpayerType?: string;
  state?: string;
  registrationDate?: string;
  cancellationDate?: string;
  source: string;
  providerRequestId?: string;
  checkedAt: string; // ISO
}

export interface ReturnRecord {
  returnType: ReturnType;
  period: string; // MMYYYY
  financialYear: string;
  status: ReturnStatus;
  filingDate?: string;
  arn?: string;
}

export interface ReturnHistory {
  gstin: string;
  records: ReturnRecord[];
  source: string;
  checkedAt: string;
}

export type ProviderErrorCode =
  | "GST_PROVIDER_TIMEOUT"
  | "GST_PROVIDER_RATE_LIMITED"
  | "GST_PROVIDER_UNAVAILABLE"
  | "GST_PROVIDER_AUTH"
  | "GST_PROVIDER_BAD_RESPONSE"
  | "GST_PROVIDER_NOT_CONFIGURED"
  /** The provider answered definitively: no registration matches this GSTIN. Not retryable, not an outage. */
  | "GST_PROVIDER_NOT_FOUND";

export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    message: string,
    public retryable: boolean,
    public billable = false,
    /** Provider-supplied Retry-After (ms) for rate limiting / maintenance windows. */
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface GstProvider {
  readonly name: string;
  verifyGstin(gstin: string): Promise<GstinResult>;
  getReturnHistory(gstin: string, financialYear?: string): Promise<ReturnHistory>;
}
