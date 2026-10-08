"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, FileUp, ListChecks, X } from "lucide-react";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, Skeleton } from "@/components/ui/feedback";
import { useToast } from "@/components/ui/toast";
import { api, errorMessage } from "@/lib/client/api";
import { looksLikeWorkbook, MAX_ENTRIES, MAX_FILE_BYTES, newIdempotencyKey, parseGstinList } from "@/lib/client/bulk-verify";
import { formatNumber } from "@/lib/client/format";
import { useApiCall, useInvalidate } from "@/lib/client/hooks";
import type { JobItemsPage, JobView, VerifyPreview } from "@/lib/client/types";
import { INVALID_REASON_TEXT } from "@/lib/verification";

const REASON = INVALID_REASON_TEXT as Record<string, string>;
const eta = (s: number) => (s < 90 ? "about a minute or less" : `about ${Math.ceil(s / 60)} minutes`);

function BulkVerifyView() {
  const { can, activeOrgId } = useSession();
  const call = useApiCall();
  const invalidate = useInvalidate();
  const { toast } = useToast();
  const router = useRouter();
  const from = useSearchParams().get("from");
  const [text, setText] = useState("");
  const [force, setForce] = useState(false);
  const [partial, setPartial] = useState(false);
  const [preview, setPreview] = useState<VerifyPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "start" | "load" | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());
  const loaded = useRef(false);
  const canRun = can("checks:run");

  const parsed = parseGstinList(text);
  const stale = () => { setPreview(null); setError(null); key.current = newIdempotencyKey(); };

  // "Run again" from a finished run: load its GSTINs (all pages) into the box.
  useEffect(() => {
    if (!from || !activeOrgId || loaded.current) return;
    loaded.current = true; setBusy("load");
    (async () => {
      const all: string[] = []; let cursor: string | undefined;
      for (let i = 0; i < 60; i++) {
        const p = await api<JobItemsPage>(`/api/bulk-checks/${encodeURIComponent(from)}/items?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { org: activeOrgId });
        all.push(...p.items.map((x) => x.gstin)); cursor = p.nextCursor; if (!cursor) break;
      }
      setText(all.join("\n"));
    })().catch((e) => setError(errorMessage(e))).finally(() => setBusy(null));
  }, [from, activeOrgId]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileNote(null); setError(null);
    if (f.size > MAX_FILE_BYTES) { setFileNote(`That file is ${(f.size / 1048576).toFixed(1)} MB; the limit is 2 MB. Split it or paste the GSTIN column instead.`); return; }
    const buf = await f.arrayBuffer();
    if (looksLikeWorkbook(f.name, new Uint8Array(buf.slice(0, 4)))) { setFileNote("Excel workbooks can't be read directly. Select the GSTIN column in Excel, copy it and paste it here — or save the sheet as CSV and upload that."); return; }
    setText(new TextDecoder("utf-8").decode(buf)); setFileNote(`Loaded ${f.name}`); stale();
  };

  const doPreview = async () => {
    setBusy("preview"); setError(null);
    try { setPreview((await call<{ preview: VerifyPreview }>("/api/bulk-verify/preview", { method: "POST", body: { gstins: parsed.entries, force } })).preview); }
    catch (e) { setPreview(null); setError(errorMessage(e)); } finally { setBusy(null); }
  };
  const start = async () => {
    setBusy("start"); setError(null);
    try {
      const r = await call<{ job: JobView; replay: boolean }>("/api/bulk-verify", { method: "POST", body: { gstins: parsed.entries, force, allowPartial: partial }, headers: { "Idempotency-Key": key.current } });
      await invalidate("/api/subscription", "/api/bulk-checks", "/api/dashboard");
      toast({ tone: "success", title: r.replay ? "This run was already started" : "Verification started", description: `${formatNumber(r.job.total)} GSTINs` });
      router.push(`/bulk-checks/${r.job.id}`);
    } catch (e) { setError(errorMessage(e)); setBusy(null); }
  };

  if (!canRun) {
    return <><PageHeader title="Verify many GSTINs" /><Card><CardBody><Alert tone="info" title="Your role can't run verifications">Ask an owner or admin to give you the Accountant role to verify lists of GSTINs.</Alert></CardBody></Card></>;
  }
  const q = preview?.quota;
  const blocked = !!preview && (preview.valid === 0 || !preview.bulkAllowed || (q && !q.sufficient && !partial));
  return (
    <>
      <Link href="/verify" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" aria-hidden />Verify a GSTIN</Link>
      <PageHeader title="Verify many GSTINs" description="Paste a list or upload a CSV. Check the preview, then run it. Nothing is used until you start, and invalid lines are never sent to the GST service." />
      <div className="grid grid-cols-1 gap-4 sm:gap-6 xl:grid-cols-3">
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader title="Your list" description="One per line, or any CSV / text copied from Excel — GSTINs are found wherever they are in each row." />
          <CardBody className="space-y-4">
            <div>
              <label htmlFor="bv-text" className="sr-only">GSTINs to verify</label>
              <textarea
                id="bv-text" value={text} onChange={(e) => { setText(e.target.value); stale(); }} rows={9} spellCheck={false} autoCapitalize="characters" disabled={busy === "load"}
                placeholder={"24AABCU9603R1ZM\n27AAPFU0939F1ZV\n…"}
                className="w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 font-mono text-[13px] leading-6 text-foreground shadow-card placeholder:text-subtle hover:border-muted focus-visible:border-info"
              />
              <p className="mt-1.5 text-xs text-muted" aria-live="polite">{busy === "load" ? "Loading the previous run…" : parsed.entries.length ? `${formatNumber(parsed.entries.length)} entries found in ${formatNumber(parsed.lines)} lines${parsed.truncated ? ` (only the first ${formatNumber(MAX_ENTRIES)} are used)` : ""}.` : "Nothing yet."}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium shadow-card hover:bg-surface-hover focus-within:ring-2 focus-within:ring-ring">
                <FileUp className="size-4" aria-hidden />Upload CSV or text
                <input type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" className="sr-only" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
              {text && <Button variant="ghost" size="sm" onClick={() => { setText(""); setFileNote(null); stale(); }}><X className="size-3.5" aria-hidden />Clear</Button>}
            </div>
            {fileNote && <Alert tone={fileNote.startsWith("Loaded") ? "success" : "warning"}>{fileNote}</Alert>}
            <label className="flex items-start gap-2.5 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 rounded accent-primary" checked={force} onChange={(e) => { setForce(e.target.checked); stale(); }} />
              <span><span className="font-medium">Verify again even if a stored result exists</span><span className="block text-xs text-muted">Uses one check per GSTIN. Leave off to reuse results from the last 24 hours at no cost.</span></span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={busy === "preview"} disabled={!parsed.entries.length || busy === "load"} onClick={() => void doPreview()}><ListChecks className="size-4" aria-hidden />Preview</Button>
            </div>
            {error && <Alert tone="danger" title="That didn't work">{error}</Alert>}
          </CardBody>
        </Card>

        <Card className="min-w-0">
          <CardHeader title="Preview" description="What starting this run would do." />
          <CardBody>
            {busy === "preview" ? <Skeleton className="h-40" /> : !preview ? <p className="text-sm text-muted">Add a list and choose Preview.</p> : (
              <div className="space-y-4">
                <dl className="space-y-2.5 text-sm">
                  <div className="flex justify-between"><dt className="text-muted">Valid GSTINs</dt><dd className="tabular font-semibold">{formatNumber(preview.valid)}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted">Reused from stored results</dt><dd className="tabular font-medium">{formatNumber(preview.servedFromCache)}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted">Live checks needed</dt><dd className="tabular font-semibold">{formatNumber(preview.needsLiveCheck)}</dd></div>
                  {preview.duplicates > 0 && <div className="flex justify-between"><dt className="text-muted">Duplicates ignored</dt><dd className="tabular font-medium">{formatNumber(preview.duplicates)}</dd></div>}
                  {preview.invalidCount > 0 && <div className="flex justify-between"><dt className="text-muted">Invalid, skipped</dt><dd className="tabular font-medium text-danger-strong">{formatNumber(preview.invalidCount)}</dd></div>}
                  <div className="flex justify-between border-t border-line pt-2.5"><dt className="text-muted">Allowance after</dt><dd className="tabular font-medium">{q && q.afterRemaining !== null ? `${formatNumber(q.afterRemaining)} of ${formatNumber(q.limit)}` : "Custom limit"}</dd></div>
                  {preview.needsLiveCheck > 0 && <div className="flex justify-between"><dt className="text-muted">Time</dt><dd className="font-medium">{eta(preview.estimatedSeconds)}</dd></div>}
                </dl>
                {preview.invalidCount > 0 && (
                  <details className="rounded-lg border border-line bg-surface-muted p-3 text-sm">
                    <summary className="cursor-pointer font-medium">See the {formatNumber(preview.invalidCount)} invalid {preview.invalidCount === 1 ? "entry" : "entries"}</summary>
                    <ul className="mt-2 max-h-48 space-y-1.5 overflow-auto text-[13px]">
                      {preview.invalid.map((i, n) => <li key={n}><span className="font-mono">{i.input || "(empty)"}</span><span className="block text-xs text-muted">{REASON[i.reason] ?? i.reason}</span></li>)}
                      {preview.invalidCount > preview.invalid.length && <li className="text-xs text-muted">…and {formatNumber(preview.invalidCount - preview.invalid.length)} more.</li>}
                    </ul>
                  </details>
                )}
                {!preview.bulkAllowed && <Alert tone="warning" title="Bulk verification isn't in your plan">Upgrade to verify more than one GSTIN at a time.</Alert>}
                {preview.valid === 0 && <Alert tone="danger" title="No valid GSTINs">Check the entries above — nothing would be verified.</Alert>}
                {q && !q.sufficient && preview.bulkAllowed && (
                  <Alert tone="warning" title="Not enough checks left">
                    You need {formatNumber(preview.needsLiveCheck)} but have {q.remaining === null ? "unlimited" : formatNumber(q.remaining)}.
                    <label className="mt-2 flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-0.5 size-4 rounded accent-primary" checked={partial} onChange={(e) => setPartial(e.target.checked)} />Run the ones my allowance covers and skip the rest</label>
                    <ButtonLink href="/billing" size="sm" variant="secondary" className="mt-2">View plans</ButtonLink>
                  </Alert>
                )}
                <Button variant="primary" className="w-full" loading={busy === "start"} disabled={!!blocked} onClick={() => void start()}>Start verification</Button>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

export default function BulkVerifyPage() { return <Suspense><BulkVerifyView /></Suspense>; }
