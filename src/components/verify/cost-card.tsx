"use client";
import { useState } from "react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ErrorState, Skeleton } from "@/components/ui/feedback";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatInr, formatNumber } from "@/lib/client/format";
import { useApi } from "@/lib/client/hooks";

interface Report {
  period: string; searches: number; paidCalls: number; cacheHits: number; sharedHits: number; cacheMisses: number; deduped: number; failures: number; credits: number;
  avoidedCallRate: number | null; estimatedCostInr: number | null;
}
interface Costs { today: Report; month: Report; sharedCache: boolean; costKnown: boolean }

function Funnel({ r, c }: { r: Report; c: Costs }) {
  const avoided = r.cacheHits + r.sharedHits + r.deduped;
  const pct = r.avoidedCallRate === null ? null : Math.round(r.avoidedCallRate * 100);
  return (
    <div className="space-y-4">
      <p className="text-sm" aria-live="polite">
        <span className="tabular text-2xl font-semibold">{formatNumber(r.searches)}</span> searches
        <span className="mx-2 text-muted" aria-hidden>→</span>
        <span className="tabular text-2xl font-semibold">{formatNumber(r.paidCalls)}</span> paid lookups
        <span className="mx-2 text-muted" aria-hidden>→</span>
        <span className="tabular text-2xl font-semibold">{formatNumber(avoided)}</span> answered without one
        {pct !== null && <span className="ml-2 text-muted">({pct}%)</span>}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-muted">From stored results</dt><dd className="tabular font-medium">{formatNumber(r.cacheHits)}</dd></div>
        {c.sharedCache && <div><dt className="text-xs text-muted">From shared results</dt><dd className="tabular font-medium">{formatNumber(r.sharedHits)}</dd></div>}
        <div><dt className="text-xs text-muted">Joined a lookup in progress</dt><dd className="tabular font-medium">{formatNumber(r.deduped)}</dd></div>
        <div><dt className="text-xs text-muted">Paid lookups that failed</dt><dd className="tabular font-medium">{formatNumber(r.failures)}</dd></div>
        <div><dt className="text-xs text-muted">Credits used</dt><dd className="tabular font-medium">{formatNumber(r.credits)}</dd></div>
        <div><dt className="text-xs text-muted">Estimated cost</dt><dd className="tabular font-medium">{c.costKnown && r.estimatedCostInr !== null ? formatInr(r.estimatedCostInr) : "Not configured"}</dd></div>
      </dl>
    </div>
  );
}

/** Admin-only (the API enforces it). Counts come from the server; nothing here is estimated by the browser. */
export function VerificationCostCard() {
  const { data, error, isLoading, mutate } = useApi<{ costs: Costs }>("/api/verify/costs");
  const [tab, setTab] = useState("today");
  return (
    <Card>
      <CardHeader title="Verification activity" description="How many searches needed a paid lookup, and how many were answered without one." />
      <CardBody>
        {isLoading ? <Skeleton className="h-24" /> : error ? <ErrorState title="Couldn't load activity" onRetry={() => void mutate()} detail={error.code} /> : data && (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList><TabsTrigger value="today">Today</TabsTrigger><TabsTrigger value="month">This month</TabsTrigger></TabsList>
            <TabsContent value="today"><Funnel r={data.costs.today} c={data.costs} /></TabsContent>
            <TabsContent value="month"><Funnel r={data.costs.month} c={data.costs} /></TabsContent>
          </Tabs>
        )}
      </CardBody>
    </Card>
  );
}
