import { formatLastChecked } from "@/lib/dates";

export const formatNumber = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-IN"));
export const formatInr = (n: number | null) => (n === null ? "Custom" : n === 0 ? "₹0" : `₹${n.toLocaleString("en-IN")}`);

/** "06 Oct 2026, 10:30 AM" in IST. */
export const formatDateTime = (iso?: string) => (iso ? formatLastChecked(iso) : "Never");

export const formatDate = (iso?: string) =>
  iso ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric" }).format(new Date(iso)) : "—";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "082026" → "Aug 2026" */
export const periodLabel = (p: string) => `${MONTHS[parseInt(p.slice(0, 2), 10) - 1] ?? p.slice(0, 2)} ${p.slice(2)}`;

export function relativeTime(iso?: string, now = Date.now()) {
  if (!iso) return "Never";
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24); if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  return formatDate(iso);
}

export const greeting = (d = new Date()) => {
  const h = Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).format(d)) % 24;
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

export const firstName = (name?: string, email?: string) => (name?.trim().split(/\s+/)[0] || email?.split("@")[0] || "there");
export const initials = (name?: string, email?: string) => {
  const src = (name?.trim() || email?.split("@")[0] || "?").split(/[\s._-]+/).filter(Boolean);
  return ((src[0]?.[0] ?? "?") + (src[1]?.[0] ?? "")).toUpperCase();
};
