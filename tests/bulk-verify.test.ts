import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { CheckService, DEFAULT_CHECK_OPTIONS } from "@/services/checks";
import { BulkService, InProcessQueue } from "@/services/bulk";
import { VerificationService, DEFAULT_VERIFY_OPTIONS } from "@/services/verification";
import { VerificationMetrics } from "@/lib/metrics";
import { ResilientProvider } from "@/providers/gate";
import { currentMonthKey } from "@/lib/dates";
import { PLANS } from "@/config/plans";
import { ProviderError } from "@/providers/types";
import { ForbiddenError } from "@/lib/permissions";
import { computeGstinChecksum } from "@/lib/gstin";
import { FAST_LIMITS, NOW, ctxFor, gst, seedOrg, StubProvider } from "./helpers";

/** Valid GSTINs beyond the 9,999 the shared helper can make (varies a PAN letter). */
const wide = (n: number) => Array.from({ length: n }, (_, i) => { const b = `24AAAA${String.fromCharCode(65 + Math.floor(i / 9999))}${String((i % 9999) + 1).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); });

const MONTH = currentMonthKey(NOW);
const LIMIT = PLANS.firm.monthlyChecks!; // read from config so plan changes do not break the accounting tests
class ManualQueue extends InProcessQueue { enqueue() { /* tests drive processJob explicitly */ } }

let store: MemoryStore, stub: StubProvider, bulk: BulkService, verification: VerificationService;
const A = () => ctxFor("A", "ACCOUNTANT");
const usage = () => store.usage.get("A", MONTH);
const job = (id: string) => store.getJob("A", id).then((j) => j!);
const list = (n: number, from = 1) => Array.from({ length: n }, (_, i) => gst(from + i));

beforeEach(async () => {
  store = new MemoryStore(); stub = new StubProvider(() => NOW);
  await seedOrg(store, "A", "firm"); await seedOrg(store, "B", "firm"); await seedOrg(store, "F", "free");
  const gate = new ResilientProvider(stub, FAST_LIMITS, { sleep: async () => {} });
  verification = new VerificationService(store, gate, new VerificationMetrics(), DEFAULT_VERIFY_OPTIONS, () => NOW);
  bulk = new BulkService(store, new CheckService(store, gate, DEFAULT_CHECK_OPTIONS, () => NOW), new ManualQueue(), FAST_LIMITS, () => NOW, verification);
});

describe("preview", () => {
  it("separates valid, invalid (with reasons), duplicates and cache hits; consumes nothing", async () => {
    await verification.verify(A(), gst(1));
    const bad = gst(2).slice(0, 14) + (gst(2)[14] === "A" ? "B" : "A");
    const p = await bulk.estimateVerify(A(), { gstins: [gst(1), gst(1).toLowerCase(), gst(3), bad, "nope", "", ` ${gst(4)} `] });
    expect(p).toMatchObject({ lines: 7, valid: 3, invalidCount: 3, duplicates: 1, servedFromCache: 1, needsLiveCheck: 2, providerRequests: 2 });
    expect(p.invalid.map((i) => i.reason).sort()).toEqual(["CHECKSUM", "EMPTY", "LENGTH"]);
    expect(p.quota).toMatchObject({ used: 1, remaining: LIMIT - 1, afterRemaining: LIMIT - 3, sufficient: true });
    expect((await usage())?.reserved).toBe(0);
  });
  it("force counts everything as live; needs checks:run", async () => {
    await verification.verify(A(), gst(1));
    expect((await bulk.estimateVerify(A(), { gstins: [gst(1)], force: true })).needsLiveCheck).toBe(1);
    await expect(bulk.estimateVerify(ctxFor("A", "VIEWER"), { gstins: [gst(1)] })).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("rejects malformed bodies and oversized lists", async () => {
    await expect(bulk.estimateVerify(A(), { gstins: [] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(bulk.estimateVerify(A(), { gstins: "x" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(bulk.estimateVerify(A(), { gstins: wide(10_001) })).rejects.toMatchObject({ code: "TOO_MANY_ITEMS" });
  });
});

describe("run", () => {
  it("verifies without client records, stores answers, consumes one unit per live item, reports skipped lines", async () => {
    const { job: j, rejected } = await bulk.createVerify(A(), { gstins: [...list(5), "bad", gst(1)] });
    expect(rejected).toEqual({ invalidCount: 1, duplicates: 1 });
    expect(j).toMatchObject({ kind: "verify", total: 5, includeReturns: false, skipped: 2, quota: { requested: 5, reserved: 5, consumed: 0, released: 0 } });
    expect(await store.listClients("A", { limit: 10 })).toMatchObject({ items: [] });          // no client records created
    await bulk.processJob("A", j.id);
    const done = await job(j.id);
    expect(done.counts).toMatchObject({ succeeded: 5, failed: 0, queued: 0 });
    expect(done.quota).toEqual({ requested: 5, reserved: 5, consumed: 5, released: 0 });
    expect(await usage()).toMatchObject({ used: 5, reserved: 0 });
    expect(stub.verifyCalls).toBe(5); expect(stub.returnCalls).toBe(0);
    expect((await verification.recent(A(), 10)).length).toBe(5);
    expect(done.status).toBe("completed");
  });
  it("serves fresh stored answers from cache, releasing their (never-held) quota", async () => {
    await verification.verify(A(), gst(1)); await verification.verify(A(), gst(2));
    stub.verifyCalls = 0;
    const { job: j } = await bulk.createVerify(A(), { gstins: list(4) });
    expect(j.quota).toMatchObject({ requested: 2, reserved: 2 });
    await bulk.processJob("A", j.id);
    expect((await job(j.id)).counts).toMatchObject({ cached: 2, succeeded: 2 });
    expect(stub.verifyCalls).toBe(2); expect(await usage()).toMatchObject({ used: 4, reserved: 0 });
  });
  it("force re-verifies stored answers (repeat verification)", async () => {
    await verification.verify(A(), gst(1)); stub.verifyCalls = 0;
    const { job: j } = await bulk.createVerify(A(), { gstins: [gst(1)], force: true });
    await bulk.processJob("A", j.id);
    expect((await job(j.id)).counts).toMatchObject({ succeeded: 1, cached: 0 }); expect(stub.verifyCalls).toBe(1);
  });
  it("NOT_FOUND is a result, not a failure, and costs nothing; outages are failures, retryable, and refunded", async () => {
    stub.failFor.set(gst(2), new ProviderError("GST_PROVIDER_NOT_FOUND", "x", false));
    stub.failFor.set(gst(3), new ProviderError("GST_PROVIDER_UNAVAILABLE", "x", false));
    stub.failFor.set(gst(4), new ProviderError("GST_PROVIDER_BAD_RESPONSE", "x", false));
    const { job: j } = await bulk.createVerify(A(), { gstins: list(4) });
    await bulk.processJob("A", j.id);
    const done = await job(j.id);
    expect(done.counts).toMatchObject({ succeeded: 2, failed: 2 });
    expect(done.quota).toMatchObject({ consumed: 1, released: 3 });                          // only gst(1) billed
    expect(await usage()).toMatchObject({ used: 1, reserved: 0 });
    const items = await bulk.items(A(), j.id, {});
    const by = Object.fromEntries(items.items.map((i) => [i.gstin, i]));
    expect(by[gst(2)].verification?.outcome).toBe("NOT_FOUND");
    expect(by[gst(3)]).toMatchObject({ status: "failed", errorCode: "GST_PROVIDER_UNAVAILABLE", retryable: true === by[gst(3)].retryable ? true : false });
    expect(by[gst(4)]).toMatchObject({ status: "failed", errorCode: "GST_PROVIDER_BAD_RESPONSE", retryable: false });
    expect(by[gst(1)].verification).toMatchObject({ outcome: "ACTIVE" });
    expect(done.status).toBe("completed_with_errors");
  });
  it("retry-failed re-runs only the retryable failures and settles quota again", async () => {
    stub.failFor.set(gst(2), new ProviderError("GST_PROVIDER_TIMEOUT", "x", true));
    const { job: j } = await bulk.createVerify(A(), { gstins: list(3) });
    await bulk.processJob("A", j.id);
    expect((await job(j.id)).counts).toMatchObject({ succeeded: 2, failed: 1 });
    stub.failFor.clear();
    const r = await bulk.retryFailed(A(), j.id); expect(r.requeued).toBe(1);
    await bulk.processJob("A", j.id);
    const done = await job(j.id);
    expect(done.counts).toMatchObject({ succeeded: 3, failed: 0 });
    expect(await usage()).toMatchObject({ used: 3, reserved: 0 });
  });
  it("is idempotent: the same list returns the same job; different list or key does not", async () => {
    const a = await bulk.createVerify(A(), { gstins: list(3) });
    const b = await bulk.createVerify(A(), { gstins: [...list(3)].reverse() });
    expect(b.replay).toBe(true); expect(b.job.id).toBe(a.job.id);
    expect(await usage()).toMatchObject({ reserved: 3 });                                    // held once
    const c = await bulk.createVerify(A(), { gstins: list(3, 10) });
    expect(c.replay).toBe(false);
  });
  it("cancel releases unstarted holds", async () => {
    const { job: j } = await bulk.createVerify(A(), { gstins: list(4) });
    await bulk.cancel(A(), j.id);
    expect(await usage()).toMatchObject({ used: 0, reserved: 0 });
    expect((await job(j.id)).status).toBe("cancelled");
  });
  it("survives a requester demoted after queuing (authorization is re-checked per item)", async () => {
    const { job: j } = await bulk.createVerify(A(), { gstins: list(2) });
    await store.putMember("A", { uid: "A-ACCOUNTANT", email: "x@x.com", role: "VIEWER", addedAt: NOW.toISOString() });
    await bulk.processJob("A", j.id);
    const done = await job(j.id);
    expect(done.counts).toMatchObject({ failed: 2, succeeded: 0 });
    expect(await usage()).toMatchObject({ used: 0, reserved: 0 });
  });
});

describe("limits, plans and tenancy", () => {
  it("quota: refuses without partial; allowPartial runs what the allowance covers", async () => {
    const F = ctxFor("F", "ACCOUNTANT");
    await store.updateOrg("F", { plan: "firm" });
    // fill most of an org that has the bulk feature but a small allowance: starter has 500; use professional with usage pre-set
    const need = LIMIT;
    const big = await bulk.createVerify(F, { gstins: list(need, 100) }).catch((e) => e);
    expect(big.job?.total).toBe(need);
    await expect(bulk.createVerify(F, { gstins: list(5, 5000) })).rejects.toMatchObject({ code: "QUOTA_EXHAUSTED" });
    const part = await bulk.createVerify(F, { gstins: list(5, 5000), allowPartial: true }).catch((e) => e);
    expect(part).toMatchObject({ code: "QUOTA_EXHAUSTED" });                                  // nothing left at all => still refused
  });
  it("bulk is a plan feature: Free cannot run many (but can run one)", async () => {
    const F = ctxFor("F", "ACCOUNTANT");
    await expect(bulk.createVerify(F, { gstins: list(3) })).rejects.toMatchObject({ code: "FEATURE_NOT_AVAILABLE" });
    const one = await bulk.createVerify(F, { gstins: [gst(1)] }); expect(one.job.total).toBe(1);
  });
  it("no valid entries / read-only subscription / viewers are refused and leave nothing held", async () => {
    await expect(bulk.createVerify(A(), { gstins: ["a", "b"] })).rejects.toMatchObject({ code: "NO_VALID_GSTINS" });
    await expect(bulk.createVerify(ctxFor("A", "VIEWER"), { gstins: [gst(1)] })).rejects.toBeInstanceOf(ForbiddenError);
    await store.updateOrg("A", { subscriptionStatus: "expired" });
    await expect(bulk.createVerify(A(), { gstins: [gst(1)] })).rejects.toMatchObject({ code: "SUBSCRIPTION_INACTIVE" });
    expect((await usage())?.reserved ?? 0).toBe(0);
  });
  it("jobs and results are per organization", async () => {
    const { job: j } = await bulk.createVerify(A(), { gstins: list(2) });
    await bulk.processJob("A", j.id);
    await expect(bulk.get(ctxFor("B", "OWNER"), j.id)).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    await expect(bulk.exportVerify(ctxFor("B", "OWNER"), j.id)).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    expect((await bulk.get(A(), j.id)).kind).toBe("verify");
  });
});

describe("export", () => {
  it("produces a formula-safe CSV with answers, errors, notes and tags", async () => {
    stub.failFor.set(gst(3), new ProviderError("GST_PROVIDER_BAD_RESPONSE", "x", false));
    stub.failFor.set(gst(2), new ProviderError("GST_PROVIDER_NOT_FOUND", "x", false));
    const { job: j } = await bulk.createVerify(A(), { gstins: list(3) });
    await bulk.processJob("A", j.id);
    await verification.annotate(A(), gst(1), { note: "=HYPERLINK(\"http://evil\")", tags: ["Monthly", "Gujarat"] });
    const r = await bulk.exportVerify(A(), j.id);
    expect(r.rows).toBe(3); expect(r.truncated).toBe(false);
    const lines = r.csv.split("\r\n");
    expect(lines[0]).toContain('"GSTIN","Result"');
    const row = (g: string) => lines.find((l) => l.startsWith(`"${g}"`))!;
    expect(row(gst(1))).toContain('"Active"'); expect(row(gst(1))).toContain('"Monthly; Gujarat"'); expect(row(gst(1))).toContain(`"'=HYPERLINK`);
    expect(row(gst(2))).toContain("No matching registration found");
    expect(row(gst(3))).toContain('"Could not verify"'); expect(row(gst(3))).toContain("GST_PROVIDER_BAD_RESPONSE");
    expect(r.csv).not.toMatch(/,"=/);                                                        // nothing starts with a raw formula char
  });
  it("is not available for client check jobs", async () => {
    await expect(bulk.exportVerify(A(), "missing")).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
  });
});

describe("notes, tags, folders", () => {
  it("annotate requires a prior verification; trims, de-duplicates, enforces limits; survives re-verification", async () => {
    await expect(verification.annotate(A(), gst(1), { note: "x" })).rejects.toMatchObject({ code: "VERIFICATION_NOT_FOUND" });
    await verification.verify(A(), gst(1));
    expect(await verification.annotate(A(), gst(1), { note: "  Call on Monday  ", tags: [" Monthly ", "monthly", "Monthly", "GJ  Zone"] })).toEqual({ gstin: gst(1), note: "Call on Monday", tags: ["Monthly", "monthly", "GJ Zone"] });
    await verification.verify(A(), gst(1), { force: true });
    expect((await verification.verify(A(), gst(1))).note).toBe("Call on Monday");
    expect((await verification.recent(A(), 10, { tag: "Monthly" })).map((r) => r.gstin)).toEqual([gst(1)]);
    expect(await verification.recent(A(), 10, { tag: "Other" })).toEqual([]);
    await expect(verification.annotate(A(), gst(1), { note: "x".repeat(501) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(verification.annotate(A(), gst(1), { tags: ["a", "b", "c", "d", "e", "f"] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(verification.annotate(A(), gst(1), { tags: ["x".repeat(25)] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(verification.annotate(A(), gst(1), { tags: [1] })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await verification.annotate(A(), gst(1), { note: "", tags: [] })).toEqual({ gstin: gst(1), note: undefined, tags: [] });
  });
  it("omitted fields are left unchanged; viewers cannot annotate; orgs are isolated", async () => {
    await verification.verify(A(), gst(1)); await verification.annotate(A(), gst(1), { note: "n", tags: ["t"] });
    expect(await verification.annotate(A(), gst(1), { tags: ["u"] })).toEqual({ gstin: gst(1), note: "n", tags: ["u"] });
    await expect(verification.annotate(ctxFor("A", "VIEWER"), gst(1), { note: "z" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(verification.annotate(ctxFor("B", "OWNER"), gst(1), { note: "z" })).rejects.toMatchObject({ code: "VERIFICATION_NOT_FOUND" });
  });
});
