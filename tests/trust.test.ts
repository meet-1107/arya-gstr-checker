import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { AuditService, ConcernService, VerificationPrivacyService } from "@/services/trust";
import { VerificationService, DEFAULT_VERIFY_OPTIONS } from "@/services/verification";
import { VerificationMetrics } from "@/lib/metrics";
import { ResilientProvider } from "@/providers/gate";
import { ForbiddenError } from "@/lib/permissions";
import { AUDIT_ACTIONS, auditLabel } from "@/lib/audit-labels";
import { CONCERN_CATEGORIES, CONCERN_DISCLAIMER, MAX_CONCERNS_PER_USER_PER_DAY } from "@/lib/concerns";
import { FAST_LIMITS, NOW, ctxFor, gst, seedOrg, StubProvider } from "./helpers";

let store: MemoryStore, clock: Date, concerns: ConcernService, audit: AuditService, privacy: VerificationPrivacyService, verification: VerificationService;
const A = () => ctxFor("A", "ACCOUNTANT");
const OWNER = () => ctxFor("A", "OWNER");
const GOOD = { gstin: gst(1), category: "NAME_MISMATCH", description: "Invoice says Shah Traders but the registration is in another name." };

beforeEach(async () => {
  store = new MemoryStore(); clock = new Date(NOW);
  await seedOrg(store, "A"); await seedOrg(store, "B");
  const stub = new StubProvider(() => clock);
  verification = new VerificationService(store, new ResilientProvider(stub, FAST_LIMITS, { sleep: async () => {} }), new VerificationMetrics(), DEFAULT_VERIFY_OPTIONS, () => clock);
  concerns = new ConcernService(store, () => clock); audit = new AuditService(store); privacy = new VerificationPrivacyService(store, () => clock);
});

describe("report a concern", () => {
  it("records an internal concern with a snapshot of what the reporter saw, and audits it without the free text", async () => {
    await verification.verify(A(), gst(1));
    const { concern, duplicate } = await concerns.create(A(), GOOD);
    expect(duplicate).toBe(false);
    expect(concern).toMatchObject({ gstin: gst(1), category: "NAME_MISMATCH", status: "open", reportedBy: "A-ACCOUNTANT", snapshot: { outcome: "ACTIVE", source: "stub" } });
    const entry = (await store.listAudit("A", 10)).find((e) => e.action === "CONCERN_REPORTED")!;
    expect(entry.metadata).toEqual({ gstin: gst(1), category: "NAME_MISMATCH" });
    expect(JSON.stringify(entry)).not.toContain("Shah Traders");
  });
  it("works without a prior verification (no snapshot)", async () => {
    const { concern } = await concerns.create(A(), GOOD);
    expect(concern.snapshot).toBeUndefined();
  });
  it("validates every field", async () => {
    await expect(concerns.create(A(), { ...GOOD, gstin: "bad" })).rejects.toMatchObject({ code: "INVALID_GSTIN" });
    await expect(concerns.create(A(), { ...GOOD, category: "FRAUD!" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(concerns.create(A(), { ...GOOD, description: "short" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(concerns.create(A(), { ...GOOD, description: "x".repeat(1001) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(concerns.create(A(), { gstin: 1, category: 2, description: 3 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await concerns.create(A(), { ...GOOD, description: "  has\u0000 control\u0007 chars but is fine  " })).concern.description).toBe("has control chars but is fine");
  });
  it("an identical open concern from the same person within a day is returned, not duplicated", async () => {
    const a = await concerns.create(A(), GOOD); const b = await concerns.create(A(), GOOD);
    expect(b.duplicate).toBe(true); expect(b.concern.id).toBe(a.concern.id);
    expect(await store.listConcerns("A", { limit: 10 })).toHaveLength(1);
    clock = new Date(NOW.getTime() + 25 * 3600_000);
    expect((await concerns.create(A(), GOOD)).duplicate).toBe(false);                           // a day later is a new report
  });
  it("is rate limited per person per day", async () => {
    for (let i = 0; i < MAX_CONCERNS_PER_USER_PER_DAY; i++) await concerns.create(A(), { ...GOOD, gstin: gst(100 + i) });
    await expect(concerns.create(A(), { ...GOOD, gstin: gst(999) })).rejects.toMatchObject({ code: "CONCERN_LIMIT", status: 429 });
    await expect(concerns.create(ctxFor("A", "ADMIN"), { ...GOOD, gstin: gst(999) })).resolves.toBeTruthy();   // someone else is unaffected
  });
  it("viewers cannot report or list; organizations are isolated", async () => {
    await expect(concerns.create(ctxFor("A", "VIEWER"), GOOD)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(concerns.list(ctxFor("A", "VIEWER"))).rejects.toBeInstanceOf(ForbiddenError);
    await concerns.create(A(), GOOD);
    expect(await concerns.list(ctxFor("B", "OWNER"))).toEqual([]);
    expect(await concerns.list(A())).toHaveLength(1);
  });
  it("lists newest first with status and GSTIN filters, and validates them", async () => {
    const c1 = (await concerns.create(A(), { ...GOOD, gstin: gst(1) })).concern;
    clock = new Date(NOW.getTime() + 1000); const c2 = (await concerns.create(A(), { ...GOOD, gstin: gst(2) })).concern;
    expect((await concerns.list(A())).map((c) => c.id)).toEqual([c2.id, c1.id]);
    expect((await concerns.list(A(), { gstin: gst(1) })).map((c) => c.id)).toEqual([c1.id]);
    await concerns.update(OWNER(), c1.id, { status: "closed" });
    expect((await concerns.list(A(), { status: "open" })).map((c) => c.id)).toEqual([c2.id]);
    await expect(concerns.list(A(), { status: "bogus" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(concerns.list(A(), { gstin: "bad" })).rejects.toMatchObject({ code: "INVALID_GSTIN" });
  });
  it("owners/admins review: open → reviewed → closed (and reopen) with a resolution; accountants cannot", async () => {
    const c = (await concerns.create(A(), GOOD)).concern;
    await expect(concerns.update(A(), c.id, { status: "reviewed" })).rejects.toBeInstanceOf(ForbiddenError);
    const r = await concerns.update(ctxFor("A", "ADMIN"), c.id, { status: "reviewed", resolution: "  Asked client for the certificate  " });
    expect(r).toMatchObject({ status: "reviewed", resolution: "Asked client for the certificate", reviewedBy: "A-ADMIN" });
    expect((await concerns.update(OWNER(), c.id, { status: "closed" })).resolution).toBe("Asked client for the certificate"); // omitted resolution is kept
    expect((await concerns.update(OWNER(), c.id, { status: "open", resolution: "" })).resolution).toBeUndefined();
    await expect(concerns.update(OWNER(), c.id, { status: "nope" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(concerns.update(OWNER(), c.id, { status: "closed", resolution: "x".repeat(501) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(concerns.update(OWNER(), "missing", { status: "closed" })).rejects.toMatchObject({ code: "CONCERN_NOT_FOUND" });
    await expect(concerns.update(ctxFor("B", "OWNER"), c.id, { status: "closed" })).rejects.toMatchObject({ code: "CONCERN_NOT_FOUND" }); // another org's concern
    expect((await store.listAudit("A", 20)).filter((e) => e.action === "CONCERN_UPDATED").map((e) => e.metadata?.status)).toContain("reviewed");
  });
  it("the wording never calls a GSTIN fake, and states that nothing leaves the organization", () => {
    expect(CONCERN_DISCLAIMER).toMatch(/internal note/i); expect(CONCERN_DISCLAIMER).toMatch(/not sent to the GST authorities/i); expect(CONCERN_DISCLAIMER).toMatch(/not a finding that the GSTIN is fake/i);
    for (const c of CONCERN_CATEGORIES) expect(`${c.label} ${c.hint}`).not.toMatch(/\bis fake\b|\bfraudulent gstin\b/i);
  });
});

describe("audit trail", () => {
  it("lists newest first with readable labels and names; owners/admins only", async () => {
    await verification.verify(A(), gst(1));
    await concerns.create(A(), GOOD);
    const rows = await audit.list(OWNER());
    expect(rows.map((r) => r.action)).toEqual(["CONCERN_REPORTED", "GST_VERIFY"]);
    expect(rows[0]).toMatchObject({ label: "Reported a concern about a GSTIN", who: "ACCOUNTANT@A.com" });
    await expect(audit.list(A())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(audit.list(ctxFor("A", "VIEWER"))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await audit.list(ctxFor("B", "OWNER"))).toEqual([]);                                  // per organization
  });
  it("filters by action, bounds the limit, rejects unknown actions, shows removed members honestly", async () => {
    for (let i = 1; i <= 5; i++) await verification.verify(A(), gst(i));
    await concerns.create(A(), GOOD);
    expect((await audit.list(OWNER(), { action: "GST_VERIFY" })).length).toBe(5);
    expect((await audit.list(OWNER(), { action: "GST_VERIFY", limit: 2 })).length).toBe(2);
    expect((await audit.list(OWNER(), { limit: 99999 })).length).toBe(6);
    await expect(audit.list(OWNER(), { action: "DROP TABLE" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await store.removeMember("A", "A-ACCOUNTANT");
    expect((await audit.list(OWNER()))[0].who).toBe("Former member or system");
  });
  it("records saves and note edits WITHOUT their content", async () => {
    await verification.verify(A(), gst(1));
    await verification.setSaved(A(), gst(1), true);
    await verification.annotate(A(), gst(1), { note: "Client owes us 4,50,000 — call Mehta on 98xxxxxx", tags: ["Risky"] });
    const log = JSON.stringify(await audit.list(OWNER()));
    expect(log).toContain("VERIFICATION_SAVED"); expect(log).toContain("VERIFICATION_ANNOTATED");
    expect(log).not.toContain("4,50,000"); expect(log).not.toContain("Mehta"); expect(log).not.toContain("Risky");
  });
  it("exports a formula-safe CSV and every action has a human label", async () => {
    await concerns.create(A(), GOOD);
    await store.addAudit({ id: "x", organizationId: "A", userId: "A-owner", action: "TEAM_MEMBER_ADDED", target: "=cmd|' /C calc'!A0", at: NOW.toISOString(), metadata: { role: "ADMIN" } });
    const { csv, rows } = await audit.exportCsv(OWNER());
    expect(rows).toBe(2); expect(csv).toContain('"When (UTC)","Who","What","Target","Details"'); expect(csv).toContain(`"'=cmd`); expect(csv).not.toMatch(/,"=/);
    await expect(audit.exportCsv(A())).rejects.toBeInstanceOf(ForbiddenError);
    for (const a of AUDIT_ACTIONS) expect(auditLabel(a)).not.toBe(a);
    expect(auditLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("privacy controls", () => {
  it("forget removes one stored lookup (with its notes, tags and pin), audits it, and is idempotent", async () => {
    await verification.verify(A(), gst(1)); await verification.verify(A(), gst(2));
    await verification.annotate(A(), gst(1), { note: "private", tags: ["t"] }); await verification.setSaved(A(), gst(1), true);
    expect(await privacy.forget(A(), gst(1).toLowerCase())).toEqual({ gstin: gst(1), removed: true });
    expect(await store.getVerification("A", gst(1))).toBeNull();
    expect((await verification.recent(A(), 10)).map((r) => r.gstin)).toEqual([gst(2)]);
    expect(await privacy.forget(A(), gst(1))).toEqual({ gstin: gst(1), removed: false });
    expect((await store.listAudit("A", 20)).filter((e) => e.action === "VERIFICATION_DELETED")).toHaveLength(1);
    await expect(privacy.forget(A(), "bad")).rejects.toMatchObject({ code: "INVALID_GSTIN" });
    await expect(privacy.forget(ctxFor("A", "VIEWER"), gst(2))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await verification.verify(A(), gst(1))).freshness).toBe("live");                    // forgotten means the next lookup is live again
  });
  it("forget never touches another organization's history", async () => {
    await verification.verify(A(), gst(1)); await verification.verify(ctxFor("B", "ACCOUNTANT"), gst(1));
    await privacy.forget(A(), gst(1));
    expect(await store.getVerification("B", gst(1))).not.toBeNull();
  });
  it("clearing the whole history is owner/admin only, complete, and audited with a count", async () => {
    for (let i = 1; i <= 7; i++) await verification.verify(A(), gst(i));
    await verification.verify(ctxFor("B", "ACCOUNTANT"), gst(1));
    await expect(privacy.forgetAll(A())).rejects.toBeInstanceOf(ForbiddenError);
    expect(await privacy.forgetAll(ctxFor("A", "ADMIN"))).toEqual({ removed: 7 });
    expect(await store.listVerifications("A", 50)).toEqual([]);
    expect(await store.listVerifications("B", 50)).toHaveLength(1);
    expect((await store.listAudit("A", 5))[0]).toMatchObject({ action: "VERIFICATION_HISTORY_CLEARED", metadata: { removed: 7 } });
  });
});
