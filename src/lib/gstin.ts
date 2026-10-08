const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const FORMAT = /^(0[1-9]|[1-3][0-9]|3[0-8]|9[79])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function normalizeGstin(input: string): string {
  return (input ?? "").replace(/\s+/g, "").toUpperCase();
}

export function computeGstinChecksum(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const val = CHARSET.indexOf(first14[i]);
    if (val < 0) throw new Error("Invalid character in GSTIN");
    const product = val * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

export type GstinValidation =
  | { valid: true; gstin: string; stateCode: string; pan: string }
  | { valid: false; gstin: string; reason: "EMPTY" | "LENGTH" | "FORMAT" | "CHECKSUM" };

export function validateGstin(input: string): GstinValidation {
  const gstin = normalizeGstin(input);
  if (!gstin) return { valid: false, gstin, reason: "EMPTY" };
  if (gstin.length !== 15) return { valid: false, gstin, reason: "LENGTH" };
  if (!FORMAT.test(gstin)) return { valid: false, gstin, reason: "FORMAT" };
  if (computeGstinChecksum(gstin.slice(0, 14)) !== gstin[14]) {
    return { valid: false, gstin, reason: "CHECKSUM" };
  }
  return { valid: true, gstin, stateCode: gstin.slice(0, 2), pan: gstin.slice(2, 12) };
}
