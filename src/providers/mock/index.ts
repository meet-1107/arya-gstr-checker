import {
  ProviderError, type GstProvider, type GstinResult, type GstinStatus, type ReturnHistory, type ReturnRecord,
} from "../types";
import { returnPeriodsForFinancialYear, dueDateFor, currentFinancialYear } from "@/lib/dates";

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** Deterministic fake provider. Development/test ONLY — refused in production by the factory. */
export class MockGstProvider implements GstProvider {
  readonly name = "mock";
  calls = 0;
  constructor(private opts: { failFor?: Set<string>; notFoundFor?: Set<string>; errorFor?: Map<string, ProviderError>; delayMs?: number; now?: () => Date } = {}) {}
  private now() { return (this.opts.now ?? (() => new Date()))(); }

  async verifyGstin(gstin: string): Promise<GstinResult> {
    this.calls++;
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    const injected = this.opts.errorFor?.get(gstin);
    if (injected) throw injected;
    if (this.opts.notFoundFor?.has(gstin)) throw new ProviderError("GST_PROVIDER_NOT_FOUND", "No registration found for this GSTIN.", false);
    if (this.opts.failFor?.has(gstin)) throw new ProviderError("GST_PROVIDER_TIMEOUT", "GST provider did not respond in time.", true);
    const statuses: GstinStatus[] = ["Active", "Active", "Active", "Active", "Active", "Suspended", "Cancelled"];
    return {
      gstin,
      status: statuses[hash(gstin) % statuses.length],
      legalName: `MOCK ${gstin.slice(2, 7)} PRIVATE LIMITED`,
      tradeName: `Mock ${gstin.slice(2, 7)}`,
      taxpayerType: "Regular",
      state: "Mock State",
      source: "mock",
      providerRequestId: `mock-${this.calls}`,
      checkedAt: this.now().toISOString(),
    };
  }

  async getReturnHistory(gstin: string, financialYear?: string): Promise<ReturnHistory> {
    this.calls++;
    const now = this.now();
    const fy = financialYear ?? currentFinancialYear(now);
    if (this.opts.failFor?.has(gstin)) throw new ProviderError("GST_PROVIDER_TIMEOUT", "GST provider did not respond in time.", true);
    const records: ReturnRecord[] = [];
    for (const returnType of ["GSTR1", "GSTR3B"] as const) {
      for (const period of returnPeriodsForFinancialYear(fy)) {
        const due = dueDateFor(returnType, period, "MONTHLY");
        if (due.getTime() > now.getTime() + 31 * 864e5) continue;
        const h = hash(gstin + returnType + period) % 10;
        if (h === 0 && due < now) {
          records.push({ returnType, period, financialYear: fy, status: "NOT_FILED" });
          continue;
        }
        const filed = new Date(due.getTime() + (h === 1 ? 5 : -2) * 864e5);
        if (filed > now) continue;
        records.push({
          returnType, period, financialYear: fy, status: "FILED",
          filingDate: filed.toISOString(), arn: `AA${period}${h}${hash(gstin) % 1000000}`,
        });
      }
    }
    return { gstin, records, source: "mock", checkedAt: now.toISOString() };
  }
}
