"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Bell, Check, ChevronDown, ChevronRight, CircleHelp, LogOut, Menu as MenuIcon, Monitor, Moon, Plus, Settings, Sun, TriangleAlert } from "lucide-react";
import { useTheme } from "@/components/theme";
import { useSession } from "@/components/session";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { useApi } from "@/lib/client/hooks";
import type { DashboardData } from "@/lib/client/types";
import { formatNumber } from "@/lib/client/format";
import { ALL_NAV } from "./nav";
import { ALERT_SEVERITY } from "@/lib/alerts";
import type { Alert } from "@/lib/store/types";
import { GlobalSearch } from "./global-search";
import { INDICATOR_DISCLAIMER } from "@/lib/compliance";

function Breadcrumb() {
  const pathname = usePathname();
  const parts = pathname.split("/").filter(Boolean);
  const root = ALL_NAV.find((n) => n.href === `/${parts[0]}`);
  // Second crumb: a plain word ("import") reads as a label; anything else (GSTIN, id) is shown verbatim in monospace.
  const seg = parts[1] ? decodeURIComponent(parts[1]) : null;
  const isWord = !!seg && /^[a-z-]+$/.test(seg);
  const crumbs = [
    { label: root?.label ?? "Home", href: `/${parts[0] ?? ""}`, mono: false },
    ...(seg ? [{ label: isWord ? seg[0].toUpperCase() + seg.slice(1).replace(/-/g, " ") : seg, href: pathname, mono: !isWord }] : []),
  ];
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-sm xl:flex">
      {crumbs.map((c, i) => (
        <span key={c.href} className="flex min-w-0 items-center gap-1.5">
          {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-subtle" aria-hidden />}
          {i === crumbs.length - 1
            ? <span aria-current="page" className={`truncate font-medium ${"mono" in c ? "max-w-40 font-mono text-[13px]" : ""}`}>{c.label}</span>
            : <Link href={c.href} className="text-muted hover:text-foreground">{c.label}</Link>}
        </span>
      ))}
    </nav>
  );
}

/** Notifications are computed from the same stored data as the dashboard — nothing is invented. */
function Notifications() {
  const { data } = useApi<{ dashboard: DashboardData }>("/api/dashboard");
  const unread = useApi<{ items: Alert[]; unreadCount: number }>("/api/alerts?unread=1&limit=3");
  const d = data?.dashboard;
  const items: { id: string; text: string; href: string; tone: "amber" | "red" | "blue" }[] = [];
  if (d) {
    if (d.subscription.readOnly) items.push({ id: "ro", text: "Your workspace is read-only. Upgrade to run checks and edit clients.", href: "/billing", tone: "red" });
    if (d.attention.needsAttention > 0) items.push({ id: "att", text: `${formatNumber(d.attention.needsAttention)} client${d.attention.needsAttention === 1 ? "" : "s"} need attention`, href: "/gstins?attention=1", tone: "amber" });
    if (d.quota.percent !== null && d.quota.percent >= 80) items.push({ id: "q", text: `Your GST check quota is ${d.quota.percent}% used`, href: "/billing", tone: d.quota.percent >= 100 ? "red" : "amber" });
    if (d.gstins.needsRefresh > 0) items.push({ id: "ref", text: `${formatNumber(d.gstins.needsRefresh)} GSTIN${d.gstins.needsRefresh === 1 ? "" : "s"} have stale data`, href: "/gstins?refresh=1", tone: "blue" });
    if (d.gstins.neverChecked > 0) items.push({ id: "nc", text: `${formatNumber(d.gstins.neverChecked)} GSTIN${d.gstins.neverChecked === 1 ? " hasn't" : "s haven't"} been checked yet`, href: "/gstins?checked=false", tone: "blue" });
  }
  return (
    <Menu>
      <MenuTrigger className="relative rounded-lg p-2 text-muted hover:bg-surface-hover hover:text-foreground" aria-label={items.length + (unread.data?.unreadCount ?? 0) ? `Notifications, ${items.length + (unread.data?.unreadCount ?? 0)} new` : "Notifications"}>
        <Bell className="size-[18px]" aria-hidden />
        {items.length + (unread.data?.unreadCount ?? 0) > 0 && <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-danger-solid px-1 text-[10px] font-semibold text-danger-solid-foreground">{Math.min(99, items.length + (unread.data?.unreadCount ?? 0))}</span>}
      </MenuTrigger>
      <MenuContent className="w-80">
        <MenuLabel>Notifications</MenuLabel>
        {items.length === 0 && !(unread.data?.items.length) && <p className="px-2.5 pb-3 pt-1 text-sm text-muted">You&apos;re all caught up.</p>}
        {(unread.data?.items ?? []).map((a) => (
          <MenuItem key={a.id} asChild>
            <Link href="/alerts" className="items-start !gap-3">
              <TriangleAlert className={ALERT_SEVERITY[a.type] === "critical" ? "!text-danger-strong" : ALERT_SEVERITY[a.type] === "warning" ? "!text-warning-strong" : "!text-info-strong"} aria-hidden />
              <span className="text-[13px] leading-snug">{a.message}</span>
            </Link>
          </MenuItem>
        ))}
        {items.map((n) => (
          <MenuItem key={n.id} asChild>
            <Link href={n.href} className="items-start !gap-3">
              <TriangleAlert className={n.tone === "red" ? "!text-danger-strong" : n.tone === "amber" ? "!text-warning-strong" : "!text-info-strong"} aria-hidden />
              <span className="text-[13px] leading-snug">{n.text}</span>
            </Link>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem asChild><Link href="/alerts" className="justify-center text-[13px] font-medium">View all alerts{unread.data && unread.data.unreadCount > 3 ? ` (${unread.data.unreadCount} unread)` : ""}</Link></MenuItem>
        <p className="px-2.5 pb-1.5 pt-0.5 text-[11px] text-subtle">Based on your latest checks. Email alerts are not set up yet.</p>
      </MenuContent>
    </Menu>
  );
}

function OrgSwitcher() {
  const { orgs, activeOrg, switchOrg } = useSession();
  const router = useRouter();
  if (!activeOrg) return null;
  return (
    <Menu>
      <MenuTrigger className="flex max-w-56 items-center gap-2.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left shadow-card hover:border-line-strong" aria-label={`Organization: ${activeOrg.name}. Switch organization`}>
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground">{activeOrg.name[0]?.toUpperCase()}</span>
        <span className="hidden min-w-0 sm:block"><span className="block truncate text-[13px] font-medium leading-tight">{activeOrg.name}</span><span className="block text-[11px] capitalize leading-tight text-muted">{activeOrg.role.toLowerCase()}</span></span>
        <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
      </MenuTrigger>
      <MenuContent className="w-72">
        <MenuLabel>Organizations</MenuLabel>
        {orgs.map((o) => (
          <MenuItem key={o.id} onSelect={() => { if (o.id !== activeOrg.id) { switchOrg(o.id); router.push("/dashboard"); } }}>
            <span className="flex size-6 items-center justify-center rounded-md bg-surface-muted text-[11px] font-semibold text-foreground">{o.name[0]?.toUpperCase()}</span>
            <span className="min-w-0 flex-1"><span className="block truncate">{o.name}</span><span className="block text-[11px] capitalize text-muted">{o.role.toLowerCase()} · {o.plan}</span></span>
            {o.id === activeOrg.id && <Check className="!text-success-strong" aria-label="Current" />}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => router.push("/onboarding?new=1")}><Plus />Create organization</MenuItem>
      </MenuContent>
    </Menu>
  );
}

function UserMenu() {
  const { user, signOut, authMode } = useSession();
  const { pref, setPref } = useTheme();
  const router = useRouter();
  if (!user) return null;
  return (
    <Menu>
      <MenuTrigger className="rounded-full" aria-label="Account menu"><Avatar name={user.name} email={user.email} /></MenuTrigger>
      <MenuContent className="w-64">
        <div className="px-2.5 py-2"><p className="truncate text-sm font-medium">{user.name ?? user.email.split("@")[0]}</p><p className="truncate text-xs text-muted">{user.email}</p>{authMode === "dev" && <Badge tone="amber" className="mt-2">Dev sign-in</Badge>}</div>
        <MenuSeparator />
        <MenuLabel>Theme</MenuLabel>
        {([["light", "Light", Sun], ["dark", "Dark", Moon], ["system", "System", Monitor]] as const).map(([v, l, I]) => (
          <MenuItem key={v} onSelect={() => setPref(v)}><I />{l}{pref === v && <Check className="ml-auto !text-success-strong" aria-label="Selected" />}</MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => router.push("/settings")}><Settings />Settings</MenuItem>
        <MenuItem danger onSelect={async () => { await signOut(); router.replace("/login"); }}><LogOut />Sign out</MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function Topbar({ onOpenNav }: { onOpenNav: () => void }) {
  const [help, setHelp] = useState(false);
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur md:px-6">
      <button onClick={onOpenNav} aria-label="Open navigation" className="rounded-lg p-2 text-muted hover:bg-surface-hover md:hidden"><MenuIcon className="size-5" /></button>
      <Breadcrumb />
      <div className="flex flex-1 justify-center xl:justify-end"><GlobalSearch /></div>
      <div className="flex items-center gap-1">
        <button onClick={() => setHelp(true)} aria-label="Help: how statuses work" className="hidden rounded-lg p-2 text-muted hover:bg-surface-hover hover:text-foreground sm:block"><CircleHelp className="size-[18px]" /></button>
        <Notifications />
        <div className="mx-1"><OrgSwitcher /></div>
        <UserMenu />
      </div>
      <Dialog open={help} onOpenChange={setHelp} title="How statuses work" description="What the labels in this workspace mean.">
        <dl className="space-y-3 text-sm">
          <div><dt className="font-medium">Not checked</dt><dd className="text-muted">No GST check has run yet. This is <em>not</em> the same as inactive.</dd></div>
          <div><dt className="font-medium">Active · Suspended · Cancelled · Inactive</dt><dd className="text-muted">The registration status reported by the GST data provider at the time of the last check.</dd></div>
          <div><dt className="font-medium">Missing · Due · Filed late</dt><dd className="text-muted">Return state as of the last time return history was retrieved. Refresh a GSTIN to update it.</dd></div>
          <div><dt className="font-medium">Internal compliance indicator</dt><dd className="text-muted">{INDICATOR_DISCLAIMER}</dd></div>
        </dl>
      </Dialog>
    </header>
  );
}
