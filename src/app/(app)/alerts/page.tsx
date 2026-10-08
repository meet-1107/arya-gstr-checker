"use client";
import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bell, CheckCheck, CheckCircle2, Info, XCircle } from "lucide-react";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/client/api";
import { formatDateTime, relativeTime } from "@/lib/client/format";
import { toQuery, useApi, useApiCall, useInvalidate } from "@/lib/client/hooks";
import { ALERT_GROUPS, ALERT_LABEL, ALERT_SEVERITY, type AlertGroup, type AlertSeverity } from "@/lib/alerts";
import type { Alert } from "@/lib/store/types";
import { cn } from "@/lib/cn";

interface AlertList { items: Alert[]; unreadCount: number; hasMore: boolean }
const SEV: Record<AlertSeverity, { Icon: typeof Info; tone: "red" | "amber" | "blue"; icon: string; label: string }> = {
  critical: { Icon: XCircle, tone: "red", icon: "text-danger-strong", label: "Needs action" },
  warning: { Icon: AlertTriangle, tone: "amber", icon: "text-warning-strong", label: "Warning" },
  info: { Icon: Info, tone: "blue", icon: "text-info-strong", label: "Info" },
};
const PAGE = 30;

export default function AlertsPage() {
  const { can } = useSession();
  const call = useApiCall(); const invalidate = useInvalidate(); const { toast } = useToast();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [group, setGroup] = useState<"" | AlertGroup>("");
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const { data, error, isLoading, mutate } = useApi<AlertList>(`/api/alerts${toQuery({ unread: unreadOnly ? 1 : undefined, group: group || undefined, limit })}`, { keepPreviousData: true });
  const write = can("checks:run");

  const mark = async (body: { ids?: string[]; all?: boolean; read?: boolean }) => {
    setBusy(true);
    try { await call("/api/alerts/read", { method: "POST", body }); await mutate(); void invalidate("/api/alerts"); }
    catch (e) { toast({ tone: "error", title: "Couldn't update alerts", description: errorMessage(e) }); }
    finally { setBusy(false); }
  };

  const items = data?.items ?? [];
  return (
    <>
      <PageHeader title="Alerts" description="What changed across your clients and workspace. Everyone in your firm sees the same list and the same read state."
        actions={write ? <Button variant="secondary" loading={busy} disabled={!data || data.unreadCount === 0} onClick={() => void mark({ all: true })}><CheckCheck className="size-4" aria-hidden />Mark all read{data && data.unreadCount > 0 ? ` (${data.unreadCount})` : ""}</Button> : undefined} />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <div role="group" aria-label="Show" className="inline-flex rounded-lg border border-line-strong p-0.5">
            {([[false, "All"], [true, "Unread"]] as const).map(([v, l]) => (
              <button key={l} type="button" aria-pressed={unreadOnly === v} onClick={() => { setUnreadOnly(v); setLimit(PAGE); }}
                className={cn("rounded-md px-3 py-1 text-[13px] font-medium", unreadOnly === v ? "bg-primary text-primary-foreground" : "text-muted hover:text-foreground")}>{l}</button>
            ))}
          </div>
          <div className="w-full sm:w-52"><label htmlFor="ag" className="sr-only">Type</label>
            <Select id="ag" className="!h-9" value={group} onChange={(e) => { setGroup(e.target.value as "" | AlertGroup); setLimit(PAGE); }}>
              <option value="">All types</option>{(Object.keys(ALERT_GROUPS) as AlertGroup[]).map((g) => <option key={g} value={g}>{ALERT_GROUPS[g].label}</option>)}
            </Select></div>
        </div>
        {error && !data ? <ErrorState onRetry={() => void mutate()} detail={error.code} /> : isLoading && !data ? (
          <ul className="divide-y divide-line">{[0, 1, 2, 3].map((i) => <li key={i} className="space-y-2 px-4 py-4 sm:px-5"><Skeleton className="h-4 w-64" /><Skeleton className="h-3.5 w-32" /></li>)}</ul>
        ) : items.length === 0 ? (
          <EmptyState icon={<Bell />} title={unreadOnly || group ? "No alerts match" : "No alerts yet"} description={unreadOnly || group ? "Try showing all alerts." : "When a client's GSTIN gets worse, a run finishes or your checks run low, it will appear here."} />
        ) : (
          <>
            <ul className="divide-y divide-line" aria-label="Alerts">
              {items.map((a) => {
                const sev = SEV[ALERT_SEVERITY[a.type]];
                return (
                  <li key={a.id} className={cn("flex items-start gap-3 px-4 py-3.5 sm:px-5", !a.read && "bg-surface-muted")}>
                    <sev.Icon className={cn("mt-0.5 size-5 shrink-0", sev.icon)} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={sev.tone}>{ALERT_LABEL[a.type]}</Badge>
                        {!a.read && <Badge tone="ink">Unread</Badge>}
                        <span className="text-xs text-muted" title={formatDateTime(a.at)}>{relativeTime(a.at)}</span>
                      </div>
                      <p className={cn("mt-1 text-sm", !a.read && "font-medium")}>{a.message}</p>
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
                        {a.gstin && <Link href={`/verify?gstin=${a.gstin}`} className="text-info-strong hover:underline">View GSTIN</Link>}
                        {write && <button type="button" className="text-muted hover:text-foreground hover:underline" disabled={busy} onClick={() => void mark({ ids: [a.id], read: !a.read })}>{a.read ? "Mark unread" : "Mark read"}</button>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {data?.hasMore && <div className="border-t border-line p-3 text-center"><Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + PAGE)}>Show more</Button></div>}
          </>
        )}
      </Card>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-muted"><CheckCircle2 className="size-3.5" aria-hidden />Alerts come from your stored checks and runs. Email and push notifications are not set up yet.</p>
    </>
  );
}
