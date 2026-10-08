"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "@/components/session";
import { Alert, ErrorState, Skeleton } from "@/components/ui/feedback";
import { useApi } from "@/lib/client/hooks";
import type { SubscriptionOverview } from "@/lib/client/types";
import { MobileDrawer, MobileTabBar } from "./mobile-nav";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

function ShellSkeleton() {
  return (
    <div className="min-h-dvh" aria-busy="true" aria-label="Loading your workspace">
      <div className="fixed inset-y-0 left-0 hidden w-16 bg-inverse md:block lg:w-64" />
      <div className="md:pl-16 lg:pl-64">
        <div className="flex h-16 items-center border-b border-line bg-surface px-6"><Skeleton className="h-9 w-72" /></div>
        <div className="space-y-6 p-6"><Skeleton className="h-8 w-64" /><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 !rounded-xl" />)}</div></div>
      </div>
    </div>
  );
}

/** Redirects unauthenticated users to /login and org-less users to onboarding. Authorization itself is enforced by the API. */
function AuthGate({ children }: { children: ReactNode }) {
  const { status, user, refresh, error } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (status === "signedOut") router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    if (status === "needsOrg") router.replace(user && !user.emailVerified ? "/verify-email" : "/onboarding");
  }, [status, router, pathname, user]);
  if (status === "error") return <div className="mx-auto max-w-lg pt-24"><ErrorState title="We couldn't load your workspace" description={error ?? undefined} onRetry={() => void refresh()} /></div>;
  if (status !== "ready") return <ShellSkeleton />;
  return <>{children}</>;
}

function SubscriptionBanner() {
  const { data } = useApi<{ subscription: SubscriptionOverview }>("/api/subscription");
  const { can } = useSession();
  const [now] = useState(() => Date.now()); // stable per mount; keeps render pure
  const s = data?.subscription;
  if (!s) return null;
  const manage = can("billing:manage");
  const link = <Link href="/billing" className="shrink-0 self-center text-[13px] font-medium underline underline-offset-2">{manage ? "View plans" : "Usage"}</Link>;
  if (s.readOnly) {
    return (
      <Alert tone="danger" title={s.status === "expired" ? "Your trial has ended — this workspace is read-only" : "This workspace is read-only"} action={link} className="mb-6">
        You can still view and export your data. {manage ? "Choose a plan to run GST checks and edit clients again." : "Ask your organization owner to choose a plan."}
      </Alert>
    );
  }
  if (s.status === "trialing" && s.trialEndsAt) {
    const days = Math.ceil((new Date(s.trialEndsAt).getTime() - now) / 864e5);
    if (days <= 7) return <Alert tone="warning" title={`Trial ends in ${Math.max(days, 0)} day${days === 1 ? "" : "s"}`} action={link} className="mb-6">After the trial the workspace becomes read-only until a plan is chosen. Your data is kept.</Alert>;
  }
  return null;
}

export function AppFrame({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  return (
    <AuthGate>
      <Sidebar />
      <MobileDrawer open={drawer} onOpenChange={setDrawer} />
      <div className="min-h-dvh md:pl-16 lg:pl-64">
        <Topbar onOpenNav={() => setDrawer(true)} />
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1280px] px-4 pb-28 pt-5 outline-none sm:pt-6 md:px-6 md:pb-12 lg:px-8 lg:pt-8 2xl:max-w-[1440px]">
          <SubscriptionBanner />
          {children}
        </main>
      </div>
      <MobileTabBar onMore={() => setDrawer(true)} />
    </AuthGate>
  );
}
