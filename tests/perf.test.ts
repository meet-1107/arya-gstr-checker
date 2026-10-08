import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";
import { CheckService, DEFAULT_CHECK_OPTIONS } from "@/services/checks";
import { BulkService, InProcessQueue } from "@/services/bulk";
import { VerificationService, DEFAULT_VERIFY_OPTIONS } from "@/services/verification";
import { VerificationMetrics } from "@/lib/metrics";
import { ResilientProvider } from "@/providers/gate";
import { computeGstinChecksum } from "@/lib/gstin";
import { BUDGET } from "@/lib/client/verify-machine";
import budgets from "../config/performance.json";
import { FAST_LIMITS, ctxFor, gst, seedOrg, StubProvider } from "./helpers";

/**
 * Regression guards for the performance work. Thresholds are deliberately generous (CI machines vary): they catch accidental O(n²) or
 * serial-where-parallel mistakes, not small drifts. They say NOTHING about real provider latency — no real provider is integrated.
 * Measured numbers from a development machine are recorded in the README (milestone 11).
 */
const wide = (n: number) => Array.from({ length: n }, (_, i) => { const b = `24AAAA${String.fromCharCode(65 + Math.floor(i / 9999))}${String((i % 9999) + 1).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); });
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
class ManualQueue extends InProcessQueue { enqueue() { /* tests drive processJob */ } }

/** Counts every call made to the store, by method name. */
function counting(store: MemoryStore) {
  const calls: Record<string, number> = {};
  const proxy = new Proxy(store, { get(t, k, r) { const v = Reflect.get(t, k, r); if (typeof v !== "function") return v; return (...a: unknown[]) => { calls[String(k)] = (calls[String(k)] ?? 0) + 1; return (v as (...x: unknown[]) => unknown).apply(t, a); }; } }) as unknown as Store;
  return { store: proxy, calls };
}

let mem: MemoryStore, stub: StubProvider;
const A = () => ctxFor("A", "ACCOUNTANT");
function build(store: Store, opts = { delayMs: 0 }) {
  stub.delayMs = opts.delayMs;
  const gate = new ResilientProvider(stub, FAST_LIMITS, { sleep: async () => {} });
  const ver = new VerificationService(store, gate, new VerificationMetrics(), DEFAULT_VERIFY_OPTIONS);
  const bulk = new BulkService(store, new CheckService(store, gate, DEFAULT_CHECK_OPTIONS), new ManualQueue(), FAST_LIMITS, () => new Date(), ver);
  return { ver, bulk };
}

beforeEach(async () => { mem = new MemoryStore(); stub = new StubProvider(); await seedOrg(mem, "A", "enterprise"); });

describe("budgets are coherent", () => {
  it("the client's progress thresholds fit inside the declared latency budgets", () => {
    const b = budgets.latencyMs;
    expect(BUDGET.slowAt).toBe(b.liveAcceptable);               // the UI says "taking longer" exactly when the budget is exceeded
    expect(BUDGET.giveUpAt).toBeGreaterThan(b.hardDeadline);     // the client outlasts the server's deadline so the server's answer wins
    expect(DEFAULT_VERIFY_OPTIONS.deadlineMs).toBe(b.hardDeadline);
    expect(b.feedback).toBeLessThan(b.storedResult); expect(b.storedResult).toBeLessThan(b.liveTypical); expect(b.liveTypical).toBeLessThan(b.liveAcceptable);
    expect(BUDGET.connectingAt).toBeLessThanOrEqual(b.feedback); // first stage is on screen within the feedback budget
  });
});

describe("store round trips (cost and latency on Firestore)", () => {
  it("previewing 2,000 GSTINs reads stored answers in ONE batched call, not 2,000", async () => {
    const { store, calls } = counting(mem);
    const { bulk, ver } = build(store);
    const list = wide(2000);
    for (const g of list.slice(0, 50)) await ver.verify(A(), g);          // 50 are stored
    for (const k of Object.keys(calls)) delete calls[k];
    const p = await bulk.estimateVerify(A(), { gstins: list });
    expect(p).toMatchObject({ valid: 2000, servedFromCache: 50, needsLiveCheck: 1950 });
    expect(calls.getVerifications).toBe(1);
    expect(calls.getVerification ?? 0).toBe(0);
  });
  it("one results page (200 items) and the export read answers per page, not per item", async () => {
    const { store, calls } = counting(mem);
    const { bulk } = build(store);
    const { job } = await bulk.createVerify(A(), { gstins: wide(450) });
    await bulk.processJob("A", job.id);
    for (const k of Object.keys(calls)) delete calls[k];
    await bulk.items(A(), job.id, { limit: 200 });
    expect(calls.getVerifications).toBe(1); expect(calls.getVerification ?? 0).toBe(0);
    for (const k of Object.keys(calls)) delete calls[k];
    const ex = await bulk.exportVerify(A(), job.id);
    expect(ex.rows).toBe(450);
    expect(calls.getVerifications).toBe(3);                               // 450 items = 3 pages of 200
    expect(calls.getVerification ?? 0).toBe(0);
  });
  it("a cached single lookup costs one store read for the answer (no hidden extras)", async () => {
    const { store, calls } = counting(mem);
    const { ver } = build(store);
    await ver.verify(A(), gst(1));
    for (const k of Object.keys(calls)) delete calls[k];
    expect((await ver.verify(A(), gst(1))).freshness).toBe("cached");
    expect(calls.getVerification).toBe(1);
  });
});

/** Every store call takes `ms` (a stand-in for a network round trip). Independent calls issued together overlap; sequential ones add up. */
function slow(store: MemoryStore, ms: number): Store {
  const wait = () => new Promise<void>((r) => setTimeout(r, ms));
  const wrap = (o: object): object => new Proxy(o, { get(t, k, r) { const v = Reflect.get(t, k, r); if (typeof v === "function") return async (...a: unknown[]) => { await wait(); return (v as (...x: unknown[]) => unknown).apply(t, a); }; if (v && typeof v === "object" && k === "usage") return wrap(v); return v; } });
  return wrap(store) as Store;
}

describe("sequential store round trips on the hot paths (critical path, in virtual time)", () => {
  /** Virtual-time measurement: every store call costs MS; independent calls overlap. Result = number of sequential round trips. Immune to OS timer granularity. */
  async function rounds(run: () => Promise<unknown>, ms: number): Promise<number> {
    let done = false; const p = run().finally(() => { done = true; });
    let elapsed = 0;
    while (!done && elapsed < 60_000) { await vi.advanceTimersByTimeAsync(ms); elapsed += ms; }
    await p; return elapsed / ms;
  }
  afterEach(() => { vi.useRealTimers(); });

  it("a stored lookup takes 3 round trips and a live lookup 5 (they took 6 and 11 before the milestone-11 parallelisation)", async () => {
    vi.useFakeTimers();
    const MS = 20;
    const { ver } = build(slow(mem, MS));
    const live = await rounds(() => ver.verify(A(), gst(1)), MS);
    const stored = await rounds(() => ver.verify(A(), gst(1)), MS);
    console.info(`[perf] critical path: live lookup ${live} round trips, stored lookup ${stored} round trips (at 20 ms each: ${live * MS} ms / ${stored * MS} ms)`);
    expect(stored).toBeLessThanOrEqual(3);
    expect(live).toBeLessThanOrEqual(5);
  });
});

describe("pipeline overhead (everything except the provider)", () => {
  it("stored results: p95 server time stays well inside the overhead budget", async () => {
    const { ver } = build(mem);
    await ver.verify(A(), gst(1));
    const ts: number[] = [];
    for (let i = 0; i < 300; i++) { const t = performance.now(); await ver.verify(A(), gst(1)); ts.push(performance.now() - t); }
    const p95 = pct(ts, 95);
    console.info(`[perf] stored lookup: p50=${pct(ts, 50).toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
    expect(p95).toBeLessThan(budgets.latencyMs.serverOverheadP95);
  });
  it("live lookups against an instant provider: p95 pipeline overhead inside the budget", async () => {
    const { ver } = build(mem);
    const list = wide(300); const ts: number[] = [];
    for (const g of list) { const t = performance.now(); await ver.verify(A(), g); ts.push(performance.now() - t); }
    const p95 = pct(ts, 95);
    console.info(`[perf] live lookup (instant provider): p50=${pct(ts, 50).toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
    expect(p95).toBeLessThan(budgets.latencyMs.serverOverheadP95);
  });
  it("the provider's latency dominates and is not hidden: a 40 ms provider shows up as ~40 ms", async () => {
    const { ver } = build(mem, { delayMs: 40 });
    const v = await ver.verify(A(), gst(5));
    expect(v.durationMs).toBeGreaterThanOrEqual(38); expect(v.durationMs).toBeLessThan(40 + budgets.latencyMs.serverOverheadP95 * 4);
  });
});

describe("concurrency and throughput", () => {
  it("60 distinct lookups against a 20 ms provider run in parallel (≤ 5 at a time), not one after another", async () => {
    const { ver } = build(mem, { delayMs: 20 });
    const t = performance.now();
    await Promise.all(wide(60).map((g) => ver.verify(A(), g)));
    const ms = performance.now() - t;
    console.info(`[perf] 60 lookups @20ms provider, concurrency cap ${FAST_LIMITS.maxConcurrent}: ${ms.toFixed(0)}ms (serial would be ≥ 1200ms)`);
    expect(stub.peak).toBeLessThanOrEqual(FAST_LIMITS.maxConcurrent); expect(stub.peak).toBeGreaterThan(1);
    expect(ms).toBeLessThan(60 * 20 * 0.75);
  });
  it("50 simultaneous lookups of the same GSTIN make one provider call (in-flight de-duplication)", async () => {
    const { ver } = build(mem, { delayMs: 30 });
    await Promise.all(Array.from({ length: 50 }, () => ver.verify(A(), gst(9))));
    expect(stub.verifyCalls).toBe(1);
  });
  it("a 3,000-GSTIN bulk run completes with bounded concurrency and exact accounting", async () => {
    const { bulk } = build(mem); // instant provider: measures OUR pipeline (a 1 ms timer is ~15 ms on Windows and would measure the OS clock instead)
    const { job } = await bulk.createVerify(A(), { gstins: wide(3000) });
    const t = performance.now();
    await bulk.processJob("A", job.id);
    const ms = performance.now() - t;
    const done = await mem.getJob("A", job.id);
    console.info(`[perf] bulk 3,000 GSTINs, instant provider: ${ms.toFixed(0)}ms (${Math.round(3000 / (ms / 1000))} items/s), peak concurrency ${stub.peak}`);
    expect(done!.counts).toMatchObject({ succeeded: 3000, failed: 0 });
    expect(done!.quota).toMatchObject({ consumed: 3000, reserved: 3000 });
    expect(stub.peak).toBeLessThanOrEqual(FAST_LIMITS.bulkConcurrency);
    expect(ms).toBeLessThan(10_000);
  });
  it("a 5,000-row export builds quickly", async () => {
    const { bulk } = build(mem);
    const { job } = await bulk.createVerify(A(), { gstins: wide(5000) });
    await bulk.processJob("A", job.id);
    const t = performance.now(); const ex = await bulk.exportVerify(A(), job.id); const ms = performance.now() - t;
    console.info(`[perf] export 5,000 rows: ${ms.toFixed(0)}ms, ${(ex.csv.length / 1024).toFixed(0)} KB`);
    expect(ex.rows).toBe(5000); expect(ms).toBeLessThan(5000);
  });
});
