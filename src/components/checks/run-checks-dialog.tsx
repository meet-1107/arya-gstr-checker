"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Clock, Info } from "lucide-react";
import { useSession } from "@/components/session";
import { Alert, Skeleton } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage, type ApiError } from "@/lib/client/api";
import { formatNumber } from "@/lib/client/format";
import { useInvalidate } from "@/lib/client/hooks";
import type { Estimate, JobView } from "@/lib/client/types";

export type Selection = { clientIds: string[] } | { mode: "all" | "never_checked" | "needs_refresh" | "needs_attention" };

const duration = (s: number) => (s < 60 ? `${s} sec` : s < 3600 ? `about ${Math.ceil(s / 60)} min` : `about ${(s / 3600).toFixed(1)} hr`);

/**
 * Confirmation before any quota is spent: shows how many checks will be used, what remains afterwards and how long it takes.
 * The preview consumes nothing. Starting the job holds the units server-side; the Idempotency-Key makes double-clicks safe.
 */
export function RunChecksDialog({ open, onOpenChange, selection, title = "Run GST checks" }: { open: boolean; onOpenChange: (o: boolean) => void; selection: Selection; title?: string }) {
  const { activeOrgId } = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const invalidate = useInvalidate();
  const [includeReturns, setIncludeReturns] = useState(true);
  const [force, setForce] = useState(false);
  const [allowPartial, setAllowPartial] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [idemKey] = useState(() => `ui-${crypto.randomUUID()}`);

  const body = { ...selection, includeReturns, force, allowPartial };
  const key = open && activeOrgId ? ["preview", activeOrgId, JSON.stringify({ ...selection, includeReturns, force })] : null;
  const { data: est, error, isLoading } = useSWR<Estimate, ApiError>(key, () => api<{ estimate: Estimate }>("/api/bulk-checks/preview", { method: "POST", org: activeOrgId, body: { ...selection, includeReturns, force } }).then((r) => r.estimate), { revalidateOnFocus: false, shouldRetryOnError: false });

  const start = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ job: JobView; replay: boolean }>("/api/bulk-checks", { method: "POST", org: activeOrgId, body, headers: { "Idempotency-Key": `${idemKey}-${includeReturns}-${force}-${allowPartial}` } });
      await invalidate("/api/bulk-checks", "/api/subscription", "/api/dashboard");
      toast({ tone: "success", title: r.replay ? "Already running" : "GST checks started", description: `${formatNumber(r.job.total)} GSTIN${r.job.total === 1 ? "" : "s"} queued.` });
      onOpenChange(false);
      router.push(`/bulk-checks/${r.job.id}`);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };

  const insufficient = est && !est.quota.sufficient;
  const canStart = !!est && est.bulkAllowed && est.requested > 0 && (est.quota.sufficient || allowPartial) && !busy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description="Review before anything is used." footer={<>
      <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
      <Button variant="brand" onClick={start} loading={busy} disabled={!canStart}>Start checks</Button>
    </>}>
      {error ? <Alert tone="danger" title="Couldn't prepare this run">{error.message}</Alert> : isLoading || !est ? (
        <div className="space-y-3" aria-busy="true"><Skeleton className="h-5 w-48" /><Skeleton className="h-24 w-full" /></div>
      ) : (
        <div className="space-y-5">
          <p className="text-sm">You&apos;re about to check <strong className="tabular">{formatNumber(est.requested)}</strong> GSTIN{est.requested === 1 ? "" : "s"}.</p>
          <dl className="divide-y divide-line rounded-xl border border-line text-sm">
            <div className="flex justify-between px-4 py-3"><dt className="text-muted">Estimated usage</dt><dd className="tabular font-semibold">{formatNumber(est.needsLiveCheck)} check{est.needsLiveCheck === 1 ? "" : "s"}</dd></div>
            {est.servedFromCache > 0 && <div className="flex justify-between px-4 py-3"><dt className="text-muted">Served from recent cache (free)</dt><dd className="tabular font-medium">{formatNumber(est.servedFromCache)}</dd></div>}
            <div className="flex justify-between px-4 py-3"><dt className="text-muted">Remaining now</dt><dd className="tabular font-medium">{est.quota.remaining === null ? "Custom" : formatNumber(est.quota.remaining)}</dd></div>
            <div className="flex justify-between px-4 py-3"><dt className="text-muted">After this run</dt><dd className="tabular font-semibold">{est.quota.afterRemaining === null ? "Custom" : formatNumber(est.quota.afterRemaining)}</dd></div>
            <div className="flex items-center justify-between px-4 py-3"><dt className="flex items-center gap-1.5 text-muted"><Clock className="size-3.5" aria-hidden />Estimated time</dt><dd className="font-medium">{est.needsLiveCheck ? duration(est.estimatedSeconds) : "Instant"}</dd></div>
          </dl>

          <div className="space-y-3">
            <label className="flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 rounded accent-primary" checked={includeReturns} onChange={(e) => setIncludeReturns(e.target.checked)} /><span><span className="font-medium">Include GSTR-1 / GSTR-3B history</span><span className="block text-xs text-muted">Needed for filing status. Turn off for a faster, status-only check.</span></span></label>
            <label className="flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 rounded accent-primary" checked={force} onChange={(e) => setForce(e.target.checked)} /><span><span className="font-medium">Refresh even if recently checked</span><span className="block text-xs text-muted">By default fresh results are reused and don&apos;t use your allowance.</span></span></label>
          </div>

          {!est.bulkAllowed && <Alert tone="warning" title="Bulk checks aren't included in your plan">Upgrade to check more than one client at a time.</Alert>}
          {insufficient && est.bulkAllowed && (
            <Alert tone="warning" title="Not enough checks remaining">
              This run needs {formatNumber(est.needsLiveCheck)} but only {formatNumber(est.quota.remaining)} are left.
              <label className="mt-2 flex cursor-pointer items-center gap-2"><input type="checkbox" className="size-4 accent-primary" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} />Check as many as remaining ({formatNumber(est.quota.remaining)}) and skip the rest</label>
            </Alert>
          )}
          {est.skipped > 0 && <Alert tone="info">{est.skipped} selected item(s) couldn&apos;t be found and will be skipped.</Alert>}
          {err && <Alert tone="danger">{err}</Alert>}
          <p className="flex gap-2 text-xs text-subtle"><Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />Checks are shared by your whole organization. Anything that fails is not charged.</p>
        </div>
      )}
    </Dialog>
  );
}
