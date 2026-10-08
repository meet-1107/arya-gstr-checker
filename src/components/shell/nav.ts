import { Briefcase, Flag, BadgeCheck, BarChart3, Bell, CreditCard, FileText, LayoutDashboard, ListChecks, SearchCheck, Receipt, ScrollText, Settings, UserRoundPlus, Users, type LucideIcon } from "lucide-react";
import type { Permission } from "@/lib/permissions";

export interface NavItem { href: string; label: string; icon: LucideIcon; permission?: Permission; soon?: boolean }

export const MAIN_NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/verify", label: "Verify GSTIN", icon: SearchCheck },
  { href: "/portfolio", label: "Portfolio", icon: Briefcase },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/gstins", label: "GSTINs", icon: BadgeCheck },
  { href: "/gstr-1", label: "GSTR-1", icon: FileText },
  { href: "/gstr-3b", label: "GSTR-3B", icon: Receipt },
  { href: "/bulk-checks", label: "Bulk Checks", icon: ListChecks },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/alerts", label: "Alerts", icon: Bell },
];

// Items are hidden from roles that cannot use them (the backend enforces the same rules independently).
export const SECONDARY_NAV: NavItem[] = [
  { href: "/team", label: "Team", icon: UserRoundPlus, permission: "team:manage" },
  { href: "/billing", label: "Billing", icon: CreditCard, permission: "billing:manage" },
  { href: "/concerns", label: "Concerns", icon: Flag, permission: "checks:run" },
  { href: "/audit-logs", label: "Audit Logs", icon: ScrollText, permission: "auditlog:read" },
  { href: "/settings", label: "Settings", icon: Settings },
];

export const ALL_NAV = [...MAIN_NAV, ...SECONDARY_NAV, { href: "/usage", label: "Usage & Billing", icon: CreditCard } as NavItem];

export const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(href + "/");
