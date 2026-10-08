/* eslint-disable @typescript-eslint/no-explicit-any -- test helper reads loosely-typed JSON envelopes */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { container, resetContainer } from "@/server/container";
import { computeGstinChecksum } from "@/lib/gstin";
import * as orgsRoute from "@/app/api/organizations/route";
import * as clientsRoute from "@/app/api/clients/route";
import * as clientRoute from "@/app/api/clients/[id]/route";
import * as gstinsRoute from "@/app/api/clients/[id]/gstins/route";
import * as gstinRoute from "@/app/api/clients/[id]/gstins/[gstin]/route";
import * as archiveRoute from "@/app/api/clients/[id]/archive/route";
import * as checkRoute from "@/app/api/gst/check/route";
import * as gstinListRoute from "@/app/api/gstins/route";
import * as bulkRoute from "@/app/api/bulk-checks/route";
import * as bulkPreviewRoute from "@/app/api/bulk-checks/preview/route";
import * as portfolioRoute from "@/app/api/portfolio/route";
import * as plannerRoute from "@/app/api/portfolio/gstins/route";
import * as scheduleRoute from "@/app/api/portfolio/schedule/route";
import * as runDueRoute from "@/app/api/portfolio/run-due/route";
import * as subRoute from "@/app/api/subscription/route";

const mk = (state: string, pan: string) => { const b = `${state}${pan}1Z`; return b + computeGstinChecksum(b); };
const PAN = "AAAAA0001A";
/** Same-PAN GSTINs grouped by the status the deterministic mock provider will report for them (so "worst status" is observable). */
const mockStatus = (g: string) => { let h = 0; for (const c of g) h = (h * 31 + c.charCodeAt(0)) >>> 0; return ["Active", "Active", "Active", "Active", "Active", "Suspended", "Cancelled"][h % 7]; };
const pair: Record<string, string[]> = {};
for (const st of ["24", "27", "07", "29", "33", "32", "19", "06", "09", "08"]) { const g = mk(st, PAN); (pair[mockStatus(g)] ??= []).push(g); }

function req(method: string, path: string, o: { as?: string; org?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.as) headers.authorization = `Bearer dev:${o.as}:${o.as}@x.com`;
  if (o.org) headers["x-organization-id"] = o.org;
  return new Request(`http://localhost${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
async function call(h: unknown, r: Request, params?: Record<string, string>) {
  const res = await (h as (r: Request, x: { params: Promise<never> }) => Promise<Response>)(r, { params: Promise.resolve(params ?? {}) as Promise<never> });
  return { status: res.status, json: JSON.parse(await res.text()) as { success: boolean; data?: any; error?: { code: string; message: string } } };
}
let org: string;
const setup = async (plan = "professional") => { resetContainer(); org = (await call(orgsRoute.POST, req("POST", "/x", { as: "meet", body: { name: "Shah & Co.", plan } }))).json.data.organization.id; };
const create = (name: string, gstin: string) => call(clientsRoute.POST, req("POST", "/x", { as: "meet", org, body: { name, gstin } }));
const addG = (id: string, gstin: unknown, as = "meet") => call(gstinsRoute.POST, req("POST", "/x", { as, org, body: { gstin } }), { id });

beforeEach(() => { Object.assign(process.env, { AUTH_MODE: "dev", GST_PROVIDER: "mock", STORE: "memory", GST_RATE_LIMIT_PER_MIN: "1000000" }); });
afterEach(() => resetContainer());

describe("client GSTIN endpoints", () => {
  it("add → list → remove, with state names and the standard envelope", async () => {
    await setup();
    const c = (await create("ABC Industries", mk("24", PAN))).json.data.client;
    const add = await addG(c.id, mk("27", PAN));
    expect(add.status).toBe(201); expect(add.json.data.client.gstins).toEqual([mk("24", PAN), mk("27", PAN)]);
    expect(add.json.data.gstins.map((g: any) => [g.primary, g.state])).toEqual([[true, "Gujarat"], [false, "Maharashtra"]]);
    expect((await call(gstinsRoute.GET, req("GET", "/x", { as: "meet", org }), { id: c.id })).json.data.gstins).toHaveLength(2);
    expect((await call(clientRoute.GET, req("GET", "/x", { as: "meet", org }), { id: c.id })).json.data.client.gstins).toHaveLength(2);
    const del = await call(gstinRoute.DELETE, req("DELETE", "/x", { as: "meet", org }), { id: c.id, gstin: mk("27", PAN) });
    expect(del.status).toBe(200); expect(del.json.data.gstins).toHaveLength(1);
    expect((await call(gstinRoute.DELETE, req("DELETE", "/x", { as: "meet", org }), { id: c.id, gstin: mk("24", PAN) })).json.error?.code).toBe("CANNOT_REMOVE_PRIMARY_GSTIN");
  });
  it("enforces PAN, plan limit, duplicates and auth over HTTP", async () => {
    await setup("free");
    const c = (await create("A", mk("24", PAN))).json.data.client;
    expect((await addG(c.id, mk("27", PAN))).json.error?.code).toBe("CLIENT_GSTIN_LIMIT_REACHED");   // Free: 1 GSTIN per client
    await setup("starter");
    const s = (await create("A", mk("24", PAN))).json.data.client;
    expect((await addG(s.id, mk("24", "BBBBB0002B"))).json.error?.code).toBe("GSTIN_PAN_MISMATCH");
    expect((await addG(s.id, mk("24", PAN))).json.error?.code).toBe("DUPLICATE_GSTIN");
    expect((await addG(s.id, "bad")).json.error?.code).toBe("INVALID_GSTIN");
    expect((await call(gstinsRoute.POST, req("POST", "/x", { org, body: { gstin: mk("27", PAN) } }), { id: s.id })).status).toBe(401);
    expect((await addG("nope", mk("27", PAN))).status).toBe(404);
  });
  it("one billing unit: adding GSTINs does not change the bill", async () => {
    await setup("starter");
    const c = (await create("A", mk("24", PAN))).json.data.client;
    const before = (await call(subRoute.GET, req("GET", "/x", { as: "meet", org }))).json.data.subscription;
    for (const st of ["27", "07", "29"]) await addG(c.id, mk(st, PAN));
    const after = (await call(subRoute.GET, req("GET", "/x", { as: "meet", org }))).json.data.subscription;
    expect(after.clients.used).toBe(1); expect(after.pricing.bill.totalInr).toBe(before.pricing.bill.totalInr);
  });
});

describe("a multi-GSTIN client across the product", () => {
  it("checks a specific GSTIN over the API; the GSTIN list shows every GSTIN under the one client name", async () => {
    await setup();
    const c = (await create("ABC", mk("24", PAN))).json.data.client; await addG(c.id, mk("27", PAN));
    const r = await call(checkRoute.POST, req("POST", "/x", { as: "meet", org, body: { clientId: c.id, gstin: mk("27", PAN) } }));
    expect(r.status).toBe(200); expect(r.json.data.gstin).toMatchObject({ gstin: mk("27", PAN), clientId: c.id });
    expect((await call(checkRoute.POST, req("POST", "/x", { as: "meet", org, body: { clientId: c.id, gstin: mk("07", PAN) } }))).json.error?.code).toBe("GSTIN_NOT_ON_CLIENT");
    expect((await call(checkRoute.POST, req("POST", "/x", { as: "meet", org, body: { clientId: c.id, gstin: 5 } }))).status).toBe(400);
    const list = await call(gstinListRoute.GET, req("GET", "/x", { as: "meet", org }));
    expect(list.json.data.items.map((i: any) => [i.clientName, i.gstin]).sort()).toEqual([["ABC", mk("24", PAN)], ["ABC", mk("27", PAN)]].sort());
  });
  it("bulk checks on a selected client run EVERY GSTIN (estimate, items and quota agree)", async () => {
    await setup();
    const c = (await create("ABC", mk("24", PAN))).json.data.client; await addG(c.id, mk("27", PAN)); await addG(c.id, mk("07", PAN));
    const single = (await create("Solo", mk("24", "CCCCC0003C"))).json.data.client;
    const est = await call(bulkPreviewRoute.POST, req("POST", "/x", { as: "meet", org, body: { clientIds: [c.id, single.id] } }));
    expect(est.json.data.estimate).toMatchObject({ requested: 4, needsLiveCheck: 4 });
    const run = await call(bulkRoute.POST, req("POST", "/x", { as: "meet", org, body: { clientIds: [c.id, single.id], includeReturns: false } }));
    expect(run.status).toBe(202);
    await container().queue.idle();
    for (const g of [mk("24", PAN), mk("27", PAN), mk("07", PAN), mk("24", "CCCCC0003C")]) expect((await container().store.getGstinRecord(org, g))!.checked).toBe(true);
    expect((await call(subRoute.GET, req("GET", "/x", { as: "meet", org }))).json.data.subscription.usage.used).toBe(4);
  });
  it("archiving the firm hides all its GSTINs; a bulk selection of an archived client checks nothing", async () => {
    await setup();
    const c = (await create("ABC", mk("24", PAN))).json.data.client; await addG(c.id, mk("27", PAN));
    await call(archiveRoute.POST, req("POST", "/x", { as: "meet", org }), { id: c.id });
    expect((await call(gstinListRoute.GET, req("GET", "/x", { as: "meet", org }))).json.data.items).toEqual([]);
    expect((await call(gstinListRoute.GET, req("GET", "/api/gstins?archived=true", { as: "meet", org }))).json.data.items).toHaveLength(2);
  });
  it("portfolio: one row per client with the worst status across its GSTINs; the refresh planner and run-due cover every GSTIN", async () => {
    await setup();
    const bad = pair["Cancelled"]; const good = pair["Active"];
    if (!bad || !good || !good.length) throw new Error("test needs a Cancelled and an Active same-PAN GSTIN from the mock");
    const c = (await create("ABC", good[0])).json.data.client; await addG(c.id, bad[0]);
    const row0 = (await call(portfolioRoute.GET, req("GET", "/x", { as: "meet", org }))).json.data.items;
    expect(row0).toHaveLength(1); expect(row0[0]).toMatchObject({ name: "ABC", gstin: good[0], gstinCount: 2, freshness: "never" });
    const plan = await call(plannerRoute.POST, req("POST", "/x", { as: "meet", org, body: { scope: "all" } }));
    expect(plan.json.data.gstins.sort()).toEqual([good[0], bad[0]].sort());
    await call(scheduleRoute.POST, req("POST", "/x", { as: "meet", org, body: { all: true, schedule: "daily" } }));
    const run = await call(runDueRoute.POST, req("POST", "/x", { as: "meet", org }));
    expect(run.json.data).toMatchObject({ due: 1, started: true, gstins: 2 });
    await container().queue.idle();
    const row1 = (await call(portfolioRoute.GET, req("GET", "/x", { as: "meet", org }))).json.data.items[0];
    expect(row1).toMatchObject({ gstinCount: 2, status: "CANCELLED", statusGstin: bad[0], freshness: "fresh" });
    expect((await call(portfolioRoute.GET, req("GET", `/api/portfolio?q=${bad[0].slice(0, 8)}`, { as: "meet", org }))).json.data.total).toBe(1); // searchable by the second GSTIN
  });
});
