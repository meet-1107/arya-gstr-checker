"use client";
import { useEffect } from "react";
import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, ErrorState, Skeleton } from "@/components/ui/feedback";
import { formatDate, formatNumber } from "@/lib/client/format";
import { useApi } from "@/lib/client/hooks";
import type { PrintSummary } from "@/lib/reports";
import { formatIst } from "@/lib/share";

/** The page prints in the light theme whatever the on-screen theme is, then restores it. */
function usePrintLight() {
  useEffect(() => {
    const root = document.documentElement; let prev: string | undefined;
    const before = () => { prev = root.dataset.theme; root.dataset.theme = "light"; };
    const after = () => { if (prev) root.dataset.theme = prev; };
    window.addEventListener("beforeprint", before); window.addEventListener("afterprint", after);
    return () => { window.removeEventListener("beforeprint", before); window.removeEventListener("afterprint", after); };
  }, []);
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return <div className="rounded-lg border border-line p-3"><dt className="text-xs text-muted">{label}</dt><dd className="mt-1"><span className="tabular block text-2xl font-semibold">{typeof value === "number" ? formatNumber(value) : value}</span>{hint && <span className="mt-0.5 block text-[11px] text-muted">{hint}</span>}</dd></div>;
}

export default function SummaryPage() {
  usePrintLight();
  const { data, error, isLoading, mutate } = useApi<{ summary: PrintSummary }>("/api/reports/summary");
  const s = data?.summary;
  if (error && !s) {
    const gated = error.code === "FEATURE_NOT_AVAILABLE";
    return (
      <>
        <PageHeader title="Monthly summary" />
        {gated ? <Alert tone="info" title="The printable summary isn't included in your plan" action={<ButtonLink href="/billing" size="sm" variant="secondary" className="self-center">View plans</ButtonLink>}>{error.message} The CSV reports are available on every plan.</Alert>
          : <Card><ErrorState onRetry={() => void mutate()} detail={error.code} /></Card>}
        <p className="mt-4 text-sm"><Link href="/reports" className="inline-flex items-center gap-1 underline"><ArrowLeft className="size-3.5" aria-hidden />Back to reports</Link></p>
      </>
    );
  }
  const p = s?.portfolio;
  return (
    <>
      <div className="no-print"><PageHeader title="Monthly summary" description="One page for your files or your clients. Use Print and choose “Save as PDF”."
        actions={<><ButtonLink href="/reports" variant="secondary"><ArrowLeft className="size-4" aria-hidden />Reports</ButtonLink><Button variant="primary" disabled={!s} onClick={() => window.print()}><Printer className="size-4" aria-hidden />Print / Save as PDF</Button></>} /></div>
      {isLoading || !s || !p ? <Skeleton className="h-96" /> : (
        <article aria-label="Monthly summary" className="space-y-4 sm:space-y-6">
          <header className="border-b border-line pb-3">
            <h2 className="text-xl font-semibold tracking-tight">{s.organization}</h2>
            <p className="text-sm text-muted">GST compliance summary · prepared {formatIst(s.generatedAt)} IST</p>
          </header>
          <section aria-labelledby="sum-portfolio">
            <h3 id="sum-portfolio" className="mb-2 text-[15px] font-semibold">Client portfolio</h3>
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Clients" value={p.total} /><Stat label="Active" value={p.byStatus.ACTIVE ?? 0} />
              <Stat label="Need attention" value={p.attention} hint="Suspended, cancelled, inactive or not found" /><Stat label="Changed recently" value={p.changedRecently} hint="Last 14 days" />
              <Stat label="Verified recently" value={p.byFreshness.fresh} /><Stat label="Out of date" value={p.byFreshness.stale + p.byFreshness.expired} /><Stat label="Never verified" value={p.byFreshness.never} /><Stat label="Scheduled" value={p.scheduled} />
            </dl>
            {s.truncated && <p className="mt-2 text-xs text-warning-strong">Only the first 5,000 clients are included.</p>}
          </section>
          <section aria-labelledby="sum-returns">
            <h3 id="sum-returns" className="mb-2 text-[15px] font-semibold">Filing position</h3>
            <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="GSTR-1 missing" value={s.returns.gstr1Missing} hint="GSTINs with a missing return" /><Stat label="GSTR-3B missing" value={s.returns.gstr3bMissing} hint="GSTINs with a missing return" />
              <Stat label="GSTR-1 filed late" value={s.returns.gstr1Late} hint="GSTINs with a late return" /><Stat label="GSTR-3B filed late" value={s.returns.gstr3bLate} hint="GSTINs with a late return" />
            </dl>
          </section>
          <Card inset className="print:border-0 print:shadow-none"><CardHeader title="Clients needing attention" description={s.attention.length === 25 ? "First 25, worst first." : undefined} />
            <CardBody>{s.attention.length === 0 ? <p className="text-sm text-muted">None right now.</p> : (
              <table className="w-full text-left text-sm"><caption className="sr-only">Clients needing attention</caption>
                <thead><tr className="border-b border-line text-xs text-muted"><th scope="col" className="py-2 pr-3 font-medium">Client</th><th scope="col" className="py-2 pr-3 font-medium">GSTIN</th><th scope="col" className="py-2 pr-3 font-medium">Status</th><th scope="col" className="py-2 font-medium">Verified</th></tr></thead>
                <tbody className="divide-y divide-line">{s.attention.map((r) => <tr key={r.gstin + r.name}><td className="py-2 pr-3 font-medium">{r.name}</td><td className="py-2 pr-3 font-mono text-xs">{r.gstin}</td><td className="py-2 pr-3">{r.status}</td><td className="py-2 text-muted">{r.verifiedAt ? formatDate(r.verifiedAt) : "—"}</td></tr>)}</tbody></table>)}</CardBody></Card>
          <Card inset className="print:border-0 print:shadow-none"><CardHeader title="Recent changes" />
            <CardBody>{s.changes.length === 0 ? <p className="text-sm text-muted">No changes detected in the last 14 days.</p> : (
              <table className="w-full text-left text-sm"><caption className="sr-only">Recent changes</caption>
                <thead><tr className="border-b border-line text-xs text-muted"><th scope="col" className="py-2 pr-3 font-medium">Client</th><th scope="col" className="py-2 pr-3 font-medium">GSTIN</th><th scope="col" className="py-2 pr-3 font-medium">Change</th><th scope="col" className="py-2 font-medium">Detected</th></tr></thead>
                <tbody className="divide-y divide-line">{s.changes.map((r) => <tr key={r.gstin + r.at}><td className="py-2 pr-3 font-medium">{r.name}</td><td className="py-2 pr-3 font-mono text-xs">{r.gstin}</td><td className="py-2 pr-3">{r.change} {r.deteriorated && <Badge tone="red">Worse</Badge>}</td><td className="py-2 text-muted">{formatDate(r.at)}</td></tr>)}</tbody></table>)}</CardBody></Card>
          <footer className="space-y-1 border-t border-line pt-3 text-xs text-muted">{s.notes.map((n) => <p key={n}>{n}</p>)}</footer>
        </article>
      )}
    </>
  );
}

