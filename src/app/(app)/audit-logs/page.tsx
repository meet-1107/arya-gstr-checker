"use client";
import { useState } from "react";
import { Download, ScrollText } from "lucide-react";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Alert, EmptyState, ErrorState } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { apiDownload, errorMessage, saveFile } from "@/lib/client/api";
import { formatDateTime } from "@/lib/client/format";
import { useApi } from "@/lib/client/hooks";
import { AUDIT_ACTIONS, AUDIT_LABEL } from "@/lib/audit-labels";
import type { AuditRow } from "@/services/trust";

const detail = (r: AuditRow) => (r.metadata ? Object.entries(r.metadata).map(([k, v]) => `${k}: ${v}`).join(" · ") : "");

export default function AuditLogsPage() {
  const { can, status, activeOrgId } = useSession();
  const { toast } = useToast();
  const [action, setAction] = useState("");
  const [exporting, setExporting] = useState(false);
  const allowed = can("auditlog:read");
  const q = useApi<{ items: AuditRow[] }>(allowed ? `/api/audit-logs?limit=200${action ? `&action=${action}` : ""}` : null);
  if (status === "ready" && !allowed) {
    return <><PageHeader title="Audit Logs" /><Alert tone="warning" title="You don't have access to audit logs">Ask an owner or admin of your organization.</Alert></>;
  }
  const exportCsv = async () => {
    setExporting(true);
    try { const { blob } = await apiDownload("/api/audit-logs/export", { org: activeOrgId }); saveFile(blob, "audit-log.csv"); toast({ tone: "success", title: "Export downloaded" }); }
    catch (e) { toast({ tone: "error", title: "Couldn't export", description: errorMessage(e) }); } finally { setExporting(false); }
  };
  const columns: Column<AuditRow>[] = [
    { key: "what", header: "What", primary: true, cell: (r) => r.label },
    { key: "who", header: "Who", cell: (r) => <span className="break-all">{r.who}</span> },
    { key: "when", header: "When", cell: (r) => <span className="text-muted">{formatDateTime(r.at)}</span> },
    { key: "target", header: "About", tabletHidden: true, cell: (r) => (r.target ? <span className="break-all font-mono text-xs">{r.target.length > 30 ? `${r.target.slice(0, 8)}…` : r.target}</span> : <span className="text-subtle">—</span>) },
    { key: "detail", header: "Details", hideOnMobile: true, tabletHidden: true, cell: (r) => <span className="text-muted">{detail(r) || "—"}</span> },
  ];
  return (
    <>
      <PageHeader title="Audit Logs" description="Who did what in your workspace. Notes, names and other typed text are never recorded here — only that something changed."
        actions={<Button variant="secondary" loading={exporting} onClick={() => void exportCsv()}><Download className="size-4" aria-hidden />Export CSV</Button>} />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-5 sm:pt-5">
          <h2 className="text-[15px] font-semibold">Recent activity</h2>
          <div className="w-64 max-w-full"><label htmlFor="aa" className="sr-only">Filter by action</label>
            <Select id="aa" className="!h-9" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">All actions</option>{AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{AUDIT_LABEL[a]}</option>)}
            </Select></div>
        </div>
        <div className="mt-3">
          {q.error && !q.data ? <ErrorState onRetry={() => void q.mutate()} detail={q.error.code} />
            : q.data && q.data.items.length === 0 ? <EmptyState className="!py-10" icon={<ScrollText />} title="Nothing recorded yet" description={action ? "No entries match this action." : "Activity will appear here as your team works."} />
            : <DataTable caption="Audit log" columns={columns} rows={q.data?.items ?? []} rowKey={(r) => r.id} loading={!q.data} skeletonRows={6} />}
        </div>
        {q.data && q.data.items.length >= 200 && <p className="border-t border-line px-4 py-3 text-xs text-muted sm:px-5">Showing the 200 most recent entries. Export includes up to 500.</p>}
      </Card>
    </>
  );
}
