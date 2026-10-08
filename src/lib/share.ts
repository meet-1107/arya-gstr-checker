// Share text for a verification result. Pure. Only registry STATUS answers are shareable: a timeout, "not found" or invalid format is not
// something to forward as if it were a finding about a business. Stored (cached) results are labelled with their age.
import { EXPLANATIONS, ageLabel, isStatus, type VerificationView } from "./verification";

export interface ShareInput { view: VerificationView; appName: string; now?: Date }

export const isShareable = (v: VerificationView) => isStatus(v.outcome) && v.freshness !== "none" && !!v.verifiedAt;

/** "6 Oct 2026, 2:14 pm" in IST regardless of the viewer's timezone, so a forwarded message reads the same everywhere. */
export function formatIst(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)).replace(/\bam\b/i, "am").replace(/\bpm\b/i, "pm");
}

export interface ShareLine { label: string; value: string }

export function shareLines(v: VerificationView): ShareLine[] {
  const d = v.details ?? {};
  const lines: ShareLine[] = [{ label: "GSTIN", value: v.gstin }, { label: "Status", value: EXPLANATIONS[v.outcome].title }];
  if (d.legalName) lines.push({ label: "Legal name", value: d.legalName });
  if (d.tradeName && d.tradeName !== d.legalName) lines.push({ label: "Trade name", value: d.tradeName });
  if (d.taxpayerType) lines.push({ label: "Taxpayer type", value: d.taxpayerType });
  if (d.state) lines.push({ label: "State", value: d.state });
  return lines;
}

export function freshnessLine(v: VerificationView): string {
  if (!v.verifiedAt) return "";
  return v.freshness === "live" ? `Verified live on ${formatIst(v.verifiedAt)} IST` : `Stored result, verified ${ageLabel(v.ageSeconds ?? 0)} (${formatIst(v.verifiedAt)} IST)`;
}

export function buildShareText({ view, appName }: ShareInput): string {
  if (!isShareable(view)) return "";
  const out = ["GST verification", ...shareLines(view).map((l) => `${l.label}: ${l.value}`), freshnessLine(view)];
  if (view.source === "mock") out.push("Source: MOCK DATA (development) — not a real verification");
  out.push("", `Checked with ${appName}. Registration status can change; verify again before relying on it.`);
  return out.join("\n");
}

export const whatsappUrl = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`;
export const mailtoUrl = (subject: string, text: string) => `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
export const telegramUrl = (text: string) => `https://t.me/share/url?url=${encodeURIComponent(" ")}&text=${encodeURIComponent(text)}`;
