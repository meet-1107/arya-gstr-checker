"use client";
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Download, RotateCcw, Repeat, Square } from "lucide-react";
import { OutcomeBadge } from "@/components/verify/outcome-badge";
import { ItemStatusBadge, JobStatusBadge, friendlyError, isActive } from "@/components/checks/job-ui";
import { useSession } from "@/components/session";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CursorPager, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState, ErrorState, ProgressBar, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { ConfirmDialog } from "@/components/ui/overlay";
import { ButtonLink } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { apiDownload, errorMessage, saveFile } from "@/lib/client/api";
import { formatDateTime, formatNumber } from "@/lib/client/format";
import { toQuery, useApi, useApiCall, useInvalidate } from "@/lib/client/hooks";
import type { JobItemsPage, JobView } from "@/lib/client/types";
import { usePager } from "@/lib/client/use-pager";

type Item = JobItemsPage["items"][number];

export default function BulkJobPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const call = useApiCall();
  const { toast } = useToast();
  const invalidate = useInvalidate();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const pager = usePager(status);

  const job = useApi<{ job: JobView }>(`/api/bulk-checks/${id}`, { refreshInterval: (d) => (!d || isActive(d.job.status) ? 2000 : 0) });
  const items = useApi<JobItemsPage>(`/api/bulk-checks/${id}/items${toQuery({ status, limit: 25, cursor: pager.cursor })}`, { keepPreviousData: true, refreshInterval: job.data && isActive(job.data.job.status) ? 4000 : 0 });
  const j = job.data?.job;
  const run = can("checks:run");
  const verify = j?.kind === "verify";
  const [exporting, setExporting] = useState(false);
  const { activeOrgId } = useSession();
  const exportCsv = async () => {
    setExporting(true);
    try {
      const { blob, truncated } = await apiDownload(`/api/bulk-checks/${id}/export`, { org: activeOrgId });
      saveFile(blob, `gstin-verification-${id.slice(0, 8)}.csv`);
      toast({ tone: truncated ? "info" : "success", title: truncated ? "Exported the first rows only" : "Export downloaded" });
    } catch (e) { toast({ tone: "error", title: "Couldn't export", description: errorMessage(e) }); } finally { setExporting(false); }
  };

  const act = async (kind: "cancel" | "retry-failed" | "resume") => {
    setBusy(kind);
    try {
      await call(`/api/bulk-checks/${id}/${kind}`, { method: "POST" });
      await Promise.all([job.mutate(), items.mutate(), invalidate("/api/subscription", "/api/dashboard", "/api/gstins")]);
      toast({ tone: "success", title: kind === "cancel" ? "Run cancelled — unused checks released" : kind === "retry-failed" ? "Retrying failed checks" : "Run resumed" });
    } catch (e) { toast({ tone: "error", title: "Couldn't do that", description: errorMessage(e) }); } finally { setBusy(null); setConfirmCancel(false); }
  };

  if (job.error && !j) return <><Link href="/bulk-checks" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" aria-hidden />Bulk checks</Link><Card><ErrorState title={job.error.status === 404 ? "We couldn't find this run" : "We couldn't load this run"} onRetry={job.error.status === 404 ? undefined : () => void job.mutate()} detail={job.error.code} /></Card></>;

  const active = !!j && isActive(j.status);
  const eta = j && j.estimatedSecondsRemaining > 0 ? (j.estimatedSecondsRemaining < 90 ? "about a minute" : `about ${Math.ceil(j.estimatedSecondsRemaining / 60)} min`) : null;
  const columns: Column<Item>[] = [
    { key: "gstin", header: "GSTIN", primary: true, cell: (i) => <Link href={verify ? `/verify?gstin=${i.gstin}` : `/gstins/${i.gstin}`} className="font-mono text-[13px] hover:underline" onClick={(e) => e.stopPropagation()}>{i.gstin}</Link> },
    { key: "status", header: "Result", badge: true, cell: (i) => (verify && i.verification ? <OutcomeBadge outcome={i.verification.outcome} /> : <ItemStatusBadge status={i.status} />) },
    ...(verify ? [{ key: "name", header: "Name", cell: (i: Item) => (i.verification?.outcome === "NOT_FOUND" ? <span className="text-muted">No registration found</span> : i.verification?.details?.legalName ?? <span className="text-subtle">—</span>) },
      { key: "tags", header: "Tags", hideOnMobile: true, tabletHidden: true, cell: (i: Item) => (i.verification?.tags?.length ? <span className="text-muted">{i.verification.tags.join(", ")}</span> : <span className="text-subtle">—</span>) }] : []),
    { key: "err", header: "Details", cell: (i) => (i.errorCode ? <span className="text-danger-strong">{friendlyError(i.errorCode)}{i.retryable ? " · can retry" : ""}</span> : <span className="text-subtle">—</span>) },
    { key: "att", header: "Attempts", align: "right", hideOnMobile: true, cell: (i) => <span className="tabular text-muted">{i.attempts}</span> },
  ];

  return (
    <>
      <Link href="/bulk-checks" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" aria-hidden />Bulk checks</Link>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          {!j ? <Skeleton className="h-8 w-64" /> : <><h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">{verify ? "GSTIN verification" : "Bulk check"} <JobStatusBadge status={j.status} /></h1><p className="mt-1 text-sm text-muted">Started {formatDateTime(j.createdAt)}{j.completedAt ? ` · finished ${formatDateTime(j.completedAt)}` : ""}</p></>}
        </div>
        {j && run && (
          <div className="flex flex-wrap gap-2">
            {verify && !active && <Button variant="secondary" loading={exporting} onClick={() => void exportCsv()}><Download className="size-4" aria-hidden />Export CSV</Button>}
            {verify && !active && <ButtonLink href={`/verify/bulk?from=${id}`} variant="secondary"><Repeat className="size-4" aria-hidden />Run again</ButtonLink>}
            {j.counts.failed > 0 && !active && j.status !== "cancelled" && <Button variant="secondary" loading={busy === "retry-failed"} onClick={() => act("retry-failed")}><RotateCcw className="size-4" aria-hidden />Retry {j.counts.failed} failed</Button>}
            {active && <Button variant="secondary" onClick={() => setConfirmCancel(true)}><Square className="size-4" aria-hidden />Cancel run</Button>}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Progress" description={active ? (eta ? `Roughly ${eta} remaining.` : "Working…") : undefined} />
          <CardBody>
            {!j ? <Skeleton className="h-24" /> : (
              <>
                <div className="flex items-baseline justify-between"><span className="tabular text-3xl font-semibold">{j.progress.percent}%</span><span className="tabular text-sm text-muted">{formatNumber(j.progress.done)} of {formatNumber(j.total)} done</span></div>
                <ProgressBar className="mt-3" value={j.progress.percent} label="Bulk check progress" tone={j.counts.failed ? "amber" : "brand"} />
                <dl className="mt-6 grid grid-cols-3 gap-4 sm:grid-cols-6">
                  {[["Queued", j.counts.queued], ["Checking", j.counts.processing], ["Checked", j.counts.succeeded], ["From cache", j.counts.cached], ["Failed", j.counts.failed], ["Cancelled", j.counts.cancelled]].map(([k, v]) => (
                    <div key={k as string}><dt className="text-xs text-muted">{k}</dt><dd className={`tabular mt-0.5 text-lg font-semibold ${k === "Failed" && (v as number) > 0 ? "text-danger-strong" : ""}`}>{formatNumber(v as number)}</dd></div>
                  ))}
                </dl>
                {active && run && <p className="mt-5 border-t border-line pt-4 text-xs text-muted">Not moving? <button className="font-medium underline" onClick={() => act("resume")} disabled={busy === "resume"}>Resume this run</button></p>}
              </>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Check usage" description="Shared by your organization." />
          <CardBody>
            {!j ? <Skeleton className="h-28" /> : (
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between"><dt className="text-muted">Needed live checks</dt><dd className="tabular font-medium">{formatNumber(j.quota.requested)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted">Held for this run</dt><dd className="tabular font-medium">{formatNumber(j.quota.reserved)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted">Used</dt><dd className="tabular font-semibold">{formatNumber(j.quota.consumed)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted">Released</dt><dd className="tabular font-medium">{formatNumber(j.quota.released)}</dd></div>
                {j.skipped > 0 && <div className="flex justify-between"><dt className="text-muted">Skipped</dt><dd className="tabular font-medium">{formatNumber(j.skipped)}</dd></div>}
              </dl>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
          <h2 className="text-[15px] font-semibold">Results</h2>
          <div className="w-44"><label htmlFor="rs" className="sr-only">Filter results</label><Select id="rs" className="!h-9" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All results</option><option value="succeeded">{verify ? "Verified live" : "Checked"}</option><option value="cached">From cache</option><option value="failed">Failed</option><option value="queued">Queued</option><option value="cancelled">Cancelled</option></Select></div>
        </div>
        <div className="mt-3">
          {items.error && !items.data ? <ErrorState onRetry={() => void items.mutate()} detail={items.error.code} /> : items.data && items.data.items.length === 0 ? <EmptyState title="No results to show" description={status ? "Nothing matches this filter." : "Results will appear as checks complete."} />
            : <><DataTable caption="Bulk check results" columns={columns} rows={items.data?.items ?? []} rowKey={(i) => i.id} loading={!items.data} skeletonRows={5} />
              <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!items.data?.nextCursor} onPrev={pager.prev} onNext={() => items.data?.nextCursor && pager.next(items.data.nextCursor)} loading={items.isLoading} /></>}
        </div>
      </Card>

      <ConfirmDialog open={confirmCancel} onOpenChange={setConfirmCancel} title="Cancel this run?" variant="danger" confirmLabel="Cancel run" loading={busy === "cancel"} onConfirm={() => act("cancel")}
        description="Checks that haven't started are cancelled and their reserved allowance is released. Checks already in progress will finish." />
    </>
  );
}
