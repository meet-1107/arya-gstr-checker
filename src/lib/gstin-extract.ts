// Pulls GSTINs out of arbitrary text: pasted invoice lines, QR payloads (plain text, URLs, JSON) and e-invoice QR codes (a JWT whose
// payload carries SellerGstin / BuyerGstin). Pure and dependency-free. Only candidates that pass format + checksum are returned.
import { validateGstin } from "./gstin";

const CANDIDATE = /(?<![0-9A-Z])(?:0[1-9]|[1-3][0-9]|3[0-8]|9[79])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z](?![0-9A-Z])/g;

function b64urlDecode(s: string): string | null {
  try {
    const pad = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
    const bin = typeof atob === "function" ? atob(pad) : Buffer.from(pad, "base64").toString("binary");
    return decodeURIComponent(bin.split("").map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
  } catch { return null; }
}

/** Expands text with decoded JWT payload(s) so e-invoice QR codes (signed JWTs) yield their embedded GSTINs. */
function expand(text: string): string[] {
  const out = [text];
  const jwt = /[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]*/.exec(text);
  if (jwt) {
    const payload = b64urlDecode(jwt[1]);
    if (payload) out.push(payload, payload.replace(/\\"/g, '"'));
  }
  try { out.push(decodeURIComponent(text)); } catch { /* not URI-encoded */ }
  return out;
}

export interface Extracted {
  /** Distinct valid GSTINs in order of first appearance. */
  valid: string[];
  /** Strings that look like a GSTIN but fail the checksum (probable typos / OCR errors). */
  invalid: string[];
}

export function extractGstins(text: string, max = 20): Extracted {
  const valid: string[] = [], invalid: string[] = [];
  const seen = new Set<string>();
  for (const chunk of expand((text ?? "").slice(0, 20_000))) {
    // Try as-is (uppercased), then with whitespace removed (GSTINs are often typed in groups: "24AABCU 9603R1ZM").
    for (const variant of [chunk.toUpperCase(), chunk.toUpperCase().replace(/[\s-]+/g, "")]) {
      for (const m of variant.matchAll(CANDIDATE)) {
        const g = m[0];
        if (seen.has(g)) continue;
        seen.add(g);
        (validateGstin(g).valid ? valid : invalid).push(g);
        if (valid.length + invalid.length >= max) return { valid, invalid };
      }
    }
  }
  return { valid, invalid };
}
