"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, MailCheck } from "lucide-react";
import { useSession } from "@/components/session";
import { Alert } from "@/components/ui/feedback";
import { Button, ButtonLink } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/form";
import { AuthFlowError, getAuthClient } from "@/lib/client/auth-client";
import { AuthShell, useAuthRedirect } from "./auth-shell";

const msg = (e: unknown) => (e instanceof AuthFlowError ? e.message : "Something went wrong. Please try again.");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function GoogleButton({ onError }: { onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button variant="secondary" size="lg" className="w-full" loading={busy} onClick={async () => {
      setBusy(true);
      try { await getAuthClient().signInWithGoogle(); } catch (e) { onError(msg(e)); setBusy(false); }
    }}>
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden><path fill="#4285F4" d="M23 12.3c0-.8-.1-1.5-.2-2.2H12v4.2h6.2a5.3 5.3 0 0 1-2.3 3.5v2.9h3.7c2.2-2 3.4-5 3.4-8.4Z" /><path fill="#34A853" d="M12 24c3.1 0 5.7-1 7.6-2.8l-3.7-2.9c-1 .7-2.3 1.1-3.9 1.1-3 0-5.5-2-6.4-4.7H1.8v3A12 12 0 0 0 12 24Z" /><path fill="#FBBC05" d="M5.6 14.7a7.200 7.200 0 0 1 0-4.600v-3H1.800a12 12 0 0 0 0 10.700l3.800-3.100Z" /><path fill="#EA4335" d="M12 4.800c1.700 0 3.200.6 4.400 1.700l3.300-3.300A12 12 0 0 0 1.800 6.700l3.800 3C6.500 6.800 9 4.800 12 4.800Z" /></svg>
      Continue with Google
    </Button>
  );
}
const Divider = () => <div className="my-6 flex items-center gap-3 text-xs text-muted"><span className="h-px flex-1 bg-line" />or<span className="h-px flex-1 bg-line" /></div>;

export function LoginForm() {
  const { redirecting, next } = useAuthRedirect();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!EMAIL.test(email)) return setErr("Enter a valid email address.");
    if (!password) return setErr("Enter your password.");
    setBusy(true);
    try { await getAuthClient().signIn(email, password); } catch (x) { setErr(msg(x)); setBusy(false); }
  };
  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your GST workspace." footer={<>New here? <Link href={`/register${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-medium text-foreground underline underline-offset-2">Create an account</Link></>}>
      <GoogleButton onError={setErr} /><Divider />
      <form onSubmit={submit} className="space-y-4" noValidate>
        {err && <Alert tone="danger">{err}</Alert>}
        <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@firm.com" autoFocus />}</Field>
        <Field label="Password">{(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <div className="text-right"><Link href="/forgot-password" className="text-[13px] text-muted hover:text-foreground hover:underline">Forgot password?</Link></div>
        <Button type="submit" size="lg" className="w-full" loading={busy || redirecting}>Sign in</Button>
      </form>
    </AuthShell>
  );
}

export function RegisterForm() {
  const { redirecting, next } = useAuthRedirect();
  const router = useRouter();
  const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (name.trim().length < 2) return setErr("Enter your name.");
    if (!EMAIL.test(email)) return setErr("Enter a valid email address.");
    if (password.length < 8) return setErr("Password must be at least 8 characters.");
    setBusy(true);
    try { await getAuthClient().signUp(email, password, name); router.replace("/verify-email" + (next ? `?next=${encodeURIComponent(next)}` : "")); } catch (x) { setErr(msg(x)); setBusy(false); }
  };
  return (
    <AuthShell title="Create your account" subtitle="Start free. No card required." footer={<>Already have an account? <Link href="/login" className="font-medium text-foreground underline underline-offset-2">Sign in</Link></>}>
      <GoogleButton onError={setErr} /><Divider />
      <form onSubmit={submit} className="space-y-4" noValidate>
        {err && <Alert tone="danger">{err}</Alert>}
        <Field label="Full name">{(p) => <Input {...p} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Meet Patel" autoFocus />}</Field>
        <Field label="Work email">{(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@firm.com" />}</Field>
        <Field label="Password" hint="At least 8 characters.">{(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Button type="submit" size="lg" className="w-full" loading={busy || redirecting}>Create account</Button>
        <p className="text-center text-xs text-muted">We&apos;ll email you a link to verify your address.</p>
      </form>
    </AuthShell>
  );
}

export function ForgotForm() {
  const [email, setEmail] = useState(""); const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [sent, setSent] = useState<{ devLink?: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (!EMAIL.test(email)) return setErr("Enter a valid email address.");
    setBusy(true);
    try { setSent(await getAuthClient().sendPasswordReset(email)); } catch (x) { setErr(msg(x)); } finally { setBusy(false); }
  };
  return (
    <AuthShell title="Reset your password" subtitle="We'll email you a link to choose a new one." footer={<Link href="/login" className="font-medium text-foreground underline underline-offset-2">Back to sign in</Link>}>
      {sent ? (
        <div className="space-y-4">
          {/* Same message whether or not the account exists (no account enumeration). */}
          <Alert tone="success" title="Check your inbox">If an account exists for <strong>{email}</strong>, a reset link is on its way.</Alert>
          {sent.devLink && <Alert tone="warning" title="Dev mode">No email is sent locally. <Link className="font-medium underline" href={sent.devLink}>Open the reset link</Link>.</Alert>}
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {err && <Alert tone="danger">{err}</Alert>}
          <Field label="Email">{(p) => <Input {...p} type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />}</Field>
          <Button type="submit" size="lg" className="w-full" loading={busy}>Send reset link</Button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetForm() {
  const code = useSearchParams().get("code");
  const router = useRouter();
  const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    if (pw.length < 8) return setErr("Password must be at least 8 characters.");
    if (pw !== pw2) return setErr("Passwords don't match.");
    setBusy(true);
    try { await getAuthClient().confirmPasswordReset(code ?? "", pw); setDone(true); setTimeout(() => router.replace("/login"), 1800); } catch (x) { setErr(msg(x)); setBusy(false); }
  };
  if (!code) return <AuthShell title="Link not valid" subtitle="This password reset link is missing or incomplete." footer={<Link href="/forgot-password" className="font-medium text-foreground underline underline-offset-2">Request a new link</Link>}><span /></AuthShell>;
  return (
    <AuthShell title="Choose a new password">
      {done ? <Alert tone="success" title="Password updated">Redirecting you to sign in…</Alert> : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          {err && <Alert tone="danger">{err}</Alert>}
          <Field label="New password" hint="At least 8 characters.">{(p) => <Input {...p} type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />}</Field>
          <Field label="Confirm new password">{(p) => <Input {...p} type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />}</Field>
          <Button type="submit" size="lg" className="w-full" loading={busy}>Update password</Button>
        </form>
      )}
    </AuthShell>
  );
}

export function VerifyEmailView() {
  const { user, status, signOut } = useSession();
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [busy, setBusy] = useState<string | null>(null); const [note, setNote] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const client = getAuthClient();

  useEffect(() => { if (status === "signedOut") router.replace("/login"); }, [status, router]);
  if (status === "loading" || !user) return <AuthShell title="One moment…"><span /></AuthShell>;
  if (user.emailVerified) {
    return (
      <AuthShell title="Email verified" subtitle="You're all set.">
        <Alert tone="success" title="Thanks — your email is verified." />
        <ButtonLink href={next && next.startsWith("/") ? next : status === "ready" ? "/dashboard" : "/onboarding"} variant="primary" size="lg" className="mt-6 w-full">Continue</ButtonLink>
      </AuthShell>
    );
  }
  const run = async (key: string, fn: () => Promise<void>, ok: string) => {
    setBusy(key); setNote(null);
    try { await fn(); setNote({ tone: "success", text: ok }); } catch (e) { setNote({ tone: "danger", text: msg(e) }); } finally { setBusy(null); }
  };
  return (
    <AuthShell title="Verify your email" subtitle="Confirm your address to create or join a firm." footer={<button className="font-medium text-foreground underline underline-offset-2" onClick={async () => { await signOut(); router.replace("/login"); }}>Use a different account</button>}>
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4"><MailCheck className="mt-0.5 size-5 text-success-strong" aria-hidden /><p className="text-sm">We sent a verification link to <strong>{user.email}</strong>. Open it, then come back and continue.</p></div>
        {note && <Alert tone={note.tone}>{note.text}</Alert>}
        <Button variant="primary" size="lg" className="w-full" loading={busy === "check"} onClick={() => run("check", async () => { await client.reload(); }, "Checked — if you verified, you can continue now.")}><CheckCircle2 className="size-4" aria-hidden />I&apos;ve verified my email</Button>
        <Button variant="secondary" className="w-full" loading={busy === "resend"} onClick={() => run("resend", () => client.sendVerification(), "Verification email sent.")}>Resend email</Button>
        {client.devVerifyEmail && (
          <Alert tone="warning" title="Dev mode" action={<Button size="sm" variant="secondary" loading={busy === "dev"} onClick={() => run("dev", () => client.devVerifyEmail!(), "Email marked as verified.")}>Verify now</Button>}>No email is sent locally. Use this shortcut instead.</Alert>
        )}
      </div>
    </AuthShell>
  );
}
