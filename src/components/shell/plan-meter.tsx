"use client";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useApi } from "@/lib/client/hooks";
import type { SubscriptionOverview } from "@/lib/client/types";
import { formatNumber } from "@/lib/client/format";
import { ProgressBar, Skeleton } from "@/components/ui/feedback";

/** Sidebar usage meter. Quota is organization-wide (shared by every member). Links to Usage & Billing. */
export function PlanMeter({ onNavigate }: { onNavigate?: () => void }) {
  const { data, isLoading } = useApi<{ subscription: SubscriptionOverview }>("/api/subscription");
  const s = data?.subscription;
  if (isLoading || !s) {
    return (
      <div className="rounded-xl border border-inverse-border bg-inverse-hover p-3.5" aria-busy="true">
        <Skeleton className="h-3.5 w-24 !bg-inverse-active" /><Skeleton className="mt-3 h-2 w-full !bg-inverse-active" /><Skeleton className="mt-3 h-3 w-32 !bg-inverse-active" />
      </div>
    );
  }
  const { limit, used, reserved, remaining, percent } = s.usage;
  const tone = percent !== null && percent >= 100 ? "red" : percent !== null && percent >= 80 ? "amber" : "brand";
  return (
    <>
    <Link href="/billing" onClick={onNavigate} title="Usage and billing" aria-label={`Usage and billing: ${percent === null ? "custom limit" : `${percent}% of checks used`}`} className="hidden size-12 flex-col items-center justify-center rounded-xl border border-inverse-border bg-inverse-hover text-[11px] font-semibold text-inverse-foreground hover:bg-inverse-active md:max-lg:flex">
      <span className="tabular">{percent === null ? "∞" : `${percent}%`}</span><span className="text-[9px] font-normal text-inverse-muted">used</span>
    </Link>
    <Link href="/billing" onClick={onNavigate} className="group block rounded-xl md:max-lg:hidden border border-inverse-border bg-inverse-hover p-3.5 transition-colors hover:bg-inverse-active" aria-label="Open usage and billing">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold text-inverse-foreground">{s.plan.name}</span>
        <span className="flex items-center gap-1 text-[11px] text-inverse-muted">{s.status === "trialing" ? "Trial" : s.readOnly ? "Read-only" : "Usage"}<ArrowUpRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden /></span>
      </div>
      {limit === null ? (
        <p className="mt-2 text-xs text-inverse-muted">{formatNumber(used)} checks used · custom limit</p>
      ) : (
        <>
          <p className="tabular mt-2 text-xs text-inverse-foreground">{formatNumber(used)} / {formatNumber(limit)} checks used</p>
          <ProgressBar value={used + reserved} max={limit} tone={tone} label="GST checks used this month" size="sm" className="mt-2 !bg-inverse-active" />
          <p className="tabular mt-2 text-[11px] text-inverse-muted">{formatNumber(remaining)} remaining{reserved > 0 && ` · ${formatNumber(reserved)} reserved`}</p>
        </>
      )}
    </Link>
    </>
  );
}
