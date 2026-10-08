// Report catalogue and shapes shared by the API and the UI (pure: safe to import from client components).
import type { PortfolioSummary } from "./portfolio";

export const REPORT_KINDS = ["clients", "attention", "changes", "returns"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const isReportKind = (v: unknown): v is ReportKind => (REPORT_KINDS as readonly unknown[]).includes(v);

export const REPORT_INFO: Record<ReportKind, { title: string; description: string }> = {
  clients: { title: "Client GST status", description: "Every client with its latest known GST status, when it was verified and how fresh that is." },
  attention: { title: "Clients needing attention", description: "Clients whose latest answer is suspended, cancelled, inactive or not found." },
  changes: { title: "Recent changes", description: "Clients whose GST status or details changed at the last live check (last 14 days)." },
  returns: { title: "Returns status", description: "GSTR-1 and GSTR-3B filing status per client and period. Defaults to returns that are missing or filed late." },
};

export interface ReportData {
  kind: ReportKind; title: string; description: string; generatedAt: string;
  columns: string[]; rows: string[][]; total: number; truncated: boolean;
  /** Honest scope notes that belong next to the numbers (shown on screen; CSV keeps to data). */
  notes: string[];
}

export interface PrintSummary {
  generatedAt: string; organization: string; portfolio: PortfolioSummary; truncated: boolean;
  attention: { name: string; gstin: string; status: string; verifiedAt?: string }[];
  changes: { name: string; gstin: string; change: string; at: string; deteriorated: boolean }[];
  returns: { gstr1Missing: number; gstr3bMissing: number; gstr1Late: number; gstr3bLate: number };
  notes: string[];
}
