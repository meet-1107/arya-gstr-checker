"use client";
import Link from "next/link";
import { CheckCircle2, CircleDashed, FileUp, Loader2, TriangleAlert, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState, ErrorState, ProgressBar } from "@/components/ui/feedback";
import { formatDateTime, formatNumber, relativeTime } from "@/lib/client/format";
import { useApi } from "@/lib/client/hooks";
import type { ImportView } from "@/lib/client/types";

export const isImportActive = (s: string) => s === "queued" || s === "processing";

export function ImportStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "queued": return <Badge tone="neutral" icon={<CircleDashed aria-hidden />}>Queued</Badge>;
    case "processing": return <Badge tone="blue" icon={<Loader2 className="animate-spin" aria-hidden />}>Importing</Badge>;
    case "completed": return <Badge tone="green" icon={<CheckCircle2 aria-hidden />}>Completed</Badge>;
    case "completed_with_errors": return <Badge tone="amber" icon={<TriangleAlert aria-hidden />}>Completed with skipped rows</Badge>;
    case "failed": return <Badge tone="red" icon={<XCircle aria-hidden />}>Failed</Badge>;
    default: return <Badge>{status}</Badge>;
  }
}

/** Past imports (import history). Polls while anything is still running. */
export function ImportHistory() {
  const { data, error, mutate } = useApi<{ imports: ImportView[] }>("/api/imports", { refreshInterval: (d) => (d?.imports.some((i) => isImportActive(i.status)) ? 2500 : 0) });
  const cols: Column<ImportView>[] = [
    { key: "when", header: "Started", primary: true, cell: (i) => <span title={formatDateTime(i.createdAt)}>{relativeTime(i.createdAt)}</span> },
    { key: "file", header: "File", cell: (i) => <span className="block max-w-48 truncate" title={i.fileName}>{i.fileName}</span> },
    { key: "status", header: "Status", cell: (i) => <ImportStatusBadge status={i.status} /> },
    { key: "rows", header: "Rows", align: "right", cell: (i) => <span className="tabular">{formatNumber(i.totalRows)}</span> },
    { key: "imp", header: "Imported", align: "right", cell: (i) => <span className="tabular font-medium">{formatNumber(i.counts.imported)}</span> },
    { key: "skip", header: "Skipped", align: "right", hideOnMobile: true, cell: (i) => { const n = i.counts.invalid + i.counts.duplicate + i.counts.existing + i.counts.skippedPlanLimit + i.counts.failedToCreate; return n ? <span className="tabular text-warning-strong">{formatNumber(n)}</span> : <span className="text-subtle">—</span>; } },
  ];
  return (
    <Card>
      <CardHeader title="Import history" description="Every file you've imported, with the rows that were skipped." />
      <div className="mt-3">
        {error && !data ? <ErrorState onRetry={() => void mutate()} detail={error.code} />
          : data && data.imports.length === 0 ? <EmptyState className="!py-10" icon={<FileUp />} title="No imports yet" description="Files you import will appear here." />
          : <DataTable caption="Import history" columns={cols} rows={data?.imports ?? []} rowKey={(i) => i.id} href={(i) => `/clients/import/${i.id}`} loading={!data} skeletonRows={3} />}
      </div>
    </Card>
  );
}

export function ProgressLine({ imp }: { imp: ImportView }) {
  return (
    <div>
      <div className="flex items-baseline justify-between"><span className="tabular text-3xl font-semibold">{imp.progress.percent}%</span><span className="tabular text-sm text-muted">{formatNumber(imp.processed)} of {formatNumber(imp.toCreate)} clients processed</span></div>
      <ProgressBar className="mt-3" value={imp.progress.percent} label="Import progress" tone={imp.status === "failed" ? "red" : imp.counts.failedToCreate || imp.counts.skippedPlanLimit ? "amber" : "brand"} />
    </div>
  );
}

export const LinkText = ({ href, children }: { href: string; children: React.ReactNode }) => <Link href={href} className="font-medium underline underline-offset-2">{children}</Link>;
