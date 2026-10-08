import { describe, it, expect } from "vitest";
import { ResilientProvider, Semaphore } from "@/providers/gate";
import { ProviderError, type GstProvider, type GstinResult, type ReturnHistory } from "@/providers/types";
import { estimateSeconds, providerLimits, providerRequestsPerCheck } from "@/config/provider";
import { withRetry } from "@/lib/resilience";
import { FAST_LIMITS, StubProvider, gst } from "./helpers";

function clock(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, advance: (ms: number) => { t += ms; }, sleeps, get t() { return t; } };
}
const ok = (g: string): GstinResult => ({ gstin: g, status: "Active", source: "x", checkedAt: "2026-10-06T00:00:00Z" });

describe("ResilientProvider — concurrency", () => {
  it("never exceeds maxConcurrent in-flight provider requests", async () => {
    const inner = new StubProvider(); inner.delayMs = 5;
    const gate = new ResilientProvider(inner, { ...FAST_LIMITS, maxConcurrent: 3 });
    await Promise.all(Array.from({ length: 40 }, (_, i) => gate.verifyGstin(gst(i + 1))));
    expect(inner.verifyCalls).toBe(40);
    expect(inner.peak).toBeLessThanOrEqual(3);
    expect(inner.peak).toBeGreaterThan(1);
    expect(gate.stats().inFlight).toBe(0);
  });
  it("semaphore: release is idempotent and hands slots to waiters in order", async () => {
    const s = new Semaphore(1);
    const r1 = await s.acquire();
    const order: number[] = [];
    const p2 = s.acquire().then((r) => { order.push(2); return r; });
    const p3 = s.acquire().then((r) => { order.push(3); return r; });
    r1(); r1(); // double release must not free two slots
    const r2 = await p2;
    expect(s.inFlight).toBe(1);
    r2();
    (await p3)();
    expect(order).toEqual([2, 3]);
    expect(s.inFlight).toBe(0);
  });
});

describe("ResilientProvider — requests-per-minute", () => {
  it("never allows more than N requests in any 60s window (virtual clock)", async () => {
    const c = clock(1_000_000);
    const stamps: number[] = [];
    const inner: GstProvider = { name: "t", verifyGstin: async (g) => { stamps.push(c.now()); return ok(g); }, getReturnHistory: async (g) => ({ gstin: g, records: [], source: "t", checkedAt: "" }) as ReturnHistory };
    const gate = new ResilientProvider(inner, { ...FAST_LIMITS, requestsPerMinute: 10, maxConcurrent: 1 }, c);
    for (let i = 0; i < 35; i++) await gate.verifyGstin(gst(i + 1));
    expect(stamps).toHaveLength(35);
    for (let i = 10; i < stamps.length; i++) expect(stamps[i] - stamps[i - 10]).toBeGreaterThanOrEqual(60_000);
    expect(c.sleeps.length).toBeGreaterThan(0);
  });
});

describe("ResilientProvider — retry, Retry-After, backoff, timeout", () => {
  it("honours Retry-After (and caps absurd values)", async () => {
    for (const [hint, expected] of [[5000, 5000], [999_999, 60_000]] as const) {
      const c = clock();
      let n = 0;
      const inner: GstProvider = { name: "t", verifyGstin: async (g) => { if (n++ === 0) throw new ProviderError("GST_PROVIDER_RATE_LIMITED", "slow down", true, false, hint); return ok(g); }, getReturnHistory: async () => { throw new Error("n/a"); } };
      await new ResilientProvider(inner, { ...FAST_LIMITS, retries: 2 }, c).verifyGstin(gst(1));
      expect(c.sleeps).toEqual([expected]);
    }
  });
  it("exponential backoff with jitter stays within [0, min(max, base*2^attempt)]", async () => {
    const sleeps: number[] = [];
    let n = 0;
    await expect(withRetry(async () => { n++; throw new ProviderError("GST_PROVIDER_TIMEOUT", "t", true); },
      { retries: 3, baseMs: 100, maxMs: 300, sleep: async (ms) => { sleeps.push(ms); } })).rejects.toThrow();
    expect(n).toBe(4);
    expect(sleeps).toHaveLength(3);
    [100, 200, 300].forEach((cap, i) => { expect(sleeps[i]).toBeGreaterThanOrEqual(0); expect(sleeps[i]).toBeLessThanOrEqual(cap); });
  });
  it("times out a hung provider with GST_PROVIDER_TIMEOUT", async () => {
    const inner: GstProvider = { name: "t", verifyGstin: () => new Promise(() => {}), getReturnHistory: () => new Promise(() => {}) };
    const gate = new ResilientProvider(inner, { ...FAST_LIMITS, timeoutMs: 20, retries: 0 });
    await expect(gate.verifyGstin(gst(1))).rejects.toMatchObject({ code: "GST_PROVIDER_TIMEOUT", retryable: true });
  });
  it("does not retry non-retryable errors", async () => {
    const inner = new StubProvider(); inner.failAll = new ProviderError("GST_PROVIDER_AUTH", "no", false);
    await expect(new ResilientProvider(inner, { ...FAST_LIMITS, retries: 3 }).verifyGstin(gst(1))).rejects.toMatchObject({ code: "GST_PROVIDER_AUTH" });
    expect(inner.verifyCalls).toBe(1);
  });
  it("never leaks raw/unknown provider errors", async () => {
    const inner: GstProvider = { name: "t", verifyGstin: async () => { throw new Error("secret apikey=abc123 at /srv/x.js"); }, getReturnHistory: async () => { throw new Error("x"); } };
    const e = await new ResilientProvider(inner, FAST_LIMITS).verifyGstin(gst(1)).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe("GST_PROVIDER_BAD_RESPONSE");
    expect(JSON.stringify({ m: e.message })).not.toMatch(/secret|abc123|srv/);
  });
});

describe("ResilientProvider — circuit breaker ('provider unavailable' state)", () => {
  it("opens after N consecutive health failures, fails fast, half-opens after cooldown, closes on success", async () => {
    const c = clock(10_000);
    const inner = new StubProvider();
    inner.failAll = new ProviderError("GST_PROVIDER_TIMEOUT", "t", true);
    const gate = new ResilientProvider(inner, { ...FAST_LIMITS, retries: 0, breakerFailureThreshold: 3, breakerCooldownMs: 1000 }, c);
    for (let i = 0; i < 3; i++) await expect(gate.verifyGstin(gst(1))).rejects.toMatchObject({ code: "GST_PROVIDER_TIMEOUT" });
    expect(gate.stats().breaker).toBe("open");
    const calls = inner.verifyCalls;
    const fast = await gate.verifyGstin(gst(1)).catch((e) => e);
    expect(fast).toMatchObject({ code: "GST_PROVIDER_UNAVAILABLE", retryable: false, billable: false });
    expect(inner.verifyCalls).toBe(calls); // no provider request while open

    c.advance(1001);
    expect(gate.stats().breaker).toBe("half-open");
    await expect(gate.verifyGstin(gst(1))).rejects.toMatchObject({ code: "GST_PROVIDER_TIMEOUT" }); // trial fails → re-opens
    expect(gate.stats().breaker).toBe("open");

    c.advance(1001);
    inner.failAll = null;
    await expect(gate.verifyGstin(gst(1))).resolves.toMatchObject({ status: "Active" }); // trial succeeds → closes
    expect(gate.stats().breaker).toBe("closed");
  });
  it("auth errors and 429s do not trip the breaker", async () => {
    const inner = new StubProvider();
    const gate = new ResilientProvider(inner, { ...FAST_LIMITS, retries: 0, breakerFailureThreshold: 2 });
    inner.failAll = new ProviderError("GST_PROVIDER_AUTH", "x", false);
    for (let i = 0; i < 5; i++) await gate.verifyGstin(gst(1)).catch(() => undefined);
    inner.failAll = new ProviderError("GST_PROVIDER_RATE_LIMITED", "x", true);
    for (let i = 0; i < 5; i++) await gate.verifyGstin(gst(1)).catch(() => undefined);
    expect(gate.stats().breaker).toBe("closed");
  });
});

describe("ISSUE-005 throughput model", () => {
  it("one check = 2 provider requests (1 if return history is skipped)", () => {
    expect(providerRequestsPerCheck(true)).toBe(2);
    expect(providerRequestsPerCheck(false)).toBe(1);
  });
  it("estimates wall-clock from the request budget", () => {
    const l = { ...FAST_LIMITS, requestsPerMinute: 60 };
    expect(estimateSeconds(1000, true, l)).toBe(2000);   // ≈ 33 min
    expect(estimateSeconds(1000, false, l)).toBe(1000);  // ≈ 17 min
    expect(estimateSeconds(0, true, l)).toBe(0);
  });
  it("limits come from env with safe defaults and are flagged unverified", () => {
    expect(providerLimits({})).toMatchObject({ requestsPerMinute: 60, maxConcurrent: 5, retries: 2, verified: false });
    expect(providerLimits({ GST_RATE_LIMIT_PER_MIN: "120", GST_MAX_CONCURRENT: "8", GST_RETRIES: "x" })).toMatchObject({ requestsPerMinute: 120, maxConcurrent: 8, retries: 2 });
    expect(providerLimits({ GST_RATE_LIMIT_PER_MIN: "-5" }).requestsPerMinute).toBe(60);
  });
});
