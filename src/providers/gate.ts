import { ProviderError, type GstProvider, type GstinResult, type ReturnHistory } from "./types";
import { RateLimiter, sleep as realSleep, withRetry, withTimeout } from "@/lib/resilience";
import type { ProviderLimits } from "@/config/provider";

export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private max: number) {}
  get inFlight() { return this.active; }
  async acquire(): Promise<() => void> {
    // When woken, the releasing caller hands its slot over (active is unchanged).
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    else this.active++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiters.shift();
      if (next) next(); else this.active--;
    };
  }
}

export type BreakerState = "closed" | "open" | "half-open";

/** Opens after N consecutive retryable health failures; fails fast during cooldown; one trial request when half-open. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private trial = false;
  constructor(private threshold: number, private cooldownMs: number, private now: () => number) {}

  get state(): BreakerState {
    if (this.failures < this.threshold) return "closed";
    return this.now() - this.openedAt >= this.cooldownMs ? "half-open" : "open";
  }
  beforeRequest() {
    const s = this.state;
    if (s === "open" || (s === "half-open" && this.trial)) {
      throw new ProviderError("GST_PROVIDER_UNAVAILABLE", "GST provider is temporarily unavailable. Please try again shortly.", false);
    }
    if (s === "half-open") this.trial = true;
  }
  success() { this.failures = 0; this.trial = false; }
  failure(e: unknown) {
    this.trial = false;
    // Only provider health problems trip the breaker; auth/validation/429 do not.
    if (e instanceof ProviderError && e.retryable && (e.code === "GST_PROVIDER_TIMEOUT" || e.code === "GST_PROVIDER_UNAVAILABLE")) {
      this.failures++;
      if (this.failures >= this.threshold) this.openedAt = this.now();
    }
  }
}

export interface GateClock { now?: () => number; sleep?: (ms: number) => Promise<void> }

/**
 * THE one place where provider throughput is controlled. Decorates any GstProvider with:
 * circuit breaker → concurrency cap → sliding-window rate limit → timeout → retry (backoff + jitter + Retry-After).
 * Unknown errors are converted into generic ProviderErrors so internals never leak to clients.
 */
export class ResilientProvider implements GstProvider {
  readonly name: string;
  private sem: Semaphore;
  private limiter: RateLimiter;
  private breaker: CircuitBreaker;
  private stat = { requests: 0, failures: 0 };
  private wait: (ms: number) => Promise<void>;

  constructor(private inner: GstProvider, private l: ProviderLimits, clock: GateClock = {}) {
    this.name = inner.name;
    const now = clock.now ?? Date.now;
    this.wait = clock.sleep ?? realSleep;
    this.sem = new Semaphore(l.maxConcurrent);
    this.limiter = new RateLimiter(l.requestsPerMinute, 60_000, now, this.wait);
    this.breaker = new CircuitBreaker(l.breakerFailureThreshold, l.breakerCooldownMs, now);
  }

  stats() { return { ...this.stat, inFlight: this.sem.inFlight, breaker: this.breaker.state }; }

  private exec<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(async () => {
      this.breaker.beforeRequest();
      const release = await this.sem.acquire();
      try {
        await this.limiter.acquire();
        this.stat.requests++;
        const r = await withTimeout(fn(), this.l.timeoutMs);
        this.breaker.success();
        return r;
      } catch (e) {
        this.stat.failures++;
        const pe = e instanceof ProviderError
          ? e
          : new ProviderError("GST_PROVIDER_BAD_RESPONSE", "GST provider returned an unexpected response.", false);
        this.breaker.failure(pe);
        throw pe;
      } finally {
        release();
      }
    }, { retries: this.l.retries, baseMs: this.l.backoffBaseMs, maxMs: this.l.backoffMaxMs, sleep: this.wait });
  }

  verifyGstin(gstin: string): Promise<GstinResult> { return this.exec(() => this.inner.verifyGstin(gstin)); }
  getReturnHistory(gstin: string, fy?: string): Promise<ReturnHistory> { return this.exec(() => this.inner.getReturnHistory(gstin, fy)); }
}
