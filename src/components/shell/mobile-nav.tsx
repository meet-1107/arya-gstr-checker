"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as D from "@radix-ui/react-dialog";
import { BadgeCheck, BarChart3, LayoutDashboard, Menu, Users, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { SidebarContent } from "./sidebar";
import { isActive } from "./nav";

const TABS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/gstins", label: "GST", icon: BadgeCheck },
  { href: "/reports", label: "Reports", icon: BarChart3 },
];

/** Drawer holding the full navigation for small screens. Controlled so the top bar can open it too. */
export function MobileDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-overlay md:hidden" />
        <D.Content className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] shadow-pop outline-none md:hidden" aria-describedby={undefined}>
          <D.Title className="sr-only">Navigation</D.Title>
          <D.Close aria-label="Close navigation" className="absolute right-3 top-4 z-10 rounded-lg p-2 text-inverse-muted hover:bg-inverse-hover"><X className="size-4" /></D.Close>
          <SidebarContent onNavigate={() => onOpenChange(false)} />
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

/** Bottom tab bar (phones only; tablets get the icon rail): the desktop sidebar is never squeezed into a small screen. */
export function MobileTabBar({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();
  const base = "flex flex-1 flex-col items-center gap-1 py-2 text-[11px] font-medium";
  return (
    <nav aria-label="Quick navigation" className="fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      {TABS.map((t) => {
        const active = isActive(pathname, t.href);
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={cn(base, active ? "text-foreground" : "text-muted")}>
            <t.icon className={cn("size-5", active && "text-success-strong")} aria-hidden />{t.label}
          </Link>
        );
      })}
      <button onClick={onMore} className={cn(base, "text-muted")} aria-label="More navigation"><Menu className="size-5" aria-hidden />More</button>
    </nav>
  );
}
