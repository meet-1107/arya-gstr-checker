"use client";
import { useState } from "react";
import Link from "next/link";
import { Flag } from "lucide-react";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { Dialog } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import { OutcomeBadge } from "@/components/verify/outcome-badge";
import { errorMessage } from "@/lib/client/api";
import { formatDateTime } from "@/lib/client/format";
import { useApi, useApiCall, useInvalidate } from "@/lib/client/hooks";
import { CONCERN_DISCLAIMER, CONCERN_LABEL, MAX_RESOLUTION } from "@/lib/concerns";
import type { Concern, ConcernStatus } from "@/lib/store/types";

const TONE = { open: "amber", reviewed: "blue", closed: "neutral" } as const;
const LABEL = { open: "Open", reviewed: "Reviewed", closed: "Closed" } as const;

function ReviewDialog({ concern, onClose }: { concern: Concern; onClose: () => void }) {
  const call = useApiCall(); const invalidate = useInvalidate(); const { toast } = useToast();
  const [status, setStatus] = useState<ConcernStatus>(concern.status);
  const [resolution, setResolution] = useState(concern.resolution ?? "");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true); setErr(null);
    try { await call(`/api/concerns/${concern.id}`, { method: "PATCH", body: { status, resolution } }); await invalidate("/api/concerns", "/api/audit-logs"); toast({ tone: "success", title: "Concern updated" }); onClose(); }
    catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Review concern" description={`${CONCERN_LABEL[concern.category]} · ${concern.gstin}`}
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button></>}>
      <div className="space-y-4">
        <p className="whitespace-pre-wrap rounded-lg bg-surface-muted p-3 text-sm">{concern.description}</p>
        <div><label htmlFor="rv-status" className="text-[13px] font-medium">Status</label>
          <Select id="rv-status" className="mt-1.5" value={status} onChange={(e) => setStatus(e.target.value as ConcernStatus)}><option value="open">Open</option><option value="reviewed">Reviewed</option><option value="closed">Closed</option></Select></div>
        <div><label htmlFor="rv-res" className="text-[13px] font-medium">What was done <span className="font-normal text-muted">(optional)</span></label>
          <textarea id="rv-res" value={resolution} onChange={(e) => setResolution(e.target.value)} rows={3} maxLength={MAX_RESOLUTION + 100} className="mt-1.5 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm shadow-card hover:border-muted focus-visible:border-info" /></div>
        {err && <p role="alert" className="text-xs text-danger-strong">{err}</p>}
      </div>
    </Dialog>
  );
}

export default function ConcernsPage() {
  const { can, status: sess } = useSession();
  const [status, setStatus] = useState("");
  const [review, setReview] = useState<Concern | null>(null);
  const allowed = can("checks:run");
  const q = useApi<{ items: Concern[] }>(allowed ? `/api/concerns${status ? `?status=${status}` : ""}` : null);
  if (sess === "ready" && !allowed) return <><PageHeader title="Concerns" /><Alert tone="warning" title="You don't have access to concerns">Ask an owner or admin to give you the Accountant role.</Alert></>;
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader title="Concerns" description="Things your team has flagged about a GSTIN. Internal to your organization." />
      <Alert tone="info" className="mb-4 sm:mb-6">{CONCERN_DISCLAIMER}</Alert>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 sm:px-5 sm:pt-5">
          <h2 className="text-[15px] font-semibold">All concerns</h2>
          <div className="w-40"><label htmlFor="cs" className="sr-only">Filter by status</label>
            <Select id="cs" className="!h-9" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option><option value="open">Open</option><option value="reviewed">Reviewed</option><option value="closed">Closed</option></Select></div>
        </div>
        <div className="mt-3">
          {q.isLoading ? <ul className="divide-y divide-line">{[0, 1, 2].map((i) => <li key={i} className="space-y-2 px-4 py-4 sm:px-5"><Skeleton className="h-4 w-56" /><Skeleton className="h-3.5 w-72" /></li>)}</ul>
            : q.error ? <ErrorState onRetry={() => void q.mutate()} detail={q.error.code} />
            : items.length === 0 ? <EmptyState className="!py-10" icon={<Flag />} title={status ? "No concerns with this status" : "No concerns yet"} description="Use “Report a concern” on a verification result to flag a GSTIN for your team." />
            : <ul className="divide-y divide-line">{items.map((c) => (
                <li key={c.id} className="px-4 py-4 sm:px-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={TONE[c.status]}>{LABEL[c.status]}</Badge>
                    <Link href={`/verify?gstin=${c.gstin}`} className="font-mono text-[13px] hover:underline">{c.gstin}</Link>
                    <span className="text-sm font-medium">{CONCERN_LABEL[c.category]}</span>
                    {c.snapshot && <span className="inline-flex items-center gap-1.5 text-xs text-muted">at the time: <OutcomeBadge outcome={c.snapshot.outcome} /></span>}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-sm">{c.description}</p>
                  {c.resolution && <p className="mt-2 rounded-lg bg-surface-muted p-2.5 text-[13px]"><span className="font-medium">What was done: </span>{c.resolution}</p>}
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                    <span>Reported {formatDateTime(c.createdAt)}{c.updatedAt ? ` · updated ${formatDateTime(c.updatedAt)}` : ""}</span>
                    {can("auditlog:read") && <Button size="sm" variant="secondary" onClick={() => setReview(c)}>Review</Button>}
                  </div>
                </li>))}</ul>}
        </div>
      </Card>
      {review && <ReviewDialog key={review.id} concern={review} onClose={() => setReview(null)} />}
    </>
  );
}
