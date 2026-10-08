/* eslint-disable @typescript-eslint/no-explicit-any -- test helper reads loosely-typed JSON envelopes */
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { container, resetContainer } from "@/server/container";
import { computeGstinChecksum } from "@/lib/gstin";
import { currentMonthKey } from "@/lib/dates";
import * as orgsRoute from "@/app/api/organizations/route";
import * as clientsRoute from "@/app/api/clients/route";
import * as membersRoute from "@/app/api/members/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import * as checkRoute from "@/app/api/gst/check/route";
import * as usageRoute from "@/app/api/usage/route";
import * as dashRoute from "@/app/api/dashboard/route";
import * as gstinsRoute from "@/app/api/gstins/route";
import * as gstinRoute from "@/app/api/gstins/[gstin]/route";
import * as gstinStatusRoute from "@/app/api/gstins/[gstin]/status/route";
import * as gstinReturnsRoute from "@/app/api/gstins/[gstin]/returns/route";
import * as gstr1Route from "@/app/api/returns/gstr1/route";
import * as gstr3bRoute from "@/app/api/returns/gstr3b/route";
import * as bulkRoute from "@/app/api/bulk-checks/route";
import * as bulkPreviewRoute from "@/app/api/bulk-checks/preview/route";
import * as bulkJobRoute from "@/app/api/bulk-checks/[id]/route";
import * as bulkItemsRoute from "@/app/api/bulk-checks/[id]/items/route";
import * as bulkCancelRoute from "@/app/api/bulk-checks/[id]/cancel/route";
import * as bulkRetryRoute from "@/app/api/bulk-checks/[id]/retry-failed/route";
import * as bulkResumeRoute from "@/app/api/bulk-checks/[id]/resume/route";

const gst = (n: number) => { const b = `24AAAAA${String(n).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };

interface Opt { as?: string; org?: string; body?: unknown; key?: string }
function req(method: string, path: string, o: Opt = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.as) headers.authorization = `Bearer dev:${o.as}:${o.as}@x.com`;
  if (o.org) headers["x-organization-id"] = o.org;
  if (o.key) headers["idempotency-key"] = o.key;
  return new Request(`http://localhost${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
async function call(h: unknown, r: Request, params?: Record<string, string>) {
  const res = await (h as (r: Request, x: { params: Promise<never> }) => Promise<Response>)(r, { params: Promise.resolve(params ?? {}) as Promise<never> });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { success: boolean; data?: any; error?: { code: string; message: string } } };
}

let orgA: string, orgB: string;
async function makeOrg(uid: string, name: string, plan?: string) {
  const r = await call(orgsRoute.POST, req("POST", "/api/organizations", { as: uid, body: { name, plan } }));
  expect(r.status).toBe(201);
  return r.json.data.organization.id as string;
}
async function addMember(owner: string, org: string, uid: string, role: string) {
  const inv = await call(membersRoute.POST, req("POST", "/x", { as: owner, org, body: { email: `${uid}@x.com`, role } }));
  const acc = await call(acceptRoute.POST, req("POST", "/x", { as: uid, body: { token: inv.json.data.token } }));
  expect(acc.status).toBe(200);
}
async function addClients(as: string, org: string, n: number, start = 1) {
  const ids: string[] = [];
  for (let i = start; i < start + n; i++) {
    const r = await call(clientsRoute.POST, req("POST", "/x", { as, org, body: { name: `Client ${i}`, gstin: gst(i) } }));
    expect(r.status).toBe(201);
    ids.push(r.json.data.client.id);
  }
  return ids;
}
const settle = () => container().queue.idle();

beforeAll(() => {
  Object.assign(process.env, { AUTH_MODE: "dev", GST_PROVIDER: "mock", STORE: "memory", GST_RATE_LIMIT_PER_MIN: "1000000", GST_MAX_CONCURRENT: "5" });
});
beforeEach(async () => {
  resetContainer();
  orgA = await makeOrg("meet", "Shah & Co.", "firm");
  orgB = await makeOrg("zed", "Zed Tax", "firm");
  await addMember("meet", orgA, "priya", "ACCOUNTANT");
  await addMember("meet", orgA, "vik", "VIEWER");
});

describe("GSTIN & returns endpoints", () => {
  it("list/detail/status/returns work end-to-end and use the standard envelope", async () => {
    const ids = await addClients("priya", orgA, 6);
    for (const id of ids.slice(0, 3)) expect((await call(checkRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { clientId: id } }))).status).toBe(200);

    const list = await call(gstinsRoute.GET, req("GET", "/api/gstins?limit=4&sort=gstin", { as: "vik", org: orgA }));
    expect(list.json.success).toBe(true);
    expect(list.json.data.items).toHaveLength(4);
    expect(list.json.data.nextCursor).toBeTruthy();
    const page2 = await call(gstinsRoute.GET, req("GET", `/api/gstins?limit=4&cursor=${list.json.data.nextCursor}`, { as: "vik", org: orgA }));
    expect(page2.json.data.items).toHaveLength(2);
    expect(page2.json.data.nextCursor).toBeUndefined();

    expect((await call(gstinsRoute.GET, req("GET", "/api/gstins?checked=true", { as: "meet", org: orgA }))).json.data.items).toHaveLength(3);
    expect((await call(gstinsRoute.GET, req("GET", "/api/gstins?checked=false", { as: "meet", org: orgA }))).json.data.items).toHaveLength(3);
    expect((await call(gstinsRoute.GET, req("GET", "/api/gstins?q=client%202", { as: "meet", org: orgA }))).json.data.items.map((i: any) => i.clientName)).toEqual(["Client 2"]);
    expect((await call(gstinsRoute.GET, req("GET", "/api/gstins?status=bogus", { as: "meet", org: orgA }))).json.error!.code).toBe("VALIDATION_ERROR");

    const g = gst(1);
    const detail = await call(gstinRoute.GET, req("GET", "/x", { as: "vik", org: orgA }), { gstin: g });
    expect(detail.json.data.gstin).toMatchObject({ gstin: g, fresh: true, source: "mock" });
    expect(detail.json.data.client.name).toBe("Client 1");
    const status = await call(gstinStatusRoute.GET, req("GET", "/x", { as: "vik", org: orgA }), { gstin: g });
    expect(status.json.data).toMatchObject({ gstin: g, neverChecked: false, fresh: true });
    const never = await call(gstinStatusRoute.GET, req("GET", "/x", { as: "vik", org: orgA }), { gstin: gst(6) });
    expect(never.json.data).toMatchObject({ status: "Unknown", neverChecked: true });

    const rets = await call(gstinReturnsRoute.GET, req("GET", "/api/x?returnType=GSTR1&limit=3", { as: "vik", org: orgA }), { gstin: g });
    expect(rets.status).toBe(200);
    expect(rets.json.data.items.length).toBeGreaterThan(0);
    expect(rets.json.data.items.every((r: any) => r.returnType === "GSTR1" && r.gstin === g && r.source === "mock" && r.dueDate && r.retrievedAt)).toBe(true);
    const g1 = await call(gstr1Route.GET, req("GET", "/api/returns/gstr1?limit=100", { as: "vik", org: orgA }));
    const g3 = await call(gstr3bRoute.GET, req("GET", "/api/returns/gstr3b?limit=100", { as: "vik", org: orgA }));
    expect(g1.json.data.items.every((r: any) => r.returnType === "GSTR1")).toBe(true);
    expect(g3.json.data.items.every((r: any) => r.returnType === "GSTR3B")).toBe(true);
    expect(g1.json.data.items[0].clientName).toMatch(/^Client /);
    expect(list.text + detail.text + rets.text).not.toContain("providerRequestId");
  });
  it("tenant isolation: org B (and forged headers) cannot reach org A GSTINs, returns or dashboard", async () => {
    const ids = await addClients("meet", orgA, 3);
    await call(checkRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { clientId: ids[0] } }));
    const g = gst(1);
    for (const [h, p] of [[gstinRoute.GET, { gstin: g }], [gstinStatusRoute.GET, { gstin: g }], [gstinReturnsRoute.GET, { gstin: g }]] as const) {
      const own = await call(h, req("GET", "/x", { as: "zed", org: orgB }), p);
      expect(own.status).toBe(404); expect(own.json.error!.code).toBe("GSTIN_NOT_FOUND");
      const forged = await call(h, req("GET", "/x", { as: "zed", org: orgA }), p);
      expect(forged.status).toBe(403); expect(forged.json.error!.code).toBe("NOT_A_MEMBER");
    }
    for (const h of [gstinsRoute.GET, gstr1Route.GET, gstr3bRoute.GET, dashRoute.GET]) {
      expect((await call(h, req("GET", "/x", { as: "zed", org: orgA }))).status).toBe(403);
    }
    expect((await call(gstinsRoute.GET, req("GET", "/x", { as: "zed", org: orgB }))).json.data.items).toEqual([]);
    expect((await call(gstr1Route.GET, req("GET", "/x", { as: "zed", org: orgB }))).json.data.items).toEqual([]);
    const dz = (await call(dashRoute.GET, req("GET", "/x", { as: "zed", org: orgB }))).json.data.dashboard;
    expect(dz.gstins.total).toBe(0); expect(dz.clients.total).toBe(0);
    expect((await call(dashRoute.GET, req("GET", "/x", { as: "meet", org: orgA }))).json.data.dashboard.gstins.total).toBe(3);
  });
  it("unauthenticated requests get 401 on every new read endpoint", async () => {
    for (const h of [gstinsRoute.GET, gstr1Route.GET, gstr3bRoute.GET, dashRoute.GET, bulkRoute.GET]) {
      const r = await call(h, req("GET", "/x"));
      expect(r.status).toBe(401); expect(r.json.error!.code).toBe("UNAUTHENTICATED");
    }
    expect((await call(gstinRoute.GET, req("GET", "/x"), { gstin: gst(1) })).status).toBe(401);
  });
});

describe("dashboard endpoint", () => {
  it("returns plan, quota (used/reserved/remaining) and compliance counts from stored data, for every role", async () => {
    const ids = await addClients("meet", orgA, 5);
    await call(bulkRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { clientIds: ids }, key: "dash-key-0001" }));
    const mid = (await call(dashRoute.GET, req("GET", "/x", { as: "vik", org: orgA }))).json.data.dashboard;
    expect(mid.quota).toMatchObject({ used: 0, reserved: 5, remaining: 1995, limit: 2000 });   // job queued, units held
    await settle();
    for (const who of ["meet", "priya", "vik"]) {
      const r = await call(dashRoute.GET, req("GET", "/x", { as: who, org: orgA }));
      expect(r.status).toBe(200);
      const d = r.json.data.dashboard;
      expect(d.quota).toMatchObject({ used: 5, reserved: 0, remaining: 1995 });
      expect(d.subscription).toMatchObject({ plan: "firm", status: "trialing" });
      expect(d.gstins.total).toBe(5);
      expect(d.gstins.neverChecked).toBe(0);
      expect(d.recentChecks.length).toBe(5);
      expect(d.gstins.active + d.gstins.suspended + d.gstins.cancelled + d.gstins.inactive + d.gstins.unknown).toBe(5);
    }
    expect((await call(dashRoute.GET, req("GET", "/x", { as: "vik", org: orgA }))).json.data.dashboard.recentActivity).toEqual([]);
    expect((await call(dashRoute.GET, req("GET", "/x", { as: "meet", org: orgA }))).json.data.dashboard.recentActivity.length).toBeGreaterThan(0);
  });
});

describe("bulk-check endpoints", () => {
  it("preview → create (202) → idempotent replay (200) → completion → items; quota is exact", async () => {
    const ids = await addClients("priya", orgA, 12);
    const pre = await call(bulkPreviewRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { clientIds: ids } }));
    expect(pre.json.data.estimate).toMatchObject({ requested: 12, needsLiveCheck: 12, servedFromCache: 0, quota: { remaining: 2000, afterRemaining: 1988, sufficient: true }, providerRequests: 24 });
    expect((await call(usageRoute.GET, req("GET", "/x", { as: "priya", org: orgA }))).json.data.usage.used).toBe(0);

    const a = await call(bulkRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { clientIds: ids }, key: "bulk-key-0001" }));
    expect(a.status).toBe(202);
    expect(a.json.data.replay).toBe(false);
    expect(a.json.data.job).toMatchObject({ status: "queued", total: 12, quota: { requested: 12, reserved: 12 } });
    expect(a.json.data.job).not.toHaveProperty("fingerprint");
    const b = await call(bulkRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { clientIds: ids }, key: "bulk-key-0001" }));
    expect(b.status).toBe(200); expect(b.json.data.replay).toBe(true); expect(b.json.data.job.id).toBe(a.json.data.job.id);
    const reuse = await call(bulkRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { clientIds: ids.slice(1) }, key: "bulk-key-0001" }));
    expect(reuse.status).toBe(422); expect(reuse.json.error!.code).toBe("IDEMPOTENCY_KEY_REUSED");

    await settle();
    const id = a.json.data.job.id;
    const job = (await call(bulkJobRoute.GET, req("GET", "/x", { as: "vik", org: orgA }), { id })).json.data.job;
    expect(job).toMatchObject({ status: "completed", counts: { succeeded: 12, failed: 0, queued: 0, processing: 0 }, quota: { consumed: 12, released: 0 }, progress: { percent: 100 } });
    expect((await call(usageRoute.GET, req("GET", "/x", { as: "meet", org: orgA }))).json.data.usage).toMatchObject({ used: 12, reserved: 0, remaining: 1988 });
    const items = await call(bulkItemsRoute.GET, req("GET", "/api/x?limit=5", { as: "vik", org: orgA }), { id });
    expect(items.json.data.items).toHaveLength(5); expect(items.json.data.nextCursor).toBeTruthy();
    expect(items.json.data.items[0]).toMatchObject({ status: "succeeded" });
    expect(items.text).not.toMatch(/providerRequestId|stack|apikey/i);
    const listed = await call(bulkRoute.GET, req("GET", "/x", { as: "vik", org: orgA }));
    expect(listed.json.data.jobs).toHaveLength(1);
  });
  it("RBAC: viewer can read jobs but cannot preview, start, cancel, retry or resume", async () => {
    const ids = await addClients("meet", orgA, 3);
    const { json } = await call(bulkRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { clientIds: ids }, key: "rbac-key-0001" }));
    const id = json.data.job.id;
    expect((await call(bulkJobRoute.GET, req("GET", "/x", { as: "vik", org: orgA }), { id })).status).toBe(200);
    expect((await call(bulkPreviewRoute.POST, req("POST", "/x", { as: "vik", org: orgA, body: { clientIds: ids } }))).status).toBe(403);
    expect((await call(bulkRoute.POST, req("POST", "/x", { as: "vik", org: orgA, body: { clientIds: ids } }))).status).toBe(403);
    for (const h of [bulkCancelRoute.POST, bulkRetryRoute.POST, bulkResumeRoute.POST]) {
      const r = await call(h, req("POST", "/x", { as: "vik", org: orgA }), { id });
      expect(r.status).toBe(403); expect(r.json.error!.code).toBe("FORBIDDEN");
    }
    await settle();
  });
  it("tenant isolation: org B cannot read or control org A's job; counts are not client-writable", async () => {
    const ids = await addClients("meet", orgA, 4);
    const { json } = await call(bulkRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { clientIds: ids }, key: "iso-key-00001" }));
    const id = json.data.job.id;
    for (const [h, m] of [[bulkJobRoute.GET, "GET"], [bulkItemsRoute.GET, "GET"], [bulkCancelRoute.POST, "POST"], [bulkRetryRoute.POST, "POST"], [bulkResumeRoute.POST, "POST"]] as const) {
      const own = await call(h, req(m, "/x", { as: "zed", org: orgB }), { id });
      expect(own.status).toBe(404); expect(own.json.error!.code).toBe("JOB_NOT_FOUND");
      const forged = await call(h, req(m, "/x", { as: "zed", org: orgA }), { id });
      expect(forged.status).toBe(403); expect(forged.json.error!.code).toBe("NOT_A_MEMBER");
    }
    expect((await call(bulkRoute.GET, req("GET", "/x", { as: "zed", org: orgB }))).json.data.jobs).toEqual([]);
    expect((bulkJobRoute as Record<string, unknown>).PATCH).toBeUndefined();
    expect((bulkJobRoute as Record<string, unknown>).PUT).toBeUndefined();
    expect((bulkJobRoute as Record<string, unknown>).DELETE).toBeUndefined();
    await settle();
    expect((await call(bulkJobRoute.GET, req("GET", "/x", { as: "meet", org: orgA }), { id })).json.data.job.status).toBe("completed");
  });
  it("cancel releases held quota; accountant may cancel", async () => {
    const ids = await addClients("meet", orgA, 8);
    const { json } = await call(bulkRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { clientIds: ids }, key: "cancel-key-001" }));
    const id = json.data.job.id;
    const c = await call(bulkCancelRoute.POST, req("POST", "/x", { as: "priya", org: orgA }), { id });
    expect(c.status).toBe(200);
    expect(c.json.data.job).toMatchObject({ status: "cancelled", counts: { cancelled: 8, queued: 0 }, quota: { released: 8 } });
    await settle();
    expect((await call(usageRoute.GET, req("GET", "/x", { as: "meet", org: orgA }))).json.data.usage).toMatchObject({ used: 0, reserved: 0 });
  });
  it("frontend cannot bypass quota or inject accounting fields; exhausted quota ⇒ 402 and nothing is held", async () => {
    const ids = await addClients("meet", orgA, 20);
    await container().store.usage.reserve(orgA, currentMonthKey(), "firm", 2000, 1990);
    const r = await call(bulkRoute.POST, req("POST", "/x", {
      as: "meet", org: orgA, key: "quota-key-001",
      body: { clientIds: ids, plan: "enterprise", limit: 999999, used: 0, reserved: 0, quota: { reserved: 0 }, organizationId: orgB, allowPartial: false },
    }));
    expect(r.status).toBe(402); expect(r.json.error!.code).toBe("QUOTA_EXHAUSTED");
    expect((await call(usageRoute.GET, req("GET", "/x", { as: "meet", org: orgA }))).json.data.usage).toMatchObject({ used: 1990, reserved: 0, remaining: 10 });
    expect((await call(bulkRoute.GET, req("GET", "/x", { as: "meet", org: orgA }))).json.data.jobs).toEqual([]);
    expect((await call(bulkRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { clientIds: ids.slice(0, 10) }, key: "quota-key-002" }))).status).toBe(202);
    await settle();
  });
  it("validation and plan gating return structured errors (no internals)", async () => {
    const bad = await call(bulkRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { clientIds: ["a"], mode: "all" } }));
    expect(bad.status).toBe(400); expect(bad.json.error!.code).toBe("VALIDATION_ERROR");
    expect((await call(bulkRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { clientIds: ["nope"] } }))).json.error!.code).toBe("NO_CLIENTS");
    expect((await call(bulkRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { mode: "all" }, key: "short" }))).json.error!.code).toBe("VALIDATION_ERROR");
    const freeOrg = await makeOrg("fran", "Free Firm");
    const fids = await addClients("fran", freeOrg, 3, 500);
    const gated = await call(bulkRoute.POST, req("POST", "/x", { as: "fran", org: freeOrg, body: { clientIds: fids } }));
    expect(gated.status).toBe(403); expect(gated.json.error!.code).toBe("FEATURE_NOT_AVAILABLE");
    expect(gated.text).not.toMatch(/at\s.*\(|node_modules/);
  });
  it("mode selection works over HTTP (all clients)", async () => {
    await addClients("meet", orgA, 7);
    const r = await call(bulkRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { mode: "all", includeReturns: false }, key: "mode-key-0001" }));
    expect(r.status).toBe(202); expect(r.json.data.job.total).toBe(7);
    await settle();
    expect((await call(dashRoute.GET, req("GET", "/x", { as: "meet", org: orgA }))).json.data.dashboard.gstins.neverChecked).toBe(0);
  });
});
