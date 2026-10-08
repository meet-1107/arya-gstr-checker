"use client";
import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, BadgeCheck, Download, Eye, FileText, Printer, Receipt, Waypoints } from "lucide-react";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Alert, ErrorState, Skeleton, Spinner } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import { apiDownload, errorMessage, saveFile } from "@/lib/client/api";
import { formatNumber } from "@/lib/client/format";
import { toQuery, useApi } from "@/lib/client/hooks";
import type { PortfolioSummary } from "@/lib/portfolio";
import { REPORT_INFO, type ReportData, type ReportKind } from "@/lib/reports";

const ICON: Record<ReportKind, typeof FileText> = { clients: BadgeCheck, attention: AlertTriangle, changes: Waypoints, returns: Receipt };
const ORDER: ReportKind[] = ["clients", "attention", "changes", "returns"];

function Preview({ kind, query, onClose }: { kind: ReportKind; query: Record<string, string>; onClose: () => void }) {
  const { data, error, isLoading } = useApi<ReportData>(`/api/reports/${kind}${toQuery(query)}`);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="lg" title={REPORT_INFO[kind].title} description="A preview of the first rows. Download the CSV for the full report.">
      {isLoading ? <p className="flex items-center gap-2 text-sm" role="status"><Spinner />Preparing the report…</p> : error || !data ? <ErrorState title="Couldn't prepare this report" detail={error?.code} /> : (
        <div className="space-y-3">
          <p className="text-sm"><strong className="tabular">{formatNumber(data.total)}</strong> row{data.total === 1 ? "" : "s"}{data.truncated && " (truncated)"}</p>
          {data.rows.length === 0 ? <p className="text-sm text-muted">Nothing to report right now.</p> : (
            <div className="max-h-[50vh] overflow-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label={`${data.title} preview (scrollable)`}>
              <table className="w-full text-left text-xs">
                <caption className="sr-only">{data.title} preview</caption>
                <thead className="sticky top-0 bg-surface-muted"><tr>{data.columns.map((c) => <th key={c} scope="col" className="whitespace-nowrap px-3 py-2 font-medium text-muted">{c}</th>)}</tr></thead>
                <tbody className="divide-y divide-line">{data.rows.slice(0, 25).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className="whitespace-nowrap px-3 py-1.5">{v || <span className="text-subtle">—</span>}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted">{data.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </div>
      )}
    </Dialog>
  );
}

export default function ReportsPage() {
  const { can } = useSession();
  const { toast } = useToast();
  const stats = useApi<{ summary: PortfolioSummary }>("/api/portfolio?limit=1");
  const s = stats.data?.summary;
  const [rt, setRt] = useState(""); const [all, setAll] = useState(false);
  const [preview, setPreview] = useState<ReportKind | null>(null);
  const [busy, setBusy] = useState<ReportKind | null>(null);
  const { activeOrgId } = useSession();
  const gen = can("reports:generate");
  const query = (k: ReportKind): Record<string, string> => (k === "returns" ? { ...(rt ? { returnType: rt } : {}), ...(all ? { scope: "all" } : {}) } : {});
  const count = (k: ReportKind) => (!s ? undefined : k === "clients" ? s.total : k === "attention" ? s.attention : k === "changes" ? s.changedRecently : undefined);

  const download = async (k: ReportKind) => {
    setBusy(k);
    try {
      const { blob, truncated } = await apiDownload(`/api/reports/${k}${toQuery({ ...query(k), format: "csv" })}`, { org: activeOrgId });
      saveFile(blob, `${k}-report.csv`);
      toast({ tone: "success", title: "Report downloaded", description: truncated ? "Truncated to the first rows." : REPORT_INFO[k].title });
    } catch (e) { toast({ tone: "error", title: "Couldn't download the report", description: errorMessage(e) }); }
    finally { setBusy(null); }
  };

  return (
    <>
      <PageHeader title="Reports" description="Export your clients' GST status and filing position for your records and for your clients." />
      <Alert tone="info" title="Reports show stored answers, not a live check" className="mb-4 sm:mb-6">Every row says when it was last verified. Refresh your portfolio first if you need current statuses.</Alert>
      <div className="grid gap-4 sm:gap-6 md:grid-cols-2">
        {ORDER.map((k) => {
          const Icon = ICON[k]; const n = count(k);
          return (
            <Card key={k} inset className="flex flex-col">
              <CardBody className="flex flex-1 flex-col gap-3">
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-muted"><Icon className="size-4" aria-hidden /></span>
                  <div className="min-w-0"><h2 className="text-[15px] font-semibold">{REPORT_INFO[k].title}</h2><p className="mt-0.5 text-[13px] text-muted">{REPORT_INFO[k].description}</p></div>
                </div>
                {k === "returns" && (
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="w-40"><label htmlFor="rt" className="sr-only">Return type</label><Select id="rt" className="!h-9" value={rt} onChange={(e) => setRt(e.target.value)}><option value="">GSTR-1 and GSTR-3B</option><option value="GSTR1">GSTR-1 only</option><option value="GSTR3B">GSTR-3B only</option></Select></div>
                    <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="size-4 accent-primary" checked={all} onChange={(e) => setAll(e.target.checked)} />Include on-time filings</label>
                  </div>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                  {stats.isLoading && k !== "returns" ? <Skeleton className="h-5 w-20" /> : n !== undefined && <Badge tone="neutral">{formatNumber(n)} row{n === 1 ? "" : "s"}</Badge>}
                  <span className="flex-1" />
                  <Button size="sm" variant="secondary" onClick={() => setPreview(k)}><Eye className="size-3.5" aria-hidden />Preview</Button>
                  {gen && <Button size="sm" variant="primary" loading={busy === k} onClick={() => void download(k)}><Download className="size-3.5" aria-hidden />Download CSV</Button>}
                </div>
              </CardBody>
            </Card>
          );
        })}
        <Card inset className="md:col-span-2">
          <CardBody className="flex flex-wrap items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-muted"><Printer className="size-4" aria-hidden /></span>
            <div className="min-w-0 flex-1"><h2 className="text-[15px] font-semibold">Monthly summary <Badge tone="blue" className="ml-1">Plan feature</Badge></h2><p className="mt-0.5 text-[13px] text-muted">A one-page overview for your files or your clients: portfolio status, clients needing attention, recent changes and filing position. Print it or save it as a PDF from your browser.</p></div>
            <ButtonLink href="/reports/summary" variant="secondary" size="sm"><FileText className="size-3.5" aria-hidden />Open summary</ButtonLink>
          </CardBody>
        </Card>
      </div>
      <p className="mt-3 text-xs text-muted">CSV files open in Excel and Google Sheets (UTF-8). Native Excel (.xlsx) files are not generated. Need a different report? <Link href="/audit-logs" className="underline">The audit log</Link> can also be exported.</p>
      {preview && <Preview kind={preview} query={query(preview)} onClose={() => setPreview(null)} />}
    </>
  );
}
