"use client";
import { useState } from "react";
import { FileText, ListChecks, Receipt } from "lucide-react";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CursorPager } from "@/components/ui/data-table";
import { EmptyState, ErrorState } from "@/components/ui/feedback";
import { Select } from "@/components/ui/form";
import { currentFinancialYear } from "@/lib/dates";
import { toQuery, useApi } from "@/lib/client/hooks";
import type { ReturnsList } from "@/lib/client/types";
import { usePager } from "@/lib/client/use-pager";
import { ReturnsTable } from "./returns-table";

const STATES = [["", "All statuses"], ["FILED_ON_TIME", "Filed on time"], ["FILED_LATE", "Filed late"], ["NOT_FILED", "Missing"], ["PENDING", "Due (not yet overdue)"], ["UNKNOWN", "Unknown"]] as const;

function fyOptions() {
  const cur = currentFinancialYear();
  const start = parseInt(cur.slice(0, 4), 10);
  return [0, 1, 2].map((i) => { const y = start - i; return `${y}-${String((y + 1) % 100).padStart(2, "0")}`; });
}

export function ReturnsPage({ type }: { type: "GSTR1" | "GSTR3B" }) {
  const { can } = useSession();
  const label = type === "GSTR1" ? "GSTR-1" : "GSTR-3B";
  const fys = fyOptions();
  const [fy, setFy] = useState(fys[0]);
  const [state, setState] = useState("");
  const pager = usePager(`${fy}|${state}`);
  const path = `/api/returns/${type === "GSTR1" ? "gstr1" : "gstr3b"}${toQuery({ fy, state, limit: 20, cursor: pager.cursor, dir: "desc" })}`;
  const { data, error, isLoading, mutate } = useApi<ReturnsList>(path, { keepPreviousData: true });
  const empty = !isLoading && !error && (data?.items.length ?? 0) === 0;

  return (
    <>
      <PageHeader title={label} description={`${label} filing status across your clients, with due dates and delays.`} />
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <div className="w-[calc(50%-6px)] sm:w-44"><label htmlFor="fy" className="mb-1 block text-xs font-medium text-muted">Financial year</label><Select id="fy" className="!h-9" value={fy} onChange={(e) => setFy(e.target.value)}>{fys.map((f) => <option key={f}>{f}</option>)}</Select></div>
          <div className="w-[calc(50%-6px)] sm:w-52"><label htmlFor="st" className="mb-1 block text-xs font-medium text-muted">Status</label><Select id="st" className="!h-9" value={state} onChange={(e) => setState(e.target.value)}>{STATES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
          {data && <p className="ml-auto self-center text-xs text-subtle">Status is as of each client&apos;s last check.</p>}
        </div>
        {error && !data ? <ErrorState onRetry={() => void mutate()} detail={error.code} /> : empty ? (
          <EmptyState icon={type === "GSTR1" ? <FileText /> : <Receipt />} title={state ? "No returns match these filters" : `No ${label} data for ${fy}`}
            description={state ? "Try a different status or financial year." : "Run GST checks with return history included to retrieve filings for your clients."}
            action={!state && can("checks:run") ? <ButtonLink href="/bulk-checks" variant="secondary" size="sm"><ListChecks className="size-4" aria-hidden />Run GST checks</ButtonLink> : undefined} />
        ) : (
          <>
            <ReturnsTable caption={`${label} returns`} rows={data?.items ?? []} loading={isLoading && !data} showClient />
            <CursorPager page={pager.page} hasPrev={pager.hasPrev} hasNext={!!data?.nextCursor} onPrev={pager.prev} onNext={() => data?.nextCursor && pager.next(data.nextCursor)} loading={isLoading} />
          </>
        )}
      </Card>
    </>
  );
}
