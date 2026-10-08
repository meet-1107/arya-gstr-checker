// Client portfolio model: one row per client, joining the client with its latest known GST answer. Pure (server + client).
// Two answer sources exist for a client GSTIN: the verification engine (VerificationRecord, registry status only) and full GST checks
// (GstinRecord, with returns). The portfolio shows whichever is NEWER and says which it was.
import { outcomeFromStatus, isStatus, type VerificationOutcome } from "./verification";
import type { ChangeInfo } from "./change-detection";
import type { Client, GstinRecord, VerificationRecord } from "./store/types";

export type PortfolioFreshness = "fresh" | "stale" | "expired" | "never";
export type VerifySchedule = "daily" | "weekly" | "monthly";
export const SCHEDULES: readonly VerifySchedule[] = ["daily", "weekly", "monthly"];
export const isSchedule = (v: unknown): v is VerifySchedule => v === "daily" || v === "weekly" || v === "monthly";
export const SCHEDULE_MS: Record<VerifySchedule, number> = { daily: 86_400_000, weekly: 7 * 86_400_000, monthly: 30 * 86_400_000 };
export const SCHEDULE_LABEL: Record<VerifySchedule, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

/** A change counts as "recent" (badge in the list, counted in the summary) for this long after it was detected. */
export const RECENT_CHANGE_MS = 14 * 86_400_000;
/** Registry answers that deserve a look. NOT_FOUND on a client's GSTIN is included: it is unusual for a real client. */
export const ATTENTION_OUTCOMES: readonly VerificationOutcome[] = ["SUSPENDED", "CANCELLED", "INACTIVE", "NOT_FOUND"];

export interface FreshnessWindows { freshMs: number; staleUsableMs: number }

export function classifyFreshness(verifiedAtIso: string | undefined, nowMs: number, w: FreshnessWindows): PortfolioFreshness {
  if (!verifiedAtIso) return "never";
  const age = nowMs - new Date(verifiedAtIso).getTime();
  if (!Number.isFinite(age) || age < w.freshMs) return "fresh"; // a future timestamp (clock skew) is not "old"
  return age < w.staleUsableMs ? "stale" : "expired";
}

/** When a schedule next runs: one interval after the latest answer (due now if that has passed or there is no answer yet). */
export function nextRun(schedule: VerifySchedule, lastAnswerIso: string | undefined, nowMs: number): string {
  const base = lastAnswerIso ? new Date(lastAnswerIso).getTime() : NaN;
  const t = Number.isFinite(base) ? base + SCHEDULE_MS[schedule] : nowMs;
  return new Date(Math.max(t, nowMs)).toISOString();
}

export interface PortfolioRow {
  clientId: string;
  name: string;
  gstin: string;
  assignedTo?: string;
  /** Latest known registry status; null = never verified. */
  status: VerificationOutcome | null;
  /** Which system produced `status`: the verification engine or a full GST check. */
  statusSource: "verification" | "check" | null;
  legalName?: string;
  verifiedAt?: string;
  /** Age of `verifiedAt` when this row was built (server clock), so the browser never needs the current time. */
  ageSeconds?: number;
  freshness: PortfolioFreshness;
  /** Meaningful change detected by the last live verification (only when recent). */
  change?: Pick<ChangeInfo, "from" | "to" | "at" | "deteriorated">;
  tags?: string[];
  saved?: boolean;
  schedule?: VerifySchedule;
  nextVerifyAt?: string;
  /** Multi-GSTIN client firms only (absent for a single GSTIN): every GSTIN of the firm, and how many. */
  gstins?: string[];
  gstinCount?: number;
  /** Multi-GSTIN only: the GSTIN that `status`, `verifiedAt`, `legalName` and `change` came from (the most serious one). */
  statusGstin?: string;
}

// ---- multi-GSTIN firms: one row per client, showing the MOST SERIOUS answer across its GSTINs -----------------------------------------
const ROW_SEVERITY: Record<string, number> = { CANCELLED: 6, SUSPENDED: 5, NOT_FOUND: 4, INACTIVE: 3, UNKNOWN: 2, ACTIVE: 1 };
const FRESH_RANK: Record<PortfolioFreshness, number> = { fresh: 0, stale: 1, expired: 2, never: 3 };

/**
 * Merge the per-GSTIN rows of ONE client into the client's row. A single-GSTIN client returns its row unchanged (byte-for-byte), so existing
 * behaviour is preserved. For several GSTINs: status = the most serious known answer (never-verified GSTINs do not mask a real problem),
 * freshness = the WORST across GSTINs (one stale or never-verified registration makes the client "needs refresh"), a recent change on ANY
 * GSTIN is surfaced. Identity (name, tags, saved, schedule) stays that of the primary GSTIN.
 */
export function mergeGstinRows(rows: PortfolioRow[]): PortfolioRow {
  if (rows.length === 1) return rows[0];
  const primary = rows[0];
  const worst = rows.reduce((a, b) => ((b.status ? ROW_SEVERITY[b.status] ?? 0 : 0) > (a.status ? ROW_SEVERITY[a.status] ?? 0 : 0) ? b : a), rows[0]);
  const fresh = rows.reduce((a, b) => (FRESH_RANK[b.freshness] > FRESH_RANK[a] ? b.freshness : a), rows[0].freshness);
  const change = rows.filter((r) => r.change).sort((a, b) => (b.change!.at).localeCompare(a.change!.at))[0]?.change;
  return {
    ...primary,
    status: worst.status, statusSource: worst.statusSource, legalName: worst.legalName ?? primary.legalName,
    verifiedAt: worst.verifiedAt, ageSeconds: worst.ageSeconds, freshness: fresh, change,
    gstins: rows.map((r) => r.gstin), gstinCount: rows.length, statusGstin: worst.gstin,
  };
}

export function buildRow(c: Client, rec: VerificationRecord | null | undefined, g: GstinRecord | null | undefined, nowMs: number, w: FreshnessWindows): PortfolioRow {
  const fromVer = rec && isStatus(rec.outcome) || rec?.outcome === "NOT_FOUND" ? { outcome: rec!.outcome, at: rec!.verifiedAt, src: "verification" as const, legal: rec!.details?.legalName } : null;
  const gs = g?.lastCheckedAt ? outcomeFromStatus(g.status) : null;
  const fromCheck = g?.lastCheckedAt && gs && gs !== "UNKNOWN" ? { outcome: gs, at: g.lastCheckedAt, src: "check" as const, legal: g.legalName } : null;
  const best = fromVer && fromCheck ? (fromCheck.at > fromVer.at ? fromCheck : fromVer) : fromVer ?? fromCheck;
  const change = rec?.change && nowMs - new Date(rec.change.at).getTime() < RECENT_CHANGE_MS
    ? { from: rec.change.from, to: rec.change.to, at: rec.change.at, deteriorated: rec.change.deteriorated } : undefined;
  return {
    clientId: c.id, name: c.name, gstin: c.gstin, assignedTo: c.assignedTo,
    status: best?.outcome ?? null, statusSource: best?.src ?? null, legalName: best?.legal ?? c.legalName, verifiedAt: best?.at, ageSeconds: best ? Math.max(0, Math.round((nowMs - new Date(best.at).getTime()) / 1000)) : undefined,
    freshness: classifyFreshness(best?.at, nowMs, w), change, tags: rec?.tags, saved: rec?.saved,
    schedule: c.verifySchedule, nextVerifyAt: c.nextVerifyAt,
  };
}

export interface PortfolioFilters {
  q?: string; status?: VerificationOutcome | "never"; freshness?: PortfolioFreshness; changed?: boolean; tag?: string; assignedTo?: string; scheduled?: boolean;
  /** "Needs a verification": never verified, or past the freshness window. */
  needsRefresh?: boolean; attention?: boolean;
}

export function filterRows(rows: PortfolioRow[], f: PortfolioFilters): PortfolioRow[] {
  const q = f.q?.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && !(r.name.toLowerCase().includes(q) || (r.gstins ?? [r.gstin]).some((g) => g.toLowerCase().startsWith(q)) || (r.legalName ?? "").toLowerCase().includes(q))) return false;
    if (f.status && (f.status === "never" ? r.status !== null : r.status !== f.status)) return false;
    if (f.freshness && r.freshness !== f.freshness) return false;
    if (f.changed && !r.change) return false;
    if (f.tag && !(r.tags ?? []).includes(f.tag)) return false;
    if (f.assignedTo && r.assignedTo !== f.assignedTo) return false;
    if (f.scheduled !== undefined && !!r.schedule !== f.scheduled) return false;
    if (f.needsRefresh && r.freshness === "fresh") return false;
    if (f.attention && !(r.status && ATTENTION_OUTCOMES.includes(r.status))) return false;
    return true;
  });
}

export type PortfolioSort = "name" | "attention" | "oldest";
const SEVERITY: Partial<Record<VerificationOutcome, number>> = { CANCELLED: 0, SUSPENDED: 1, NOT_FOUND: 2, INACTIVE: 3 };

export function sortRows(rows: PortfolioRow[], sort: PortfolioSort): PortfolioRow[] {
  const byName = (a: PortfolioRow, b: PortfolioRow) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.gstin.localeCompare(b.gstin);
  const out = [...rows];
  if (sort === "attention") out.sort((a, b) => (SEVERITY[a.status ?? "ACTIVE"] ?? 9) - (SEVERITY[b.status ?? "ACTIVE"] ?? 9) || (b.change ? 1 : 0) - (a.change ? 1 : 0) || byName(a, b));
  else if (sort === "oldest") out.sort((a, b) => (a.verifiedAt ?? "").localeCompare(b.verifiedAt ?? "") || byName(a, b)); // never verified ("") first
  else out.sort(byName);
  return out;
}

export interface PortfolioSummary {
  total: number;
  byStatus: Partial<Record<VerificationOutcome | "never", number>>;
  byFreshness: Record<PortfolioFreshness, number>;
  attention: number;
  changedRecently: number;
  /** Never verified or past the freshness window: what a "refresh all" would actually verify. */
  needsRefresh: number;
  scheduled: number;
  /** Scheduled and due now. */
  due: number;
}

export function summarize(rows: PortfolioRow[], nowMs: number): PortfolioSummary {
  const s: PortfolioSummary = { total: rows.length, byStatus: {}, byFreshness: { fresh: 0, stale: 0, expired: 0, never: 0 }, attention: 0, changedRecently: 0, needsRefresh: 0, scheduled: 0, due: 0 };
  for (const r of rows) {
    const k = r.status ?? "never";
    s.byStatus[k] = (s.byStatus[k] ?? 0) + 1;
    s.byFreshness[r.freshness]++;
    if (r.status && ATTENTION_OUTCOMES.includes(r.status)) s.attention++;
    if (r.change) s.changedRecently++;
    if (r.freshness !== "fresh") s.needsRefresh++;
    if (r.schedule) { s.scheduled++; if (r.nextVerifyAt && new Date(r.nextVerifyAt).getTime() <= nowMs) s.due++; }
  }
  return s;
}
