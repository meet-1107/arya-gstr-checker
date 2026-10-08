"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Pencil, RefreshCw } from "lucide-react";
import { ClientFormDialog } from "@/components/clients/client-form-dialog";
import { ReturnsTable } from "@/components/returns/returns-table";
import { useSession } from "@/components/session";
import { IndicatorBadge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/client/api";
import { formatDateTime, relativeTime } from "@/lib/client/format";
import { toQuery, useApi, useApiCall, useInvalidate } from "@/lib/client/hooks";
import type { GstinDetail, ReturnsList } from "@/lib/client/types";
import { INDICATOR_DISCLAIMER } from "@/lib/compliance";
import { currentFinancialYear } from "@/lib/dates";

const Item = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="flex justify-between gap-4 border-b border-line py-3 text-sm last:border-0"><dt className="text-muted">{k}</dt><dd className="min-w-0 truncate text-right font-medium">{v ?? "—"}</dd></div>;

function ReturnsTab({ gstin, type }: { gstin: string; type: "GSTR1" | "GSTR3B" }) {
  const cur = currentFinancialYear();
  const start = parseInt(cur.slice(0, 4), 10);
  const fys = [0, 1, 2].map((i) => `${start - i}-${String((start - i + 1) % 100).padStart(2, "0")}`);
  const [fy, setFy] = useState(fys[0]);
  const { data, error, isLoading, mutate } = useApi<ReturnsList>(`/api/gstins/${gstin}/returns${toQuery({ returnType: type, fy, limit: 50, dir: "desc" })}`);
  return (
    <Card>
      <div className="flex items-end justify-between gap-3 border-b border-line p-4">
        <div className="w-44"><label htmlFor={`fy-${type}`} className="mb-1 block text-xs font-medium text-muted">Financial year</label><Select id={`fy-${type}`} className="!h-9" value={fy} onChange={(e) => setFy(e.target.value)}>{fys.map((f) => <option key={f}>{f}</option>)}</Select></div>
        <p className="text-xs text-subtle">Status is as of the last check.</p>
      </div>
      {error ? <ErrorState onRetry={() => void mutate()} detail={error.code} /> : !isLoading && (data?.items.length ?? 0) === 0
        ? <EmptyState title={`No ${type === "GSTR1" ? "GSTR-1" : "GSTR-3B"} data for ${fy}`} description="Refresh this GSTIN with return history included to retrieve filings." />
        : <ReturnsTable caption={`${type} returns`} rows={data?.items ?? []} loading={isLoading} />}
    </Card>
  );
}

export function GstinView({ gstin, backHref, backLabel }: { gstin: string; backHref: string; backLabel: string }) {
  const { can } = useSession();
  const call = useApiCall();
  const { toast } = useToast();
  const invalidate = useInvalidate();
  const [refreshing, setRefreshing] = useState(false);
  const [edit, setEdit] = useState(false);
  const { data, error, isLoading, mutate } = useApi<GstinDetail>(`/api/gstins/${gstin}`);

  if (error) {
    return <><Link href={backHref} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" aria-hidden />{backLabel}</Link>
      <Card><ErrorState title={error.status === 404 ? "We couldn't find this GSTIN" : "We couldn't load this GSTIN"} description={error.status === 404 ? "It may have been deleted, or it belongs to a different organization." : undefined} onRetry={error.status === 404 ? undefined : () => void mutate()} detail={error.code} /></Card></>;
  }
  const g = data?.gstin, c = data?.client;

  const refresh = async () => {
    if (!g) return;
    setRefreshing(true);
    try {
      await call("/api/gst/check", { method: "POST", body: { clientId: g.clientId, gstin: g.gstin, force: true } });
      await Promise.all([mutate(), invalidate("/api/gstins", "/api/dashboard", "/api/subscription", "/api/returns")]);
      toast({ tone: "success", title: "GST data refreshed" });
    } catch (e) { toast({ tone: "error", title: "Couldn't refresh", description: errorMessage(e) }); } finally { setRefreshing(false); }
  };

  return (
    <>
      <Link href={backHref} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"><ArrowLeft className="size-4" aria-hidden />{backLabel}</Link>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {isLoading || !g ? <><Skeleton className="h-8 w-72" /><Skeleton className="mt-3 h-4 w-48" /></> : (
            <>
              <h1 className="truncate text-2xl font-semibold tracking-tight">{g.clientName ?? g.legalName ?? gstin}</h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2"><span className="font-mono text-sm text-muted">{g.gstin}</span><StatusBadge status={g.status} /><IndicatorBadge value={g.indicator} /></div>
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
          <div className="flex gap-2">
            {c && can("clients:write") && <Button variant="secondary" onClick={() => setEdit(true)}><Pencil className="size-4" aria-hidden />Edit</Button>}
            {can("checks:run") && <Button variant="primary" onClick={refresh} loading={refreshing} disabled={!g}><RefreshCw className="size-4" aria-hidden />Refresh GST data</Button>}
          </div>
          {g && <p className="text-xs text-muted" title={g.lastCheckedAt}>{g.lastCheckedAt ? <>Last checked: {formatDateTime(g.lastCheckedAt)}{g.source ? ` · ${g.source}` : ""}</> : "Not checked yet"}</p>}
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList aria-label="GSTIN sections">
          {[["overview", "Overview"], ["gstin", "GSTIN"], ["gstr1", "GSTR-1"], ["gstr3b", "GSTR-3B"], ["compliance", "Compliance"], ["reports", "Reports"], ["activity", "Activity"]].map(([v, l]) => <TabsTrigger key={v} value={v}>{l}</TabsTrigger>)}
        </TabsList>

        <TabsContent value="overview">
          <div className="grid gap-6 lg:grid-cols-2">
            <Card><CardHeader title="GST status" /><CardBody>{!g ? <Skeleton className="h-28" /> : <dl>
              <Item k="Registration status" v={<StatusBadge status={g.status} />} />
              <Item k="Last checked" v={g.lastCheckedAt ? `${formatDateTime(g.lastCheckedAt)} (${relativeTime(g.lastCheckedAt)})` : "Never"} />
              <Item k="Data freshness" v={!g.lastCheckedAt ? "—" : g.fresh ? "Fresh" : "Stale — refresh recommended"} />
              {g.lastError && <Item k="Last problem" v={<span className="text-danger-strong">Provider error ({g.lastError.code.replace("GST_PROVIDER_", "").toLowerCase()})</span>} />}
            </dl>}</CardBody></Card>
            <Card><CardHeader title="Client" /><CardBody>{!g ? <Skeleton className="h-28" /> : c ? <dl>
              <Item k="Filing frequency" v={c.filingFrequency === "MONTHLY" ? "Monthly" : "Quarterly (QRMP)"} />
              <Item k="Contact person" v={c.contactPerson} /><Item k="Email" v={c.email} /><Item k="Phone" v={c.phone} />
            </dl> : <p className="text-sm text-muted">Client details unavailable.</p>}</CardBody></Card>
          </div>
        </TabsContent>

        <TabsContent value="gstin">
          <Card><CardHeader title="Registration details" description="As reported by the GST data provider at the last check." /><CardBody>{!g ? <Skeleton className="h-40" /> : <dl>
            <Item k="GSTIN" v={<span className="font-mono">{g.gstin}</span>} /><Item k="Legal name" v={g.legalName} /><Item k="Trade name" v={g.tradeName} />
            <Item k="Status" v={<StatusBadge status={g.status} />} /><Item k="Taxpayer type" v={g.taxpayerType} /><Item k="State" v={g.state} /><Item k="Data source" v={g.source} />
          </dl>}</CardBody></Card>
        </TabsContent>

        <TabsContent value="gstr1"><ReturnsTab gstin={gstin} type="GSTR1" /></TabsContent>
        <TabsContent value="gstr3b"><ReturnsTab gstin={gstin} type="GSTR3B" /></TabsContent>

        <TabsContent value="compliance">
          <Card><CardHeader title="Compliance summary" description={g?.lastReturnsAt ? `Return history retrieved ${relativeTime(g.lastReturnsAt)}.` : "No return history retrieved yet."} /><CardBody>
            {!g ? <Skeleton className="h-28" /> : (
              <>
                <div className="flex items-center gap-3"><IndicatorBadge value={g.indicator} /><span className="text-sm text-muted">Internal compliance indicator</span></div>
                <dl className="mt-4 grid gap-x-8 sm:grid-cols-2">
                  <Item k="GSTR-1 missing" v={g.gstr1Missing ?? "—"} /><Item k="GSTR-1 filed late" v={g.gstr1Late ?? "—"} />
                  <Item k="GSTR-3B missing" v={g.gstr3bMissing ?? "—"} /><Item k="GSTR-3B filed late" v={g.gstr3bLate ?? "—"} />
                </dl>
                <p className="mt-4 text-xs text-subtle">{INDICATOR_DISCLAIMER}</p>
              </>
            )}
          </CardBody></Card>
        </TabsContent>

        <TabsContent value="reports"><Card><EmptyState title="Reports are coming next" description="Per-client compliance reports will appear here." /></Card></TabsContent>
        <TabsContent value="activity"><Card><EmptyState title="Activity history is coming next" description="A per-client timeline of checks and changes will appear here." /></Card></TabsContent>
      </Tabs>
      {c && <ClientFormDialog key={c.id} open={edit} onOpenChange={setEdit} clientId={c.id} onSaved={() => void mutate()} />}
    </>
  );
}
