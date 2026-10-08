"use client";
import Link from "next/link";
import { AlertTriangle, BadgeCheck, CheckCircle2, FileUp, Gauge, ListChecks, Plus, RefreshCw, SearchCheck, Users } from "lucide-react";
import { useSession } from "@/components/session";
import { QuickVerify } from "@/components/verify/quick-verify";
import { PageHeader } from "@/components/shell/page-header";
import { IndicatorBadge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader, StatCard } from "@/components/ui/card";
import { EmptyState, ErrorState, ProgressBar, Skeleton } from "@/components/ui/feedback";
import { firstName, formatNumber, greeting, relativeTime } from "@/lib/client/format";
import { toQuery, useApi } from "@/lib/client/hooks";
import type { DashboardData, GstinItem, GstinList } from "@/lib/client/types";
import { INDICATOR_DISCLAIMER } from "@/lib/compliance";

function ReturnBar({ label, compliant, missing, late }: { label: string; compliant: number; missing: number; late: number }) {
  const total = compliant + missing;
  const pct = (n: number) => (total ? (n / total) * 100 : 0);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-medium">{label}</h3>
        <span className="tabular text-xs text-muted">{formatNumber(total)} GSTIN{total === 1 ? "" : "s"} with return data</span>
      </div>
      <div role="img" aria-label={`${label}: ${compliant} with no missing returns, ${missing} with missing returns`} className="flex h-2.5 overflow-hidden rounded-full bg-surface-muted">
        <div className="bg-success" style={{ width: `${pct(compliant)}%` }} />
        <div className="bg-danger" style={{ width: `${pct(missing)}%` }} />
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-success" aria-hidden /><span className="tabular font-medium">{formatNumber(compliant)}</span><span className="text-muted">up to date</span></li>
        <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-danger" aria-hidden /><span className="tabular font-medium">{formatNumber(missing)}</span><span className="text-muted">with missing returns</span></li>
        <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-warning" aria-hidden /><span className="tabular font-medium">{formatNumber(late)}</span><span className="text-muted">filed late</span></li>
      </ul>
    </div>
  );
}

function reason(g: GstinItem): string {
  const parts: string[] = [];
  if (g.status === "Suspended") parts.push("GSTIN suspended");
  if (g.status === "Cancelled") parts.push("GSTIN cancelled");
  if ((g.gstr3bMissing ?? 0) > 0) parts.push(`GSTR-3B missing (${g.gstr3bMissing})`);
  if ((g.gstr1Missing ?? 0) > 0) parts.push(`GSTR-1 missing (${g.gstr1Missing})`);
  if (!parts.length && ((g.gstr1Late ?? 0) > 0 || (g.gstr3bLate ?? 0) > 0)) parts.push("Late filings");
  return parts.join(" · ") || "Review recommended";
}

const OUTCOME = { SUCCESS: "Checked", CACHED: "From cache", FAILED: "Failed" } as const;

export default function DashboardPage() {
  const { user, can } = useSession();
  const dash = useApi<{ dashboard: DashboardData }>("/api/dashboard");
  const attn = useApi<GstinList>(`/api/gstins${toQuery({ indicator: "High Attention,Needs Attention", limit: 6 })}`);
  const d = dash.data?.dashboard;

  if (dash.error && !d) {
    return <><PageHeader title="Dashboard" /><Card><ErrorState title="We couldn't load your GST data" description="The dashboard reads your stored data only, so this is likely a temporary problem on our side." onRetry={() => void dash.mutate()} detail={dash.error.code} /></Card></>;
  }

  const loading = !d;
  const empty = d && d.clients.total === 0;

  return (
    <>
      <PageHeader
        title={`${greeting()}, ${firstName(user?.name, user?.email)}`}
        description="Here's your GST compliance overview."
        actions={<>
          {can("checks:run") && <ButtonLink href="/verify" variant="secondary"><SearchCheck className="size-4" aria-hidden />Verify GSTIN</ButtonLink>}
          {can("clients:write") && <ButtonLink href="/clients?new=1" variant="secondary"><Plus className="size-4" aria-hidden />Add client</ButtonLink>}
          {can("checks:run") && <ButtonLink href="/bulk-checks" variant="primary"><ListChecks className="size-4" aria-hidden />Run GST checks</ButtonLink>}
        </>}
      />

      {can("checks:run") && <QuickVerify />}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatCard loading={loading} label="Total clients" value={formatNumber(d?.clients.total)} icon={<Users />} href="/clients" hint={d && `${formatNumber(d.gstins.total)} GSTIN${d.gstins.total === 1 ? "" : "s"} monitored`} />
        <StatCard loading={loading} label="Active GSTINs" value={formatNumber(d?.gstins.active)} tone="green" icon={<BadgeCheck />} href="/gstins?status=Active" hint={d && `${formatNumber(d.gstins.suspended)} suspended · ${formatNumber(d.gstins.cancelled)} cancelled`} />
        <StatCard loading={loading} label="Needs attention" value={formatNumber(d?.attention.needsAttention)} tone={d && d.attention.needsAttention > 0 ? "amber" : "neutral"} icon={<AlertTriangle />} href="/gstins?attention=1" hint={d && (d.attention.highAttention > 0 ? `${formatNumber(d.attention.highAttention)} high attention` : "Nothing urgent")} />
        <StatCard loading={loading} label="Checks remaining" value={d?.quota.remaining === null ? "Custom" : formatNumber(d?.quota.remaining)} tone={d && d.quota.percent !== null && d.quota.percent >= 80 ? "amber" : "blue"} icon={<Gauge />} href="/billing" hint={d && (d.quota.limit === null ? "Custom limit" : `${formatNumber(d.quota.used)} of ${formatNumber(d.quota.limit)} used this month`)} />
      </div>

      {empty ? (
        <Card className="mt-4 sm:mt-6">
          <EmptyState icon={<Users />} title="No GST clients yet" description="Import your client list from a CSV, or add a client by hand, to start monitoring GSTIN status and GSTR-1 / GSTR-3B filings." action={can("clients:write") ? <>{can("imports:run") && <ButtonLink href="/clients/import" variant="brand"><FileUp className="size-4" aria-hidden />Import CSV</ButtonLink>}<ButtonLink href="/clients?new=1" variant="secondary"><Plus className="size-4" aria-hidden />Add a client</ButtonLink></> : undefined} />
        </Card>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:mt-6 sm:gap-6 xl:grid-cols-3">
          <div className="min-w-0 space-y-4 sm:space-y-6 xl:col-span-2">
            <Card>
              <CardHeader title="Compliance overview" description="Return filing across GSTINs whose history has been retrieved." />
              <CardBody className="space-y-6">
                {loading ? <><Skeleton className="h-16" /><Skeleton className="h-16" /></> : d.returns.gstr1.compliant + d.returns.gstr1.missing + d.returns.gstr3b.compliant + d.returns.gstr3b.missing === 0 ? (
                  <EmptyState className="!py-8" icon={<RefreshCw />} title="No return data yet" description="Run GST checks to retrieve GSTR-1 and GSTR-3B filing history for your clients." action={can("checks:run") ? <ButtonLink href="/bulk-checks" variant="secondary" size="sm">Run GST checks</ButtonLink> : undefined} />
                ) : (
                  <>
                    <ReturnBar label="GSTR-1" {...d.returns.gstr1} />
                    <ReturnBar label="GSTR-3B" {...d.returns.gstr3b} />
                    <p className="text-xs text-subtle">{d.returns.note}</p>
                  </>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Needs attention" description="Clients with suspended or cancelled GSTINs, or missing and late returns." action={<Link href="/gstins?attention=1" className="text-[13px] font-medium text-info-strong hover:underline">View all</Link>} />
              <div className="mt-3">
                {attn.isLoading ? (
                  <ul className="divide-y divide-line">{[0, 1, 2].map((i) => <li key={i} className="flex justify-between px-4 py-3.5 sm:px-5"><Skeleton className="h-4 w-48" /><Skeleton className="h-5 w-24" /></li>)}</ul>
                ) : attn.error ? (
                  <ErrorState title="Couldn't load this list" onRetry={() => void attn.mutate()} />
                ) : (attn.data?.items.length ?? 0) === 0 ? (
                  <EmptyState className="!py-10" icon={<CheckCircle2 />} title={d && d.gstins.total - d.gstins.neverChecked === 0 ? "Nothing checked yet" : "Nothing needs attention"} description={d && d.gstins.total - d.gstins.neverChecked === 0 ? "Run your first GST checks to see which clients need follow-up." : "Every checked client is in good standing."} />
                ) : (
                  <ul className="divide-y divide-line">
                    {attn.data!.items.map((g) => (
                      <li key={g.gstin}>
                        <Link href={`/gstins/${g.gstin}`} className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-surface-hover sm:px-5 lg:px-6">
                          <span className="min-w-0"><span className="block truncate text-sm font-medium">{g.clientName ?? "Client"}</span><span className="block truncate text-xs text-muted">{reason(g)}</span></span>
                          <IndicatorBadge value={g.indicator} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p className="border-t border-line px-4 py-3 text-[11px] sm:px-5 lg:px-6 text-subtle">{INDICATOR_DISCLAIMER}</p>
            </Card>
          </div>

          <div className="min-w-0 space-y-4 sm:space-y-6">
            <Card>
              <CardHeader title="GST check usage" description="Shared by everyone in your organization." />
              <CardBody>
                {loading ? <Skeleton className="h-20" /> : d.quota.limit === null ? (
                  <p className="text-sm text-muted">{formatNumber(d.quota.used)} checks used this month · custom limit.</p>
                ) : (
                  <>
                    <div className="flex items-baseline justify-between"><span className="tabular text-2xl font-semibold">{formatNumber(d.quota.used)}</span><span className="tabular text-sm text-muted">of {formatNumber(d.quota.limit)}</span></div>
                    <ProgressBar className="mt-3" value={d.quota.used + d.quota.reserved} max={d.quota.limit} tone={(d.quota.percent ?? 0) >= 100 ? "red" : (d.quota.percent ?? 0) >= 80 ? "amber" : "brand"} label="GST checks used this month" />
                    <p className="tabular mt-3 text-xs text-muted">{formatNumber(d.quota.remaining)} remaining{d.quota.reserved > 0 && ` · ${formatNumber(d.quota.reserved)} reserved by running jobs`}</p>
                  </>
                )}
                <p className="mt-3 border-t border-line pt-3 text-xs text-subtle">Plan: <span className="font-medium text-foreground">{d?.subscription.planName ?? "…"}</span> · resets monthly</p>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="GSTIN status" />
              <CardBody className="space-y-2.5 pt-4">
                {loading ? <Skeleton className="h-28" /> : [
                  ["Active", d.gstins.active, "bg-success"], ["Suspended", d.gstins.suspended, "bg-warning"], ["Cancelled", d.gstins.cancelled, "bg-danger"],
                  ["Inactive", d.gstins.inactive, "bg-subtle"], ["Not checked", d.gstins.neverChecked, "bg-subtle"],
                ].map(([label, n, dot]) => (
                  <div key={label as string} className="flex items-center justify-between text-sm"><span className="flex items-center gap-2"><span className={`size-2 rounded-full ${dot}`} aria-hidden />{label}</span><span className="tabular font-medium">{formatNumber(n as number)}</span></div>
                ))}
                {d && d.gstins.needsRefresh > 0 && <Link href="/gstins?refresh=1" className="mt-1 block rounded-lg bg-info-soft px-3 py-2 text-xs text-info-strong hover:underline">{formatNumber(d.gstins.needsRefresh)} GSTIN{d.gstins.needsRefresh === 1 ? "" : "s"} due for a refresh</Link>}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Recent GST checks" />
              <div className="mt-2">
                {loading ? <ul className="space-y-3 p-4 sm:p-5">{[0, 1, 2].map((i) => <li key={i}><Skeleton className="h-4 w-full" /></li>)}</ul>
                  : d.recentChecks.length === 0 ? <p className="px-4 pb-4 pt-2 text-sm sm:px-5 sm:pb-5 text-muted">No checks have run yet.</p>
                  : <ul className="divide-y divide-line">{d.recentChecks.slice(0, 6).map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm sm:px-5 lg:px-6">
                      <Link href={`/gstins/${c.gstin}`} className="truncate font-mono text-xs hover:underline">{c.gstin}</Link>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-muted"><span className={c.outcome === "FAILED" ? "text-danger-strong" : ""}>{OUTCOME[c.outcome]}</span><span>· {relativeTime(c.at)}</span></span>
                    </li>))}</ul>}
              </div>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
