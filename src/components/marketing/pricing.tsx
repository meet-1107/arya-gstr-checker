"use client";
import { useId, useState } from "react";
import { Check, ChevronDown, Minus, Plus } from "lucide-react";
import { PLAN_IDS, PLANS, type PlanConfig, type PlanId } from "@/config/plans";
import { annualSavingsPercent } from "@/lib/subscription";
import { ANNUAL_MONTHS_PAID, cheapestPlan, computeBill, quoteAll } from "@/lib/pricing";
import { formatInr, formatNumber } from "@/lib/client/format";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const RECOMMENDED: PlanId = "professional";

const TAGLINE: Record<PlanId, string> = {
  free: "Try it on a small practice.", starter: "For small CA and tax consultants.", professional: "For growing CA firms.",
  firm: "For established CA firms.", enterprise: "For large CA networks and resellers.",
};

function priceOf(p: PlanConfig, yearly: boolean) {
  if (p.monthlyPriceInr === null) return { main: "Custom", sub: "Talk to us" };
  if (p.monthlyPriceInr === 0) return { main: "₹0", sub: "forever" };
  return yearly
    ? { main: formatInr(p.annualPriceInr), sub: "per year", note: `${formatInr(Math.round((p.annualPriceInr ?? 0) / 12))}/month equivalent` }
    : { main: formatInr(p.monthlyPriceInr), sub: "per month" };
}

const HIGHLIGHTS = (p: PlanConfig): string[] => [
  p.includedClients === null ? "Custom number of client firms" : `${formatNumber(p.includedClients)} active client firms included`,
  p.extraClientInr === null ? (p.id === "free" ? "Upgrade to add more clients" : "Custom pricing") : `+ ${formatInr(p.extraClientInr)} per additional active client / month`,
  `${p.gstinsPerClient === null ? "Custom" : `Up to ${p.gstinsPerClient}`} GSTIN${p.gstinsPerClient === 1 ? "" : "s"} per client firm`,
  `${p.monthlyChecks === null ? "Custom" : formatNumber(p.monthlyChecks)} live GST checks / month`,
  `${p.userLimit === null ? "Custom" : p.userLimit} user${p.userLimit === 1 ? "" : "s"}`,
  p.features.bulkChecks ? "Bulk GST checks" : "Single GST checks",
  "GSTR-1 & GSTR-3B history",
];

export function BillingToggle({ yearly, onChange }: { yearly: boolean; onChange: (y: boolean) => void }) {
  const best = Math.max(...PLAN_IDS.map((id) => annualSavingsPercent(id) ?? 0));
  const base = "rounded-full px-4 py-1.5 text-sm font-medium transition-colors";
  return (
    <div role="radiogroup" aria-label="Billing period" className="inline-flex items-center rounded-full border border-line bg-surface p-1 shadow-card">
      <button role="radio" aria-checked={!yearly} onClick={() => onChange(false)} className={cn(base, !yearly ? "bg-primary text-primary-foreground" : "text-muted hover:text-foreground")}>Monthly</button>
      <button role="radio" aria-checked={yearly} onClick={() => onChange(true)} className={cn(base, "flex items-center gap-2", yearly ? "bg-primary text-primary-foreground" : "text-muted hover:text-foreground")}>
        Yearly{best > 0 && <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-semibold", yearly ? "bg-success-solid text-success-solid-foreground" : "bg-success-soft text-success-strong")}>Save {best}%</span>}
      </button>
    </div>
  );
}

export function PlanCards({ yearly, ctaHref = "/register", headingAs: Heading = "h3" }: { yearly: boolean; ctaHref?: string; headingAs?: "h2" | "h3" }) {
  return (
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
      {(["free", "starter", "professional", "firm"] as PlanId[]).map((id) => {
        const p = PLANS[id], price = priceOf(p, yearly), rec = id === RECOMMENDED, save = annualSavingsPercent(id);
        return (
          <div key={id} className={cn("relative flex flex-col rounded-2xl border bg-surface p-6 shadow-card", rec ? "border-primary ring-1 ring-primary xl:-my-2 xl:py-8" : "border-line")}>
            {rec && <Badge tone="ink" className="absolute -top-3 left-6">Recommended</Badge>}
            <Heading className="text-base font-semibold">{p.name}</Heading>
            <p className="mt-1 text-sm text-muted">{TAGLINE[id]}</p>
            <p className="mt-6 flex items-baseline gap-1.5"><span className="tabular text-4xl font-semibold tracking-tight">{price.main}</span><span className="text-sm text-muted">{price.sub}</span></p>
            <p className="mt-1 h-4 text-xs text-muted">{yearly && save ? `Save ${save}% vs monthly · ${price.note}` : ""}</p>
            <ButtonLink href={ctaHref} variant={rec ? "primary" : "secondary"} size="lg" className="mt-6 w-full">{id === "free" ? "Start free" : "Start free trial"}</ButtonLink>
            <ul className="mt-6 space-y-3 text-sm">
              {HIGHLIGHTS(p).map((h) => <li key={h} className="flex gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-success-strong" aria-hidden />{h}</li>)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

const ROWS: { label: string; get: (p: PlanConfig) => string | boolean; soon?: boolean }[] = [
  { label: "Active client firms included", get: (p) => (p.includedClients === null ? "Custom" : formatNumber(p.includedClients)) },
  { label: "Each additional active client", get: (p) => (p.extraClientInr === null ? (p.id === "free" ? "Not available" : "Custom") : `${formatInr(p.extraClientInr)}/mo`) },
  { label: "GSTINs per client firm", get: (p) => (p.gstinsPerClient === null ? "Custom" : String(p.gstinsPerClient)) },
  { label: "Live GST checks per month", get: (p) => (p.monthlyChecks === null ? "Custom" : formatNumber(p.monthlyChecks)) },
  { label: "Users", get: (p) => (p.userLimit === null ? "Custom" : String(p.userLimit)) },
  { label: "GSTIN verification", get: () => true },
  { label: "GSTR-1 & GSTR-3B history", get: () => true },
  { label: "Bulk GST checks", get: (p) => p.features.bulkChecks },
  { label: "Team roles & invitations", get: (p) => (p.userLimit ?? 99) > 1 },
  { label: "Scheduled monitoring", get: (p) => p.features.scheduledChecks, soon: true },
  { label: "Alerts", get: (p) => p.features.alerts, soon: true },
  { label: "PDF reports", get: (p) => p.features.pdfReports, soon: true },
  { label: "Audit log", get: (p) => p.features.auditLog, soon: true },
  { label: "Client portal", get: (p) => p.features.clientPortal, soon: true },
  { label: "White-label reports", get: (p) => p.features.whiteLabel, soon: true },
  { label: "Webhooks", get: (p) => p.features.webhooks, soon: true },
  { label: "Overage per extra check", get: (p) => (p.overagePerCheckInr ? `₹${p.overagePerCheckInr.toFixed(2)}` : "—"), soon: true },
];

function Cell({ v }: { v: string | boolean }) {
  if (v === true) return <><Check className="mx-auto size-4 text-success-strong" aria-hidden /><span className="sr-only">Included</span></>;
  if (v === false) return <><Minus className="mx-auto size-4 text-subtle" aria-hidden /><span className="sr-only">Not included</span></>;
  return <span className="tabular">{v}</span>;
}

export function ComparisonTable() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-2xl border border-line bg-surface shadow-card md:block">
        <table className="w-full text-sm">
          <caption className="sr-only">Plan comparison</caption>
          <thead><tr className="border-b border-line bg-surface-muted text-left"><th scope="col" className="px-5 py-3.5 font-medium text-muted">Feature</th>{PLAN_IDS.map((id) => <th key={id} scope="col" className={cn("px-3 py-3.5 text-center font-semibold", id === RECOMMENDED && "bg-success-soft")}>{PLANS[id].name}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">
            {ROWS.map((r) => (
              <tr key={r.label}>
                <th scope="row" className="px-5 py-3 text-left font-medium">{r.label}{r.soon && <Badge className="ml-2 align-middle">Soon</Badge>}</th>
                {PLAN_IDS.map((id) => <td key={id} className={cn("px-3 py-3 text-center", id === RECOMMENDED && "bg-success-soft/50")}><Cell v={r.get(PLANS[id])} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Mobile: one expandable card per plan */}
      <div className="space-y-3 md:hidden">
        {PLAN_IDS.map((id) => (
          <details key={id} open={open && id === RECOMMENDED} className="group rounded-xl border border-line bg-surface shadow-card" onToggle={() => setOpen(true)}>
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3.5 font-semibold">{PLANS[id].name}<ChevronDown className="size-4 text-muted transition-transform group-open:rotate-180" aria-hidden /></summary>
            <dl className="divide-y divide-line border-t border-line">
              {ROWS.map((r) => <div key={r.label} className="flex items-center justify-between px-4 py-2.5 text-sm"><dt className="text-muted">{r.label}{r.soon && <span className="ml-1.5 text-[10px] uppercase text-subtle">soon</span>}</dt><dd><Cell v={r.get(PLANS[id])} /></dd></div>)}
            </dl>
          </details>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted">“Soon” marks features on the plan that are still being built. Prices and allowances are the current plan; per-check overage prices are indicative and may change once provider costs are final. Live GST checks are a fair-use allowance for lookups that reach the GST service; results already stored for your organization do not use it.</p>
    </div>
  );
}

/** Live bill preview: "how many client firms do you manage?" → what each plan would cost. Uses the same pure calculator as billing. */
export function ClientCalculator({ yearly, headingAs: Heading = "h3" }: { yearly: boolean; headingAs?: "h2" | "h3" }) {
  const [n, setN] = useState(80);
  const id = useId();
  const period = yearly ? "annual" : "monthly";
  const quotes = quoteAll(n, period);
  const best = cheapestPlan(n, period);
  const rec = computeBill("professional", n, period);
  const set = (v: number) => setN(Math.min(5000, Math.max(0, Math.floor(Number.isFinite(v) ? v : 0))));
  const btn = "flex size-10 items-center justify-center rounded-lg border border-line-strong bg-surface text-foreground shadow-card hover:bg-surface-hover disabled:opacity-40";
  return (
    <section aria-labelledby={`${id}-h`} className="mx-auto max-w-3xl rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-7">
      <Heading id={`${id}-h`} className="text-xl font-semibold tracking-tight">What will it cost for your practice?</Heading>
      <p className="mt-1 text-sm text-muted">You pay a base fee plus a small amount for each <strong className="font-medium text-foreground">active client firm</strong> above what your plan includes. One client firm is one billing unit, however many GSTINs it holds (up to your plan&apos;s per-client limit). Archived clients are not billed.</p>
      <div className="mt-5 flex items-center gap-3">
        <label htmlFor={`${id}-n`} className="text-sm font-medium">Active client firms you manage</label>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" className={btn} aria-label="Fewer clients" disabled={n <= 0} onClick={() => set(n - (n > 100 ? 10 : 1))}><Minus className="size-4" aria-hidden /></button>
        <input id={`${id}-n`} inputMode="numeric" pattern="[0-9]*" value={n} onChange={(e) => set(Number(e.target.value.replace(/\D/g, "")))} className="tabular h-10 w-28 rounded-lg border border-line-strong bg-surface px-3 text-center text-lg font-semibold shadow-card" />
        <button type="button" className={btn} aria-label="More clients" disabled={n >= 5000} onClick={() => set(n + (n >= 100 ? 10 : 1))}><Plus className="size-4" aria-hidden /></button>
      </div>
      <div className="mt-6" aria-live="polite">
        <div className="overflow-x-auto rounded-xl border border-line" tabIndex={0} role="region" aria-label="Price of each plan for your client count">
          <table className="w-full text-sm">
            <caption className="sr-only">Price of each plan for {n} active client firms, billed {yearly ? "yearly" : "monthly"}</caption>
            <thead><tr className="border-b border-line bg-surface-muted text-left text-xs font-medium text-muted"><th scope="col" className="px-4 py-2.5">Plan</th><th scope="col" className="px-4 py-2.5">Base</th><th scope="col" className="px-4 py-2.5">Extra clients</th><th scope="col" className="px-4 py-2.5 text-right">Total {yearly ? "/ year" : "/ month"}</th></tr></thead>
            <tbody className="divide-y divide-line">
              {quotes.map(({ planId, bill }) => (
                <tr key={planId} className={cn(planId === RECOMMENDED && "bg-success-soft/40")}>
                  <th scope="row" className="px-4 py-3 text-left font-medium">{PLANS[planId].name}{planId === RECOMMENDED && <Badge tone="ink" className="ml-2 align-middle">Recommended</Badge>}{best?.planId === planId && planId !== RECOMMENDED && <Badge tone="green" className="ml-2 align-middle">Lowest price</Badge>}</th>
                  <td className="tabular px-4 py-3">{formatInr(bill.baseInr)}<span className="ml-1 text-xs text-muted">({bill.includedClients} incl.)</span></td>
                  <td className="tabular px-4 py-3">{bill.extraClients > 0 ? `${bill.extraClients} × ${formatInr(bill.extraClientInr)}${yearly ? ` × ${ANNUAL_MONTHS_PAID} mo` : ""} = ${formatInr(bill.extraInr)}` : "—"}</td>
                  <td className="tabular px-4 py-3 text-right font-semibold">{formatInr(bill.totalInr)}</td>
                </tr>
              ))}
              {quotes.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-muted">For this many client firms, talk to us about an Enterprise arrangement.</td></tr>}
            </tbody>
          </table>
        </div>
        {rec.totalInr !== null && (
          <p className="mt-4 text-sm">
            On <strong className="font-semibold">Professional</strong> with {n} client firms: <strong className="tabular font-semibold">{formatInr(rec.totalInr)}</strong>{yearly ? " per year" : " per month"}
            {yearly && rec.perMonthInr !== null && <> (about {formatInr(rec.perMonthInr)}/month; {formatInr(rec.annualSavingInr)} less than paying monthly)</>}.
          </p>
        )}
        {best && best.planId !== RECOMMENDED && <p className="mt-2 text-xs text-muted">At this size {PLANS[best.planId].name} costs the least on price alone; plans also differ in team users and features, so compare the table below.</p>}
      </div>
      <p className="mt-4 text-xs text-muted">Prices are in INR and exclude any applicable taxes. {yearly ? `Yearly billing is ${ANNUAL_MONTHS_PAID} months' price for 12, including additional clients.` : ""} Billing is not live yet: nothing is charged today.</p>
    </section>
  );
}

export function PricingSection({ withComparison }: { withComparison?: boolean }) {
  const [yearly, setYearly] = useState(false);
  return (
    <div>
      <div className="flex flex-col items-center gap-3 text-center"><BillingToggle yearly={yearly} onChange={setYearly} /><p className="text-xs text-muted">Paid plans start with a 14-day free trial. No card required.</p></div>
      <div className="mt-12"><PlanCards yearly={yearly} headingAs={withComparison ? "h2" : "h3"} /></div>
      <div className="mt-12"><ClientCalculator yearly={yearly} headingAs={withComparison ? "h2" : "h3"} /></div>
      <p className="mt-8 text-center text-sm text-muted">Managing a very large portfolio? Enterprise plans are arranged directly — contact details will be published before launch.</p>
      {withComparison && <div className="mt-20"><h2 className="mb-6 text-center text-2xl font-semibold tracking-tight">Compare plans</h2><ComparisonTable /></div>}
    </div>
  );
}
