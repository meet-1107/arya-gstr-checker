"use client";
// Renders a shareable PNG of a verification result with the Canvas API (no dependency). Fixed light palette on purpose: the image is
// an artefact that gets forwarded to people who never see the app's theme. Text comes from src/lib/share.ts so image and message agree.
import { freshnessLine, isShareable, shareLines } from "@/lib/share";
import { EXPLANATIONS, type VerificationView } from "@/lib/verification";

const TONE = {
  success: { bg: "#e6f6f0", fg: "#0b7a5c" }, warning: { bg: "#fff4e0", fg: "#a84f06" }, danger: { bg: "#fdeceb", fg: "#b01919" },
  info: { bg: "#e8f0fe", fg: "#1d4ed8" }, neutral: { bg: "#f1f5f9", fg: "#172033" },
} as const;

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/), lines: string[] = []; let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxWidth && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

export async function renderShareCard(view: VerificationView, appName: string): Promise<Blob | null> {
  if (!isShareable(view) || typeof document === "undefined") return null;
  const W = 1080, pad = 64, inner = W - pad * 2;
  const rows = shareLines(view).filter((l) => l.label !== "GSTIN" && l.label !== "Status");
  const tone = TONE[EXPLANATIONS[view.outcome].tone];
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const meaning = EXPLANATIONS[view.outcome].meaning;
  ctx.font = "400 30px system-ui, sans-serif";
  const meaningLines = wrap(ctx, meaning, inner);
  const H = pad + 44 + 40 + 96 + 50 + 38 + 36 + rows.length * 78 + 52 + meaningLines.length * 40 + 60 + 40 + pad;
  canvas.width = W; canvas.height = H;

  ctx.fillStyle = "#f7f9fc"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(24, 24, W - 48, H - 48, 28); ctx.fill(); ctx.stroke();

  let y = pad + 24;
  ctx.fillStyle = "#56667c"; ctx.font = "600 26px system-ui, sans-serif"; ctx.textBaseline = "alphabetic";
  ctx.fillText("GST VERIFICATION", pad, y); y += 54;

  ctx.font = "700 34px system-ui, sans-serif";
  const label = EXPLANATIONS[view.outcome].title;
  const bw = ctx.measureText(label).width + 56;
  ctx.fillStyle = tone.bg; ctx.beginPath(); ctx.roundRect(pad, y - 40, bw, 62, 31); ctx.fill();
  ctx.fillStyle = tone.fg; ctx.fillText(label, pad + 28, y + 3); y += 70;

  const name = view.details?.legalName ?? view.details?.tradeName ?? "";
  ctx.fillStyle = "#172033"; ctx.font = "700 44px system-ui, sans-serif";
  ctx.fillText(name.length > 34 ? name.slice(0, 33) + "…" : name, pad, y); y += 54;
  ctx.fillStyle = "#56667c"; ctx.font = "500 34px ui-monospace, Menlo, Consolas, monospace";
  ctx.fillText(view.gstin, pad, y); y += 56;

  ctx.strokeStyle = "#e2e8f0"; ctx.beginPath(); ctx.moveTo(pad, y - 20); ctx.lineTo(W - pad, y - 20); ctx.stroke();
  for (const r of rows) {
    ctx.fillStyle = "#56667c"; ctx.font = "500 24px system-ui, sans-serif"; ctx.fillText(r.label.toUpperCase(), pad, y + 6);
    ctx.fillStyle = "#172033"; ctx.font = "600 32px system-ui, sans-serif"; ctx.fillText(r.value.length > 44 ? r.value.slice(0, 43) + "…" : r.value, pad, y + 44);
    y += 78;
  }
  y += 22;
  ctx.fillStyle = "#172033"; ctx.font = "400 30px system-ui, sans-serif";
  for (const l of meaningLines) { ctx.fillText(l, pad, y); y += 40; }
  y += 14;
  ctx.fillStyle = tone.fg; ctx.font = "600 26px system-ui, sans-serif";
  ctx.fillText(freshnessLine(view) + (view.source === "mock" ? " · MOCK DATA" : ""), pad, y + 20);
  ctx.fillStyle = "#56667c"; ctx.font = "500 24px system-ui, sans-serif";
  ctx.fillText(`Checked with ${appName}`, pad, H - pad - 8);

  return new Promise((res) => canvas.toBlob((b) => res(b), "image/png"));
}
