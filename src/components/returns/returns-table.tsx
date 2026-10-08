"use client";
import Link from "next/link";
import { FilingBadge } from "@/components/ui/badge";
import { DataTable, type Column } from "@/components/ui/data-table";
import { formatDate, periodLabel } from "@/lib/client/format";
import type { ReturnItem } from "@/lib/client/types";

export function ReturnsTable({ rows, loading, showClient, caption }: { rows: ReturnItem[]; loading?: boolean; showClient?: boolean; caption: string }) {
  const cols: Column<ReturnItem>[] = [
    ...(showClient ? [{ key: "client", header: "Client", primary: true, cell: (r: ReturnItem) => <Link href={`/gstins/${r.gstin}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{r.clientName ?? "Client"}<span className="block font-mono text-[11px] font-normal text-muted">{r.gstin}</span></Link> }] : []),
    { key: "period", header: "Period", primary: !showClient, cell: (r) => <span className="font-medium">{periodLabel(r.period)}</span> },
    { key: "fy", header: "Financial year", hideOnMobile: true, tabletHidden: true, cell: (r) => <span className="text-muted">{r.financialYear}</span> },
    { key: "due", header: "Due date", cell: (r) => formatDate(r.dueDate) },
    { key: "filed", header: "Filed on", cell: (r) => (r.filingDate ? formatDate(r.filingDate) : <span className="text-subtle">—</span>) },
    { key: "state", header: "Status", badge: true, cell: (r) => <FilingBadge state={r.state} /> },
    { key: "arn", header: "ARN", hideOnMobile: true, tabletHidden: true, cell: (r) => (r.arn ? <span className="font-mono text-xs">{r.arn}</span> : <span className="text-subtle">—</span>) },
    { key: "delay", header: "Delay", align: "right", cell: (r) => (r.delayDays && r.delayDays > 0 ? <span className={r.state === "NOT_FILED" ? "text-danger-strong" : "text-warning-strong"}>{r.delayDays} day{r.delayDays === 1 ? "" : "s"}</span> : <span className="text-subtle">—</span>) },
  ];
  return <DataTable caption={caption} columns={cols} rows={rows} rowKey={(r) => r.id} loading={loading} />;
}
