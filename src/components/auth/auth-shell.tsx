"use client";
import { useEffect, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BadgeCheck, FileCheck2, Users2 } from "lucide-react";
import { Logo } from "@/components/shell/logo";
import { useSession } from "@/components/session";
import { Alert } from "@/components/ui/feedback";
import { ThemeToggle } from "@/components/theme";
import { safeNext } from "@/lib/client/safe-next";


/** Sends already-signed-in users to the right place. */
export function useAuthRedirect() {
  const { status, user } = useSession();
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  useEffect(() => {
    if (status === "ready") router.replace(next ?? "/dashboard");
    // A safe `next` (e.g. an invitation link) wins over onboarding so invitees never lose their invite.
    else if (status === "needsOrg") router.replace(user && !user.emailVerified ? `/verify-email${next ? `?next=${encodeURIComponent(next)}` : ""}` : next ?? "/onboarding");
  }, [status, user, router, next]);
  return { next, redirecting: status === "ready" || status === "needsOrg" };
}

export function DevModeNotice() {
  const { authMode } = useSession();
  if (authMode === "unconfigured") {
    return <Alert tone="danger" title="Sign-in isn't configured" className="mb-6">This deployment has no Firebase configuration, so nobody can sign in yet. Set the NEXT_PUBLIC_FIREBASE_* variables and redeploy.</Alert>;
  }
  if (authMode !== "dev") return null;
  return (
    <Alert tone="warning" title="Development sign-in" className="mb-6">
      Firebase isn&apos;t configured, so accounts are stored locally in this browser. This mode is disabled in production builds.
    </Alert>
  );
}

const POINTS = [
  { icon: BadgeCheck, title: "Every client, one view", text: "GSTIN status, GSTR-1 and GSTR-3B filing history side by side." },
  { icon: FileCheck2, title: "Quota you can trust", text: "A shared monthly check allowance with a confirmation before anything is spent." },
  { icon: Users2, title: "Built for CA teams", text: "Invite accountants and viewers with the right level of access." },
];

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
      <div className="flex flex-col px-6 py-8 sm:px-12 lg:px-20">
        <header className="flex items-center justify-between"><Logo /><ThemeToggle /></header>
        <main id="main" className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center py-10">
          <h1 className="text-[26px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
          <div className="mt-8"><DevModeNotice />{children}</div>
          {footer && <div className="mt-8 text-center text-sm text-muted">{footer}</div>}
        </main>
      </div>
      <aside className="relative hidden overflow-hidden bg-inverse lg:block" aria-hidden>
        <div className="absolute -right-32 -top-32 size-96 rounded-full bg-success/10 blur-3xl" />
        <div className="relative flex h-full flex-col justify-center gap-10 px-16 text-inverse-foreground">
          <h2 className="max-w-sm text-3xl font-semibold leading-tight tracking-tight">GST compliance, without the spreadsheet chaos.</h2>
          <ul className="space-y-6">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-inverse-hover text-success"><p.icon className="size-5" /></span>
                <div><p className="text-[15px] font-medium">{p.title}</p><p className="mt-0.5 text-sm text-inverse-muted">{p.text}</p></div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
