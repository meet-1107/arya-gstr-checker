export type FilingFrequency = "MONTHLY" | "QUARTERLY";

/** FY runs Apr–Mar. Returns e.g. "2026-27". */
export function currentFinancialYear(d = new Date()): string {
  const y = d.getUTCFullYear();
  const start = d.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Periods "MMYYYY" Apr..Mar for the financial year. */
export function returnPeriodsForFinancialYear(fy: string): string[] {
  const start = parseInt(fy.slice(0, 4), 10);
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const m = ((3 + i) % 12) + 1;
    const y = m >= 4 ? start : start + 1;
    out.push(`${String(m).padStart(2, "0")}${y}`);
  }
  return out;
}

/**
 * Statutory default due dates: GSTR-1 on 11th, GSTR-3B on 20th of the following month.
 * QUARTERLY (QRMP): GSTR-1 on 13th / GSTR-3B on 22nd after quarter end (24th for some states not modelled).
 * NOTE: Government extensions/waivers are NOT modelled — see README known issues.
 */
export function dueDateFor(type: "GSTR1" | "GSTR3B", period: string, freq: FilingFrequency): Date {
  const m = parseInt(period.slice(0, 2), 10);
  const y = parseInt(period.slice(2), 10);
  const endMonth = freq === "QUARTERLY" ? Math.ceil(m / 3) * 3 : m; // 1-based month the period ends in
  const day = freq === "QUARTERLY" ? (type === "GSTR1" ? 13 : 22) : type === "GSTR1" ? 11 : 20;
  // Date.UTC month is 0-based, so passing endMonth (1-based) yields the following month; overflow rolls the year.
  return new Date(Date.UTC(y, endMonth, day, 23, 59, 59));
}

export function formatLastChecked(iso: string | undefined, tz = "Asia/Kolkata"): string {
  if (!iso) return "Never checked";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: tz, day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  }).format(new Date(iso));
}

export const currentMonthKey = (d = new Date()) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
