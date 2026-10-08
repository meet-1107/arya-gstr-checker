"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { useSession } from "@/components/session";
import { Badge } from "@/components/ui/badge";
import { Logo } from "./logo";
import { isActive, MAIN_NAV, SECONDARY_NAV, type NavItem } from "./nav";
import { PlanMeter } from "./plan-meter";

function Item({ item, pathname, onNavigate }: { item: NavItem; pathname: string; onNavigate?: () => void }) {
  const active = isActive(pathname, item.href);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      title={item.label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-medium transition-colors md:max-lg:justify-center md:max-lg:px-0 md:max-lg:py-2.5",
        active ? "bg-inverse-active text-inverse-foreground" : "text-inverse-muted hover:bg-inverse-hover hover:text-inverse-foreground",
      )}
    >
      <item.icon className={cn("size-[18px] shrink-0", active ? "text-success" : "text-inverse-subtle group-hover:text-inverse-foreground")} aria-hidden />
      <span className="flex-1 truncate md:max-lg:sr-only">{item.label}</span>
      {item.soon && <Badge tone="neutral" className="md:max-lg:hidden !bg-inverse-hover !px-1.5 !py-0 !text-[10px] !text-inverse-muted">Soon</Badge>}
    </Link>
  );
}

/** Dark navigation rail. Used both as the desktop sidebar and inside the mobile drawer. */
export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { can } = useSession();
  const secondary = SECONDARY_NAV.filter((i) => !i.permission || can(i.permission));
  return (
    <div className="flex h-full flex-col bg-inverse">
      <div className="flex h-16 shrink-0 items-center px-5 md:max-lg:justify-center md:max-lg:px-0"><Logo href="/dashboard" light className="md:max-lg:[&>span:last-child]:hidden" /></div>
      <nav aria-label="Primary" className="flex-1 space-y-6 overflow-y-auto px-3 pb-4 pt-2 md:max-lg:space-y-3 md:max-lg:px-2">
        <ul className="space-y-0.5">{MAIN_NAV.map((i) => <li key={i.href}><Item item={i} pathname={pathname} onNavigate={onNavigate} /></li>)}</ul>
        <div>
          <p className="mb-1.5 px-3 text-[11px] md:max-lg:hidden font-medium uppercase tracking-wider text-inverse-subtle">Workspace</p>
          <ul className="space-y-0.5">{secondary.map((i) => <li key={i.href}><Item item={i} pathname={pathname} onNavigate={onNavigate} /></li>)}</ul>
        </div>
      </nav>
      <div className="shrink-0 p-3 md:max-lg:flex md:max-lg:justify-center md:max-lg:p-2"><PlanMeter onNavigate={onNavigate} /></div>
    </div>
  );
}

export const Sidebar = () => (
  <aside className="fixed inset-y-0 left-0 z-30 hidden w-16 md:block lg:w-64" aria-label="Sidebar"><SidebarContent /></aside>
);
