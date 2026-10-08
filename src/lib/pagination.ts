import { AppError } from "./errors";

/** Opaque cursor: base64url(JSON). Clients must not interpret it. */
export function encodeCursor(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString("base64url");
}

export function decodeCursor<T>(c: string | undefined | null): T | undefined {
  if (!c) return undefined;
  try {
    return JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as T;
  } catch {
    throw new AppError("INVALID_CURSOR", "Invalid pagination cursor.", 400);
  }
}

export const clampLimit = (n: number | undefined, def = 25, max = 100) =>
  Math.min(Math.max(Number.isFinite(n) ? Math.floor(n as number) : def, 1), max);
