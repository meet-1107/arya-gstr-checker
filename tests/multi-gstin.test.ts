import { describe, it, expect, beforeEach } from "vitest";
import { MemoryStore } from "@/lib/store/memory";
import { ClientService } from "@/services/clients";
import { CheckService } from "@/services/checks";
import { SubscriptionService } from "@/services/subscription";
import { MockGstProvider } from "@/providers/mock";
import { PLANS } from "@/config/plans";
import { ForbiddenError } from "@/lib/permissions";
import { computeGstinChecksum } from "@/lib/gstin";
import { clientGstins, clientHasGstin, GST_STATE_NAMES, panOf, stateNameOf } from "@/lib/client-gstins";
import { mergeGstinRows, filterRows, type PortfolioRow } from "@/lib/portfolio";
import { ctxFor, NOW, seedOrg } from "./helpers";

/** A GSTIN for the given state code and PAN (10 chars), with a correct check character. */
const mk = (state: string, pan: string, entity = "1") => { const b = `${state}${pan}${entity}Z`; return b + computeGstinChecksum(b); };
const PAN = "AAAAA0001A", PAN2 = "BBBBB0002B";
const G = { gj: mk("24", PAN), mh: mk("27", PAN), dl: mk("07", PAN), ka: mk("29", PAN), tn: mk("33", PAN), other: mk("24", PAN2) };

let store: MemoryStore, clients: ClientService, subs: SubscriptionService;
const O = (org: string) => ctxFor(org, "OWNER");

beforeEach(async () => {
  store = new MemoryStore(); clients = new ClientService(store, () => NOW); subs = new SubscriptionService(store, () => NOW);
  for (const [id, plan] of [["free", "free"], ["st", "starter"], ["pro", "professional"], ["firm", "firm"], ["x", "starter"]] as const) await seedOrg(store, id, plan);
});

describe("helpers", () => {
  it("clientGstins: primary first, de-duplicated, legacy records are single-GSTIN", () => {
    expect(clientGstins({ gstin: G.gj })).toEqual([G.gj]);
    expect(clientGstins({ gstin: G.gj, gstins: [G.gj, G.mh] })).toEqual([G.gj, G.mh]);
    expect(clientGstins({ gstin: G.gj, gstins: [G.mh, G.gj, G.mh] })).toEqual([G.gj, G.mh]);
    expect(clientGstins({ gstin: G.gj, gstins: [] })).toEqual([G.gj]);
    expect(clientHasGstin({ gstin: G.gj, gstins: [G.gj, G.mh] }, G.mh)).toBe(true); expect(clientHasGstin({ gstin: G.gj }, G.mh)).toBe(false);
  });
  it("PAN and state name come from the GSTIN", () => {
    expect(panOf(G.gj)).toBe(PAN); expect(panOf(G.mh)).toBe(PAN); expect(panOf(G.other)).toBe(PAN2);
    expect(stateNameOf(G.gj)).toBe("Gujarat"); expect(stateNameOf(G.mh)).toBe("Maharashtra"); expect(stateNameOf(G.dl)).toBe("Delhi"); expect(stateNameOf(G.ka)).toBe("Karnataka"); expect(stateNameOf(G.tn)).toBe("Tamil Nadu");
    expect(stateNameOf("25AAAAA0001A1Z5")).toBeUndefined(); // 25 was merged into 26 and is not a current code
    expect(Object.keys(GST_STATE_NAMES)).toHaveLength(38);
  });
});

describe("adding GSTINs to a client firm", () => {
  it("adds a same-PAN GSTIN: one client (one billing unit), several GSTINs, each with its own record", async () => {
    const c = await clients.create(O("st"), { name: "ABC Industries", gstin: G.gj });
    const after = await clients.addGstin(O("st"), c.id, G.mh.toLowerCase());
    expect(clientGstins(after)).toEqual([G.gj, G.mh]);
    expect(await store.countClients("st")).toBe(1);                                     // still ONE billable client firm
    expect(await store.countGstins("st", {})).toBe(2);                                  // two monitored GSTINs
    expect(await store.getGstinRecord("st", G.mh)).toMatchObject({ clientId: c.id, clientName: "ABC Industries", status: "Unknown", checked: false });
    expect(await store.findClientByGstin("st", G.mh)).toMatchObject({ id: c.id });
    expect((await store.allGstins("st"))).toEqual(new Set([G.gj, G.mh]));
    expect((await clients.list(O("st"), { search: G.mh.slice(0, 8) })).items.map((x) => x.id)).toEqual([c.id]); // searchable by any of its GSTINs
    expect((await subs.overview(O("st"))).clients.used).toBe(1);                       // billing follows clients, not GSTINs
    const listed = await clients.listGstins(O("st"), c.id);
    expect(listed).toEqual([
      expect.objectContaining({ gstin: G.gj, primary: true, state: "Gujarat" }),
      expect.objectContaining({ gstin: G.mh, primary: false, state: "Maharashtra", status: "Unknown", checked: false }),
    ]);
  });
  it("is capped per plan: Free 1, Starter 5, Professional 10, Firm 25", async () => {
    expect([PLANS.free, PLANS.starter, PLANS.professional, PLANS.firm].map((p) => p.gstinsPerClient)).toEqual([1, 5, 10, 25]);
    expect(PLANS.enterprise.gstinsPerClient).toBeNull();
    const f = await clients.create(O("free"), { name: "F", gstin: G.gj });
    await expect(clients.addGstin(O("free"), f.id, G.mh)).rejects.toMatchObject({ code: "CLIENT_GSTIN_LIMIT_REACHED", status: 402 });
    const s = await clients.create(O("st"), { name: "S", gstin: G.gj });
    for (const g of [G.mh, G.dl, G.ka, G.tn]) await clients.addGstin(O("st"), s.id, g);   // 5 total
    await expect(clients.addGstin(O("st"), s.id, mk("32", PAN))).rejects.toMatchObject({ code: "CLIENT_GSTIN_LIMIT_REACHED", message: expect.stringContaining("5 GSTINs per client firm") });
  });
  it("must share the firm's PAN (a different PAN is a different business: its own client)", async () => {
    const c = await clients.create(O("st"), { name: "ABC", gstin: G.gj });
    await expect(clients.addGstin(O("st"), c.id, G.other)).rejects.toMatchObject({ code: "GSTIN_PAN_MISMATCH", status: 422 });
    expect(clientGstins((await clients.get(O("st"), c.id)))).toEqual([G.gj]);
  });
  it("rejects invalid GSTINs, non-strings, and duplicates (same client or another client in the organization)", async () => {
    const a = await clients.create(O("st"), { name: "A", gstin: G.gj });
    const b = await clients.create(O("st"), { name: "B", gstin: G.other });
    await expect(clients.addGstin(O("st"), a.id, "nope")).rejects.toMatchObject({ code: "INVALID_GSTIN" });
    await expect(clients.addGstin(O("st"), a.id, 5)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(clients.addGstin(O("st"), a.id, G.gj)).rejects.toMatchObject({ code: "DUPLICATE_GSTIN", message: expect.stringContaining("already on this client") });
    await clients.addGstin(O("st"), a.id, G.mh);
    await expect(clients.addGstin(O("st"), a.id, G.mh)).rejects.toMatchObject({ code: "DUPLICATE_GSTIN" });
    // an additional GSTIN of A is taken org-wide: B cannot create a client with it, nor claim it
    await expect(clients.create(O("st"), { name: "C", gstin: G.mh })).rejects.toMatchObject({ code: "DUPLICATE_GSTIN" });
    const b2 = await clients.create(O("st"), { name: "B2", gstin: mk("27", PAN2) });
    await expect(clients.addGstin(O("st"), b.id, mk("27", PAN2))).rejects.toMatchObject({ code: "DUPLICATE_GSTIN", message: expect.stringContaining('"B2"') });
    void b2;
  });
  it("needs clients:write and a writable subscription; an archived client must be restored first; stays inside the organization", async () => {
    const c = await clients.create(O("st"), { name: "A", gstin: G.gj });
    await expect(clients.addGstin(ctxFor("st", "VIEWER"), c.id, G.mh)).rejects.toBeInstanceOf(ForbiddenError);
    const foreign = await clients.create(O("x"), { name: "Z", gstin: G.gj });
    await expect(clients.addGstin(O("st"), foreign.id, G.mh)).rejects.toMatchObject({ code: "CLIENT_NOT_FOUND" });
    await clients.archive(O("st"), c.id);
    await expect(clients.addGstin(O("st"), c.id, G.mh)).rejects.toMatchObject({ code: "CLIENT_ARCHIVED" });
    await clients.restore(O("st"), c.id);
    await store.updateOrg("st", { subscriptionStatus: "cancelled" });
    await expect(clients.addGstin(O("st"), c.id, G.mh)).rejects.toMatchObject({ code: "SUBSCRIPTION_INACTIVE" });
  });
  it("GSTINs are unique per organization, not across organizations", async () => {
    const a = await clients.create(O("st"), { name: "A", gstin: G.gj }); await clients.addGstin(O("st"), a.id, G.mh);
    const z = await clients.create(O("x"), { name: "Z", gstin: G.gj });
    await expect(clients.addGstin(O("x"), z.id, G.mh)).resolves.toBeTruthy();
  });
});

describe("removing GSTINs", () => {
  it("removes an additional GSTIN and everything stored for it; the primary cannot be removed", async () => {
    const c = await clients.create(O("st"), { name: "A", gstin: G.gj }); await clients.addGstin(O("st"), c.id, G.mh);
    await store.putReturns("st", G.mh, [{ id: `${G.mh}_GSTR1_202604`, gstin: G.mh, returnType: "GSTR1", financialYear: "2026-27", period: "042026", periodSort: "202604", status: "FILED", state: "FILED_ON_TIME", dueDate: "2026-05-11T00:00:00.000Z", source: "t", checkedAt: NOW.toISOString(), retrievedAt: NOW.toISOString() } as never]);
    await expect(clients.removeGstin(O("st"), c.id, G.gj)).rejects.toMatchObject({ code: "CANNOT_REMOVE_PRIMARY_GSTIN", status: 409 });
    await expect(clients.removeGstin(O("st"), c.id, G.dl)).rejects.toMatchObject({ code: "GSTIN_NOT_ON_CLIENT", status: 404 });
    const after = await clients.removeGstin(O("st"), c.id, G.mh.toLowerCase());
    expect(clientGstins(after)).toEqual([G.gj]);
    expect(await store.getGstinRecord("st", G.mh)).toBeNull(); expect(await store.listReturns("st", G.mh)).toEqual([]);
    expect(await store.findClientByGstin("st", G.mh)).toBeNull();
    await expect(clients.addGstin(O("st"), c.id, G.mh)).resolves.toBeTruthy();            // the slot and the GSTIN are free again
  });
});

describe("firm-level operations apply to every GSTIN", () => {
  it("rename / reassign sync the denormalized fields on all GSTIN records", async () => {
    const c = await clients.create(O("st"), { name: "Old", gstin: G.gj }); await clients.addGstin(O("st"), c.id, G.mh);
    await clients.update(O("st"), c.id, { name: "New Name" });
    for (const g of [G.gj, G.mh]) expect(await store.getGstinRecord("st", g)).toMatchObject({ clientName: "New Name" });
  });
  it("archive hides every GSTIN of the firm and restore brings them all back; both counts stay per client", async () => {
    const c = await clients.create(O("st"), { name: "A", gstin: G.gj }); await clients.addGstin(O("st"), c.id, G.mh);
    await clients.archive(O("st"), c.id);
    expect(await store.countGstins("st", {})).toBe(0); expect(await store.countGstins("st", { archived: true })).toBe(2);
    expect(await store.countClients("st")).toBe(0);
    await clients.restore(O("st"), c.id);
    expect(await store.countGstins("st", {})).toBe(2); expect(await store.countClients("st")).toBe(1);
  });
  it("delete removes every GSTIN's data", async () => {
    const c = await clients.create(O("st"), { name: "A", gstin: G.gj }); await clients.addGstin(O("st"), c.id, G.mh);
    await clients.remove(O("st"), c.id);
    expect(await store.countGstins("st", {})).toBe(0); expect(await store.allGstins("st")).toEqual(new Set());
  });
});

describe("checks per GSTIN", () => {
  const mkChecks = () => new CheckService(store, new MockGstProvider({ now: () => NOW }), undefined, () => NOW);
  it("checks the requested GSTIN (default: the primary), one quota unit each, and stores the result on that GSTIN", async () => {
    const c = await clients.create(O("pro"), { name: "A", gstin: G.gj }); await clients.addGstin(O("pro"), c.id, G.mh);
    const checks = mkChecks();
    const d = await checks.checkClient(O("pro"), c.id);                                  // default → primary
    expect(d.record.gstin).toBe(G.gj);
    const m = await checks.checkClient(O("pro"), c.id, { gstin: G.mh });
    expect(m.record.gstin).toBe(G.mh); expect(m.record).toMatchObject({ clientId: c.id, clientName: "A", checked: true });
    expect((await store.getGstinRecord("pro", G.mh))!.checked).toBe(true);
    expect((await store.usage.get("pro", "2026-10"))?.used).toBe(2);
    expect((await checks.checkClient(O("pro"), c.id, { gstin: G.mh })).cached).toBe(true); // cache is per GSTIN
  });
  it("a GSTIN that is not on the client is refused (cannot be used to check arbitrary GSTINs against the client's record)", async () => {
    const c = await clients.create(O("pro"), { name: "A", gstin: G.gj });
    await expect(mkChecks().checkClient(O("pro"), c.id, { gstin: G.mh })).rejects.toMatchObject({ code: "GSTIN_NOT_ON_CLIENT" });
    const other = await clients.create(O("pro"), { name: "B", gstin: G.other });
    await expect(mkChecks().checkClient(O("pro"), c.id, { gstin: other.gstin })).rejects.toMatchObject({ code: "GSTIN_NOT_ON_CLIENT" });
  });
});

describe("portfolio: one row per client, showing the most serious GSTIN", () => {
  const row = (g: string, o: Partial<PortfolioRow> = {}): PortfolioRow => ({ clientId: "c1", name: "ABC", gstin: g, status: "ACTIVE", statusSource: "verification", freshness: "fresh", verifiedAt: "2026-10-05T00:00:00.000Z", ageSeconds: 100, legalName: `LEGAL ${g.slice(0, 2)}`, ...o });
  it("a single-GSTIN row is returned untouched (same object, no new fields)", () => {
    const r = row(G.gj); expect(mergeGstinRows([r])).toBe(r); expect(mergeGstinRows([r])).not.toHaveProperty("gstins");
  });
  it("status is the most serious known answer; a never-verified GSTIN does not mask a real problem", () => {
    const m = mergeGstinRows([row(G.gj), row(G.mh, { status: "CANCELLED", legalName: "CANCELLED CO" }), row(G.dl, { status: null, freshness: "never", statusSource: null, verifiedAt: undefined, legalName: undefined })]);
    expect(m).toMatchObject({ gstin: G.gj, status: "CANCELLED", legalName: "CANCELLED CO", statusGstin: G.mh, gstinCount: 3, gstins: [G.gj, G.mh, G.dl] });
    const calm = mergeGstinRows([row(G.gj), row(G.mh, { status: null, freshness: "never", statusSource: null, verifiedAt: undefined })]);
    expect(calm.status).toBe("ACTIVE");
  });
  it("freshness is the WORST across GSTINs (one never-verified or stale registration makes the client need a refresh)", () => {
    expect(mergeGstinRows([row(G.gj), row(G.mh, { freshness: "stale" })]).freshness).toBe("stale");
    expect(mergeGstinRows([row(G.gj, { freshness: "stale" }), row(G.mh, { freshness: "never", status: null })]).freshness).toBe("never");
    expect(mergeGstinRows([row(G.gj, { freshness: "expired" }), row(G.mh, { freshness: "stale" })]).freshness).toBe("expired");
  });
  it("surfaces the most recent change on ANY GSTIN; search matches any of the firm's GSTINs", () => {
    const ch = (at: string) => ({ from: "ACTIVE", to: "CANCELLED", at, deteriorated: true }) as never;
    const m = mergeGstinRows([row(G.gj, { change: ch("2026-10-01T00:00:00.000Z") }), row(G.mh, { change: ch("2026-10-04T00:00:00.000Z") })]);
    expect(m.change).toMatchObject({ at: "2026-10-04T00:00:00.000Z" });
    expect(filterRows([m], { q: G.mh.slice(0, 7) })).toHaveLength(1); expect(filterRows([m], { q: "99" })).toHaveLength(0);
  });
});
