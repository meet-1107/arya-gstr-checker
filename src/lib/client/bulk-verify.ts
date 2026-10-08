// Turns whatever a CA pastes or uploads into a list of raw entries for the server to validate. Pure.
// Accepts one-per-line lists, CSV/TSV (any column — GSTINs are found by shape, so extra columns are harmless) and text copied from Excel.
import { extractGstins } from "@/lib/gstin-extract";

export const MAX_ENTRIES = 20_000;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface ParsedList {
  /** Entries to send: every GSTIN-shaped token (valid or not) so the server can report typos; no header words, no empty lines. */
  entries: string[];
  /** Non-empty lines read. */
  lines: number;
  truncated: boolean;
}

const HEADER = /^(gstin|gst\s*no\.?|gst\s*number|gstin\/uin|gstin\s*no\.?|uin|sr\.?\s*no\.?|s\.?\s*no\.?|name|client|party|sl\.?\s*no\.?)$/i;
const SHAPE = /^[0-9]{2}[0-9A-Z]{13}$/; // 15 chars starting with two digits: looks like a GSTIN even if its checksum is wrong

/** Quote-aware split of one CSV/TSV line into cells. */
function cells(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === "," || c === "\t" || c === ";" || c === "|") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

export function parseGstinList(text: string): ParsedList {
  const entries: string[] = [];
  let lines = 0, truncated = false;
  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (!line) continue;
    lines++;
    if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
    const cs = cells(line).filter(Boolean);
    // Prefer cells that look like a GSTIN (valid or mistyped). Otherwise search the line for valid ones (invoice text), otherwise
    // treat a lone cell as an attempted GSTIN so it is reported as invalid instead of silently disappearing.
    const shaped = cs.map((c) => c.replace(/\s+/g, "").toUpperCase()).filter((c) => SHAPE.test(c));
    if (shaped.length) { entries.push(...shaped); continue; }
    const found = extractGstins(line).valid;
    if (found.length) { entries.push(...found); continue; }
    const attempt = cs.length === 1 && /[0-9A-Za-z]/.test(cs[0]) && !HEADER.test(cs[0]) ? cs[0] : cs.find((c) => /^[0-9A-Za-z]{10,20}$/.test(c) && /\d/.test(c) && !HEADER.test(c));
    if (attempt) entries.push(attempt.toUpperCase());
    // otherwise: a header row or a row with no GSTIN-like cell; ignored (counted in `lines` only)
  }
  return { entries: entries.slice(0, MAX_ENTRIES), lines, truncated };
}

/** Excel workbooks are zip files ("PK"); we do not read them (no spreadsheet parser is bundled). */
export function looksLikeWorkbook(name: string, head: Uint8Array): boolean {
  return /\.(xlsx|xlsm|xls|ods)$/i.test(name) || (head[0] === 0x50 && head[1] === 0x4b) || (head[0] === 0xd0 && head[1] === 0xcf);
}

export function newIdempotencyKey(): string {
  const r = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `bv-${r}`.slice(0, 120);
}
