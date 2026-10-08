"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Check, Copy, PartyPopper, Plus, Sparkles, Trash2 } from "lucide-react";
import { Logo } from "@/components/shell/logo";
import { useSession } from "@/components/session";
import { Alert, Skeleton } from "@/components/ui/feedback";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { PLANS, type PlanId } from "@/config/plans";
import { ApiError, errorMessage } from "@/lib/client/api";
import { useApiCall } from "@/lib/client/hooks";
import { formatInr, formatNumber } from "@/lib/client/format";
import { TRIAL_DAYS } from "@/lib/subscription";
import { cn } from "@/lib/cn";

const STEPS = ["Your firm", "Your practice", "Your team", "First client", "All set"];
const SIZES: { label: string; max: number; plan: PlanId }[] = [
  { label: "Up to 25", max: 25, plan: "free" }, { label: "26 – 100", max: 100, plan: "starter" }, { label: "101 – 500", max: 500, plan: "professional" },
  { label: "501 – 2,000", max: 2000, plan: "firm" }, { label: "More than 2,000", max: Infinity, plan: "enterprise" },
];
const ROLES = ["Chartered Accountant", "Tax consultant", "GST practitioner", "Accounting team"];
const SELECTABLE: PlanId[] = ["free", "starter", "professional", "firm"];

function Stepper({ step }: { step: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s} className="flex flex-1 items-center gap-2" aria-current={i === step ? "step" : undefined}>
          <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", i < step ? "bg-success-solid text-success-solid-foreground" : i === step ? "bg-primary text-primary-foreground" : "bg-surface-hover text-muted")}>
            {i < step ? <Check className="size-3.5" aria-label="Completed" /> : i + 1}
          </span>
          <span className={cn("hidden text-xs font-medium sm:block", i === step ? "text-foreground" : "text-muted")}>{s}</span>
          {i < STEPS.length - 1 && <span className="h-px flex-1 bg-line" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

function Onboarding() {
  const router = useRouter();
  const isNew = useSearchParams().get("new") === "1";
  const { status, user, orgs, refresh, signOut } = useSession();
  const call = useApiCall();
  const { toast } = useToast();

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [plan, setPlan] = useState<PlanId>("free");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdPlan, setCreatedPlan] = useState<PlanId | null>(null);
  const [invites, setInvites] = useState<{ email: string; role: string }[]>([{ email: "", role: "ACCOUNTANT" }]);
  const [links, setLinks] = useState<{ email: string; url: string }[]>([]);
  const [client, setClient] = useState({ name: "", gstin: "" });
  const [clientAdded, setClientAdded] = useState(false);

  // Guard: signed out → login; unverified → verify; already has an org (and not adding another) → dashboard.
  useEffect(() => {
    if (status === "signedOut") router.replace("/login?next=/onboarding");
    else if (user && !user.emailVerified) router.replace("/verify-email");
    else if (status === "ready" && !isNew && step === 0 && !createdPlan && orgs.length > 0) router.replace("/dashboard");
  }, [status, user, isNew, step, createdPlan, orgs.length, router]);

  if (status === "loading" || status === "signedOut" || !user?.emailVerified) {
    return <div className="mx-auto max-w-xl space-y-4 px-6 pt-32" aria-busy="true"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full !rounded-xl" /></div>;
  }

  const recommended = SIZES.find((s) => s.max === size)?.plan ?? null;
  const seatLimit = PLANS[createdPlan ?? plan].userLimit ?? 99;

  const createWorkspace = async () => {
    setErr(null); setBusy(true);
    try {
      const r = await call<{ organization: { id: string } }>("/api/organizations", { method: "POST", body: { name: name.trim(), plan } });
      await refresh(r.organization.id);
      setCreatedPlan(plan);
      setStep(PLANS[plan].userLimit === 1 ? 3 : 2);
    } catch (e) { setErr(errorMessage(e)); } finally { setBusy(false); }
  };

  const sendInvites = async () => {
    setErr(null); setBusy(true);
    const out: { email: string; url: string }[] = [];
    try {
      for (const inv of invites.filter((i) => i.email.trim())) {
        const r = await call<{ token: string }>("/api/members", { method: "POST", body: inv });
        out.push({ email: inv.email.trim(), url: `${location.origin}/invite?token=${r.token}` });
      }
      setLinks(out);
      if (!out.length) setStep(3);
    } catch (e) {
      setLinks(out);
      setErr(errorMessage(e));
    } finally { setBusy(false); }
  };

  const addClient = async () => {
    setErr(null); setBusy(true);
    try {
      await call("/api/clients", { method: "POST", body: { name: client.name.trim(), gstin: client.gstin.trim() } });
      setClientAdded(true); setStep(4);
    } catch (e) { setErr(e instanceof ApiError && e.code === "INVALID_GSTIN" ? "That GSTIN doesn't look valid. Check the 15 characters and try again." : errorMessage(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="min-h-dvh bg-surface-muted">
      <header className="flex h-16 items-center justify-between border-b border-line bg-surface px-6"><Logo href={orgs.length ? "/dashboard" : "/"} />
        <button onClick={async () => { await signOut(); router.replace("/login"); }} className="text-sm text-muted hover:text-foreground">Sign out</button></header>
      <main id="main" className="mx-auto max-w-2xl px-6 py-10">
        <Stepper step={step} />
        <div className="mt-10">
          {err && <Alert tone="danger" className="mb-6">{err}</Alert>}

          {step === 0 && (
            <section>
              <h1 className="text-2xl font-semibold tracking-tight">Name your firm</h1>
              <p className="mt-1.5 text-sm text-muted">This is your workspace. Your team, clients and usage all live under it.</p>
              <form className="mt-8 space-y-6" onSubmit={(e) => { e.preventDefault(); if (name.trim().length < 2) return setErr("Enter your firm name."); setErr(null); setStep(1); }}>
                <Field label="Firm name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Patel & Associates" autoFocus maxLength={100} />}</Field>
                <Button type="submit" size="lg">Continue<ArrowRight className="size-4" aria-hidden /></Button>
              </form>
            </section>
          )}

          {step === 1 && (
            <section>
              <h1 className="text-2xl font-semibold tracking-tight">About your practice</h1>
              <p className="mt-1.5 text-sm text-muted">We use this to suggest a plan. You can change it later.</p>
              <div className="mt-8 space-y-7">
                <Field label="Your role" optional>{(p) => <Select {...p} value={role ?? ""} onChange={(e) => setRole(e.target.value || null)}><option value="">Prefer not to say</option>{ROLES.map((r) => <option key={r}>{r}</option>)}</Select>}</Field>
                <fieldset>
                  <legend className="mb-2 text-[13px] font-medium">How many GST clients do you manage?</legend>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {SIZES.map((s) => (
                      <label key={s.label} className={cn("flex cursor-pointer items-center justify-center rounded-lg border bg-surface px-3 py-2.5 text-sm shadow-card has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring", "border-line-strong")}>
                        <input type="radio" name="size" className="sr-only" checked={size === s.max} onChange={() => { setSize(s.max); if (s.plan !== "enterprise") setPlan(s.plan); }} />{s.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                {recommended === "enterprise" && <Alert tone="info" title="Enterprise plans are arranged with our team">Start on the Firm plan for now — it comfortably supports up to 2,000 clients.</Alert>}
                <fieldset>
                  <legend className="mb-2 text-[13px] font-medium">Plan</legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {SELECTABLE.map((id) => {
                      const p = PLANS[id];
                      return (
                        <label key={id} className="relative flex cursor-pointer flex-col rounded-xl border border-line-strong bg-surface p-4 shadow-card has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring">
                          <input type="radio" name="plan" className="sr-only" checked={plan === id} onChange={() => setPlan(id)} />
                          <span className="flex items-center justify-between"><span className="font-semibold">{p.name}</span>{recommended === id && <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success-strong"><Sparkles className="size-3" aria-hidden />Suggested</span>}</span>
                          <span className="mt-1 text-sm"><span className="font-semibold">{formatInr(p.monthlyPriceInr)}</span>{p.monthlyPriceInr ? <span className="text-muted"> / month</span> : <span className="text-muted"> forever</span>}</span>
                          <span className="mt-2 text-xs text-muted">{formatNumber(p.monthlyChecks)} live GST checks / month · {formatNumber(p.includedClients)} clients included{p.extraClientInr ? ` (+${formatInr(p.extraClientInr)} each after)` : ""} · {p.userLimit} user{p.userLimit === 1 ? "" : "s"}</span>
                        </label>
                      );
                    })}
                  </div>
                  {plan !== "free" ? <p className="mt-3 text-xs text-muted">Includes a {TRIAL_DAYS}-day free trial. No card needed — after the trial your workspace is read-only until you choose a plan. Your data is always kept.</p>
                    : <p className="mt-3 text-xs text-muted">Free plan: 1 user, no bulk checks. You can upgrade any time.</p>}
                </fieldset>
                <div className="flex gap-3">
                  <Button variant="secondary" size="lg" onClick={() => setStep(0)} disabled={busy}>Back</Button>
                  <Button size="lg" variant="brand" onClick={createWorkspace} loading={busy}>Create workspace</Button>
                </div>
              </div>
            </section>
          )}

          {step === 2 && (
            <section>
              <h1 className="text-2xl font-semibold tracking-tight">Invite your team</h1>
              <p className="mt-1.5 text-sm text-muted">Everyone shares your firm&apos;s clients, plan and GST check quota. Your plan includes {seatLimit} users. You can skip this and do it later in Team.</p>
              {links.length > 0 ? (
                <div className="mt-8 space-y-3">
                  <Alert tone="success" title="Invitations created">Email delivery isn&apos;t set up yet — copy each link and send it to the person. Links are shown once and expire in 7 days.</Alert>
                  {links.map((l) => (
                    <div key={l.url} className="flex items-center gap-2 rounded-lg border border-line bg-surface p-2.5 pl-3.5">
                      <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{l.email}</p><p className="truncate font-mono text-[11px] text-muted">{l.url}</p></div>
                      <Button size="sm" variant="secondary" onClick={async () => { await navigator.clipboard.writeText(l.url); toast({ tone: "success", title: "Invitation link copied" }); }}><Copy className="size-3.5" aria-hidden />Copy</Button>
                    </div>
                  ))}
                  <Button size="lg" className="mt-4" onClick={() => setStep(3)}>Continue<ArrowRight className="size-4" aria-hidden /></Button>
                </div>
              ) : (
                <div className="mt-8 space-y-3">
                  {invites.map((inv, i) => (
                    <div key={i} className="flex gap-2">
                      <div className="flex-1"><Input aria-label={`Teammate ${i + 1} email`} type="email" placeholder="colleague@firm.com" value={inv.email} onChange={(e) => setInvites((l) => l.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} /></div>
                      <div className="w-36"><Select aria-label={`Teammate ${i + 1} role`} value={inv.role} onChange={(e) => setInvites((l) => l.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}><option value="ADMIN">Admin</option><option value="ACCOUNTANT">Accountant</option><option value="VIEWER">Viewer</option></Select></div>
                      {invites.length > 1 && <button aria-label="Remove row" className="rounded-lg p-2.5 text-muted hover:bg-surface-hover" onClick={() => setInvites((l) => l.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>}
                    </div>
                  ))}
                  {invites.length < seatLimit - 1 && <button className="flex items-center gap-1.5 text-[13px] font-medium text-info-strong hover:underline" onClick={() => setInvites((l) => [...l, { email: "", role: "ACCOUNTANT" }])}><Plus className="size-3.5" aria-hidden />Add another</button>}
                  <div className="flex gap-3 pt-3">
                    <Button size="lg" onClick={sendInvites} loading={busy} disabled={!invites.some((i) => i.email.trim())}>Create invitations</Button>
                    <Button size="lg" variant="ghost" onClick={() => setStep(3)}>Skip for now</Button>
                  </div>
                </div>
              )}
            </section>
          )}

          {step === 3 && (
            <section>
              <h1 className="text-2xl font-semibold tracking-tight">Add your first client</h1>
              <p className="mt-1.5 text-sm text-muted">Start with one to see how monitoring works. You can import a whole CSV from the Clients page afterwards.</p>
              <form className="mt-8 space-y-5" onSubmit={(e) => { e.preventDefault(); if (!client.name.trim() || !client.gstin.trim()) return setErr("Enter the client name and GSTIN."); void addClient(); }}>
                <Field label="Client name">{(p) => <Input {...p} value={client.name} onChange={(e) => setClient({ ...client, name: e.target.value })} placeholder="ABC Industries Pvt Ltd" />}</Field>
                <Field label="GSTIN" hint="15 characters, e.g. 24AAACC1206D1ZM">{(p) => <Input {...p} className="font-mono uppercase" value={client.gstin} onChange={(e) => setClient({ ...client, gstin: e.target.value.toUpperCase() })} maxLength={15} spellCheck={false} />}</Field>
                <div className="flex gap-3"><Button type="submit" size="lg" loading={busy}>Add client</Button><Button type="button" size="lg" variant="ghost" onClick={() => setStep(4)}>Skip for now</Button></div>
              </form>
            </section>
          )}

          {step === 4 && (
            <section className="text-center">
              <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-success-soft text-success-strong"><PartyPopper className="size-7" aria-hidden /></span>
              <h1 className="mt-5 text-2xl font-semibold tracking-tight">{name.trim() || "Your workspace"} is ready</h1>
              <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">{clientAdded ? "Your first client is added. Run a GST check from the Clients page to see its status and filings." : "Add clients and run your first GST checks from the dashboard."}</p>
              <Button size="lg" variant="brand" className="mt-8" onClick={() => router.replace("/dashboard")}>Go to dashboard<ArrowRight className="size-4" aria-hidden /></Button>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

export default function Page() { return <Suspense><Onboarding /></Suspense>; }
