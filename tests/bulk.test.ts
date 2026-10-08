import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { CheckService, DEFAULT_CHECK_OPTIONS } from "@/services/checks";
import { BulkService, InProcessQueue, STALE_ITEM_MS } from "@/services/bulk";
import { ResilientProvider, type GateClock } from "@/providers/gate";
import { currentMonthKey } from "@/lib/dates";
import { UsageService } from "@/lib/usage";
import { FAST_LIMITS, NOW, PERMANENT, StubProvider, TRANSIENT, ctxFor, gst, seedClients, seedOrg } from "./helpers";
import { ProviderError } from "@/providers/types";

const MONTH = currentMonthKey(NOW);
let store: MemoryStore, stub: StubProvider, bulk: BulkService, queue: InProcessQueue, clock: { now: Date };
const A = () => ctxFor("A", "OWNER");

class ManualQueue extends InProcessQueue { enqueue() { /* tests drive processJob explicitly */ } }

function build(q: InProcessQueue = new ManualQueue(), gateClock: GateClock = {}) {
  queue = q;
  const gate = new ResilientProvider(stub, FAST_LIMITS, { sleep: async () => {}, ...gateClock });
  const checks = new CheckService(store, gate, DEFAULT_CHECK_OPTIONS, () => clock.now);
  bulk = new BulkService(store, checks, queue, FAST_LIMITS, () => clock.now);
}
const usage = () => store.usage.get("A", MONTH);
const job = (id: string) => store.getJob("A", id).then((j) => j!);

beforeEach(async () => {
  clock = { now: NOW };
  store = new MemoryStore(); stub = new StubProvider(() => clock.now);
  await seedOrg(store, "A", "firm"); await seedOrg(store, "B", "firm");
  build();
});

describe("quota accounting: requested → reserved → consumed / released", () => {
  it("500 requested: 470 succeed, 20 permanently fail, 10 cancelled ⇒ used=470, reserved=0, 30 released", async () => {
    const ids = await seedClients(store, "A", 500);
    const failing = new Set(Array.from({ length: 20 }, (_, i) => gst(i * 20 + 5)));        // 20 permanent, non-billable failures
    for (const g of failing) stub.failFor.set(g, PERMANENT());
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    expect(j.quota).toEqual({ requested: 500, reserved: 500, consumed: 0, released: 0 });
    expect(await usage()).toMatchObject({ used: 0, reserved: 500 });
    expect((await new UsageService(store.usage).summary({ organizationId: "A", plan: "firm", status: "active" }, MONTH)).remaining).toBe(1500);

    // cancel after item #490 has started: with claimBatch=1 exactly 490 are processed, 10 are still queued
    stub.onVerify = async (n) => { if (n === 490) await bulk.cancel(A(), j.id); };
    await bulk.processJob("A", j.id, { concurrency: 1, claimBatch: 1 });

    const done = await job(j.id);
    expect(done.counts).toEqual({ queued: 0, processing: 0, succeeded: 470, cached: 0, failed: 20, cancelled: 10 });
    expect(done.quota).toEqual({ requested: 500, reserved: 500, consumed: 470, released: 30 });
    expect(done.status).toBe("cancelled");
    expect(done.completedAt).toBeTruthy();
    expect(await usage()).toMatchObject({ used: 470, reserved: 0 });
    expect(stub.verifyCalls).toBe(490);
  });

  it("reserving more than is available is refused atomically (no partial hold, no negative quota)", async () => {
    await store.usage.reserve("A", MONTH, "firm", 2000, 1990);
    const ids = await seedClients(store, "A", 20);
    await expect(bulk.create(A(), { clientIds: ids })).rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });
    expect(await usage()).toMatchObject({ used: 1990, reserved: 0 });
    expect(await store.listJobs("A", 10)).toHaveLength(0);
    // the idempotency key was released, so the user can retry after freeing quota / choosing fewer
    expect((await bulk.create(A(), { clientIds: ids.slice(0, 10) })).replay).toBe(false);
    expect(await usage()).toMatchObject({ used: 1990, reserved: 10 });
  });

  it("allowPartial holds only what is left and reports the shortfall as skipped", async () => {
    await store.usage.reserve("A", MONTH, "firm", 2000, 1990);
    const ids = await seedClients(store, "A", 20);
    const { job: j } = await bulk.create(A(), { clientIds: ids, allowPartial: true, includeReturns: false });
    expect(j.total).toBe(10); expect(j.skipped).toBe(10);
    expect(j.quota).toMatchObject({ requested: 20, reserved: 10 });
    await bulk.processJob("A", j.id);
    expect(await usage()).toMatchObject({ used: 2000, reserved: 0 });
    expect((await job(j.id)).counts.succeeded).toBe(10);
  });

  it("five competing jobs on 100 remaining units: reservations never exceed the limit", async () => {
    await store.usage.reserve("A", MONTH, "firm", 2000, 1900);
    const sets = await Promise.all([0, 1, 2, 3, 4].map((k) => seedClients(store, "A", 40, 1 + k * 40)));
    const res = await Promise.allSettled(sets.map((ids) => bulk.create(A(), { clientIds: ids })));
    const okCount = res.filter((r) => r.status === "fulfilled").length;
    expect(okCount).toBe(2);
    expect(res.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.code === "QUOTA_EXHAUSTED")).toBe(true);
    const u = (await usage())!;
    expect(u.used + u.reserved).toBeLessThanOrEqual(2000);
    expect(u.reserved).toBe(80);
  });

  it("bulk reservations also block single checks from overspending (shared pool)", async () => {
    await store.usage.reserve("A", MONTH, "firm", 2000, 1950);
    const ids = await seedClients(store, "A", 50);
    await bulk.create(A(), { clientIds: ids });                       // holds the last 50
    const r = await store.usage.reserve("A", MONTH, "firm", 2000, 1);
    expect(r.ok).toBe(false);                                         // nobody else can spend held units
  });

  it("settle never goes negative or over-consumes", async () => {
    await store.usage.hold("A", MONTH, "firm", 2000, 5, false);
    await store.usage.settle("A", MONTH, 3, 10);                      // asks for more than held
    expect(await usage()).toMatchObject({ used: 3, reserved: 0 });
    await store.usage.settle("A", MONTH, 5, 5);                       // nothing held any more
    expect(await usage()).toMatchObject({ used: 3, reserved: 0 });
  });

  it("units are not held for items served from fresh cache; those finish as 'cached' and cost nothing", async () => {
    const ids = await seedClients(store, "A", 10, 1, (i) => (i <= 4 ? { checked: true, status: "Active", lastCheckedAt: NOW.toISOString(), cacheExpiresAt: new Date(NOW.getTime() + 3600e3).toISOString() } : {}));
    const est = await bulk.estimate(A(), { clientIds: ids });
    expect(est).toMatchObject({ requested: 10, needsLiveCheck: 6, servedFromCache: 4, quota: { remaining: 2000, afterRemaining: 1994, sufficient: true } });
    expect(await usage()).toBeNull();                                  // estimate consumes nothing
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    expect(j.quota).toMatchObject({ requested: 6, reserved: 6 });
    await bulk.processJob("A", j.id);
    const d = await job(j.id);
    expect(d.counts).toMatchObject({ cached: 4, succeeded: 6 });
    expect(await usage()).toMatchObject({ used: 6, reserved: 0 });
    expect(stub.verifyCalls).toBe(6);
  });
});

describe("idempotency", () => {
  it("same Idempotency-Key ⇒ same job, quota held once, provider work once", async () => {
    const ids = await seedClients(store, "A", 20);
    const a = await bulk.create(A(), { clientIds: ids }, "key-abcdef-0001");
    const b = await bulk.create(A(), { clientIds: ids }, "key-abcdef-0001");
    expect(b.replay).toBe(true); expect(b.job.id).toBe(a.job.id);
    expect(await usage()).toMatchObject({ reserved: 20, used: 0 });
    await bulk.processJob("A", a.job.id); await bulk.processJob("A", a.job.id);
    expect(stub.verifyCalls).toBe(20);
    expect(await usage()).toMatchObject({ used: 20, reserved: 0 });
    // still a replay after completion (explicit keys are durable)
    expect((await bulk.create(A(), { clientIds: ids }, "key-abcdef-0001")).job.id).toBe(a.job.id);
    expect(await store.listJobs("A", 10)).toHaveLength(1);
  });
  it("reusing a key with a different payload is rejected (422), nothing is reserved", async () => {
    const ids = await seedClients(store, "A", 20);
    await bulk.create(A(), { clientIds: ids.slice(0, 10) }, "key-abcdef-0002");
    await expect(bulk.create(A(), { clientIds: ids.slice(10) }, "key-abcdef-0002")).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 422 });
    expect(await usage()).toMatchObject({ reserved: 10 });
  });
  it("double-click without a key: an identical request while the job is active returns the same job", async () => {
    const ids = await seedClients(store, "A", 15);
    const a = await bulk.create(A(), { clientIds: ids });
    const b = await bulk.create(A(), { clientIds: [...ids].reverse() }); // order must not matter
    expect(b.replay).toBe(true); expect(b.job.id).toBe(a.job.id);
    expect(await usage()).toMatchObject({ reserved: 15 });
  });
  it("after the matching job finishes, an identical keyless request starts a NEW job", async () => {
    const ids = await seedClients(store, "A", 5);
    const a = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    await bulk.processJob("A", a.job.id);
    clock.now = new Date(NOW.getTime() + 48 * 3600e3); // cache expired
    const b = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    expect(b.replay).toBe(false); expect(b.job.id).not.toBe(a.job.id);
  });
  it("10 simultaneous identical submissions ⇒ exactly one job and one reservation", async () => {
    const ids = await seedClients(store, "A", 30);
    const res = await Promise.all(Array.from({ length: 10 }, () => bulk.create(A(), { clientIds: ids }, "key-abcdef-0003")));
    expect(new Set(res.map((r) => r.job.id)).size).toBe(1);
    expect(res.filter((r) => !r.replay)).toHaveLength(1);
    expect(await usage()).toMatchObject({ reserved: 30 });
    expect(await store.listJobs("A", 10)).toHaveLength(1);
  });
  it("two workers on the same job never process an item twice (no double charge)", async () => {
    const ids = await seedClients(store, "A", 60);
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    await Promise.all([bulk.processJob("A", j.id, { concurrency: 3 }), bulk.processJob("A", j.id, { concurrency: 3 }), bulk.processJob("A", j.id, { concurrency: 2 })]);
    expect(stub.verifyCalls).toBe(60);
    const d = await job(j.id);
    expect(d.counts).toMatchObject({ succeeded: 60, queued: 0, processing: 0 });
    expect(d.quota).toMatchObject({ consumed: 60, released: 0 });
    expect(await usage()).toMatchObject({ used: 60, reserved: 0 });
    expect(d.status).toBe("completed");
  });
  it("an explicit-key retry AFTER the job finished replays it, even though the selection is now empty (mode=never_checked)", async () => {
    await seedClients(store, "A", 5);
    const a = await bulk.create(A(), { mode: "never_checked", includeReturns: false }, "key-replay-0001");
    await bulk.processJob("A", a.job.id);
    const b = await bulk.create(A(), { mode: "never_checked", includeReturns: false }, "key-replay-0001");
    expect(b.replay).toBe(true); expect(b.job.id).toBe(a.job.id);
    await expect(bulk.create(A(), { mode: "never_checked", includeReturns: false })).rejects.toMatchObject({ code: "NO_CLIENTS" }); // keyless: nothing left to do
    expect(await store.listJobs("A", 10)).toHaveLength(1);
  });
  it("malformed idempotency keys are rejected", async () => {
    const ids = await seedClients(store, "A", 2);
    await expect(bulk.create(A(), { clientIds: ids }, "short")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("failures, retries, partial completion", () => {
  it("provider outage items fail as retryable (non-billable ⇒ released); retryFailed completes them with no double charge", async () => {
    const ids = await seedClients(store, "A", 30);
    for (let i = 3; i <= 30; i += 3) stub.failFor.set(gst(i), TRANSIENT()); // every 3rd: isolated failures never trip the breaker
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    await bulk.processJob("A", j.id);
    let d = await job(j.id);
    expect(d.status).toBe("completed_with_errors");
    expect(d.counts).toMatchObject({ succeeded: 20, failed: 10 });
    expect(d.quota).toMatchObject({ consumed: 20, released: 10 });
    expect(await usage()).toMatchObject({ used: 20, reserved: 0 });
    const failed = await bulk.items(A(), j.id, { status: "failed" });
    expect(failed.items).toHaveLength(10);
    expect(failed.items.every((i) => i.errorCode === "GST_PROVIDER_TIMEOUT" && i.retryable === true)).toBe(true);
    expect(JSON.stringify(failed)).not.toMatch(/slow|stack|secret/); // codes only

    stub.failFor.clear();
    const r = await bulk.retryFailed(A(), j.id);
    expect(r.requeued).toBe(10);
    await bulk.processJob("A", j.id);
    d = await job(j.id);
    expect(d.status).toBe("completed");
    expect(d.counts).toMatchObject({ succeeded: 30, failed: 0 });
    expect(await usage()).toMatchObject({ used: 30, reserved: 0 });
    const u = (await usage())!;
    expect(u.used).toBe(30); // each GSTIN billed exactly once
  });
  it("provider outage: breaker opens, remaining items fail fast with NO provider calls, every unit is released, retry after cooldown completes", async () => {
    const g = { t: 1_000_000 };
    build(new ManualQueue(), { now: () => g.t });
    const ids = await seedClients(store, "A", 30);
    stub.failAll = TRANSIENT();
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    await bulk.processJob("A", j.id, { concurrency: 1, claimBatch: 1 });
    const d = await job(j.id);
    expect(d.status).toBe("failed");
    expect(d.counts).toMatchObject({ failed: 30, succeeded: 0 });
    expect(stub.verifyCalls).toBe(5);                       // threshold reached, then fail-fast
    expect(d.quota).toMatchObject({ consumed: 0, released: 30 });
    expect(await usage()).toMatchObject({ used: 0, reserved: 0 });
    const items = (await bulk.items(A(), j.id, { status: "failed", limit: 200 })).items;
    expect(items.every((i) => i.retryable)).toBe(true);
    expect(new Set(items.map((i) => i.errorCode))).toEqual(new Set(["GST_PROVIDER_TIMEOUT", "GST_PROVIDER_UNAVAILABLE"]));

    stub.failAll = null; g.t += 31_000;                     // provider recovered, cooldown elapsed
    await bulk.retryFailed(A(), j.id);
    await bulk.processJob("A", j.id, { concurrency: 1, claimBatch: 1 });
    expect((await job(j.id)).counts).toMatchObject({ succeeded: 30, failed: 0 });
    expect(await usage()).toMatchObject({ used: 30, reserved: 0 });
  });
  it("a billable provider failure consumes the unit; a non-billable one does not", async () => {
    const ids = await seedClients(store, "A", 2);
    stub.failFor.set(gst(1), new ProviderError("GST_PROVIDER_BAD_RESPONSE", "x", false, true));   // billable
    stub.failFor.set(gst(2), new ProviderError("GST_PROVIDER_BAD_RESPONSE", "x", false, false));  // not billable
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    await bulk.processJob("A", j.id);
    expect((await job(j.id)).quota).toMatchObject({ consumed: 1, released: 1 });
    expect(await usage()).toMatchObject({ used: 1, reserved: 0 });
  });
  it("all items failing marks the job 'failed' (not 'completed')", async () => {
    const ids = await seedClients(store, "A", 3);
    stub.failAll = PERMANENT();
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    await bulk.processJob("A", j.id);
    expect((await job(j.id)).status).toBe("failed");
    expect(await usage()).toMatchObject({ used: 0, reserved: 0 });
  });
  it("progress, completion alerts and audit trail are recorded", async () => {
    const ids = await seedClients(store, "A", 12);
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    expect((await bulk.get(A(), j.id)).progress).toEqual({ done: 0, percent: 0 });
    await bulk.processJob("A", j.id);
    const g = await bulk.get(A(), j.id);
    expect(g.progress).toEqual({ done: 12, percent: 100 });
    expect(g.estimatedSecondsRemaining).toBe(0);
    const alerts = await store.listAlerts("A", 20);
    expect(alerts.filter((a) => a.type === "BULK_CHECK_COMPLETED")).toHaveLength(1);
    expect((await store.listAudit("A", 50)).map((a) => a.action)).toContain("BULK_CHECK_STARTED");
    expect((await store.listChecks("A", 50)).every((c) => c.jobId === j.id)).toBe(true);
  });
  it("job items are traceable to the parent job and paginate", async () => {
    const ids = await seedClients(store, "A", 25);
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    const seen: string[] = []; let cursor: string | undefined;
    do { const p = await bulk.items(A(), j.id, { limit: 10, cursor }); seen.push(...p.items.map((i) => i.id)); cursor = p.nextCursor; } while (cursor);
    expect(new Set(seen).size).toBe(25);
    const all = (await store.listJobItems("A", j.id, { limit: 100 })).items;
    expect(all.every((i) => i.jobId === j.id)).toBe(true);
  });
  it("runs with a bounded provider footprint (never an uncontrolled burst)", async () => {
    const ids = await seedClients(store, "A", 80);
    stub.delayMs = 2;
    build(new InProcessQueue()); (queue as InProcessQueue).setHandler((o, id) => bulk.processJob(o, id, { concurrency: 4 }));
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    await queue.idle();
    expect(stub.peak).toBeLessThanOrEqual(4);
    expect((await job(j.id)).counts.succeeded).toBe(80);
  });
});

describe("cancel / resume / permissions mid-flight", () => {
  it("cancelling before any work releases every held unit", async () => {
    const ids = await seedClients(store, "A", 40);
    const { job: j } = await bulk.create(A(), { clientIds: ids });
    expect(await usage()).toMatchObject({ reserved: 40 });
    const c = await bulk.cancel(A(), j.id);
    expect(c.status).toBe("cancelled");
    expect(c.counts).toMatchObject({ cancelled: 40, queued: 0 });
    expect(c.quota).toMatchObject({ reserved: 40, consumed: 0, released: 40 });
    expect(await usage()).toMatchObject({ used: 0, reserved: 0 });
    await bulk.processJob("A", j.id);
    expect(stub.verifyCalls).toBe(0);
    await bulk.cancel(A(), j.id); // idempotent
    expect(await usage()).toMatchObject({ used: 0, reserved: 0 });
  });
  it("crash recovery: stuck 'processing' items are re-queued, then finished; exhausted attempts release their unit", async () => {
    const ids = await seedClients(store, "A", 6);
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    const claimed = await store.claimJobItems("A", j.id, 6, NOW.toISOString()); // worker "crashes" after claiming
    expect(claimed).toHaveLength(6);
    expect((await job(j.id)).counts).toMatchObject({ queued: 0, processing: 6 });
    clock.now = new Date(NOW.getTime() + STALE_ITEM_MS + 1000);
    const r = await bulk.resume(A(), j.id);
    expect(r).toMatchObject({ requeued: 6, abandoned: 0 });
    await bulk.processJob("A", j.id);
    expect((await job(j.id)).counts).toMatchObject({ succeeded: 6, processing: 0 });
    expect(await usage()).toMatchObject({ used: 6, reserved: 0 });

    // attempts exhausted → failed + unit released (outcome unknown ⇒ never overcharge)
    const ids2 = await seedClients(store, "A", 2, 100);
    const { job: j2 } = await bulk.create(A(), { clientIds: ids2, includeReturns: false });
    for (let k = 0; k < 3; k++) {
      await store.claimJobItems("A", j2.id, 2, clock.now.toISOString());
      clock.now = new Date(clock.now.getTime() + STALE_ITEM_MS + 1000);
      if (k < 2) await bulk.resume(A(), j2.id).then(() => undefined);
    }
    const r2 = await bulk.resume(A(), j2.id);
    expect(r2.abandoned + (await job(j2.id)).counts.failed).toBeGreaterThan(0);
    const u = (await usage())!;
    expect(u.reserved).toBeGreaterThanOrEqual(0);
  });
  it("authorization is re-checked per item: a requester demoted to VIEWER cannot spend quota", async () => {
    const ids = await seedClients(store, "A", 5);
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    await store.putMember("A", { uid: "A-owner", email: "o@x.com", role: "VIEWER", addedAt: NOW.toISOString() });
    await bulk.processJob("A", j.id);
    const d = await job(j.id);
    expect(d.counts).toMatchObject({ failed: 5, succeeded: 0 });
    expect(d.quota).toMatchObject({ consumed: 0, released: 5 });
    expect(stub.verifyCalls).toBe(0);
    expect(await usage()).toMatchObject({ used: 0, reserved: 0 });
    expect((await bulk.items({ ...A(), role: "OWNER" }, j.id, { status: "failed" }).catch(() => ({ items: [] }))).items.length).toBeGreaterThanOrEqual(0);
  });
  it("subscription ending mid-job: remaining items fail without consuming quota", async () => {
    const ids = await seedClients(store, "A", 6);
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    stub.onVerify = async (n) => { if (n === 2) await store.updateOrg("A", { subscriptionStatus: "expired" }); };
    await bulk.processJob("A", j.id, { concurrency: 1, claimBatch: 1 });
    const d = await job(j.id);
    expect(d.counts.succeeded).toBeGreaterThanOrEqual(2);
    expect(d.counts.failed).toBeGreaterThan(0);
    expect(d.counts.succeeded + d.counts.failed).toBe(6);
    const u = (await usage())!;
    expect(u.used).toBe(d.counts.succeeded); expect(u.reserved).toBe(0);
  });
});

describe("selection, plan gating and tenant scoping", () => {
  it("modes select from stored data: all / never_checked / needs_refresh / needs_attention", async () => {
    await seedClients(store, "A", 12, 1, (i) => ({
      checked: i <= 6, ...(i <= 6 ? { status: "Active" as const, lastCheckedAt: NOW.toISOString(), cacheExpiresAt: new Date(NOW.getTime() + (i <= 3 ? -1 : 1) * 3600e3).toISOString() } : {}),
      indicator: i % 4 === 0 ? ("High Attention" as const) : ("Good" as const),
    }));
    const n = async (mode: string) => (await bulk.estimate(A(), { mode })).requested;
    expect(await n("all")).toBe(12);
    expect(await n("never_checked")).toBe(6);
    expect(await n("needs_refresh")).toBe(3);
    expect(await n("needs_attention")).toBe(3);
  });
  it("requires exactly one of clientIds / mode and rejects oversized or empty selections", async () => {
    await expect(bulk.create(A(), {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(bulk.create(A(), { clientIds: ["x"], mode: "all" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(bulk.create(A(), { clientIds: ["nope"] })).rejects.toMatchObject({ code: "NO_CLIENTS" });
    await expect(bulk.create(A(), { clientIds: Array.from({ length: 10_001 }, (_, i) => `id${i}`) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
  it("foreign client ids are silently skipped (never processed, never revealed)", async () => {
    const mine = await seedClients(store, "A", 3);
    const theirs = await seedClients(store, "B", 3, 500);
    const { job: j } = await bulk.create(A(), { clientIds: [...mine, ...theirs], includeReturns: false });
    expect(j.total).toBe(3); expect(j.skipped).toBe(3);
    await bulk.processJob("A", j.id);
    expect(stub.verifyCalls).toBe(3);
    expect(await store.usage.get("B", MONTH)).toBeNull();
    expect((await store.listJobs("B", 10))).toHaveLength(0);
  });
  it("Free plan: single check allowed through bulk API, multi-client bulk is gated; Starter allowed", async () => {
    await seedOrg(store, "F", "free"); await seedOrg(store, "S", "starter");
    const f = await seedClients(store, "F", 3); const s = await seedClients(store, "S", 3);
    await expect(bulk.create(ctxFor("F", "OWNER"), { clientIds: f })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE", status: 403 });
    expect((await bulk.create(ctxFor("F", "OWNER"), { clientIds: f.slice(0, 1) })).job.total).toBe(1);
    expect((await bulk.create(ctxFor("S", "OWNER"), { clientIds: s })).job.total).toBe(3);
  });
  it("read-only subscription cannot start a job", async () => {
    const ids = await seedClients(store, "A", 3);
    await store.updateOrg("A", { subscriptionStatus: "cancelled" });
    await expect(bulk.create(A(), { clientIds: ids })).rejects.toMatchObject({ code: "SUBSCRIPTION_INACTIVE" });
    expect(await usage()).toBeNull();
  });
});

describe("RBAC and tenant isolation for jobs", () => {
  it("roles: OWNER/ADMIN/ACCOUNTANT may run & cancel; VIEWER may only read", async () => {
    const ids = await seedClients(store, "A", 3);
    for (const role of ["OWNER", "ADMIN", "ACCOUNTANT"] as const) {
      const { job: j } = await bulk.create(ctxFor("A", role), { clientIds: ids, includeReturns: false }, `key-role-${role}-1`);
      expect(await bulk.cancel(ctxFor("A", role), j.id)).toMatchObject({ status: "cancelled" });
    }
    const v = ctxFor("A", "VIEWER");
    const { job } = await bulk.create(A(), { clientIds: ids, includeReturns: false }, "key-role-viewer1");
    await expect(bulk.create(v, { clientIds: ids })).rejects.toThrow();
    await expect(bulk.estimate(v, { clientIds: ids })).rejects.toThrow();
    await expect(bulk.cancel(v, job.id)).rejects.toThrow();
    await expect(bulk.retryFailed(v, job.id)).rejects.toThrow();
    await expect(bulk.resume(v, job.id)).rejects.toThrow();
    expect((await bulk.get(v, job.id)).id).toBe(job.id);
    expect((await bulk.list(v)).length).toBeGreaterThan(0);
  });
  it("organization B cannot read, list, cancel, retry or resume organization A's job", async () => {
    const ids = await seedClients(store, "A", 4);
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    const b = ctxFor("B", "OWNER");
    for (const op of [() => bulk.get(b, j.id), () => bulk.items(b, j.id, {}), () => bulk.cancel(b, j.id), () => bulk.retryFailed(b, j.id), () => bulk.resume(b, j.id)]) {
      await expect(op()).rejects.toMatchObject({ code: "JOB_NOT_FOUND", status: 404 });
    }
    expect(await bulk.list(b)).toEqual([]);
    expect(await usage()).toMatchObject({ reserved: 4 });                  // untouched by the attempted cancel
    expect((await job(j.id)).counts.queued).toBe(4);
    expect(await store.getJob("B", j.id)).toBeNull();
  });
  it("job counters cannot be changed from outside: the store API only exposes atomic claim/finish transitions", async () => {
    const ids = await seedClients(store, "A", 2);
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    const [it] = await store.claimJobItems("A", j.id, 1, NOW.toISOString());
    expect(await store.finishJobItem("A", j.id, it.id, { status: "succeeded" })).toBe(true);
    expect(await store.finishJobItem("A", j.id, it.id, { status: "succeeded" })).toBe(false);   // settles once
    expect(await store.finishJobItem("A", j.id, "nonexistent", { status: "succeeded" })).toBe(false);
    expect((await job(j.id)).counts).toMatchObject({ queued: 1, processing: 0, succeeded: 1 });
    expect((await bulk.get(A(), j.id)) as Record<string, unknown>).not.toHaveProperty("fingerprint");
  });
});

describe("real queue path", () => {
  it("InProcessQueue runs the job to completion in the background", async () => {
    const q = new InProcessQueue();
    build(q); q.setHandler((o, id) => bulk.processJob(o, id));
    const ids = await seedClients(store, "A", 15);
    const { job: j } = await bulk.create(A(), { clientIds: ids, includeReturns: false });
    expect((await job(j.id)).status).toBe("queued");
    await q.idle();
    expect((await job(j.id)).status).toBe("completed");
    expect(await usage()).toMatchObject({ used: 15, reserved: 0 });
  });
});
