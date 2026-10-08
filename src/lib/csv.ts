import { validateGstin, normalizeGstin } from "./gstin";

export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 20000;

/** Minimal RFC 4180 parser (quotes, escaped quotes, CRLF, BOM). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** Neutralise spreadsheet formula injection (=, +, -, @, tab, CR) by prefixing an apostrophe. */
export function sanitizeCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

export function toCsv(rows: unknown[][]): string {
  return rows
    .map((r) => r.map((v) => `"${sanitizeCell(v).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
}

export interface ColumnMapping { name?: number; gstin: number; email?: number; phone?: number }

const ALIASES: Record<keyof ColumnMapping, string[]> = {
  name: ["client_name", "name", "business_name", "client", "legal_name"],
  gstin: ["gstin", "gst_no", "gst_number", "gstin_number", "gst"],
  email: ["email", "email_id", "e-mail"],
  phone: ["phone", "mobile", "phone_number", "contact"],
};

export function guessMapping(header: string[]): Partial<ColumnMapping> {
  const h = header.map((x) => x.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const out: Partial<ColumnMapping> = {};
  (Object.keys(ALIASES) as (keyof ColumnMapping)[]).forEach((k) => {
    const idx = h.findIndex((x) => ALIASES[k].includes(x));
    if (idx >= 0) out[k] = idx;
  });
  return out;
}

export type RowStatus = "valid" | "invalid" | "duplicate" | "existing";
export interface ImportRow {
  line: number; name: string; gstin: string; email: string; phone: string;
  status: RowStatus; reason?: string;
}
export interface ImportAnalysis {
  rows: ImportRow[];
  counts: { total: number; valid: number; invalid: number; duplicate: number; existing: number };
}

export function analyzeImport(
  data: string[][],
  mapping: ColumnMapping,
  existingGstins: Set<string> = new Set(),
  hasHeader = true,
): ImportAnalysis {
  if (data.length - (hasHeader ? 1 : 0) > MAX_CSV_ROWS) throw new Error("TOO_MANY_ROWS");
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  data.slice(hasHeader ? 1 : 0).forEach((r, i) => {
    const line = i + (hasHeader ? 2 : 1);
    const cell = (idx?: number) => (idx === undefined ? "" : (r[idx] ?? "").trim());
    const v = validateGstin(cell(mapping.gstin));
    const base = {
      line, name: cell(mapping.name), gstin: normalizeGstin(cell(mapping.gstin)),
      email: cell(mapping.email), phone: cell(mapping.phone),
    };
    if (!v.valid) rows.push({ ...base, status: "invalid", reason: v.reason });
    else if (seen.has(v.gstin)) rows.push({ ...base, status: "duplicate", reason: "DUPLICATE_IN_FILE" });
    else if (existingGstins.has(v.gstin)) { seen.add(v.gstin); rows.push({ ...base, status: "existing", reason: "ALREADY_IN_ORG" }); }
    else { seen.add(v.gstin); rows.push({ ...base, status: "valid" }); }
  });
  const c = (s: RowStatus) => rows.filter((r) => r.status === s).length;
  return {
    rows,
    counts: { total: rows.length, valid: c("valid"), invalid: c("invalid"), duplicate: c("duplicate"), existing: c("existing") },
  };
}
