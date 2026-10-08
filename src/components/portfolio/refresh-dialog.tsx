"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/feedback";
import { Dialog } from "@/components/ui/overlay";
import { errorMessage } from "@/lib/client/api";
import { newIdempotencyKey } from "@/lib/client/bulk-verify";
import { formatNumber } from "@/lib/client/format";
import { useApiCall, useInvalidate } from "@/lib/client/hooks";
import type { JobView } from "@/lib/client/types";

export type RefreshScope = { kind: "needs_refresh" | "attention" | "all" } | { kind: "selected"; clientIds: string[] };

interface Preview {
  valid: number; invalidCount: number; needsLiveCheck: number; servedFromCache: number; estimatedSeconds: number; bulkAllowed: boolean;
  quota: { limit: number | null; remaining: number | null; afterRemaining: number | null; sufficient: boolean };
}

const SCOPE_TITLE = { needs_refresh: "Refresh clients that need it", attention: "Re-verify clients needing attention", all: "Verify all clients", selected: "Verify selected clients" } as const;
const duration = (s: number) => (s < 60 ? "under a minute" : s < 3600 ? `about ${Math.ceil(s / 60)} min` : `about ${(s / 3600).toFixed(1)} hr`);

/**
 * "Verify all" the cost-aware way: shows what WILL be paid for (fresh answers are not looked up again) before anything starts,
 * then runs ONE background job — never a burst of requests from the browser.
 */
export function RefreshDialog({ open, onOpenChange, scope }: { open: boolean; onOpenChange: (o: boolean) => void; scope: RefreshScope }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={SCOPE_TITLE[scope.kind]} description="Review what will be verified before anything starts." size="md">
      {open && <Body scope={scope} onClose={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function Body({ scope, onClose }: { scope: RefreshScope; onClose: () => void }) {
  const call = useApiCall(); const invalidate = useInvalidate(); const router = useRouter();
  const [gstins, setGstins] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [force, setForce] = useState(false);
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const key = useRef(newIdempotencyKey());

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const g = await call<{ gstins: string[] }>("/api/portfolio/gstins", { method: "POST", body: scope.kind === "selected" ? { scope: "selected", clientIds: scope.clientIds } : { scope: scope.kind } });
        if (live) setGstins(g.gstins);
      } catch (e) { if (live) setError(errorMessage(e)); }
    })();
    return () => { live = false; };
  }, [call, scope]);

  useEffect(() => {
    if (!gstins || gstins.length === 0) return;
    let live = true;
    key.current = newIdempotencyKey(); // a different request is a different job
    (async () => {
      setPreview(null);
      try {
        const r = await call<{ preview: Preview }>("/api/bulk-verify/preview", { method: "POST", body: { gstins, force } });
        if (live) setPreview(r.preview);
      } catch (e) { if (live) setError(errorMessage(e)); }
    })();
    return () => { live = false; };
  }, [call, gstins, force]);

  const start = async () => {
    if (!gstins) return;
    setStarting(true); setError(null);
    try {
      const r = await call<{ job: JobView }>("/api/bulk-verify", { method: "POST", body: { gstins, force, allowPartial: partial }, headers: { "Idempotency-Key": key.current } });
      void invalidate("/api/portfolio", "/api/subscription", "/api/bulk-checks");
      onClose(); router.push(`/bulk-checks/${r.job.id}`);
    } catch (e) { setError(errorMessage(e)); setStarting(false); }
  };

  if (error && !preview) return <Alert tone="danger" title="Couldn't prepare this run">{error}</Alert>;
  if (gstins && gstins.length === 0) return <p className="text-sm">There are no clients in this selection.</p>;
  if (!preview) return <p className="flex items-center gap-2 text-sm" role="status"><Spinner />Working out what needs verifying…</p>;

  const q = preview.quota, nothing = preview.needsLiveCheck === 0;
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-3 gap-3 text-center">
        <div className="rounded-lg bg-surface-muted p-3"><dt className="text-xs text-muted">Clients</dt><dd className="tabular text-xl font-semibold">{formatNumber(preview.valid)}</dd></div>
        <div className="rounded-lg bg-surface-muted p-3"><dt className="text-xs text-muted">Already up to date</dt><dd className="tabular text-xl font-semibold">{formatNumber(preview.servedFromCache)}</dd></div>
        <div className="rounded-lg bg-info-soft p-3"><dt className="text-xs text-info-strong">Will be verified</dt><dd className="tabular text-xl font-semibold text-info-strong">{formatNumber(preview.needsLiveCheck)}</dd></div>
      </dl>
      {nothing ? <p className="text-sm">Everything in this selection was verified recently, so nothing needs a new lookup.</p> : (
        <ul className="space-y-1 text-sm">
          <li>Uses <strong className="tabular">{formatNumber(preview.needsLiveCheck)}</strong> of your checks{q.remaining !== null && <> — <span className="tabular">{formatNumber(q.remaining)}</span> remaining, <span className="tabular">{formatNumber(q.afterRemaining)}</span> after this run</>}.</li>
          <li>Runs in the background ({duration(preview.estimatedSeconds)}); you can leave this page.</li>
        </ul>
      )}
      {!preview.bulkAllowed && <Alert tone="warning" title="Bulk verification isn't included in your plan">Upgrade to verify many clients at once.</Alert>}
      {!q.sufficient && preview.bulkAllowed && (
        <Alert tone="warning" title="Not enough checks remaining for all of them">
          <label className="mt-1 flex items-center gap-2"><input type="checkbox" className="size-4 accent-primary" checked={partial} onChange={(e) => setPartial(e.target.checked)} />Verify as many as my remaining checks allow</label>
        </Alert>
      )}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={force} onChange={(e) => setForce(e.target.checked)} />
        <span>Verify again even if recently verified <span className="text-muted">(uses one check per client)</span></span></label>
      {error && <Alert tone="danger" title="Couldn't start">{error}</Alert>}
      <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        {preview.bulkAllowed
          ? <Button variant="primary" loading={starting} disabled={nothing && !force || (!q.sufficient && !partial)} onClick={() => void start()}><RefreshCw className="size-4" aria-hidden />{nothing && !force ? "Nothing to verify" : `Verify ${formatNumber(preview.needsLiveCheck)} now`}</Button>
          : <ButtonLink href="/billing" variant="primary">View plans</ButtonLink>}
      </div>
    </div>
  );
}
