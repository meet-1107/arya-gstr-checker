"use client";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { CheckCircle2, CircleHelp, Clock, RefreshCw, ScanLine, SearchCheck, WifiOff, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Alert, Spinner } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import dynamic from "next/dynamic";
import { OutcomeBadge } from "./outcome-badge";
// Loaded only when someone taps Scan (camera/QR code is ~never needed on first paint).
const GstinScanner = dynamic(() => import("./scanner").then((m) => m.GstinScanner), { ssr: false });
import { CopyGstin, SaveButton, ShareMenu } from "./result-actions";
import { AddClientButton, NotesEditor } from "./result-notes";
import { AboutResult, ReportConcernButton } from "./trust-bits";
import { useSession } from "@/components/session";
import { extractGstins } from "@/lib/gstin-extract";
import { formatDate, formatDateTime } from "@/lib/client/format";
import { useGstinVerification } from "@/lib/client/use-verification";
import { failureChecklist, failureOutcome, progressAt, STAGE_LABEL, type ClientFailure, type NetworkState, type RunStage } from "@/lib/client/verify-machine";
import { cn } from "@/lib/cn";
import { normalizeGstin, validateGstin } from "@/lib/gstin";
import { ageLabel, EXPLANATIONS, NOTICE_TEXT, INVALID_REASON_TEXT, isFailure, type VerificationOutcome, type VerificationView } from "@/lib/verification";

export { OutcomeBadge }; // re-exported so existing imports keep working

const toneBox = { success: "border-success/40 bg-success-soft", warning: "border-warning/40 bg-warning-soft", danger: "border-danger/40 bg-danger-soft", info: "border-info/40 bg-info-soft", neutral: "border-line bg-surface-muted" } as const;
const toneText = { success: "text-success-strong", warning: "text-warning-strong", danger: "text-danger-strong", info: "text-info-strong", neutral: "text-foreground" } as const;

const STAGES: RunStage[] = ["connecting", "fetching", "processing"];

function Progress({ elapsedMs, slowDismissed, onKeepWaiting, onRetry, network }: { elapsedMs: number; slowDismissed: boolean; onKeepWaiting: () => void; onRetry: () => void; network: NetworkState }) {
  const p = progressAt(elapsedMs);
  const showSlow = p.slow && !slowDismissed;
  return (
    <div className="space-y-4" aria-busy="true">
      <ol className="space-y-2.5 text-sm">
        <li className="flex items-center gap-2.5 text-success-strong"><CheckCircle2 className="size-4" aria-hidden />GSTIN format verified</li>
        {STAGES.map((s) => {
          const idx = STAGES.indexOf(s), cur = STAGES.indexOf(p.stage);
          return (
            <li key={s} className={cn("flex items-center gap-2.5", idx > cur && "text-subtle", idx === cur && "font-medium")}>
              {idx < cur ? <CheckCircle2 className="size-4 text-success-strong" aria-hidden /> : idx === cur ? <Spinner /> : <span className="size-4 rounded-full border border-line-strong" aria-hidden />}
              {STAGE_LABEL[s]}
            </li>
          );
        })}
      </ol>
      {showSlow && (
        <Alert tone="warning" title="Taking longer than usual">
          {network === "weak" ? "Your connection looks slow, and the GST verification service may be responding slowly too." : "The GST verification service is responding slowly."}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={onKeepWaiting}>Keep waiting</Button>
            <Button size="sm" variant="secondary" onClick={onRetry}><RefreshCw className="size-3.5" aria-hidden />Try again</Button>
          </div>
        </Alert>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return <div className="min-w-0"><dt className="text-xs text-muted">{label}</dt><dd className="mt-0.5 break-words text-sm font-medium">{value}</dd></div>;
}

const SKIP_TEXT = {
  provider_down: "Live refresh is paused because the verification service is unavailable.",
  provider_degraded: "Live refresh is paused because the verification service is slow right now.",
  quota: "Live refresh isn't available (no checks left this month, or the workspace is read-only).",
  capacity: "Live refresh is limited right now to protect verification capacity. The stored result is shown.",
} as const;

function Freshness({ v, onRefresh, canRefresh, refresh }: { v: VerificationView; onRefresh: () => void; canRefresh: boolean; refresh?: "running" | "updated" | "failed" }) {
  if (!v.verifiedAt) return null;
  const live = v.freshness === "live";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
      <span className={cn("inline-flex items-center gap-1.5 font-medium", live ? "text-success-strong" : "text-foreground")}>
        {live ? <CheckCircle2 className="size-4" aria-hidden /> : <Clock className="size-4" aria-hidden />}
        {live ? (v.outcome === "NOT_FOUND" ? "Checked live" : "Verified live") : `Stored result · verified ${ageLabel(v.ageSeconds ?? 0)}`}
      </span>
      <span>{formatDateTime(v.verifiedAt)}</span>
      {!live && v.staleness === "stale" && <Badge tone="amber">May be out of date</Badge>}
      {live && refresh === "updated" && <span className="font-medium text-success-strong">Updated just now</span>}
      {refresh === "running" && <span className="inline-flex items-center gap-1.5" role="status"><Spinner />Refreshing from the verification service…</span>}
      {!live && refresh !== "running" && canRefresh && <Button size="sm" variant="secondary" onClick={onRefresh}><RefreshCw className="size-3.5" aria-hidden />Verify live now</Button>}
      {refresh === "failed" && <p className="basis-full text-xs" role="status">Live refresh unavailable. Showing the stored result from {formatDateTime(v.verifiedAt)}.</p>}
      {v.refreshSkipped && refresh === undefined && !(v.refreshSkipped === "capacity" && v.notice) && <p className="basis-full text-xs">{SKIP_TEXT[v.refreshSkipped]}</p>}
      {v.joined && <p className="basis-full text-xs">Shared with a check that was already in progress: no extra lookup was used.</p>}
      {v.provenance === "SHARED_CACHE" && <p className="basis-full text-xs">Served from a recent shared result; no new lookup was made for you.</p>}
      {v.notice && <p className="basis-full text-xs font-medium" role="status">{NOTICE_TEXT[v.notice]}</p>}
    </div>
  );
}

function ResultCard({ v, onRetry, onRefresh, onAnother, canVerify, refresh }: { v: VerificationView; onRetry: () => void; onRefresh: () => void; onAnother: () => void; canVerify: boolean; refresh?: "running" | "updated" | "failed" }) {
  const e = EXPLANATIONS[v.outcome];
  const d = v.details;
  const { can } = useSession();
  const registry = !!d && (v.outcome !== "NOT_FOUND");
  return (
    <div className={cn("rounded-xl border p-4 sm:p-5", toneBox[e.tone])} aria-labelledby="verify-result-title">
      <div className="flex flex-wrap items-center gap-2"><OutcomeBadge outcome={v.outcome} /><span className="font-mono text-[13px] text-muted">{v.gstin}</span></div>
      {registry && <p className="mt-3 break-words text-lg font-semibold tracking-tight">{d.legalName ?? d.tradeName ?? "Name not provided"}</p>}
      <h2 id="verify-result-title" className={cn(registry ? "sr-only" : "mt-3 text-base font-semibold", toneText[e.tone])}>{e.title}</h2>
      <p className="mt-2 text-sm">{e.meaning}</p>
      {e.caveat && <p className="mt-2 text-sm font-medium">{e.caveat}</p>}
      {v.outcome === "NOT_FOUND" && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px]">
          <li>The GSTIN may have been typed or copied incorrectly.</li>
          <li>The registration may not exist in the available source.</li>
          <li>The verification service may be having a temporary problem.</li>
        </ul>
      )}
      {v.change && (
        <Alert tone={v.change.deteriorated ? "warning" : "info"} title={v.change.fields.includes("status") ? `Status changed: ${EXPLANATIONS[v.change.from].title} → ${EXPLANATIONS[v.change.to].title}` : "Registration details changed"} className="mt-4">
          {v.change.fields.includes("status") ? "This differs from the previous stored result. " : ""}
          {v.change.fields.filter((f) => f !== "status").length > 0 && `Changed: ${v.change.fields.filter((f) => f !== "status").join(", ")}. `}
          Review before relying on earlier information about this GSTIN.
        </Alert>
      )}
      {registry && (
        <dl className="mt-4 grid gap-x-6 gap-y-3 border-t border-line pt-4 sm:grid-cols-2">
          <Detail label="Legal name" value={d.legalName} />
          <Detail label="Trade name" value={d.tradeName} />
          <Detail label="Taxpayer type" value={d.taxpayerType} />
          <Detail label="State" value={d.state} />
          <Detail label="Registration date" value={d.registrationDate ? formatDate(d.registrationDate) : undefined} />
          <Detail label="Cancellation date" value={d.cancellationDate ? formatDate(d.cancellationDate) : undefined} />
        </dl>
      )}
      <div className="mt-4 space-y-2 border-t border-line pt-3">
        <Freshness v={v} onRefresh={onRefresh} canRefresh={canVerify} refresh={refresh} />
        {v.source && <p className="text-xs text-muted">Source: {v.source === "mock" ? "mock data (development)" : v.source}</p>}
        {v.outcome === "NOT_FOUND" && canVerify && <Button size="sm" variant="secondary" onClick={onRetry}><RefreshCw className="size-3.5" aria-hidden />Try again</Button>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <CopyGstin gstin={v.gstin} />
        <SaveButton key={v.requestId} view={v} canSave={canVerify} />
        <ShareMenu view={v} />
        <AddClientButton view={v} canAdd={can("clients:write")} />
        <Button size="sm" variant="ghost" onClick={onAnother} className="sm:ml-auto">Verify another</Button>
      </div>
      <div className="mt-3"><NotesEditor key={v.requestId} view={v} canEdit={canVerify} /></div>
      <div className="mt-2 flex flex-wrap items-start gap-1"><AboutResult view={v} /><ReportConcernButton view={v} canReport={canVerify} /></div>
    </div>
  );
}

function FailureCard({ outcome, network, checklist, retryable, retryAfterMs, requestId, lastKnown, onRetry, extra }: {
  outcome: VerificationOutcome; network: NetworkState; checklist: { label: string; ok: boolean }[]; retryable: boolean; retryAfterMs?: number;
  requestId?: string; lastKnown?: VerificationView["lastKnown"]; onRetry: () => void; extra?: ReactNode;
}) {
  const e = EXPLANATIONS[outcome];
  const [why, setWhy] = useState(false);
  const whyId = useId();
  return (
    <div className={cn("rounded-xl border p-4 sm:p-5", toneBox[e.tone])}>
      <div className="flex items-center gap-2"><OutcomeBadge outcome={outcome} /></div>
      <h2 className={cn("mt-3 text-base font-semibold", toneText[e.tone])}>{e.title}</h2>
      <p className="mt-2 text-sm">{e.meaning}</p>
      {e.caveat && <p className="mt-2 text-sm font-medium">{e.caveat}</p>}
      <ul className="mt-4 space-y-1.5 text-sm" aria-label="What we checked">
        {checklist.map((c) => (
          <li key={c.label} className="flex items-center gap-2">
            {c.ok ? <CheckCircle2 className="size-4 text-success-strong" aria-hidden /> : <XCircle className="size-4 text-danger-strong" aria-hidden />}
            <span><span className="sr-only">{c.ok ? "Yes: " : "No: "}</span>{c.label}</span>
          </li>
        ))}
      </ul>
      {lastKnown && (
        <div className="mt-4 rounded-lg border border-line bg-surface p-3 text-sm">
          <p className="font-medium">Last stored result (may be out of date)</p>
          <p className="mt-1 flex flex-wrap items-center gap-2"><OutcomeBadge outcome={lastKnown.outcome} /><span className="text-muted">verified {formatDateTime(lastKnown.verifiedAt)}</span></p>
        </div>
      )}
      {extra}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {retryable && <Button size="sm" variant="primary" onClick={onRetry}><RefreshCw className="size-3.5" aria-hidden />Try again</Button>}
        <Button size="sm" variant="ghost" aria-expanded={why} aria-controls={whyId} onClick={() => setWhy((w) => !w)}><CircleHelp className="size-3.5" aria-hidden />Why did this happen?</Button>
        {retryAfterMs ? <span className="text-xs text-muted">The service asked us to wait about {Math.max(1, Math.round(retryAfterMs / 1000))}s.</span> : null}
      </div>
      {why && (
        <div id={whyId} className="mt-3 rounded-lg border border-line bg-surface p-3 text-[13px] leading-relaxed">
          {outcome === "NETWORK_ERROR" ? (network === "offline" ? "Your device appears to be offline. GST verification needs an internet connection." : "Your request didn't reach our servers. This is usually a connection problem on your side or ours.")
            : "We asked the GST verification service about this GSTIN but didn't get a usable answer. That says nothing about the GSTIN itself — it can be valid, active and registered while the service is slow, busy or down."}
          {requestId && requestId !== "local" && <p className="mt-2 text-muted">Reference: <span className="font-mono">{requestId}</span></p>}
        </div>
      )}
    </div>
  );
}

function clientFailureView(f: ClientFailure, network: NetworkState, onRetry: () => void) {
  if (f.kind === "http") {
    const billing = f.code === "QUOTA_EXHAUSTED" || f.code === "SUBSCRIPTION_INACTIVE";
    return (
      <Alert tone="danger" title={f.code === "FORBIDDEN" ? "You don't have permission to verify GSTINs" : f.code === "QUOTA_EXHAUSTED" ? "No GST checks left this month" : "We couldn't start the verification"}
        action={billing ? <ButtonLink href="/billing" size="sm" variant="secondary" className="self-center">View plans</ButtonLink> : undefined}>
        {f.message}
      </Alert>
    );
  }
  const o = failureOutcome(f);
  const offline = f.kind === "offline";
  if (offline) {
    return (
      <div className="rounded-xl border border-warning/40 bg-warning-soft p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold text-warning-strong"><WifiOff className="size-4" aria-hidden />You&apos;re offline</h2>
        <p className="mt-2 text-sm">GST verification needs an internet connection. Check your connection and try again.</p>
        <p className="mt-2 text-sm font-medium">Your GSTIN has not been checked, and nothing was used from your quota.</p>
        <Button className="mt-4" size="sm" variant="primary" onClick={onRetry}><RefreshCw className="size-3.5" aria-hidden />Try again</Button>
      </div>
    );
  }
  return <FailureCard outcome={o} network={network} checklist={failureChecklist(f, network)} retryable onRetry={onRetry} />;
}

export function VerifyPanel({ canVerify, initial, autoRun }: { canVerify: boolean; initial?: string; autoRun?: boolean }) {
  const { state, network, start, cancel, keepWaiting } = useGstinVerification();
  const { toast } = useToast();
  const [text, setText] = useState(initial ?? "");
  const [scan, setScan] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ran = useRef(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const hintId = useId();

  const norm = normalizeGstin(text);
  const live = norm.length === 15 ? validateGstin(norm) : null;
  const submit = (e?: FormEvent, force = false) => { e?.preventDefault(); setNote(null); void start(text, { force }); };
  const retry = (force = false) => void start(state.status === "running" || state.status === "failed" ? state.gstin : text, { force });

  // Prefilled from a link (dashboard quick-verify, recent list): run once. Verification of a stored GSTIN is a cache hit, so this is cheap.
  useEffect(() => {
    if (!(autoRun && initial && canVerify) || ran.current) return;
    ran.current = true; void start(initial);
    // Reset on cleanup: React StrictMode (dev) mounts, unmounts (which aborts the in-flight request) and mounts again, and the second mount must run.
    return () => { ran.current = false; };
  }, [autoRun, initial, canVerify, start]);
  // Desktop: ready to type/paste immediately. Not on touch devices (it would pop the keyboard over the page).
  useEffect(() => {
    if (!initial && canVerify && window.matchMedia?.("(pointer: fine)").matches) inputRef.current?.focus();
  }, [initial, canVerify]);

  const another = () => { cancel(); setText(""); setNote(null); inputRef.current?.focus(); };
  const found = (g: string, others: string[]) => {
    setText(g); setNote(others.length ? `${others.length + 1} GSTINs were found; verifying the first. Use Bulk checks for many at once.` : null);
    void start(g);
  };
  // Pasting a block of text (invoice line, "GSTIN: …", a QR payload): pull the GSTIN out and verify it straight away.
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    const x = extractGstins(pasted);
    if (x.valid.length === 0) return; // let the browser paste as-is; the live hint explains what is wrong
    e.preventDefault();
    if (!canVerify) { setText(x.valid[0]); return; }
    found(x.valid[0], x.valid.slice(1));
    if (x.valid.length > 1) toast({ tone: "info", title: `${x.valid.length} GSTINs found`, description: "Verifying the first one." });
  };

  // Move focus to the outcome when a run settles so keyboard/screen-reader users land on it.
  const settled = state.status === "done" || state.status === "failed";
  useEffect(() => { if (settled) resultRef.current?.focus({ preventScroll: false }); }, [settled, state]);

  return (
    <Card>
      <CardBody>
        <form onSubmit={submit} noValidate>
          <label htmlFor="gstin-input" className="text-[13px] font-medium">GSTIN</label>
          <div className="mt-1.5 flex flex-wrap gap-2 sm:flex-nowrap">
            <Input
              id="gstin-input" ref={inputRef} onPaste={onPaste} value={text} onChange={(e) => setText(e.target.value.toUpperCase())} disabled={!canVerify}
              className="basis-full font-mono uppercase tracking-wide sm:basis-0 sm:flex-1" placeholder="e.g. 24AABCU9603R1ZM" maxLength={24} autoComplete="off" autoCapitalize="characters" spellCheck={false}
              enterKeyHint="search" aria-describedby={hintId} aria-invalid={live && !live.valid ? true : undefined}
            />
            {canVerify && <Button type="button" variant="secondary" size="lg" className="flex-1 sm:flex-none" onClick={() => setScan(true)} aria-label="Scan a GSTIN or QR code"><ScanLine className="size-4" aria-hidden /><span className="sm:sr-only">Scan</span></Button>}
            <Button type="submit" variant="primary" size="lg" loading={state.status === "running"} disabled={!canVerify || !norm} className="flex-[2] sm:w-36 sm:flex-none"><SearchCheck className="size-4" aria-hidden />Verify</Button>
          </div>
          {note && <p className="mt-1.5 text-xs text-info-strong" role="status">{note}</p>}
          <p id={hintId} className="mt-1.5 min-h-5 text-xs" aria-live="polite">
            {!canVerify ? <span className="text-muted">Your role can view past results but can&apos;t run new verifications.</span>
              : live ? (live.valid ? <span className="inline-flex items-center gap-1 text-success-strong"><CheckCircle2 className="size-3.5" aria-hidden />GSTIN format verified</span>
                : <span className="text-danger-strong">{INVALID_REASON_TEXT[live.reason]}</span>)
              : <span className="text-muted">15 characters. Spaces and lowercase are fine.</span>}
          </p>
        </form>

        {network === "offline" && <Alert tone="warning" title="You're offline" className="mt-4">GST verification needs an internet connection. You can still look at past results.</Alert>}
        {network === "weak" && <Alert tone="info" title="Your connection looks slow" className="mt-4">Verification may take longer than usual.</Alert>}

        {state.status === "done" && state.view.providerHealth && state.view.providerHealth !== "healthy" && (
          <Alert tone="info" title={state.view.providerHealth === "down" ? "The GST verification service is unavailable" : "The GST verification service is slow right now"} className="mt-4">
            Stored results are shown where we have them. {state.view.providerHealth === "down" ? "New live checks will resume automatically when it recovers." : "Background refreshes are paused to avoid piling on."}
          </Alert>
        )}

        <div ref={resultRef} tabIndex={-1} className="mt-5 outline-none" aria-live="polite" aria-atomic="false">
          {state.status === "running" && <Progress elapsedMs={state.elapsedMs} slowDismissed={state.slowDismissed} onKeepWaiting={keepWaiting} onRetry={() => retry(state.force)} network={network} />}
          {state.status === "failed" && clientFailureView(state.failure, network, () => retry())}
          {state.status === "done" && (() => {
            const v = state.view;
            if (v.outcome === "INVALID_GSTIN") {
              return <Alert tone="danger" title="Not a valid GSTIN">{v.invalidReason ? INVALID_REASON_TEXT[v.invalidReason] : EXPLANATIONS.INVALID_GSTIN.meaning} No lookup was made and nothing was used from your quota.</Alert>;
            }
            if (isFailure(v.outcome)) {
              return <FailureCard outcome={v.outcome} network={network} requestId={v.requestId} retryable={v.retryable} retryAfterMs={v.retryAfterMs} lastKnown={v.lastKnown} onRetry={() => retry(true)}
                checklist={[{ label: "Your GSTIN format is valid", ok: true }, { label: "Your internet connection is available", ok: true }, { label: "The verification service gave a usable answer", ok: false }]} />;
            }
            return <ResultCard v={v} canVerify={canVerify} refresh={state.refresh} onRetry={() => retry(true)} onRefresh={() => retry(true)} onAnother={another} />;
          })()}
        </div>
        {state.status === "running" && <div className="mt-3"><Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button></div>}
        {scan && <GstinScanner open={scan} onOpenChange={setScan} onFound={found} />}
        {state.status === "failed" && state.failure.kind === "http" && state.failure.code === "UNAUTHENTICATED" && <p className="mt-3 text-sm"><Link href="/login" className="underline">Sign in again</Link></p>}
      </CardBody>
    </Card>
  );
}
