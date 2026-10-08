"use client";
import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, BadgeCheck, CalendarClock, Clock, RefreshCw, Users, Waypoints } from "lucide-react";
import { RefreshDialog, type RefreshScope } from "@/components/portfolio/refresh-dialog";
import { ScheduleDialog } from "@/components/portfolio/schedule-dialog";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, StatCard } from "@/components/ui/card";
import { CursorPager, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState, ErrorState } from "@/components/ui/feedback";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/client/api";
import { Input, Select } from "@/components/ui/form";
import { VerificationCostCard } from "@/components/verify/cost-card";
import { OutcomeBadge } from "@/components/verify/outcome-badge";
import { formatNumber } from "@/lib/client/format";
import { toQuery, useApi, useApiCall, useInvalidate } from "@/lib/client/hooks";
import { usePager } from "@/lib/client/use-pager";
import { SCHEDULE_LABEL, type PortfolioFreshness, type PortfolioRow, type PortfolioSummary } from "@/lib/portfolio";
import { ageLabel, EXPLANATIONS, type VerificationOutcome } from "@/lib/verification";

interface PortfolioList { items: PortfolioRow[]; total: number; nextCursor?: string; summary: PortfolioSummary; truncated: boolean }

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All statuses" }, { value: "ACTIVE", label: "Active" }, { value: "SUSPENDED", label: "Suspended" }, { value: "CANCELLED", label: "Cancelled" },
  { value: "INACTIVE", label: "Inactive" }, { value: "NOT_FOUND", label: "No registration found" }, { value: "never", label: "Not verified yet" },
];
const FRESH_OPTIONS: { value: string; label: string }[] = [{ value: "", label: "Any freshness" }, { value: "fresh", label: "Fresh" }, { value: "stale", label: "Stale" }, { value: "expired", label: "Expired" }, { value: "never", label: "Never verified" }];
const SORTS = [{ value: "name", label: "Sort: name" }, { value: "attention", label: "Sort: needs attention first" }, { value: "oldest", label: "Sort: least recently verified" }];
const TIER: Record<Exclude<PortfolioFreshness, "never">, { tone: "green" | "amber" | "red"; label: string }> = { fresh: { tone: "green", label: "Fresh" }, stale: { tone: "amber", label: "Stale" }, expired: { tone: "red", label: "Expired" } };

function Verified({ r }: { r: PortfolioRow }) {
  if (!r.verifiedAt || r.freshness === "never") return <span className="text-muted">Never</span>;
  const t = TIER[r.freshness];
  const age = ageLabel(r.ageSeconds ?? 0);
  return <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="text-muted">{age}</span><Badge tone={t.tone}>{t.label}</Badge></span>;
}

function PortfolioView() {
  const { can } = useSession();
  const router = useRouter(); const call = useApiCall(); const invalidate = useInvalidate(); const { toast } = useToast();
  const [runningDue, setRunningDue] = useState(false);
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [fresh, setFresh] = useState(sp.get("freshness") ?? "");
  const [sort, setSort] = useState(sp.get("sort") ?? "name");
  const attention = sp.get("attention") === "1", changed = sp.get("changed") === "1", needs = sp.get("needsRefresh") === "1";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [refresh, setRefresh] = useState<RefreshScope | null>(null);
  const [schedule, setSchedule] = useState<{ ids: string[] | null } | null>(null);

  const filters = { q: q.trim() || undefined, status: status || undefined, freshness: fresh || undefined, sort, attention: attention ? 1 : undefined, changed: changed ? 1 : undefined, needsRefresh: needs ? 1 : undefined };
  const key = JSON.stringify(filters);
  const pager = usePager(key);
  const { data, error, isLoading, mutate } = useApi<PortfolioList>(`/api/portfolio${toQuery({ ...filters, limit: 20, cursor: pager.cursor })}`, { keepPreviousData: true });
  const rows = useMemo(() => data?.items ?? [], [data]);
  const s = data?.summary;
  const run = can("checks:run"), write = can("clients:write");
  const filtered = !!(filters.q || status || fresh || attention || changed || needs);
  const pageAll = rows.length > 0 && rows.every((r) => selected.has(r.clientId));
  const toggle = (id: string) => setSelected((x) => { const n = new Set(x); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const togglePage = () => setSelected((x) => { const n = new Set(x); for (const r of rows) { if (pageAll) n.delete(r.clientId); else n.add(r.clientId); } return n; });

  const columns: Column<PortfolioRow>[] = [
    ...(run ? [{ key: "sel", header: "", className: "w-10", hideOnMobile: true, cell: (r: PortfolioRow) => <input type="checkbox" aria-label={`Select ${r.name}`} className="size-4 rounded accent-primary" checked={selected.has(r.clientId)} onChange={() => toggle(r.clientId)} onClick={(e) => e.stopPropagation()} /> }] : []),
    { key: "name", header: "Client", primary: true, cell: (r) => <span>{r.name}{r.legalName && r.legalName.toLowerCase() !== r.name.toLowerCase() && <span className="block max-w-64 truncate text-xs font-normal text-muted">{r.legalName}</span>}</span> },
    { key: "gstin", header: "GSTIN", cell: (r) => <span className="font-mono text-[13px]">{r.gstin}</span> },
    { key: "status", header: "Latest status", badge: true, cell: (r) => (r.status ? <OutcomeBadge outcome={r.status} /> : <Badge tone="neutral">Not verified</Badge>) },
    { key: "verified", header: "Last verified", cell: (r) => <Verified r={r} /> },
    { key: "change", header: "Change", hideOnMobile: true, tabletHidden: true, cell: (r) => r.change
      ? <Badge tone={r.change.deteriorated ? "red" : "blue"}>{EXPLANATIONS[r.change.from as VerificationOutcome].title} → {EXPLANATIONS[r.change.to as VerificationOutcome].title}</Badge> : <span className="text-subtle">—</span> },
    { key: "schedule", header: "Schedule", hideOnMobile: true, tabletHidden: true, cell: (r) => (r.schedule ? <span className="inline-flex items-center gap-1 text-muted"><CalendarClock className="size-3.5" aria-hidden />{SCHEDULE_LABEL[r.schedule]}</span> : <span className="text-subtle">—</span>) },
  ];

  // Scheduled clients that are due: verified together in ONE background job (answers still fresh are not looked up again).
  const runDue = async () => {
    setRunningDue(true);
    try {
      const r = await call<{ started: boolean; jobId?: string }>("/api/portfolio/run-due", { method: "POST" });
      void invalidate("/api/portfolio", "/api/subscription", "/api/bulk-checks");
      if (r.jobId) router.push(`/bulk-checks/${r.jobId}`); else toast({ tone: "info", title: "Nothing is due right now" });
    } catch (e) { toast({ tone: "error", title: "Couldn't run the scheduled verification", description: errorMessage(e) }); }
    finally { setRunningDue(false); }
  };
  const reset = () => { setQ(""); setStatus(""); setFresh(""); };
  return (
    <>
      <PageHeader title="Client portfolio" description="Every client's latest GST status, how fresh it is, and what has changed — without paying to look up the same GSTIN twice."
        actions={<>
          {write && <ButtonLink href="/clients?new=1" variant="secondary"><Users className="size-4" aria-hidden />Add client</ButtonLink>}
          {write && <Button variant="secondary" onClick={() => setSchedule({ ids: selected.size ? [...selected] : null })}><CalendarClock className="size-4" aria-hidden />Schedule{selected.size ? ` (${selected.size})` : ""}</Button>}
          {run && s && s.due > 0 && <Button variant="secondary" loading={runningDue} onClick={() => void runDue()}><CalendarClock className="size-4" aria-hidden />Run {formatNumber(s.due)} due now</Button>}
          {run && <Button variant="primary" disabled={!s || s.total === 0} onClick={() => setRefresh(selected.size ? { kind: "selected", clientIds: [...selected] } : { kind: "needs_refresh" })}><RefreshCw className="size-4" aria-hidden />{selected.size ? `Verify selected (${selected.size})` : s && s.needsRefresh > 0 ? `Refresh ${formatNumber(s.needsRefresh)} that need it` : "Refresh"}</Button>}
        </>} />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-5">
        <StatCard loading={!s} label="Clients" value={formatNumber(s?.total)} icon={<Users />} href="/portfolio" hint={s && s.total > 0 ? `${formatNumber(s.byFreshness.fresh)} fresh` : undefined} />
        <StatCard loading={!s} label="Active" value={formatNumber(s?.byStatus.ACTIVE ?? 0)} tone="green" icon={<BadgeCheck />} href="/portfolio?status=ACTIVE" />
        <StatCard loading={!s} label="Attention" value={formatNumber(s?.attention)} tone={s && s.attention > 0 ? "amber" : "neutral"} icon={<AlertTriangle />} href="/portfolio?attention=1&sort=attention" hint="Suspended, cancelled, inactive or not found" />
        <StatCard loading={!s} label="To refresh" value={formatNumber(s?.needsRefresh)} tone={s && s.needsRefresh > 0 ? "blue" : "neutral"} icon={<Clock />} href="/portfolio?needsRefresh=1&sort=oldest" hint={s ? `${formatNumber(s.byFreshness.never)} never verified` : undefined} />
        <StatCard loading={!s} label="Changed" value={formatNumber(s?.changedRecently)} tone={s && s.changedRecently > 0 ? "red" : "neutral"} icon={<Waypoints />} href="/portfolio?changed=1" hint="Status or details differ from the last check" />
      </div>

      <Card className="mt-4 sm:mt-6">
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <div className="w-full sm:w-64"><label htmlFor="pq" className="sr-only">Search clients</label><Input id="pq" className="h-9" placeholder="Search name, legal name or GSTIN" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="w-[calc(50%-6px)] sm:w-44"><label htmlFor="ps" className="sr-only">Status</label><Select id="ps" className="!h-9" value={status} onChange={(e) => setStatus(e.target.value)}>{STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></div>
          <div className="w-[calc(50%-6px)] sm:w-40"><label htmlFor="pf" className="sr-only">Freshness</label><Select id="pf" className="!h-9" value={fresh} onChange={(e) => setFresh(e.target.value)}>{FRESH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></div>
          <div className="w-full sm:w-56"><label htmlFor="po" className="sr-only">Sort</label><Select id="po" className="!h-9" value={sort} onChange={(e) => setSort(e.target.value)}>{SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select></div>
          {(filtered) && <Link href="/portfolio" onClick={reset} className="inline-flex h-9 items-center text-[13px] text-muted hover:text-foreground">Clear filters</Link>}
        </div>
        {data?.truncated && <p className="border-b border-line bg-warning-soft px-4 py-2 text-xs text-warning-strong" role="status">Showing the first 5,000 clients only.</p>}
        {error && !data ? <ErrorState onRetry={() => void mutate()} detail={error.code} /> : !isLoading && rows.length === 0 ? (
          <EmptyState icon={<Users />} title={filtered ? "No clients match these filters" : "No clients in your portfolio yet"} description={filtered ? "Try clearing a filter." : "Add clients, or import your client list, then verify them all in one go."}
            action={!filtered && write ? <><ButtonLink href="/clients/import" variant="brand">Import CSV</ButtonLink><ButtonLink href="/clients?new=1" variant="secondary">Add a client</ButtonLink></> : undefined} />
        ) : (
          <>
            {run && rows.length > 0 && <div className="hidden border-b border-line px-5 py-2 md:block"><label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" className="size-4 rounded accent-primary" checked={pageAll} onChange={togglePage} />Select all on this page{selected.size > 0 && <button className="ml-3 underline" onClick={() => setSelected(new Set())}>Clear selection ({selected.size})</button>}</label></div>}
            <DataTable caption="Client portfolio" columns={columns} rows={rows} rowKey={(r) => r.clientId} href={(r) => `/clients/${r.clientId}`} loading={isLoading && !data} />
            <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!data?.nextCursor} onPrev={pager.prev} onNext={() => data?.nextCursor && pager.next(data.nextCursor)} loading={isLoading} label={data ? `${formatNumber(data.total)} client${data.total === 1 ? "" : "s"} · page ${pager.page}` : undefined} />
          </>
        )}
      </Card>

      {can("auditlog:read") && <div className="mt-4 sm:mt-6"><VerificationCostCard /></div>}
      {refresh && <RefreshDialog open onOpenChange={(o) => !o && setRefresh(null)} scope={refresh} />}
      {schedule && <ScheduleDialog open onOpenChange={(o) => !o && setSchedule(null)} clientIds={schedule.ids} count={s?.total ?? 0} />}
    </>
  );
}

export default function PortfolioPage() {
  // Re-key on the quick-filter query so links from the summary cards reset the filters.
  return <Suspense><KeyedView /></Suspense>;
}
function KeyedView() { const sp = useSearchParams(); return <PortfolioView key={sp.toString()} />; }
