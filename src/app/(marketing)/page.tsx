import Link from "next/link";
import { BadgeCheck, ClipboardList, FileSpreadsheet, Gauge, Lock, ShieldCheck, Users2, FileText, Bell, ListChecks, ArrowRight, Check } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PricingSection } from "@/components/marketing/pricing";
import { INDICATOR_DISCLAIMER } from "@/lib/compliance";

const STEPS = [
  { n: "01", title: "Add your clients", text: "Import a CSV or add clients one by one. Invalid and duplicate GSTINs are caught up front, and nothing is saved until you confirm." },
  { n: "02", title: "Verify GSTINs", text: "Check registration status for one client or your whole list. Every result shows when it was last checked." },
  { n: "03", title: "Monitor filings", text: "See GSTR-1 and GSTR-3B history per client, with due dates, filing dates and ARNs where the provider supplies them." },
  { n: "04", title: "Act on what matters", text: "A single list of clients with suspended GSTINs and missing or late returns, so follow-ups don't slip." },
];

const FEATURES = [
  { icon: BadgeCheck, title: "GSTIN verification", text: "Active, suspended, cancelled — and never a guess. A client that hasn't been checked is shown as “Not checked”, not as inactive." },
  { icon: FileText, title: "GSTR-1 & GSTR-3B monitoring", text: "Filing status, due date, filing date and delay for every period, filterable by financial year and status." },
  { icon: ListChecks, title: "Bulk GST checks", text: "Run checks across all clients or a selection, with a confirmation showing exactly how many checks it will use first." },
  { icon: Gauge, title: "A quota you can see", text: "One monthly check allowance for the whole firm, with a live meter. Cached results don't use it." },
  { icon: Users2, title: "Teams and roles", text: "Owner, admin, accountant and viewer roles. Invite your team — they all work from the same client list." },
  { icon: ShieldCheck, title: "Internal compliance indicator", text: "A quick Good / Needs attention / High attention read on each client — clearly labelled as ours, not a government rating." },
  { icon: FileSpreadsheet, title: "Reports", text: "CSV, Excel and PDF exports for status, missing returns and monthly summaries.", soon: true },
  { icon: Bell, title: "Alerts", text: "Get told when a GSTIN changes status, a return goes missing or your quota runs low.", soon: true },
];

const FAQ = [
  { q: "Where does the GST data come from?", a: "From a licensed GST data provider, fetched on our servers. Availability and freshness depend on that provider, which is why every result carries a “last checked” time and a refresh button." },
  { q: "Is the compliance indicator an official GST score?", a: INDICATOR_DISCLAIMER },
  { q: "What does “Not checked” mean?", a: "No check has run for that GSTIN yet. It does not mean the registration is inactive — we never treat missing data as bad news." },
  { q: "Who can see my clients?", a: "Only members of your firm. Each firm is a separate workspace; access is checked on the server for every request." },
  { q: "How does the free trial work?", a: "Paid plans start with a 14-day trial and no card. If you don't choose a plan afterwards, your workspace becomes read-only — your data is kept." },
  { q: "Can my whole team share one plan?", a: "Yes. The subscription belongs to the firm: clients, seats and the monthly GST check allowance are shared by everyone on the team." },
];

function Preview() {
  // Static illustration — clearly labelled; not live data.
  const row = (n: string, g: string, tone: string, label: string) => (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5"><span className="min-w-0"><span className="block truncate text-[13px] font-medium">{n}</span><span className="block font-mono text-[11px] text-muted">{g}</span></span><span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{label}</span></li>
  );
  return (
    <div className="relative mx-auto mt-16 max-w-4xl" aria-hidden>
      <div className="absolute -inset-x-8 -top-8 bottom-0 -z-10 rounded-[2rem] bg-gradient-to-b from-success-soft to-transparent" />
      <div className="overflow-hidden rounded-2xl border border-line bg-surface-muted shadow-pop">
        <div className="flex items-center gap-1.5 border-b border-line bg-surface px-4 py-3"><span className="size-2.5 rounded-full bg-surface-hover" /><span className="size-2.5 rounded-full bg-surface-hover" /><span className="size-2.5 rounded-full bg-surface-hover" /><span className="ml-3 text-[11px] text-subtle">Illustration · sample data</span></div>
        <div className="grid gap-4 p-5 sm:grid-cols-3">
          {[["Total clients", "—"], ["Needs attention", "—"], ["Checks remaining", "—"]].map(([l]) => (
            <div key={l} className="rounded-xl border border-line bg-surface p-4"><p className="text-xs text-muted">{l}</p><div className="skeleton mt-3 h-7 w-16" /></div>
          ))}
          <div className="rounded-xl border border-line bg-surface sm:col-span-3">
            <p className="border-b border-line px-4 py-3 text-[13px] font-semibold">Needs attention</p>
            <ul className="divide-y divide-line">
              {row("Sample Industries Pvt Ltd", "24AAAAA0000A1Z5", "bg-danger-soft text-danger-strong", "GSTR-3B missing")}
              {row("Example Traders", "27AAAAA0000A1Z5", "bg-warning-soft text-warning-strong", "GSTIN suspended")}
              {row("Demo Enterprises LLP", "29AAAAA0000A1Z5", "bg-warning-soft text-warning-strong", "GSTR-1 filed late")}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  return (
    <>
      <section className="relative overflow-hidden">
        <div className="mx-auto max-w-6xl px-6 pb-20 pt-16 sm:pt-24">
          <div className="mx-auto max-w-3xl text-center">
            <Badge tone="green" className="mb-6">Built for Indian CA firms</Badge>
            <h1 className="text-balance text-4xl font-semibold leading-[1.08] tracking-tight sm:text-6xl">GST compliance, without the spreadsheet chaos.</h1>
            <p className="mx-auto mt-6 max-w-2xl text-balance text-lg text-muted">Monitor GSTINs, GSTR-1 and GSTR-3B for your entire CA practice from one workspace.</p>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <ButtonLink href="/register" size="lg" variant="primary">Start free<ArrowRight className="size-4" aria-hidden /></ButtonLink>
              <ButtonLink href="/pricing" size="lg" variant="secondary">View pricing</ButtonLink>
            </div>
            <p className="mt-4 text-xs text-muted">Free plan available · No card required</p>
          </div>
          <Preview />
        </div>
      </section>

      <section className="border-y border-line bg-surface-muted">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-12 md:grid-cols-3">
          {[
            ["One workspace for the whole firm", "Clients, GSTINs, filings and your team in one place — not scattered across sheets and portals."],
            ["Honest about what it knows", "Every status shows when it was last checked. Missing data is shown as missing, never as bad news."],
            ["Made for how CA firms work", "One subscription, shared by your team, with roles that match who does what."],
          ].map(([t, d]) => <div key={t}><h2 className="text-[15px] font-semibold">{t}</h2><p className="mt-1.5 text-sm text-muted">{d}</p></div>)}
        </div>
      </section>

      <section id="how-it-works" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-24">
        <div className="max-w-2xl"><h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">From client list to clear picture</h2><p className="mt-3 text-muted">A simple loop you can repeat every filing cycle.</p></div>
        <ol className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s) => (
            <li key={s.n} className="rounded-2xl border border-line bg-surface p-6 shadow-card">
              <span className="font-mono text-sm text-success-strong">{s.n}</span>
              <h3 className="mt-3 text-base font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-muted">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="features" className="scroll-mt-20 bg-inverse py-24 text-inverse-foreground">
        <div className="mx-auto max-w-6xl px-6">
          <div className="max-w-2xl"><h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Everything your practice needs to stay on top of GST</h2><p className="mt-3 text-inverse-muted">Monitoring, bulk checks, teams and a quota you can trust.</p></div>
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-inverse-border bg-inverse-border sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="bg-inverse p-6">
                <span className="flex size-10 items-center justify-center rounded-xl bg-inverse-hover text-success"><f.icon className="size-5" aria-hidden /></span>
                <h3 className="mt-4 flex items-center gap-2 text-[15px] font-semibold">{f.title}{f.soon && <span className="rounded-full bg-inverse-hover px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-inverse-muted">Soon</span>}</h3>
                <p className="mt-2 text-sm leading-relaxed text-inverse-muted">{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-24 lg:grid-cols-2">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Check hundreds of clients without the guesswork</h2>
          <p className="mt-4 text-muted">Pick the clients, see exactly how many checks it will use and how long it should take, then confirm. Progress is tracked, failures are retryable and nothing is charged twice.</p>
          <ul className="mt-6 space-y-3 text-sm">
            {["Confirmation before any quota is spent", "Cached results don't use your allowance", "Safe to retry — duplicate submissions are ignored", "Failed items can be re-run in one click"].map((t) => <li key={t} className="flex gap-2.5"><Check className="mt-0.5 size-4 shrink-0 text-success-strong" aria-hidden />{t}</li>)}
          </ul>
        </div>
        <div className="rounded-2xl border border-line bg-surface-muted p-6">
          <div className="flex items-center gap-3"><ClipboardList className="size-5 text-muted" aria-hidden /><h3 className="font-semibold">Before you start</h3></div>
          <dl className="mt-5 space-y-3 text-sm">
            {[["GSTINs selected", "Your choice"], ["Checks this will use", "Shown before you confirm"], ["Checks remaining after", "Shown before you confirm"], ["Estimated time", "Shown before you confirm"]].map(([k, v]) => <div key={k} className="flex justify-between border-b border-line pb-3 last:border-0"><dt className="text-muted">{k}</dt><dd className="font-medium">{v}</dd></div>)}
          </dl>
        </div>
      </section>

      <section id="pricing" className="scroll-mt-20 border-y border-line bg-surface-muted py-24">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mx-auto mb-12 max-w-2xl text-center"><h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Simple pricing for every practice</h2><p className="mt-3 text-muted">One plan for the whole firm. Start free and upgrade when you grow.</p></div>
          <PricingSection />
          <p className="mt-6 text-center text-sm"><Link href="/pricing" className="font-medium underline underline-offset-2">Compare all features</Link></p>
        </div>
      </section>

      <section id="security" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-24">
        <div className="max-w-2xl"><h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Your clients&apos; data stays yours</h2></div>
        <div className="mt-10 grid gap-6 md:grid-cols-3">
          {[[Lock, "Separate workspace per firm", "Every request is checked on the server against your firm membership. No firm can see another’s data."], [Users2, "Roles that limit access", "Viewers are read-only; billing and team controls are reserved for owners and admins."], [ShieldCheck, "Keys stay on the server", "GST provider credentials never reach the browser. Important actions are recorded in an audit trail."]].map(([Icon, t, d]) => {
            const I = Icon as typeof Lock;
            return <div key={t as string} className="rounded-2xl border border-line bg-surface p-6 shadow-card"><I className="size-5 text-success-strong" aria-hidden /><h3 className="mt-4 font-semibold">{t as string}</h3><p className="mt-2 text-sm text-muted">{d as string}</p></div>;
          })}
        </div>
      </section>

      <section id="faq" className="scroll-mt-20 border-t border-line bg-surface-muted py-24">
        <div className="mx-auto max-w-3xl px-6">
          <h2 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">Frequently asked questions</h2>
          <div className="mt-10 divide-y divide-line rounded-2xl border border-line bg-surface shadow-card">
            {FAQ.map((f) => (
              <details key={f.q} className="group px-6 py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">{f.q}<span className="text-xl leading-none text-muted transition-transform group-open:rotate-45" aria-hidden>+</span></summary>
                <p className="mt-3 text-sm leading-relaxed text-muted">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-inverse py-20 text-center text-inverse-foreground">
        <div className="mx-auto max-w-2xl px-6">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Spend less time chasing GST status</h2>
          <p className="mt-4 text-inverse-muted">Create your workspace in a couple of minutes. The free plan is free forever.</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <ButtonLink href="/register" size="lg" variant="brand">Start free</ButtonLink>
            <ButtonLink href="/pricing" size="lg" variant="inverse">View pricing</ButtonLink>
          </div>
        </div>
      </section>
    </>
  );
}
