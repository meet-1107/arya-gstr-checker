import { AppError } from "./errors";
import type { Store } from "./store/types";

/** A claim with no record after this long belongs to a crashed request and may be taken over. */
export const IDEMPOTENCY_CLAIM_TTL_MS = 60_000;
const CLAIM_WAIT_MS = 5_000;

export interface IdempotencyOptions<T> {
  orgId: string;
  /** Namespaced storage key (e.g. `k:<sha>` for an explicit header, `auto:<fingerprint>` otherwise). */
  key: string;
  /** Id of the record the caller is about to create. */
  id: string;
  fingerprint: string;
  /** True when the client supplied an Idempotency-Key (durable replay; payload must match). */
  explicit: boolean;
  now: () => Date;
  load: (id: string) => Promise<T | null>;
  /** Finished records may be replaced by a new run when the key was auto-derived. */
  isTerminal: (t: T) => boolean;
}

/**
 * Claims the idempotency key for a new record (returns null → the caller now owns the key) or returns
 * the existing record to replay. A claim is written BEFORE its record exists, so a claim without a record
 * means "in progress", not "stale": waiters keep re-attempting the claim (taking over instantly if the
 * owner failed and released it) and only steal claims older than IDEMPOTENCY_CLAIM_TTL_MS (crashed request).
 * Releases are compare-and-delete. Shared by bulk checks and CSV imports.
 */
export async function acquireIdempotent<T>(
  store: Pick<Store, "claimIdempotency" | "releaseIdempotency">, o: IdempotencyOptions<T>,
): Promise<T | null> {
  const ageMs = (createdAt: string) => o.now().getTime() - new Date(createdAt).getTime();
  const deadline = Date.now() + CLAIM_WAIT_MS;
  for (let guard = 0; guard < 1000; guard++) {
    const existing = await store.claimIdempotency(o.orgId, o.key, o.id, o.fingerprint, o.now().toISOString());
    if (!existing) return null; // we own the key
    if (o.explicit && existing.fingerprint !== o.fingerprint) {
      throw new AppError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used with a different request.", 422);
    }
    const rec = await o.load(existing.jobId);
    if (rec) {
      if (o.explicit || !o.isTerminal(rec)) return rec; // replay
      await store.releaseIdempotency(o.orgId, o.key, existing.jobId); // auto-key of a finished run: start a new one
      continue;
    }
    if (ageMs(existing.createdAt) >= IDEMPOTENCY_CLAIM_TTL_MS) { // abandoned by a crashed request
      await store.releaseIdempotency(o.orgId, o.key, existing.jobId);
      continue;
    }
    if (Date.now() >= deadline) throw new AppError("IDEMPOTENCY_IN_PROGRESS", "This request is already being processed. Retry shortly.", 409);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new AppError("CONFLICT", "Please retry the request.", 409);
}
