"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { useSession } from "@/components/session";
import { Alert, Skeleton } from "@/components/ui/feedback";
import { Button, ButtonLink } from "@/components/ui/button";
import { api, ApiError, errorMessage } from "@/lib/client/api";

const EXPLAIN: Record<string, string> = {
  INVITATION_INVALID: "This invitation is invalid, already used or has expired. Ask the person who invited you to send a new one.",
  INVITATION_EMAIL_MISMATCH: "This invitation was sent to a different email address. Sign in with the address it was sent to.",
  EMAIL_NOT_VERIFIED: "Verify your email address first, then accept the invitation.",
  ALREADY_MEMBER: "You're already a member of this organization.",
  USER_LIMIT_REACHED: "This team has reached its member limit. Ask the owner to make room.",
};

function Accept() {
  const token = useSearchParams().get("token");
  const router = useRouter();
  const { status, user, refresh, signOut } = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ code: string; message: string } | null>(null);
  const here = `/invite?token=${encodeURIComponent(token ?? "")}`;
  const next = encodeURIComponent(here);

  if (!token) return <AuthShell title="Invitation link incomplete" subtitle="The link is missing its token. Ask for a new invitation."><ButtonLink href="/login" variant="secondary" className="w-full">Go to sign in</ButtonLink></AuthShell>;
  if (status === "loading") return <AuthShell title="Checking your invitation…"><Skeleton className="h-24 w-full" /></AuthShell>;
  if (status === "signedOut" || !user) {
    return (
      <AuthShell title="You've been invited" subtitle="Sign in or create an account with the email address that received the invitation.">
        <div className="space-y-3"><ButtonLink href={`/login?next=${next}`} variant="primary" size="lg" className="w-full">Sign in</ButtonLink><ButtonLink href={`/register?next=${next}`} variant="secondary" size="lg" className="w-full">Create account</ButtonLink></div>
      </AuthShell>
    );
  }
  if (!user.emailVerified) {
    return <AuthShell title="Verify your email first" subtitle="You need a verified email address to join a team."><ButtonLink href={`/verify-email?next=${next}`} variant="primary" size="lg" className="w-full">Verify email</ButtonLink></AuthShell>;
  }

  const accept = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ organizationId: string }>("/api/invitations/accept", { method: "POST", body: { token } });
      await refresh(r.organizationId);
      router.replace("/dashboard");
    } catch (e) { setErr({ code: e instanceof ApiError ? e.code : "", message: errorMessage(e) }); setBusy(false); }
  };

  return (
    <AuthShell title="Join your team" subtitle={`Signed in as ${user.email}.`} footer={<Link href="/dashboard" className="font-medium text-foreground underline underline-offset-2">Not now</Link>}>
      <div className="space-y-4">
        {err && <Alert tone="danger" title="Couldn't accept the invitation">{EXPLAIN[err.code] ?? err.message}</Alert>}
        <Button variant="brand" size="lg" className="w-full" loading={busy} onClick={accept}>Accept invitation</Button>
        {err?.code === "INVITATION_EMAIL_MISMATCH" && <Button variant="secondary" className="w-full" onClick={async () => { await signOut(); router.replace(`/login?next=${next}`); }}>Sign in with a different account</Button>}
      </div>
    </AuthShell>
  );
}

export default function InvitePage() { return <Suspense><Accept /></Suspense>; }
