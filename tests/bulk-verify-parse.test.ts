import { describe, it, expect } from "vitest";
import { looksLikeWorkbook, MAX_ENTRIES, newIdempotencyKey, parseGstinList } from "@/lib/client/bulk-verify";
import { gst } from "./helpers";

describe("parseGstinList", () => {
  it("reads one per line, ignoring blanks, BOM and CRLF", () => {
    const r = parseGstinList(`﻿${gst(1)}\r\n\r\n${gst(2)}\n  ${gst(3).toLowerCase()}  \n`);
    expect(r.entries).toEqual([gst(1), gst(2), gst(3)]); expect(r.lines).toBe(3); expect(r.truncated).toBe(false);
  });
  it("finds the GSTIN column anywhere in CSV / TSV / Excel-pasted rows and skips header rows", () => {
    const csv = `Sr No,Party name,GSTIN,Amount\n1,"Shah, Mehta & Co",${gst(1)},1200\n2,Zed Traders,${gst(2)},50\n`;
    expect(parseGstinList(csv).entries).toEqual([gst(1), gst(2)]);
    expect(parseGstinList(`GSTIN\tName\n${gst(3)}\tA\n${gst(4)}\tB`).entries).toEqual([gst(3), gst(4)]);
    expect(parseGstinList(`GSTIN\n${gst(5)}`).entries).toEqual([gst(5)]);
  });
  it("keeps mistyped entries so the server can report them, but drops pure header/junk rows", () => {
    const bad = gst(1).slice(0, 14) + (gst(1)[14] === "A" ? "B" : "A");
    const r = parseGstinList(`GSTIN\n${bad}\n24ABC\n---\nName,Amount\n${gst(2)}`);
    expect(r.entries).toEqual([bad, "24ABC", gst(2)]);
  });
  it("pulls a GSTIN out of free text and handles grouped / quoted cells", () => {
    expect(parseGstinList(`Supplier GSTIN: ${gst(1)} (verified)`).entries).toEqual([gst(1)]);
    expect(parseGstinList(`"${gst(2)}",x`).entries).toEqual([gst(2)]);
    expect(parseGstinList(`${gst(3).slice(0, 7)} ${gst(3).slice(7)}`).entries).toEqual([gst(3)]);
  });
  it("is bounded and never throws", () => {
    const big = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => gst((i % 9000) + 1)).join("\n");
    const r = parseGstinList(big);
    expect(r.entries.length).toBe(MAX_ENTRIES); expect(r.truncated).toBe(true);
    expect(() => parseGstinList("x".repeat(500_000))).not.toThrow();
    expect(parseGstinList("")).toEqual({ entries: [], lines: 0, truncated: false });
  });
});

describe("workbook detection and keys", () => {
  it("recognises Excel workbooks by extension or magic bytes", () => {
    expect(looksLikeWorkbook("clients.xlsx", new Uint8Array([0, 0]))).toBe(true);
    expect(looksLikeWorkbook("clients.csv", new Uint8Array([0x50, 0x4b, 3, 4]))).toBe(true);   // zip (xlsx renamed)
    expect(looksLikeWorkbook("old.csv", new Uint8Array([0xd0, 0xcf, 0x11]))).toBe(true);        // legacy OLE .xls
    expect(looksLikeWorkbook("list.csv", new Uint8Array([0x32, 0x34]))).toBe(false);
  });
  it("idempotency keys satisfy the server's format and differ per call", () => {
    const a = newIdempotencyKey(), b = newIdempotencyKey();
    expect(a).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/); expect(a).not.toBe(b);
  });
});
