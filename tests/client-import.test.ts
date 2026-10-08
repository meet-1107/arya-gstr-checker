import { describe, it, expect } from "vitest";
import { inspectCsv, reasonText, sampleCsv, validateCsvFile, verifyErrorText } from "@/lib/client/import-wizard";
import { KNOWN_REASON_CODES } from "@/lib/import-reasons";
import { analyzeImport, guessMapping, parseCsv } from "@/lib/csv";
import { validateGstin } from "@/lib/gstin";
import { MAX_CSV_BYTES } from "@/lib/csv";

describe("validateCsvFile (fast client-side pre-check)", () => {
  it("accepts .csv within the size limit; explains everything else", () => {
    expect(validateCsvFile({ name: "clients.csv", size: 1234 })).toBeNull();
    expect(validateCsvFile({ name: "CLIENTS.CSV", size: 1 })).toBeNull();
    expect(validateCsvFile({ name: "clients.xlsx", size: 100 })).toMatch(/\.csv/);
    expect(validateCsvFile({ name: "clients.csv.exe", size: 100 })).toMatch(/\.csv/);
    expect(validateCsvFile({ name: "empty.csv", size: 0 })).toMatch(/empty/);
    expect(validateCsvFile({ name: "big.csv", size: MAX_CSV_BYTES + 1 })).toMatch(/larger than 5 MB/);
  });
});

describe("inspectCsv", () => {
  it("detects the header and proposes a mapping", () => {
    const i = inspectCsv("Client Name,GSTIN,Email ID,Mobile\nAcme,24AAACC1206D1ZM,a@x.com,9876543210\nBeta,27AAPFU0939F1ZV,,\n")!;
    expect(i.hasHeader).toBe(true);
    expect(i.mapping).toEqual({ name: 0, gstin: 1, email: 2, phone: 3 });
    expect(i.rowCount).toBe(2); expect(i.columns).toBe(4); expect(i.sample).toHaveLength(2);
  });
  it("treats a first row that contains a real GSTIN as data (headerless file) and finds the GSTIN column", () => {
    const text = "Acme,24AAACC1206D1ZM\nBeta,27AAPFU0939F1ZV\nGamma,24AAACC1206D1ZM\n";
    const i = inspectCsv(text)!;
    expect(i.hasHeader).toBe(false);
    expect(i.rowCount).toBe(3);
    expect(i.mapping.gstin).toBe(1);
  });
  it("handles BOM, CRLF, quoted commas and empty files", () => {
    const i = inspectCsv('﻿name,gstin\r\n"Acme, Co",24AAACC1206D1ZM\r\n')!;
    expect(i.header).toEqual(["name", "gstin"]); expect(i.sample[0][0]).toBe("Acme, Co");
    expect(inspectCsv("")).toBeNull();
    expect(inspectCsv("\n\n  \n")).toBeNull();
  });
  it("flags files over the row limit and caps the sample", () => {
    const rows = Array.from({ length: 20_001 }, (_, i) => `n${i},x`).join("\n");
    const i = inspectCsv("name,gstin\n" + rows)!;
    expect(i.tooManyRows).toBe(true); expect(i.sample).toHaveLength(5);
  });
  it("unmapped when headers are unrecognisable", () => {
    expect(inspectCsv("foo,bar\n1,2\n")!.mapping).toEqual({});
  });
});

describe("reason and error text", () => {
  it("every server reason code has friendly text, and unknown codes never leak", () => {
    expect(KNOWN_REASON_CODES).toHaveLength(12);
    for (const c of KNOWN_REASON_CODES) {
      expect(reasonText(c)).not.toBe("Row could not be imported");
      expect(reasonText(c)).not.toMatch(/^[A-Z_]+$/);
    }
    expect(reasonText("SOMETHING_NEW")).toBe("Row could not be imported");
    expect(reasonText(undefined)).toBe("");
    expect(verifyErrorText("FEATURE_NOT_AVAILABLE")).toMatch(/imported/);
    expect(verifyErrorText("WEIRD")).toMatch(/imported/);
    expect(verifyErrorText(undefined)).toBe("");
  });
});

describe("sample CSV", () => {
  it("is parseable and every GSTIN in it is valid (so users can try the flow immediately)", () => {
    const rows = parseCsv(sampleCsv());
    expect(rows[0]).toEqual(["client_name", "gstin", "email", "phone"]);
    expect(rows).toHaveLength(4);
    for (const r of rows.slice(1)) expect(validateGstin(r[1]).valid).toBe(true);
    expect(rows[3][0]).toBe("Demo Foods, Retail");
    const a = analyzeImport(rows, guessMapping(rows[0]) as { gstin: number }, new Set(), true);
    expect(a.counts).toMatchObject({ total: 3, valid: 3, invalid: 0 });
  });
});
