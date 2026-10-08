"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BadgeCheck, ListChecks, Search, X } from "lucide-react";
import { RunChecksDialog } from "@/components/checks/run-checks-dialog";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { IndicatorBadge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CursorPager, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState, ErrorState } from "@/components/ui/feedback";
import { Input, Select } from "@/components/ui/form";
import { relativeTime } from "@/lib/client/format";
import { toQuery, useApi } from "@/lib/client/hooks";
import type { GstinItem, GstinList } from "@/lib/client/types";
import { usePager } from "@/lib/client/use-pager";

const STATUS = ["Active", "Suspended", "Cancelled", "Inactive", "Unknown"] as const;
const MISSING = (n?: number) => (n === undefined ? <span className="text-subtle">—</span> : n === 0 ? <span className="text-success-strong">OK</span> : <span className="whitespace-nowrap font-medium text-danger-strong">{n} missing</span>);

function GstinsView() {
  const { can } = useSession();
  const sp = useSearchParams();
  const [q, setQ] = useState(""); const [term, setTerm] = useState("");
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [view, setView] = useState(sp.get("attention") ? "attention" : sp.get("refresh") ? "refresh" : sp.get("checked") === "false" ? "never" : "");
  const [sort, setSort] = useState("gstin");
  const [selected, setSelected] = useState<Map<string, string>>(new Map()); // gstin → clientId
  const [dialog, setDialog] = useState(false);
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  const filters = { q: term, status, indicator: view === "attention" ? "High Attention,Needs Attention" : "", needsRefresh: view === "refresh" ? "true" : "", checked: view === "never" ? "false" : "" };
  const [sortBy, dir] = sort.split(":");
  const key = JSON.stringify([filters, sort]);
  const pager = usePager(key);
  const { data, error, isLoading, mutate } = useApi<GstinList>(`/api/gstins${toQuery({ ...filters, sort: sortBy, dir: dir ?? "asc", limit: 20, cursor: pager.cursor })}`, { keepPreviousData: true });
  const rows = useMemo(() => data?.items ?? [], [data]);
  const pageAll = rows.length > 0 && rows.every((r) => selected.has(r.gstin));
  const run = can("checks:run");
  const filtered = !!(term || status || view);

  const toggle = (g: GstinItem) => setSelected((m) => { const n = new Map(m); if (n.has(g.gstin)) n.delete(g.gstin); else n.set(g.gstin, g.clientId); return n; });
  const togglePage = () => setSelected((m) => { const n = new Map(m); for (const r of rows) { if (pageAll) n.delete(r.gstin); else n.set(r.gstin, r.clientId); } return n; });

  const columns: Column<GstinItem>[] = [
    ...(run ? [{ key: "sel", header: "", className: "w-10", hideOnMobile: true, cell: (g: GstinItem) => <input type="checkbox" aria-label={`Select ${g.clientName ?? g.gstin}`} className="size-4 rounded accent-primary" checked={selected.has(g.gstin)} onChange={() => toggle(g)} onClick={(e) => e.stopPropagation()} /> }] : []),
    { key: "name", header: "Client", primary: true, cell: (g) => <>{g.clientName ?? "Unnamed client"}</> },
    { key: "gstin", header: "GSTIN", cell: (g) => <span className="font-mono text-[13px]">{g.gstin}</span> },
    { key: "status", header: "GST status", badge: true, cell: (g) => <StatusBadge status={g.status} /> },
    { key: "ind", header: "Compliance", tabletHidden: true, cell: (g) => <IndicatorBadge value={g.indicator} /> },
    { key: "g1", header: "GSTR-1", tabletHidden: true, cell: (g) => MISSING(g.gstr1Missing) },
    { key: "g3", header: "GSTR-3B", tabletHidden: true, cell: (g) => MISSING(g.gstr3bMissing) },
    { key: "last", header: "Last checked", cell: (g) => <span className={g.lastCheckedAt && !g.fresh ? "text-warning-strong" : "text-muted"} title={g.lastCheckedAt}>{g.lastCheckedAt ? relativeTime(g.lastCheckedAt) : "Never"}</span> },
  ];

  return (
    <>
      <PageHeader title="GSTINs" description="Monitor registration status and filing compliance across every GSTIN."
        actions={run ? <Button variant="primary" disabled={selected.size === 0} onClick={() => setDialog(true)}><ListChecks className="size-4" aria-hidden />{selected.size ? `Run checks (${selected.size})` : "Run checks"}</Button> : undefined} />
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <div className="relative w-full sm:w-64"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden /><label htmlFor="gq" className="sr-only">Search GSTINs</label><Input id="gq" className="h-9 pl-9" placeholder="Search name or GSTIN" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="w-[calc(50%-6px)] sm:w-40"><label htmlFor="gs" className="sr-only">Status</label><Select id="gs" className="!h-9" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{STATUS.map((s) => <option key={s} value={s}>{s === "Unknown" ? "Not checked" : s}</option>)}</Select></div>
          <div className="w-[calc(50%-6px)] sm:w-48"><label htmlFor="gv" className="sr-only">View</label><Select id="gv" className="!h-9" value={view} onChange={(e) => setView(e.target.value)}><option value="">All GSTINs</option><option value="attention">Needs attention</option><option value="refresh">Due for refresh</option><option value="never">Never checked</option></Select></div>
          <div className="w-[calc(50%-6px)] sm:w-44"><label htmlFor="go" className="sr-only">Sort</label><Select id="go" className="!h-9" value={sort} onChange={(e) => setSort(e.target.value)}><option value="gstin">Sort: GSTIN</option><option value="lastCheckedAt:desc">Sort: recently checked</option><option value="lastCheckedAt:asc">Sort: longest unchecked</option></Select></div>
          {filtered && <button className="inline-flex h-9 items-center gap-1 text-[13px] text-muted hover:text-foreground" onClick={() => { setQ(""); setStatus(""); setView(""); }}><X className="size-3.5" aria-hidden />Clear</button>}
        </div>
        {selected.size > 0 && <div className="flex items-center justify-between bg-info-soft px-4 py-2 text-sm text-info-strong"><span><strong>{selected.size}</strong> selected</span><button className="font-medium underline" onClick={() => setSelected(new Map())}>Clear selection</button></div>}
        {error && !data ? <ErrorState onRetry={() => void mutate()} detail={error.code} /> : !isLoading && rows.length === 0 ? (
          <EmptyState icon={<BadgeCheck />} title={filtered ? "No GSTINs match these filters" : "No GSTINs yet"} description={filtered ? "Try clearing a filter." : "Add clients to start monitoring their GSTINs."} />
        ) : (
          <>
            {run && rows.length > 0 && <div className="hidden border-b border-line px-5 py-2 md:block"><label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" className="size-4 rounded accent-primary" checked={pageAll} onChange={togglePage} />Select all on this page</label></div>}
            <DataTable caption="GSTINs" columns={columns} rows={rows} rowKey={(g) => g.gstin} href={(g) => `/gstins/${g.gstin}`} loading={isLoading && !data} />
            <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!data?.nextCursor} onPrev={pager.prev} onNext={() => data?.nextCursor && pager.next(data.nextCursor)} loading={isLoading} />
          </>
        )}
      </Card>
      {dialog && <RunChecksDialog key={[...selected.values()].join(",")} open onOpenChange={(o) => !o && setDialog(false)} selection={{ clientIds: [...selected.values()] }} title={`Run GST checks (${selected.size})`} />}
    </>
  );
}

export default function GstinsPage() { return <Suspense><GstinsView /></Suspense>; }
