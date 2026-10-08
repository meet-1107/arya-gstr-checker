// Valid GSTINs (correct format + checksum) for tests. `gstin(n)` is deterministic; pick a distinct n per test so tests never share an answer.
const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function gstin(n: number, state = "27"): string {
  const base = `${state}AAAAA${String(n).padStart(4, "0")}A1Z`;
  let sum = 0;
  [...base].forEach((ch, i) => { const p = CHARSET.indexOf(ch) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); });
  return base + CHARSET[(36 - (sum % 36)) % 36];
}

/** The mock provider is told (server env, see playwright.config.ts) to answer "no registration" / "timeout" for exactly these. */
export const NOT_FOUND_GSTIN = gstin(7);
export const TIMEOUT_GSTIN = gstin(8);
