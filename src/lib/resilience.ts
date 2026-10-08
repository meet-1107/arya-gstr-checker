import { ProviderError } from "@/providers/types";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new ProviderError("GST_PROVIDER_TIMEOUT", "GST provider did not respond in time.", true)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

export interface RetryOptions {
  retries: number; baseMs: number; maxMs: number; sleep?: (ms: number) => Promise<void>;
  /** Upper bound honoured for a provider Retry-After hint. Default 60s. */
  maxRetryAfterMs?: number;
}

/** Exponential backoff with full jitter; honours Retry-After; only retries errors flagged retryable. */
export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions): Promise<T> {
  const wait = o.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e instanceof ProviderError && e.retryable;
      if (!retryable || attempt >= o.retries) throw e;
      const hint = (e as ProviderError).retryAfterMs;
      const delay = hint !== undefined
        ? Math.min(Math.max(hint, 0), o.maxRetryAfterMs ?? 60_000)
        : Math.random() * Math.min(o.maxMs, o.baseMs * 2 ** attempt);
      await wait(delay);
    }
  }
}

/** Sliding-window limiter: at most `limit` acquisitions per `windowMs` (provider requests/min). */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now, private wait = sleep) {}
  async acquire(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
      if (this.stamps.length < this.limit) { this.stamps.push(t); return; }
      await this.wait(this.windowMs - (t - this.stamps[0]) + 1);
    }
  }
}

/** Run tasks with bounded concurrency (never Promise.all over thousands of items). */
export async function runWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
