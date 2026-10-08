"use client";
import { CreditCard, FileText, Lock, Receipt, XCircle } from "lucide-react";
import { useSession } from "@/components/session";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Alert, ErrorState, ProgressBar, Skeleton } from "@/components/ui/feedback";
import { Tooltip } from "@/components/ui/overlay";
import { formatDate, formatInr, formatNumber } from "@/lib/client/format";
import { useApi } from "@/lib/client/hooks";
import type { SubscriptionOverview } from "@/lib/client/types";
import { annualSavingsPercent } from "@/lib/subscription";
import { PLANS } from "@/config/plans";
import { ANNUAL_MONTHS_PAID } from "@/lib/pricing";

function Meter({ label, used, limit, hint }: { label: string; used: number; limit: number | null; hint?: string }) {
  const pct = limit ? (used / limit) * 100 : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm"><span className="font-medium">{label}</span><span className="tabular text-muted">{formatNumber(used)} / {limit === null ? "custom" : formatNumber(limit)}</span></div>
      {limit !== null && <ProgressBar className="mt-2" value={used} max={limit} tone={pct >= 100 ? "red" : pct >= 80 ? "amber" : "brand"} label={label} />}
      {hint && <p className="tabular mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function BillPanel({ s }: { s: SubscriptionOverview }) {
  const { bill, nextClient, cheaper, period } = s.pricing;
  const per = period === "annual" ? "year" : "month";
  if (bill.custom) return <p className="text-sm text-muted">Enterprise pricing is arranged directly, so no automatic amount is shown here.</p>;
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <dl className="space-y-2.5 text-sm" aria-label="Bill breakdown">
        <div className="flex justify-between"><dt className="text-muted">{s.plan.name} base ({period})</dt><dd className="tabular font-medium">{formatInr(bill.baseInr)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted">Active client firms</dt><dd className="tabular font-medium">{formatNumber(bill.activeClients)} <span className="text-muted">({formatNumber(bill.includedClients)} included)</span></dd></div>
        <div className="flex justify-between"><dt className="text-muted">Additional clients</dt><dd className="tabular font-medium">{bill.extraClients > 0 && bill.extraClientInr !== null ? `${bill.extraClients} × ${formatInr(bill.extraClientInr)}${period === "annual" ? ` × ${ANNUAL_MONTHS_PAID} months` : ""} = ${formatInr(bill.extraInr)}` : "—"}</dd></div>
        <div className="flex justify-between border-t border-line pt-2.5 text-base"><dt className="font-semibold">Total per {per}</dt><dd className="tabular text-2xl font-semibold tracking-tight">{formatInr(bill.totalInr)}</dd></div>
        {period === "annual" && bill.perMonthInr !== null && <p className="text-xs text-muted">About {formatInr(bill.perMonthInr)} per month{bill.annualSavingInr ? ` · ${formatInr(bill.annualSavingInr)} less than paying monthly` : ""}.</p>}
      </dl>
      <div className="space-y-3 text-sm">
        {bill.overCap
          ? <Alert tone="warning" title="Over this plan's client limit">Free includes {formatNumber(bill.includedClients)} clients. Upgrade to add more.</Alert>
          : nextClient.blocked
            ? <Alert tone="warning" title="You've reached this plan's client limit">Archive a client or upgrade to add another.</Alert>
            : nextClient.deltaInr > 0
              ? <Alert tone="info" title={`Adding one more client adds ${formatInr(nextClient.deltaInr)} per ${per}`}>New total: <strong className="tabular">{formatInr(nextClient.newTotalInr)}</strong> per {per}. You will see this again before you add a client.</Alert>
              : <Alert tone="info" title="Your next client is included">Adding one more client does not change your bill.</Alert>}
        {cheaper && <p className="text-muted">On price alone, {PLANS[cheaper.planId].name} would cost {formatInr(cheaper.totalInr)} per {per} for your {formatNumber(bill.activeClients)} clients ({formatInr(cheaper.savingInr)} less). Plans also differ in team users and features.</p>}
        <p className="text-xs text-muted">Amounts are in INR and exclude any applicable taxes. Billing is not live yet: nothing is being charged. Only active client firms count; archive a client to stop billing for it.</p>
      </div>
    </div>
  );
}

export default function BillingPage() {
  const { can } = useSession();
  const { data, error, mutate } = useApi<{ subscription: SubscriptionOverview; role: string }>("/api/subscription");
  const manage = can("billing:manage");
  const s = data?.subscription;

  if (error && !s) return <><PageHeader title="Usage & billing" /><Card><ErrorState onRetry={() => void mutate()} detail={error.code} /></Card></>;

  const statusTone = !s ? "neutral" : s.status === "active" ? "green" : s.status === "trialing" ? "blue" : s.readOnly ? "red" : "amber";
  const save = s ? annualSavingsPercent(s.plan.id) : null;
  const disabledBtn = (label: string, icon: React.ReactNode) => (
    <Tooltip label="Payments aren't set up yet. Plan changes will be available here once billing is connected."><span><Button variant="secondary" size="sm" disabled>{icon}{label}</Button></span></Tooltip>
  );

  return (
    <>
      <PageHeader title="Usage & billing" description="One subscription for your whole firm. Clients, team seats and GST checks are shared by every member." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Current plan" action={s && <Badge tone={statusTone} className="capitalize">{s.status.replace("_", " ")}</Badge>} />
          <CardBody>
            {!s ? <div className="space-y-3"><Skeleton className="h-9 w-48" /><Skeleton className="h-4 w-72" /></div> : (
              <>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><span className="text-3xl font-semibold tracking-tight">{s.plan.name}</span>
                  <span className="text-muted">{s.plan.monthlyPriceInr === null ? "Custom pricing" : s.plan.monthlyPriceInr === 0 ? "Free" : `${formatInr(s.plan.monthlyPriceInr)} / month`}</span></div>
                <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                  <div className="flex justify-between"><dt className="text-muted">Billing period</dt><dd className="font-medium capitalize">{s.billingPeriod}</dd></div>
                  {s.trialEndsAt && <div className="flex justify-between"><dt className="text-muted">Trial ends</dt><dd className="font-medium">{formatDate(s.trialEndsAt)}</dd></div>}
                  {s.currentPeriodEnd && <div className="flex justify-between"><dt className="text-muted">Renews</dt><dd className="font-medium">{formatDate(s.currentPeriodEnd)}</dd></div>}
                  <div className="flex justify-between"><dt className="text-muted">Usage month</dt><dd className="font-medium">{s.usage.month}</dd></div>
                </dl>
                {s.readOnly && <Alert tone="danger" className="mt-5" title="This workspace is read-only">Your data is safe. Choose a plan to run GST checks and edit clients again.</Alert>}
                {manage ? (
                  <div className="mt-6 flex flex-wrap gap-2 border-t border-line pt-5">
                    {disabledBtn("Upgrade", <CreditCard className="size-4" aria-hidden />)}{disabledBtn("Change plan", <Receipt className="size-4" aria-hidden />)}
                    {disabledBtn("Manage billing", <Lock className="size-4" aria-hidden />)}{disabledBtn("View invoices", <FileText className="size-4" aria-hidden />)}{disabledBtn("Cancel subscription", <XCircle className="size-4" aria-hidden />)}
                  </div>
                ) : <p className="mt-6 border-t border-line pt-4 text-sm text-muted">Only the organization owner can change the plan or billing details.</p>}
                {manage && save && <p className="mt-3 text-xs text-muted">Yearly billing will save {save}% on this plan once payments are available.</p>}
              </>
            )}
          </CardBody>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader title="Your bill" description="Base plan plus each active client firm above what your plan includes. Archived clients are not billed." />
          <CardBody>
            {!s ? <Skeleton className="h-28" /> : <BillPanel s={s} />}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Included in your plan" />
          <CardBody>
            {!s ? <Skeleton className="h-32" /> : (
              <ul className="space-y-2.5 text-sm">
                <li className="flex justify-between"><span className="text-muted">Active client firms included</span><span className="font-medium">{s.plan.includedClients === null ? "Custom" : formatNumber(s.plan.includedClients)}</span></li>
                <li className="flex justify-between"><span className="text-muted">Each additional client</span><span className="font-medium">{s.plan.extraClientInr === null ? (s.plan.id === "free" ? "Not available" : "Custom") : `${formatInr(s.plan.extraClientInr)} / month`}</span></li>
                <li className="flex justify-between"><span className="text-muted">GSTINs per client firm</span><span className="font-medium">{s.plan.gstinsPerClient === null ? "Custom" : s.plan.gstinsPerClient}</span></li>
                <li className="flex justify-between"><span className="text-muted">Live GST checks / month</span><span className="font-medium">{s.plan.monthlyChecks === null ? "Custom" : formatNumber(s.plan.monthlyChecks)}</span></li>
                <li className="flex justify-between"><span className="text-muted">Team members</span><span className="font-medium">{s.plan.userLimit === null ? "Custom" : s.plan.userLimit}</span></li>
                <li className="flex justify-between"><span className="text-muted">Bulk GST checks</span><span className="font-medium">{s.plan.features.bulkChecks ? "Included" : "Not included"}</span></li>
              </ul>
            )}
          </CardBody>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader title="Usage this month" description="Shared across your whole organization — not per user." />
          <CardBody className="grid gap-8 md:grid-cols-3">
            {!s ? <><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></> : (
              <>
                <Meter label="GST checks" used={s.usage.used} limit={s.usage.limit} hint={`${formatNumber(s.usage.remaining)} remaining${s.usage.reserved ? ` · ${formatNumber(s.usage.reserved)} reserved by running jobs` : ""} · ${formatNumber(s.usage.cachedChecks)} served from cache`} />
                <Meter label="Team members" used={s.seats.used} limit={s.seats.limit} hint="Includes pending invitations" />
                <Meter label="Active clients" used={s.clients.used} limit={s.plan.id === "free" ? s.clients.limit : s.clients.included} hint={s.plan.id === "free" ? (s.clients.archived ? `${s.clients.archived} archived (not counted)` : undefined) : `${s.clients.used > (s.clients.included ?? Infinity) ? `${s.clients.used - (s.clients.included ?? 0)} above the included count are billed` : "Within your included clients"}${s.clients.archived ? ` · ${s.clients.archived} archived (not billed)` : ""}`} />
              </>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
