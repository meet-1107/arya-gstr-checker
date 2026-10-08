"use client";
import { useState } from "react";
import { AlertTriangle, BadgeCheck, FileUp, ListChecks, RefreshCw, Users } from "lucide-react";
import { RunChecksDialog, type Selection } from "@/components/checks/run-checks-dialog";
import { JobStatusBadge, isActive } from "@/components/checks/job-ui";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Alert, EmptyState, ErrorState, ProgressBar, Skeleton } from "@/components/ui/feedback";
import { formatDateTime, formatNumber, relativeTime } from "@/lib/client/format";
import { useApi } from "@/lib/client/hooks";
import type { DashboardData, JobView } from "@/lib/client/types";
import { cn } from "@/lib/cn";

type Mode = Extract<Selection, { mode: string }>["mode"];

export default function BulkChecksPage() {
  const { can } = useSession();
  const [mode, setMode] = useState<Mode>("all");
  const [dialog, setDialog] = useState(false);
  const dash = useApi<{ dashboard: DashboardData }>("/api/dashboard");
  const jobs = useApi<{ jobs: JobView[] }>("/api/bulk-checks", { refreshInterval: (d) => (d?.jobs.some((j) => isActive(j.status)) ? 2500 : 0) });
  const d = dash.data?.dashboard;
  const run = can("checks:run");

  const OPTIONS: { id: Mode; icon: React.ReactNode; title: string; text: string; count?: number }[] = [
    { id: "all", icon: <Users />, title: "All clients", text: "Every GSTIN in your workspace", count: d?.gstins.total },
    { id: "never_checked", icon: <BadgeCheck />, title: "Never checked", text: "GSTINs with no check yet", count: d?.gstins.neverChecked },
    { id: "needs_refresh", icon: <RefreshCw />, title: "Due for refresh", text: "Cached data has expired", count: d?.gstins.needsRefresh },
    { id: "needs_attention", icon: <AlertTriangle />, title: "Needs attention", text: "Suspended, cancelled or missing returns", count: d?.attention.needsAttention },
  ];
  const selected = OPTIONS.find((o) => o.id === mode)!;

  const columns: Column<JobView>[] = [
    { key: "started", header: "Started", primary: true, cell: (j) => <span title={formatDateTime(j.createdAt)}>{relativeTime(j.createdAt)}{j.kind === "verify" ? <span className="ml-2 text-xs font-normal text-muted">GSTIN list</span> : null}</span> },
    { key: "status", header: "Status", badge: true, cell: (j) => <JobStatusBadge status={j.status} /> },
    { key: "progress", header: "Progress", cell: (j) => <div className="flex min-w-32 items-center gap-2"><ProgressBar size="sm" value={j.progress.percent} label="Job progress" tone={j.counts.failed ? "amber" : "brand"} /><span className="tabular w-9 text-xs text-muted">{j.progress.percent}%</span></div> },
    { key: "total", header: "GSTINs", align: "right", cell: (j) => <span className="tabular">{formatNumber(j.total)}</span> },
    { key: "failed", header: "Failed", align: "right", hideOnMobile: true, tabletHidden: true, cell: (j) => (j.counts.failed ? <span className="tabular text-danger-strong">{j.counts.failed}</span> : <span className="text-subtle">—</span>) },
    { key: "used", header: "Checks used", align: "right", hideOnMobile: true, tabletHidden: true, cell: (j) => <span className="tabular">{formatNumber(j.quota.consumed)}</span> },
  ];

  return (
    <>
      <PageHeader title="Bulk checks" description="Check many GSTINs at once. You'll see exactly what it will use before anything starts."
        actions={run ? <ButtonLink href="/verify/bulk" variant="secondary"><FileUp className="size-4" aria-hidden />Verify a list of GSTINs</ButtonLink> : undefined} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="New bulk check" description="Choose which clients to include." />
          <CardBody>
            {!run && <Alert tone="info" className="mb-4">Your role is read-only. Accountants, admins and owners can start checks.</Alert>}
            <fieldset disabled={!run} className="grid gap-3 sm:grid-cols-2">
              <legend className="sr-only">Clients to check</legend>
              {OPTIONS.map((o) => (
                <label key={o.id} className={cn("flex cursor-pointer items-start gap-3 rounded-xl border border-line-strong bg-surface p-4 shadow-card transition-colors has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring", !run && "opacity-60")}>
                  <input type="radio" name="mode" className="sr-only" checked={mode === o.id} onChange={() => setMode(o.id)} />
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-muted [&>svg]:size-4" aria-hidden>{o.icon}</span>
                  <span className="min-w-0 flex-1"><span className="flex items-baseline justify-between gap-2"><span className="text-sm font-medium">{o.title}</span>{d ? <span className="tabular text-sm font-semibold">{formatNumber(o.count)}</span> : <Skeleton className="h-4 w-8" />}</span><span className="mt-0.5 block text-xs text-muted">{o.text}</span></span>
                </label>
              ))}
            </fieldset>
            <div className="mt-5 flex items-center justify-between gap-4 border-t border-line pt-5">
              <p className="text-xs text-muted">Checks are shared by your whole organization{d?.quota.remaining !== undefined && d.quota.remaining !== null ? ` · ${formatNumber(d.quota.remaining)} remaining` : ""}.</p>
              <Button variant="primary" disabled={!run || !d || (selected.count ?? 0) === 0} onClick={() => setDialog(true)}><ListChecks className="size-4" aria-hidden />Review & run</Button>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="How it works" />
          <CardBody className="space-y-3 text-sm text-muted">
            <p><strong className="font-medium text-foreground">1.</strong> Review the number of checks, what&apos;s left and the time it should take.</p>
            <p><strong className="font-medium text-foreground">2.</strong> Those checks are held for the run, so nothing else can spend them.</p>
            <p><strong className="font-medium text-foreground">3.</strong> Only successful checks are used. Failed or cancelled ones are released.</p>
            <p><strong className="font-medium text-foreground">4.</strong> Re-run anything that failed with one click.</p>
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title="Recent runs" />
        <div className="mt-3">
          {jobs.error && !jobs.data ? <ErrorState onRetry={() => void jobs.mutate()} detail={jobs.error.code} /> : jobs.data && jobs.data.jobs.length === 0 ? (
            <EmptyState icon={<ListChecks />} title="No bulk checks yet" description="Runs you start will appear here with live progress." />
          ) : <DataTable caption="Recent bulk check runs" columns={columns} rows={jobs.data?.jobs ?? []} rowKey={(j) => j.id} href={(j) => `/bulk-checks/${j.id}`} loading={!jobs.data} skeletonRows={3} />}
        </div>
      </Card>
      {dialog && <RunChecksDialog key={mode} open onOpenChange={(o) => !o && setDialog(false)} selection={{ mode }} title={`Run GST checks · ${selected.title}`} />}
    </>
  );
}
