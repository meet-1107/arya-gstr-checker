"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Archive, ArchiveRestore, ExternalLink, FileUp, MoreHorizontal, Pencil, Play, Plus, Search, Trash2, Users } from "lucide-react";
import { ClientFormDialog } from "@/components/clients/client-form-dialog";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { Badge, IndicatorBadge, StatusBadge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CursorPager, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState, ErrorState } from "@/components/ui/feedback";
import { Input } from "@/components/ui/form";
import { ConfirmDialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/client/api";
import { relativeTime } from "@/lib/client/format";
import { toQuery, useApi, useApiCall, useInvalidate } from "@/lib/client/hooks";
import type { GstinItem, GstinList, SubscriptionOverview } from "@/lib/client/types";
import { usePager } from "@/lib/client/use-pager";
import { stateNameOf } from "@/lib/client-gstins";

function ClientsView() {
  const router = useRouter();
  const { can } = useSession();
  const call = useApiCall();
  const { toast } = useToast();
  const invalidate = useInvalidate();
  const [form, setForm] = useState<{ open: boolean; clientId?: string }>({ open: useSearchParams().get("new") === "1" });
  const [del, setDel] = useState<GstinItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState(""); const [term, setTerm] = useState("");
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 250); return () => clearTimeout(t); }, [q]);

  const [archived, setArchived] = useState(false);
  const pager = usePager(`${term}|${archived}`);
  const { data, error, isLoading, mutate } = useApi<GstinList>(`/api/gstins${toQuery({ q: term, archived: archived ? "true" : undefined, limit: 15, cursor: pager.cursor })}`, { keepPreviousData: true });
  const subscription = useApi<{ subscription: SubscriptionOverview }>("/api/subscription");
  const archivedCount = subscription.data?.subscription.clients.archived ?? 0;
  const write = can("clients:write"), run = can("checks:run");

  const check = async (g: GstinItem) => {
    setBusy(g.gstin);
    try { await call("/api/gst/check", { method: "POST", body: { clientId: g.clientId, gstin: g.gstin, force: true } }); await invalidate("/api/gstins", "/api/dashboard", "/api/subscription", "/api/returns"); toast({ tone: "success", title: "GST check complete", description: g.clientName }); }
    catch (e) { toast({ tone: "error", title: "Check failed", description: errorMessage(e) }); } finally { setBusy(null); }
  };

  const setArchivedState = async (g: GstinItem, to: boolean) => {
    setBusy(g.gstin);
    try {
      await call(`/api/clients/${g.clientId}/${to ? "archive" : "restore"}`, { method: "POST" });
      await invalidate("/api/clients", "/api/gstins", "/api/dashboard", "/api/subscription");
      toast({ tone: "success", title: to ? "Client archived" : "Client restored", description: to ? `${g.clientName ?? g.gstin} is no longer billed or checked. Restore it any time.` : `${g.clientName ?? g.gstin} counts toward your bill again.` });
    } catch (e) { toast({ tone: "error", title: to ? "Couldn't archive" : "Couldn't restore", description: errorMessage(e) }); } finally { setBusy(null); }
  };

  const columns: Column<GstinItem>[] = [
    { key: "name", header: "Client", primary: true, cell: (g) => <>{g.clientName ?? "Unnamed client"}{g.archived && <Badge className="ml-2 align-middle">Archived</Badge>}</> },
    { key: "gstin", header: "GSTIN", cell: (g) => <span className="font-mono text-[13px]">{g.gstin}{stateNameOf(g.gstin) && <span className="mt-0.5 block font-sans text-xs text-muted">{stateNameOf(g.gstin)}</span>}</span> },
    { key: "status", header: "GST status", badge: true, cell: (g) => <StatusBadge status={g.status} /> },
    { key: "ind", header: "Compliance", cell: (g) => <IndicatorBadge value={g.indicator} />, hideOnMobile: true, tabletHidden: true },
    { key: "last", header: "Last checked", cell: (g) => <span className="text-muted" title={g.lastCheckedAt}>{g.lastCheckedAt ? relativeTime(g.lastCheckedAt) : "Never"}</span> },
    { key: "act", header: "", align: "right", hideOnMobile: true, cell: (g) => (
      <div onClick={(e) => e.stopPropagation()}>
        <Menu>
          <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-surface-hover hover:text-foreground" aria-label={`Actions for ${g.clientName}`}><MoreHorizontal className="size-4" /></MenuTrigger>
          <MenuContent>
            <MenuItem onSelect={() => router.push(`/clients/${g.clientId}`)}><ExternalLink />Open client</MenuItem>
            {run && !g.archived && <MenuItem disabled={busy === g.gstin} onSelect={() => void check(g)}><Play />Run GST check</MenuItem>}
            {write && <MenuItem onSelect={() => setForm({ open: true, clientId: g.clientId })}><Pencil />Edit</MenuItem>}
            {write && (g.archived
              ? <MenuItem disabled={busy === g.gstin} onSelect={() => void setArchivedState(g, false)}><ArchiveRestore />Restore</MenuItem>
              : <MenuItem disabled={busy === g.gstin} onSelect={() => void setArchivedState(g, true)}><Archive />Archive (stop billing)</MenuItem>)}
            {write && <><MenuSeparator /><MenuItem danger onSelect={() => setDel(g)}><Trash2 />Delete</MenuItem></>}
          </MenuContent>
        </Menu>
      </div>) },
  ];

  const empty = !isLoading && !error && (data?.items.length ?? 0) === 0;
  return (
    <>
      <PageHeader title="Clients" description="Every client and their GSTIN status in one list."
        actions={write ? <>
          {can("imports:run") && <ButtonLink href="/clients/import" variant="secondary"><FileUp className="size-4" aria-hidden />Import CSV</ButtonLink>}
          <Button variant="primary" onClick={() => setForm({ open: true })}><Plus className="size-4" aria-hidden />Add client</Button>
        </> : undefined} />
      <Card>
        <div className="border-b border-line p-4">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <div className="relative w-full max-w-sm"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden /><label htmlFor="client-search" className="sr-only">Search clients</label>
              <Input id="client-search" className="h-9 pl-9" placeholder="Search by name or GSTIN" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            {(archivedCount > 0 || archived) && (
              <label className="flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" className="size-4 rounded accent-primary" checked={archived} onChange={(e) => setArchived(e.target.checked)} />Show archived only <span className="text-muted">({archivedCount})</span></label>
            )}
          </div>
        </div>
        {error && !data ? <ErrorState onRetry={() => void mutate()} detail={error.code} /> : empty ? (
          term ? <EmptyState icon={<Search />} title="No matching clients" description={`Nothing matches “${term}”. Try a GSTIN prefix or part of the name.`} />
            : <EmptyState icon={<Users />} title="No GST clients yet" description="Import your client list from a CSV, or add your first client by hand, to start monitoring GSTIN status and filings." action={write ? <>{can("imports:run") && <ButtonLink href="/clients/import" variant="brand"><FileUp className="size-4" aria-hidden />Import CSV</ButtonLink>}<Button variant="secondary" onClick={() => setForm({ open: true })}><Plus className="size-4" aria-hidden />Add client</Button></> : undefined} />
        ) : (
          <>
            <DataTable caption="Clients" columns={columns} rows={data?.items ?? []} rowKey={(g) => g.gstin} href={(g) => `/clients/${g.clientId}`} loading={isLoading && !data} />
            <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!data?.nextCursor} onPrev={pager.prev} onNext={() => data?.nextCursor && pager.next(data.nextCursor)} loading={isLoading} />
          </>
        )}
      </Card>

      <ClientFormDialog key={form.clientId ?? "new"} open={form.open} onOpenChange={(o) => setForm((f) => ({ ...f, open: o }))} clientId={form.clientId} />
      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} variant="danger" confirmLabel="Delete client" title={`Delete ${del?.clientName ?? "client"}?`}
        description="This removes the client, its GSTIN record and stored return history. It can't be undone."
        onConfirm={async () => { if (!del) return; try { await call(`/api/clients/${del.clientId}`, { method: "DELETE" }); await invalidate("/api/clients", "/api/gstins", "/api/dashboard", "/api/returns", "/api/subscription"); toast({ tone: "success", title: "Client deleted" }); } catch (e) { toast({ tone: "error", title: "Couldn't delete", description: errorMessage(e) }); } setDel(null); }} />
    </>
  );
}

export default function ClientsPage() { return <Suspense><ClientsView /></Suspense>; }
