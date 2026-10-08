import { randomUUID } from "node:crypto";
import { AppError, type Ctx } from "@/lib/errors";
import { assertCan } from "@/lib/permissions";
import { getPlan } from "@/config/plans";
import { MAX_CSV_ROWS, toCsv } from "@/lib/csv";
import { SCHEDULE_LABEL, type PortfolioRow } from "@/lib/portfolio";
import { EXPLANATIONS } from "@/lib/verification";
import type { NormalizedReturn } from "@/lib/returns";
import type { ReturnFilter, Store } from "@/lib/store/types";
import type { PortfolioService } from "./portfolio";
import { isReportKind, REPORT_INFO, type PrintSummary, type ReportData } from "@/lib/reports";

export { REPORT_KINDS, REPORT_INFO, isReportKind, type ReportKind, type ReportData, type PrintSummary } from "@/lib/reports";

const STATE_LABEL: Record<NormalizedReturn["state"], string> = { FILED_ON_TIME: "Filed on time", FILED_LATE: "Filed late", NOT_FILED: "Not filed", PENDING: "Not due yet", UNKNOWN: "Unknown" };
const FRESH_LABEL = { fresh: "Fresh", stale: "Stale", expired: "Expired", never: "Never verified" } as const;
const statusText = (r: PortfolioRow) => (r.status ? EXPLANATIONS[r.status].title : "Not verified");
const gstinText = (r: PortfolioRow) => (r.gstins?.length ? r.gstins.join("; ") : r.gstin);
const changeText = (r: PortfolioRow) => (r.change ? `${EXPLANATIONS[r.change.from].title} → ${EXPLANATIONS[r.change.to].title}` : "");
const periodText = (p: string) => `${p.slice(0, 2)}/${p.slice(2)}`;

/**
 * Reports are read-only views over data the system already holds (portfolio rows, stored returns). Nothing here calls the provider.
 * CSV is formula-safe and UTF-8 with a BOM so Excel opens it correctly; there is no native .xlsx writer. The printable summary is an HTML page
 * the browser saves as PDF; there is no server-side PDF generator.
 */
export class ReportService {
  constructor(private store: Store, private portfolio: PortfolioService, private now: () => Date = () => new Date()) {}

  async build(ctx: Ctx, kind: unknown, q: Record<string, string | undefined> = {}, o: { csv?: boolean } = {}): Promise<ReportData> {
    assertCan(ctx.role, o.csv ? "reports:generate" : "reports:read");
    if (!isReportKind(kind)) throw new AppError("NOT_FOUND", "Unknown report.", 404);
    const info = REPORT_INFO[kind];
    const base = { kind, title: info.title, description: info.description, generatedAt: this.now().toISOString() };
    if (kind === "returns") return { ...base, ...(await this.returns(ctx, q)) };
    const filters = kind === "attention" ? { attention: true } : kind === "changes" ? { changed: true } : {};
    const { rows, truncated } = await this.portfolio.exportRows(ctx, { ...filters, sort: kind === "clients" ? "name" : "attention" });
    const notes = ["Statuses are the latest stored answers, not a live check. The 'Last verified' column and freshness say how old each one is."];
    if (truncated) notes.push("Only the first 5,000 clients are included.");
    if (kind === "changes") return { ...base, columns: ["Client", "GSTIN", "Change", "Detected (UTC)", "Worse than before", "Latest status", "Last verified (UTC)"], notes,
      rows: rows.map((r) => [r.name, gstinText(r), changeText(r), r.change!.at, r.change!.deteriorated ? "Yes" : "No", statusText(r), r.verifiedAt ?? ""]), total: rows.length, truncated };
    return { ...base, columns: ["Client", "GSTIN", "Legal name", "Latest status", "Answer from", "Last verified (UTC)", "Freshness", "Recent change", "Schedule"], notes,
      rows: rows.map((r) => [r.name, gstinText(r), r.legalName ?? "", statusText(r), r.statusSource === "check" ? "Full GST check" : r.statusSource === "verification" ? "Verification" : "", r.verifiedAt ?? "", FRESH_LABEL[r.freshness], changeText(r), r.schedule ? SCHEDULE_LABEL[r.schedule] : ""]),
      total: rows.length, truncated };
  }

  private async returns(ctx: Ctx, q: Record<string, string | undefined>) {
    const rt = q.returnType === "GSTR1" || q.returnType === "GSTR3B" ? q.returnType : undefined;
    if (q.returnType && !rt) throw new AppError("VALIDATION_ERROR", "returnType must be GSTR1 or GSTR3B.", 400);
    if (q.fy && !/^\d{4}-\d{2}$/.test(q.fy)) throw new AppError("VALIDATION_ERROR", "fy must look like 2026-27.", 400);
    const all = q.scope === "all";
    const filters: ReturnFilter[] = (all ? [{}] : [{ state: "NOT_FILED" as const }, { state: "FILED_LATE" as const }]).map((f) => ({ ...f, ...(rt ? { returnType: rt } : {}), ...(q.fy ? { financialYear: q.fy } : {}) }));
    const items: NormalizedReturn[] = []; let truncated = false;
    for (const f of filters) {
      let cursor: string | undefined;
      do {
        const page = await this.store.queryReturns(ctx.orgId, f, { limit: 500, cursor, dir: "desc" });
        items.push(...page.items); cursor = page.nextCursor;
        if (items.length >= MAX_CSV_ROWS) { truncated = true; break; }
      } while (cursor);
    }
    items.sort((a, b) => b.dueDate.localeCompare(a.dueDate) || a.gstin.localeCompare(b.gstin) || a.returnType.localeCompare(b.returnType));
    const names = new Map<string, string | undefined>();
    const need = [...new Set(items.map((i) => i.gstin))];
    for (let i = 0; i < need.length; i += 300) for (const g of await this.store.getGstinRecords(ctx.orgId, need.slice(i, i + 300))) names.set(g.gstin, g.clientName);
    const rows = items.slice(0, MAX_CSV_ROWS).map((r) => [names.get(r.gstin) ?? "", r.gstin, r.returnType === "GSTR1" ? "GSTR-1" : "GSTR-3B", r.financialYear, periodText(r.period), r.dueDate.slice(0, 10),
      r.filingDate?.slice(0, 10) ?? "", STATE_LABEL[r.state], r.delayDays !== undefined ? String(r.delayDays) : "", r.arn ?? "", r.retrievedAt]);
    return {
      columns: ["Client", "GSTIN", "Return", "Financial year", "Period (MM/YYYY)", "Due date", "Filed on", "Status", "Days late / overdue", "ARN", "Data retrieved (UTC)"],
      rows, total: rows.length, truncated: truncated || items.length > MAX_CSV_ROWS,
      notes: ["Filing status is as of the last time each GSTIN's return history was retrieved; refresh a GSTIN to update it.", ...(all ? [] : ["Showing returns that are not filed or were filed late. Use scope=all for every return."])],
    };
  }

  /** CSV of a report. UTF-8 with BOM, formula-safe, audited. */
  async csv(ctx: Ctx, kind: unknown, q: Record<string, string | undefined> = {}): Promise<{ csv: string; filename: string; rows: number; truncated: boolean }> {
    const r = await this.build(ctx, kind, q, { csv: true });
    await this.store.addAudit({ id: randomUUID(), organizationId: ctx.orgId, userId: ctx.userId, action: "REPORT_GENERATED", target: r.kind, at: this.now().toISOString(), metadata: { rows: r.rows.length, format: "csv" } });
    return { csv: toCsv([r.columns, ...r.rows]), filename: `${r.kind}-report-${r.generatedAt.slice(0, 10)}.csv`, rows: r.rows.length, truncated: r.truncated };
  }

  /** The printable monthly summary. A plan feature (`pdfReports`): the browser prints it to PDF. */
  async summary(ctx: Ctx): Promise<PrintSummary> {
    assertCan(ctx.role, "reports:read");
    const org = await this.store.getOrg(ctx.orgId);
    if (!org) throw new AppError("ORG_NOT_FOUND", "Organization not found.", 404);
    if (!getPlan(org.plan).features.pdfReports) throw new AppError("FEATURE_NOT_AVAILABLE", `The printable summary is not included in the ${getPlan(org.plan).name} plan.`, 403);
    const [all, att, chg] = await Promise.all([
      this.portfolio.exportRows(ctx, {}), this.portfolio.exportRows(ctx, { attention: true, sort: "attention" }), this.portfolio.exportRows(ctx, { changed: true, sort: "attention" }),
    ]);
    const cnt = (f: Parameters<Store["countGstins"]>[1]) => this.store.countGstins(ctx.orgId, f);
    const [gstr1Missing, gstr3bMissing, gstr1Late, gstr3bLate] = await Promise.all([cnt({ gstr1Missing: "some" }), cnt({ gstr3bMissing: "some" }), cnt({ gstr1Late: "some" }), cnt({ gstr3bLate: "some" })]);
    return {
      generatedAt: this.now().toISOString(), organization: org.name, portfolio: all.summary, truncated: all.truncated,
      attention: att.rows.slice(0, 25).map((r) => ({ name: r.name, gstin: gstinText(r), status: statusText(r), verifiedAt: r.verifiedAt })),
      changes: chg.rows.slice(0, 25).map((r) => ({ name: r.name, gstin: gstinText(r), change: changeText(r), at: r.change!.at, deteriorated: r.change!.deteriorated })),
      returns: { gstr1Missing, gstr3bMissing, gstr1Late, gstr3bLate },
      notes: [
        "Statuses are the latest stored answers, each with its own verification time; they are not a live check of today's registration status.",
        "Return counts are GSTINs with at least one missing or late return, as of the last retrieval of their return history.",
        "This summary is an internal working document, not a statement by or on behalf of the GST authorities.",
      ],
    };
  }
}
