/* eslint-disable @typescript-eslint/no-explicit-any -- test helper reads loosely-typed JSON envelopes */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { container, resetContainer } from "@/server/container";
import { computeGstinChecksum } from "@/lib/gstin";
import * as orgsRoute from "@/app/api/organizations/route";
import * as membersRoute from "@/app/api/members/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import * as clientsRoute from "@/app/api/clients/route";
import * as verifyRoute from "@/app/api/verify/route";
import * as portfolioRoute from "@/app/api/portfolio/route";
import * as gstinsRoute from "@/app/api/portfolio/gstins/route";
import * as scheduleRoute from "@/app/api/portfolio/schedule/route";
import * as runDueRoute from "@/app/api/portfolio/run-due/route";
import * as cronRoute from "@/app/api/internal/portfolio-due/route";
import * as bulkVerifyRoute from "@/app/api/bulk-verify/route";
import * as bulkPreviewRoute from "@/app/api/bulk-verify/preview/route";

const gst = (n: number) => { const b = `24AAAAA${String(n).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };

function req(method: string, path: string, o: { as?: string; org?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...o.headers };
  if (o.as) headers.authorization = `Bearer dev:${o.as}:${o.as}@x.com`;
  if (o.org) headers["x-organization-id"] = o.org;
  return new Request(`http://localhost${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
async function call(h: unknown, r: Request) {
  const res = await (h as (r: Request, x: { params: Promise<never> }) => Promise<Response>)(r, { params: Promise.resolve({}) as Promise<never> });
  return { status: res.status, json: JSON.parse(await res.text()) as { success: boolean; data?: any; error?: { code: string } } };
}
let org: string;
async function setup(plan = "professional", members = true) {
  resetContainer();
  const o = await call(orgsRoute.POST, req("POST", "/x", { as: "meet", body: { name: "Shah & Co.", plan } }));
  org = o.json.data.organization.id;
  if (members) for (const [uid, role] of [["priya", "ACCOUNTANT"], ["vik", "VIEWER"]]) {
    const inv = await call(membersRoute.POST, req("POST", "/x", { as: "meet", org, body: { email: `${uid}@x.com`, role } }));
    await call(acceptRoute.POST, req("POST", "/x", { as: uid, body: { token: inv.json.data.token } }));
  }
}
const addClient = (n: number, as = "priya") => call(clientsRoute.POST, req("POST", "/x", { as, org, body: { name: `Client ${n}`, gstin: gst(n) } }));
const get = (as: string, qs = "") => call(portfolioRoute.GET, req("GET", `/api/portfolio${qs}`, { as, org }));

beforeEach(() => { Object.assign(process.env, { AUTH_MODE: "dev", GST_PROVIDER: "mock", STORE: "memory", GST_RATE_LIMIT_PER_MIN: "1000000" }); delete process.env.CRON_SECRET; });
afterEach(() => { delete process.env.CRON_SECRET; resetContainer(); });

describe("GET /api/portfolio", () => {
  it("lists clients with status, freshness and a portfolio summary; viewers can read", async () => {
    await setup(); for (const n of [1, 2, 3]) expect((await addClient(n)).status).toBe(201);
    await call(verifyRoute.POST, req("POST", "/x", { as: "priya", org, body: { gstin: gst(1) } }));
    const r = await get("vik");
    expect(r.status).toBe(200);
    expect(r.json.data.total).toBe(3); expect(r.json.data.summary).toMatchObject({ total: 3, needsRefresh: 2, byFreshness: { fresh: 1, never: 2, stale: 0, expired: 0 } });
    expect(r.json.data.items[0]).toMatchObject({ name: "Client 1", gstin: gst(1), freshness: "fresh", statusSource: "verification" });
    expect(r.json.data.items.find((i: any) => i.name === "Client 3")).toMatchObject({ status: null, freshness: "never" });
  });
  it("filters and paginates through query parameters; bad values are ignored, not trusted", async () => {
    await setup(); for (const n of [1, 2, 3, 4]) await addClient(n);
    await call(verifyRoute.POST, req("POST", "/x", { as: "priya", org, body: { gstin: gst(2) } }));
    expect((await get("meet", "?freshness=never")).json.data.total).toBe(3);
    expect((await get("meet", "?needsRefresh=1&limit=2")).json.data).toMatchObject({ total: 3, nextCursor: "2" });
    expect((await get("meet", "?q=client%203")).json.data.items.map((i: any) => i.name)).toEqual(["Client 3"]);
    expect((await get("meet", "?status=bogus&freshness=bogus&sort=bogus")).json.data.total).toBe(4);
    expect((await get("meet", "?cursor=zzz")).status).toBe(400);
  });
  it("requires authentication and an organization; other organizations' clients never appear", async () => {
    await setup(); await addClient(1);
    expect((await call(portfolioRoute.GET, req("GET", "/api/portfolio", { org }))).status).toBe(401);
    const o2 = await call(orgsRoute.POST, req("POST", "/x", { as: "zed", body: { name: "Zed" } }));
    const r = await call(portfolioRoute.GET, req("GET", "/api/portfolio", { as: "zed", org: o2.json.data.organization.id }));
    expect(r.json.data.total).toBe(0);
  });
});

describe("refresh through the existing bulk-verification job", () => {
  it("gstins → preview → start: the CA sees 'N fresh, M need verification' and one background job does the work", async () => {
    await setup(); for (let n = 1; n <= 6; n++) await addClient(n);
    for (const n of [1, 2, 3, 4]) await call(verifyRoute.POST, req("POST", "/x", { as: "priya", org, body: { gstin: gst(n) } }));
    const g = await call(gstinsRoute.POST, req("POST", "/x", { as: "priya", org, body: { scope: "all" } }));
    expect(g.json.data.count).toBe(6);
    const prev = await call(bulkPreviewRoute.POST, req("POST", "/x", { as: "priya", org, body: { gstins: g.json.data.gstins } }));
    expect(prev.json.data.preview).toMatchObject({ valid: 6, servedFromCache: 4, needsLiveCheck: 2, providerRequests: 2 });
    const need = await call(gstinsRoute.POST, req("POST", "/x", { as: "priya", org, body: { scope: "needs_refresh" } }));
    expect(need.json.data.gstins.sort()).toEqual([gst(5), gst(6)]);
    const start = await call(bulkVerifyRoute.POST, req("POST", "/x", { as: "priya", org, body: { gstins: need.json.data.gstins } }));
    expect(start.status).toBe(202);
    await container().queue.idle();
    const after = await get("priya");
    expect(after.json.data.summary).toMatchObject({ needsRefresh: 0, byFreshness: { fresh: 6, never: 0, stale: 0, expired: 0 } });
  });
  it("viewers cannot plan a refresh; foreign client ids match nothing", async () => {
    await setup(); await addClient(1);
    expect((await call(gstinsRoute.POST, req("POST", "/x", { as: "vik", org, body: { scope: "all" } }))).status).toBe(403);
    const r = await call(gstinsRoute.POST, req("POST", "/x", { as: "priya", org, body: { scope: "selected", clientIds: ["nope"] } }));
    expect(r.json.data.count).toBe(0);
  });
});

describe("scheduling", () => {
  it("set → shown in the portfolio → run now → advanced; clear", async () => {
    await setup(); for (const n of [1, 2]) await addClient(n);
    const s = await call(scheduleRoute.POST, req("POST", "/x", { as: "priya", org, body: { all: true, schedule: "daily" } }));
    expect(s.json.data).toEqual({ updated: 2, schedule: "daily" });
    expect((await get("priya")).json.data.summary).toMatchObject({ scheduled: 2, due: 2 });
    const run = await call(runDueRoute.POST, req("POST", "/x", { as: "priya", org }));
    expect(run.status).toBe(202); expect(run.json.data).toMatchObject({ due: 2, started: true });
    await container().queue.idle();
    expect((await get("priya")).json.data.summary).toMatchObject({ scheduled: 2, due: 0, byFreshness: { fresh: 2 } });
    expect((await call(runDueRoute.POST, req("POST", "/x", { as: "priya", org }))).json.data).toEqual({ due: 0, started: false });
    expect((await call(scheduleRoute.POST, req("POST", "/x", { as: "priya", org, body: { all: true, schedule: null } }))).json.data.updated).toBe(2);
  });
  it("is gated by role, plan and input", async () => {
    await setup(); await addClient(1);
    expect((await call(scheduleRoute.POST, req("POST", "/x", { as: "vik", org, body: { all: true, schedule: "daily" } }))).status).toBe(403);
    expect((await call(scheduleRoute.POST, req("POST", "/x", { as: "priya", org, body: { all: true, schedule: "hourly" } }))).status).toBe(400);
    await setup("starter", false); await addClient(1, "meet");
    const r = await call(scheduleRoute.POST, req("POST", "/x", { as: "meet", org, body: { all: true, schedule: "daily" } }));
    expect(r.status).toBe(403); expect(r.json.error?.code).toBe("FEATURE_NOT_AVAILABLE");
  });
});

describe("POST /api/internal/portfolio-due (scheduler entry point)", () => {
  const cron = (token?: string) => call(cronRoute.POST, req("POST", "/x", { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  it("does not exist (404) unless CRON_SECRET is configured, and never accepts a wrong secret", async () => {
    await setup(); expect((await cron("anything")).status).toBe(404); expect((await cron()).status).toBe(404);
    process.env.CRON_SECRET = "s3cret-value";
    expect((await cron()).status).toBe(404); expect((await cron("wrong")).status).toBe(404); expect((await cron("s3cret-value-extra")).status).toBe(404);
    // a user token is not the secret
    expect((await call(cronRoute.POST, req("POST", "/x", { as: "meet" }))).status).toBe(404);
  });
  it("with the secret it runs every organization's due clients as background jobs", async () => {
    await setup(); for (const n of [1, 2]) await addClient(n);
    await call(scheduleRoute.POST, req("POST", "/x", { as: "priya", org, body: { all: true, schedule: "daily" } }));
    process.env.CRON_SECRET = "s3cret-value";
    const r = await cron("s3cret-value");
    expect(r.status).toBe(200); expect(r.json.data.results).toEqual([{ orgId: org, due: 2, started: true, jobId: expect.any(String) }]);
    await container().queue.idle();
    expect((await cron("s3cret-value")).json.data.results).toEqual([]);
  });
});
