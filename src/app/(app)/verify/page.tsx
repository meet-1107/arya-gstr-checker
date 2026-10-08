"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Bookmark, History, ListChecks } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { ForgetButton, PrivacyPanel } from "@/components/verify/privacy-panel";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/feedback";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VerificationCostCard } from "@/components/verify/cost-card";
import { OutcomeBadge } from "@/components/verify/outcome-badge";
import { VerifyPanel } from "@/components/verify/verify-panel";
import { useApi } from "@/lib/client/hooks";
import { ageLabel, type VerificationOutcome, type VerifiedDetails } from "@/lib/verification";

interface Recent { tags?: string[]; note?: string; saved: boolean; gstin: string; outcome: VerificationOutcome; details?: VerifiedDetails; verifiedAt: string; ageSeconds: number; source: string }

function List({ saved, onPick }: { saved: boolean; onPick: (g: string) => void }) {
  const [tag, setTag] = useState<string | null>(null);
  const canForget = useSession().can("checks:run");
  const q = useApi<{ items: Recent[] }>(`/api/verify/recent?limit=${saved ? 50 : 8}${saved ? "&saved=1" : ""}`);
  if (q.isLoading) return <ul className="divide-y divide-line">{[0, 1, 2].map((i) => <li key={i} className="space-y-2 px-4 py-3 sm:px-5"><Skeleton className="h-4 w-40" /><Skeleton className="h-3.5 w-24" /></li>)}</ul>;
  if (q.error) return <ErrorState title="Couldn't load this list" onRetry={() => void q.mutate()} detail={q.error.code} />;
  const all = q.data?.items ?? [];
  const tags = [...new Set(all.flatMap((r) => r.tags ?? []))].sort();
  const items = tag ? all.filter((r) => (r.tags ?? []).includes(tag)) : all;
  if (items.length === 0) {
    return saved
      ? <EmptyState className="!py-10" icon={<Bookmark />} title="No saved GSTINs" description="Verify a GSTIN, then choose Save to keep it here for quick re-checks." />
      : <EmptyState className="!py-10" icon={<History />} title="Nothing verified yet" description="Verified GSTINs will appear here for one-tap re-checks." />;
  }
  return (
    <>
    {tags.length > 0 && (
      <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-3 sm:px-5" role="group" aria-label="Filter by tag">
        <button type="button" aria-pressed={tag === null} onClick={() => setTag(null)} className={`rounded-full px-2.5 py-1 text-xs font-medium ${tag === null ? "bg-primary text-primary-foreground" : "bg-surface-muted hover:bg-surface-hover"}`}>All</button>
        {tags.map((t) => <button key={t} type="button" aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)} className={`rounded-full px-2.5 py-1 text-xs font-medium ${tag === t ? "bg-primary text-primary-foreground" : "bg-surface-muted hover:bg-surface-hover"}`}>{t}</button>)}
      </div>
    )}
    <ul className="divide-y divide-line">
      {items.map((r) => (
        <li key={r.gstin} className="flex items-center">
          <button type="button" onClick={() => onPick(r.gstin)} className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface-hover sm:px-5">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{r.outcome === "NOT_FOUND" ? "No registration found" : r.details?.legalName ?? r.details?.tradeName ?? "Name not provided"}</span>
              <span className="block truncate font-mono text-xs text-muted">{r.gstin}</span>
              <span className="block text-xs text-muted">{ageLabel(r.ageSeconds)}{r.saved && !saved ? " · saved" : ""}{r.tags?.length ? ` · ${r.tags.join(", ")}` : ""}</span>
            </span>
            <OutcomeBadge outcome={r.outcome} />
          </button>
          {canForget && <ForgetButton gstin={r.gstin} onDone={() => void q.mutate()} />}
        </li>
      ))}
    </ul>
    </>
  );
}

function VerifyView() {
  const { can } = useSession();
  const params = useSearchParams();
  const fromLink = params.get("gstin") ?? undefined;
  const [pick, setPick] = useState<{ gstin: string; n: number } | null>(fromLink ? { gstin: fromLink, n: 0 } : null);
  const canVerify = can("checks:run");
  return (
    <>
      <PageHeader title="Verify a GSTIN" description="Check any GSTIN in seconds. If we can't get an answer, we'll tell you why — a failed lookup never means the GSTIN is fake."
        actions={<>{canVerify && <ButtonLink href="/verify/bulk" variant="secondary"><ListChecks className="size-4" aria-hidden />Verify many</ButtonLink>}<PrivacyPanel /></>} />
      <div className="grid grid-cols-1 gap-4 sm:gap-6 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">
          <VerifyPanel key={pick ? `${pick.gstin}-${pick.n}` : "p"} canVerify={canVerify} initial={pick?.gstin} autoRun={!!pick} />
        </div>
        <div className="min-w-0">
          <Card>
            <Tabs defaultValue="recent">
              <TabsList className="px-4 sm:px-5">
                <TabsTrigger value="recent">Recent</TabsTrigger>
                <TabsTrigger value="saved">Saved</TabsTrigger>
              </TabsList>
              <TabsContent value="recent" className="mt-0" tabIndex={-1}><List saved={false} onPick={(g) => setPick({ gstin: g, n: (pick?.n ?? 0) + 1 })} /></TabsContent>
              <TabsContent value="saved" className="mt-0" tabIndex={-1}><List saved onPick={(g) => setPick({ gstin: g, n: (pick?.n ?? 0) + 1 })} /></TabsContent>
            </Tabs>
          </Card>
        </div>
      </div>
      {can("auditlog:read") && <div className="mt-4 sm:mt-6"><VerificationCostCard /></div>}
    </>
  );
}

export default function VerifyPage() { return <Suspense><VerifyView /></Suspense>; }
