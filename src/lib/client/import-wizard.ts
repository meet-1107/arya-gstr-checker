import { guessMapping, MAX_CSV_BYTES, MAX_CSV_ROWS, parseCsv, type ColumnMapping } from "@/lib/csv";
import { computeGstinChecksum, validateGstin } from "@/lib/gstin";

export const FIELD_LABELS: Record<keyof ColumnMapping, string> = { gstin: "GSTIN", name: "Client name", email: "Email", phone: "Phone" };

/** Client-side pre-check only for fast feedback; the server validates everything again. */
export function validateCsvFile(f: { name: string; size: number }): string | null {
  if (!/\.csv$/i.test(f.name)) return "Please choose a .csv file. In Excel use File → Save As → CSV.";
  if (f.size === 0) return "That file is empty.";
  if (f.size > MAX_CSV_BYTES) return `That file is larger than ${MAX_CSV_BYTES / 1024 / 1024} MB. Split it into smaller files.`;
  return null;
}

export interface CsvInspection {
  header: string[];
  /** First data rows as raw cells, for the mapping preview. */
  sample: string[][];
  columns: number;
  /** Data rows (excluding the header when `hasHeader`). */
  rowCount: number;
  hasHeader: boolean;
  mapping: Partial<ColumnMapping>;
  tooManyRows: boolean;
}

/** Reads a CSV text and proposes a header/mapping. Header is assumed unless some cell of row 1 is itself a valid GSTIN. */
export function inspectCsv(text: string): CsvInspection | null {
  const data = parseCsv(text);
  if (data.length === 0) return null;
  const first = data[0];
  const looksLikeData = first.some((c) => validateGstin(c).valid);
  const hasHeader = !looksLikeData;
  const columns = Math.max(...data.slice(0, 50).map((r) => r.length));
  let mapping = hasHeader ? guessMapping(first) : {};
  if (!hasHeader) {
    // Headerless: find the column that holds GSTINs in the first rows.
    const col = Array.from({ length: columns }, (_, i) => i).find((i) => data.slice(0, 10).filter((r) => validateGstin(r[i] ?? "").valid).length >= Math.min(3, data.length));
    if (col !== undefined) mapping = { gstin: col };
  }
  const rowCount = data.length - (hasHeader ? 1 : 0);
  return { header: first, sample: data.slice(hasHeader ? 1 : 0, (hasHeader ? 1 : 0) + 5), columns, rowCount, hasHeader, mapping, tooManyRows: rowCount > MAX_CSV_ROWS };
}

export { reasonText } from "@/lib/import-reasons";

const VERIFY_ERRORS: Record<string, string> = {
  FEATURE_NOT_AVAILABLE: "Your plan doesn't include bulk checks, so verification didn't start. The clients were imported.",
  QUOTA_EXHAUSTED: "Not enough GST checks were left to verify these clients. The clients were imported.",
  SUBSCRIPTION_INACTIVE: "Your subscription isn't active, so verification didn't start. The clients were imported.",
  TOO_MANY_ITEMS: "Too many clients for one verification run. Use Bulk checks → “Never checked” to verify them in batches.",
  FORBIDDEN: "You no longer have permission to run checks. The clients were imported.",
};
export const verifyErrorText = (code?: string) => (code ? VERIFY_ERRORS[code] ?? "Verification couldn't start. The clients were imported." : "");

/** A small valid sample file users can download to see the expected shape. GSTINs are checksum-valid. */
export function sampleCsv(): string {
  const mk = (n: number) => { const b = `27AAAAA${String(1000 + n)}A1Z`; return b + computeGstinChecksum(b); };
  return ["client_name,gstin,email,phone", `Sample Traders Pvt Ltd,${mk(1)},accounts@sample-traders.example,9876543210`, `Example Industries LLP,${mk(2)},,9876543211`, `"Demo Foods, Retail",${mk(3)},finance@demo-foods.example,`].join("\r\n") + "\r\n";
}
