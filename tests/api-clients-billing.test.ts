/* eslint-disable @typescript-eslint/no-explicit-any -- test helper reads loosely-typed JSON envelopes */
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { resetContainer } from "@/server/container";
import { computeGstinChecksum } from "@/lib/gstin";
import * as orgsRoute from "@/app/api/organizations/route";
import * as clientsRoute from "@/app/api/clients/route";
import * as archiveRoute from "@/app/api/clients/[id]/archive/route";
import * as restoreRoute from "@/app/api/clients/[id]/restore/route";
import * as subRoute from "@/app/api/subscription/route";
import * as gstinsRoute from "@/app/api/gstins/route";
import * as checkRoute from "@/app/api/gst/check/route";

const gst = (n: number) => { const b = `24AAAAA${String(n).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };
function req(method: string, path: string, o: { as?: string; org?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.as) headers.authorization = `Bearer dev:${o.as}:${o.as}@x.com`;
  if (o.org) headers["x-organization-id"] = o.org;
  return new Request(`http://localhost${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
async function call(h: unknown, r: Request, params?: Record<string, string>) {
  const res = await (h as (r: Request, x: { params: Promise<never> }) => Promise<Response>)(r, { params: Promise.resolve(params ?? {}) as Promise<never> });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as { success: boolean; data?: any; error?: { code: string; message: string } } };
}
async function makeOrg(uid: string, name: string, plan: string) {
  const r = await call(orgsRoute.POST, req("POST", "/x", { as: uid, body: { name, plan } })); expect(r.status).toBe(201); return r.json.data.organization.id as string;
}

let org: string, free: string, other: string;
const mk = async (as: string, o: string, n: number, start = 1) => { const ids: string[] = []; for (let i = 0; i < n; i++) { const r = await call(clientsRoute.POST, req("POST", "/x", { as, org: o, body: { name: `C${start + i}`, gstin: gst(start + i) } })); expect(r.status).toBe(201); ids.push(r.json.data.client.id); } return ids; };
const sub = async (as: string, o: string) => (await call(subRoute.GET, req("GET", "/x", { as, org: o }))).json.data.subscription;

beforeAll(() => { Object.assign(process.env, { AUTH_MODE: "dev", GST_PROVIDER: "mock", STORE: "memory", GST_RATE_LIMIT_PER_MIN: "1000000" }); });
beforeEach(async () => {
  resetContainer();
  org = await makeOrg("meet", "Shah & Co.", "starter"); free = await makeOrg("fran", "Free Firm", "free"); other = await makeOrg("zed", "Zed", "starter");
});

describe("archive / restore over HTTP", () => {
  it("archive removes the client from the default list and the bill; restore brings it back; both are idempotent", async () => {
    const [a, b] = await mk("meet", org, 2);
    const arch = await call(archiveRoute.POST, req("POST", "/x", { as: "meet", org }), { id: a });
    expect(arch.status).toBe(200); expect(arch.json.data.client.status).toBe("archived");
    expect((await call(archiveRoute.POST, req("POST", "/x", { as: "meet", org }), { id: a })).status).toBe(200);
    const list = await call(clientsRoute.GET, req("GET", "/api/clients", { as: "meet", org }));
    expect(list.json.data.items.map((c: any) => c.id)).toEqual([b]);
    expect((await call(clientsRoute.GET, req("GET", "/api/clients?status=archived", { as: "meet", org }))).json.data.items.map((c: any) => c.id)).toEqual([a]);
    expect((await call(clientsRoute.GET, req("GET", "/api/clients?status=all", { as: "meet", org }))).json.data.items).toHaveLength(2);
    const g = await call(gstinsRoute.GET, req("GET", "/api/gstins", { as: "meet", org }));
    expect(g.json.data.items.map((i: any) => i.clientId)).toEqual([b]);
    expect((await call(gstinsRoute.GET, req("GET", "/api/gstins?archived=true", { as: "meet", org }))).json.data.items.map((i: any) => i.clientId)).toEqual([a]);
    expect((await sub("meet", org)).clients).toMatchObject({ used: 1, archived: 1 });
    expect((await call(restoreRoute.POST, req("POST", "/x", { as: "meet", org }), { id: a })).json.data.client.status).toBe("active");
    expect((await sub("meet", org)).clients).toMatchObject({ used: 2, archived: 0 });
  });
  it("an archived client cannot be checked over the API", async () => {
    const [a] = await mk("meet", org, 1);
    await call(archiveRoute.POST, req("POST", "/x", { as: "meet", org }), { id: a });
    const r = await call(checkRoute.POST, req("POST", "/x", { as: "meet", org, body: { clientId: a } }));
    expect(r.status).toBe(409); expect(r.json.error?.code).toBe("CLIENT_ARCHIVED");
  });
  it("cannot touch another organization's client; unknown ids are 404", async () => {
    const [z] = await mk("zed", other, 1, 60);
    expect((await call(archiveRoute.POST, req("POST", "/x", { as: "meet", org }), { id: z })).json.error?.code).toBe("CLIENT_NOT_FOUND");
    expect((await call(restoreRoute.POST, req("POST", "/x", { as: "meet", org }), { id: "nope" })).status).toBe(404);
    expect((await call(archiveRoute.POST, req("POST", "/x", { org }), { id: z })).status).toBe(401);
  });
  it("Free: the cap counts active clients only, and the API says so", async () => {
    const ids = await mk("fran", free, 5);
    const over = await call(clientsRoute.POST, req("POST", "/x", { as: "fran", org: free, body: { name: "x", gstin: gst(9) } }));
    expect(over.status).toBe(402); expect(over.json.error?.code).toBe("CLIENT_LIMIT_REACHED"); expect(over.json.error?.message).toMatch(/active clients/);
    await call(archiveRoute.POST, req("POST", "/x", { as: "fran", org: free }), { id: ids[0] });
    expect((await call(clientsRoute.POST, req("POST", "/x", { as: "fran", org: free, body: { name: "x", gstin: gst(9) } }))).status).toBe(201);
    expect((await call(restoreRoute.POST, req("POST", "/x", { as: "fran", org: free }), { id: ids[0] })).json.error?.code).toBe("CLIENT_LIMIT_REACHED");
  });
});

describe("GET /api/subscription — pricing", () => {
  it("returns the bill, the next-client preview and the included/active/archived counts", async () => {
    await mk("meet", org, 27);                                         // Starter: 25 included
    const s = await sub("meet", org);
    expect(s.clients).toMatchObject({ used: 27, included: 25, archived: 0 });
    expect(s.pricing).toMatchObject({ period: "monthly", bill: { planId: "starter", totalInr: 499 + 2 * 18, extraClients: 2 }, nextClient: { deltaInr: 18, blocked: false } });
  });
  it("extra clients are billed, not blocked, on a paid plan", async () => {
    await mk("meet", org, 26);
    const r = await call(clientsRoute.POST, req("POST", "/x", { as: "meet", org, body: { name: "x", gstin: gst(99) } }));
    expect(r.status).toBe(201);
  });
});
