/* eslint-disable @typescript-eslint/no-explicit-any -- test helper reads loosely-typed JSON envelopes */
import { PLANS } from "@/config/plans";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { resetContainer } from "@/server/container";
import { computeGstinChecksum } from "@/lib/gstin";
import * as me from "@/app/api/me/route";
import * as orgsRoute from "@/app/api/organizations/route";
import * as clientsRoute from "@/app/api/clients/route";
import * as clientRoute from "@/app/api/clients/[id]/route";
import * as membersRoute from "@/app/api/members/route";
import * as memberRoute from "@/app/api/members/[uid]/route";
import * as transferRoute from "@/app/api/members/transfer-ownership/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import * as checkRoute from "@/app/api/gst/check/route";
import * as usageRoute from "@/app/api/usage/route";
import * as subRoute from "@/app/api/subscription/route";

const gst = (n: number) => { const b = `24AAAAA${String(n).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };

interface Opt { as?: string; org?: string; body?: unknown; raw?: string; unverified?: boolean }
function req(method: string, path: string, o: Opt = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.as) headers.authorization = `Bearer dev:${o.as}:${o.as}@x.com${o.unverified ? ":unverified" : ""}`;
  if (o.org) headers["x-organization-id"] = o.org;
  return new Request(`http://localhost${path}`, { method, headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) });
}
type Handler = (r: Request, x?: { params: Promise<never> }) => Promise<Response>;
async function call(h: unknown, r: Request, params?: Record<string, string>) {
  const res = await (h as Handler)(r, { params: Promise.resolve(params ?? {}) as Promise<never> });
  return { status: res.status, json: (await res.json()) as { success: boolean; data?: any; error?: { code: string; message: string } } };
}

let orgA: string, orgB: string;

async function makeOrg(uid: string, name: string, plan?: string) {
  const r = await call(orgsRoute.POST, req("POST", "/api/organizations", { as: uid, body: { name, plan } }));
  expect(r.status).toBe(201);
  return r.json.data.organization.id as string;
}
async function invite(owner: string, org: string, email: string, role: string) {
  const r = await call(membersRoute.POST, req("POST", "/api/members", { as: owner, org, body: { email, role } }));
  expect(r.status).toBe(201);
  return r.json.data.token as string;
}
async function addMember(owner: string, org: string, uid: string, role: string) {
  const token = await invite(owner, org, `${uid}@x.com`, role);
  const r = await call(acceptRoute.POST, req("POST", "/api/invitations/accept", { as: uid, body: { token } }));
  expect(r.status).toBe(200);
}

beforeAll(() => { process.env.AUTH_MODE = "dev"; process.env.GST_PROVIDER = "mock"; process.env.STORE = "memory"; process.env.GST_RATE_LIMIT_PER_MIN = "100000"; });
beforeEach(async () => {
  resetContainer();
  orgA = await makeOrg("meet", "Shah & Co.", "firm");
  orgB = await makeOrg("zed", "Zed Tax");
});

describe("authentication & response envelope", () => {
  it("401 without or with bad credentials, structured error", async () => {
    for (const r of [req("GET", "/api/me"), req("GET", "/api/me", { as: undefined })]) {
      const res = await call(me.GET, r);
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ success: false, error: { code: "UNAUTHENTICATED", message: "Please sign in." } });
    }
    const bad = new Request("http://localhost/api/me", { headers: { authorization: "Bearer nonsense" } });
    expect((await call(me.GET, bad)).status).toBe(401);
  });
  it("success envelope + /me lists organizations", async () => {
    const r = await call(me.GET, req("GET", "/api/me", { as: "meet" }));
    expect(r.json.success).toBe(true);
    expect(r.json.data.organizations).toEqual([expect.objectContaining({ id: orgA, name: "Shah & Co.", role: "OWNER", plan: "firm", status: "trialing" })]);
  });
  it("unverified email cannot create a firm", async () => {
    const r = await call(orgsRoute.POST, req("POST", "/api/organizations", { as: "newbie", unverified: true, body: { name: "Firm" } }));
    expect(r.status).toBe(403); expect(r.json.error!.code).toBe("EMAIL_NOT_VERIFIED");
  });
  it("malformed JSON gives structured 400, no stack leak", async () => {
    const r = await call(clientsRoute.POST, req("POST", "/api/clients", { as: "meet", raw: "{not json" }));
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).not.toMatch(/at\s.*\(|node_modules|SyntaxError/);
  });
});

describe("tenant isolation over HTTP", () => {
  it("user cannot read/modify/check another org's data, with or without forged org header", async () => {
    const created = await call(clientsRoute.POST, req("POST", "/api/clients", { as: "meet", org: orgA, body: { name: "Acme", gstin: gst(1) } }));
    expect(created.status).toBe(201);
    const id = created.json.data.client.id as string;

    // zed (member of orgB only) forges orgA header
    for (const [h, p] of [[clientsRoute.GET, undefined], [usageRoute.GET, undefined], [subRoute.GET, undefined], [membersRoute.GET, undefined]] as const) {
      const r = await call(h, req("GET", "/x", { as: "zed", org: orgA }), p);
      expect(r.status).toBe(403); expect(r.json.error!.code).toBe("NOT_A_MEMBER");
    }
    expect((await call(checkRoute.POST, req("POST", "/x", { as: "zed", org: orgA, body: { clientId: id } }))).json.error!.code).toBe("NOT_A_MEMBER");
    expect((await call(clientRoute.DELETE, req("DELETE", "/x", { as: "zed", org: orgA }), { id })).status).toBe(403);

    // zed uses his own org but orgA's client id: indistinguishable from not found
    for (const r of [
      await call(clientRoute.GET, req("GET", "/x", { as: "zed", org: orgB }), { id }),
      await call(clientRoute.PATCH, req("PATCH", "/x", { as: "zed", org: orgB, body: { name: "pwn" } }), { id }),
      await call(clientRoute.DELETE, req("DELETE", "/x", { as: "zed", org: orgB }), { id }),
      await call(checkRoute.POST, req("POST", "/x", { as: "zed", org: orgB, body: { clientId: id } })),
    ]) { expect(r.status).toBe(404); expect(r.json.error!.code).toBe("CLIENT_NOT_FOUND"); }

    // not-existent org id is indistinguishable from foreign org (no oracle)
    expect((await call(clientsRoute.GET, req("GET", "/x", { as: "zed", org: "nope" }))).json.error!.code).toBe("NOT_A_MEMBER");

    const list = await call(clientsRoute.GET, req("GET", "/x", { as: "zed", org: orgB }));
    expect(list.json.data.items).toEqual([]);
    expect((await call(clientRoute.GET, req("GET", "/x", { as: "meet", org: orgA }), { id })).json.data.client.name).toBe("Acme");
  });
  it("body cannot inject organizationId / id / role / plan", async () => {
    const r = await call(clientsRoute.POST, req("POST", "/api/clients", {
      as: "meet", org: orgA,
      body: { name: "Inject", gstin: gst(2), organizationId: orgB, id: "fixed-id", plan: "enterprise", role: "OWNER", status: "archived" },
    }));
    expect(r.status).toBe(201);
    expect(r.json.data.client.id).not.toBe("fixed-id");
    expect(r.json.data.client.status).toBe("active");
    expect((await call(clientsRoute.GET, req("GET", "/x", { as: "zed", org: orgB }))).json.data.items).toHaveLength(0);
    expect((await call(clientsRoute.GET, req("GET", "/x", { as: "meet", org: orgA }))).json.data.items).toHaveLength(1);
  });
  it("two orgs, no header => ORG_REQUIRED; switching header switches data", async () => {
    const second = await makeOrg("meet", "Meet Tax Consulting");
    expect((await call(clientsRoute.GET, req("GET", "/x", { as: "meet" }))).json.error!.code).toBe("ORG_REQUIRED");
    await call(clientsRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { name: "In A", gstin: gst(1) } }));
    expect((await call(clientsRoute.GET, req("GET", "/x", { as: "meet", org: orgA }))).json.data.items).toHaveLength(1);
    expect((await call(clientsRoute.GET, req("GET", "/x", { as: "meet", org: second }))).json.data.items).toHaveLength(0);
    expect((await call(me.GET, req("GET", "/x", { as: "meet" }))).json.data.organizations).toHaveLength(2);
  });
});

describe("roles over HTTP", () => {
  it("viewer is read-only; accountant works but cannot manage team/ownership", async () => {
    await addMember("meet", orgA, "priya", "ACCOUNTANT");
    await addMember("meet", orgA, "vik", "VIEWER");
    const make = (as: string) => call(clientsRoute.POST, req("POST", "/x", { as, org: orgA, body: { name: `by ${as}`, gstin: gst(as === "priya" ? 3 : 4) } }));
    expect((await make("priya")).status).toBe(201);
    const v = await make("vik");
    expect(v.status).toBe(403); expect(v.json.error!.code).toBe("FORBIDDEN");
    const id = (await call(clientsRoute.GET, req("GET", "/x", { as: "vik", org: orgA }))).json.data.items[0].id;
    expect((await call(checkRoute.POST, req("POST", "/x", { as: "vik", org: orgA, body: { clientId: id } }))).status).toBe(403);
    expect((await call(clientRoute.DELETE, req("DELETE", "/x", { as: "vik", org: orgA }), { id })).status).toBe(403);
    expect((await call(clientsRoute.GET, req("GET", "/x", { as: "vik", org: orgA }))).status).toBe(200);

    for (const as of ["priya", "vik"]) {
      expect((await call(membersRoute.GET, req("GET", "/x", { as, org: orgA }))).status).toBe(403);
      expect((await call(membersRoute.POST, req("POST", "/x", { as, org: orgA, body: { email: "n@x.com", role: "VIEWER" } }))).status).toBe(403);
      expect((await call(memberRoute.PATCH, req("PATCH", "/x", { as, org: orgA, body: { role: "ADMIN" } }), { uid: "vik" })).status).toBe(403);
      expect((await call(memberRoute.PATCH, req("PATCH", "/x", { as, org: orgA, body: { role: "VIEWER" } }), { uid: "meet" })).status).toBe(403);
      expect((await call(memberRoute.DELETE, req("DELETE", "/x", { as, org: orgA }), { uid: "meet" })).status).toBe(403);
      expect((await call(transferRoute.POST, req("POST", "/x", { as, org: orgA, body: { uid: as } }))).status).toBe(403);
    }
  });
  it("role is read from membership, never from the request", async () => {
    await addMember("meet", orgA, "vik", "VIEWER");
    const r = await call(clientsRoute.POST, req("POST", "/x", { as: "vik", org: orgA, body: { name: "x", gstin: gst(1), role: "OWNER" } }));
    expect(r.status).toBe(403);
    const self = await call(memberRoute.PATCH, req("PATCH", "/x", { as: "vik", org: orgA, body: { role: "OWNER" } }), { uid: "vik" });
    expect(self.status).toBe(403);
  });
  it("invitation cannot be redeemed by a different or unverified identity", async () => {
    const token = await invite("meet", orgA, "priya@x.com", "ACCOUNTANT");
    expect((await call(acceptRoute.POST, req("POST", "/x", { as: "eve", body: { token } }))).json.error!.code).toBe("INVITATION_EMAIL_MISMATCH");
    expect((await call(acceptRoute.POST, req("POST", "/x", { as: "priya", unverified: true, body: { token } }))).json.error!.code).toBe("EMAIL_NOT_VERIFIED");
    expect((await call(acceptRoute.POST, req("POST", "/x", { body: { token } }))).status).toBe(401);
    expect((await call(acceptRoute.POST, req("POST", "/x", { as: "priya", body: { token } }))).status).toBe(200);
  });
});

describe("GST check, quota and shared usage over HTTP", () => {
  it("check works, caches, and usage is one org-wide number for every member", async () => {
    await addMember("meet", orgA, "priya", "ACCOUNTANT");
    const c = await call(clientsRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { name: "Acme", gstin: gst(1) } }));
    const id = c.json.data.client.id;
    const r1 = await call(checkRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { clientId: id } }));
    expect(r1.status).toBe(200);
    expect(r1.json.data).toMatchObject({ cached: false, gstin: { source: "mock" } });
    expect(r1.json.data.gstin.lastCheckedAt).toBeTruthy();
    const r2 = await call(checkRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { clientId: id } }));
    expect(r2.json.data.cached).toBe(true);
    await call(checkRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { clientId: id, force: true } }));
    for (const as of ["meet", "priya"]) {
      const u = await call(usageRoute.GET, req("GET", "/x", { as, org: orgA }));
      expect(u.json.data.usage).toMatchObject({ used: 2, limit: 2000, remaining: 1998, cachedChecks: 1 });
    }
    expect((await call(usageRoute.GET, req("GET", "/x", { as: "zed", org: orgB }))).json.data.usage.used).toBe(0);
  });
  it("client cannot bypass quota by sending plan/limit; exhausted quota returns 402", async () => {
    // orgB is Free (10 checks, 5 clients). Create the 5 clients the plan allows and burn the quota with force checks.
    const N = PLANS.free.clientLimit!, Q = PLANS.free.monthlyChecks!;
    const ids: string[] = [];
    for (let i = 1; i <= N; i++) ids.push((await call(clientsRoute.POST, req("POST", "/x", { as: "zed", org: orgB, body: { name: `c${i}`, gstin: gst(i) } }))).json.data.client.id);
    let ok = 0, blocked = 0;
    for (let i = 0; i < Q + 5; i++) {
      const r = await call(checkRoute.POST, req("POST", "/x", { as: "zed", org: orgB, body: { clientId: ids[i % N], force: true, plan: "enterprise", limit: 999999, organizationId: orgA } }));
      if (r.status === 200) ok++; else { blocked++; expect(r.status).toBe(402); expect(r.json.error!.code).toBe("QUOTA_EXHAUSTED"); }
    }
    expect({ ok, blocked }).toEqual({ ok: Q, blocked: 5 });
    expect((await call(usageRoute.GET, req("GET", "/x", { as: "zed", org: orgB }))).json.data.usage).toMatchObject({ used: Q, remaining: 0 });
    // one client beyond the Free cap is refused by the plan client limit
    const over = await call(clientsRoute.POST, req("POST", "/x", { as: "zed", org: orgB, body: { name: "over", gstin: gst(N + 1) } }));
    expect(over.status).toBe(402); expect(over.json.error!.code).toBe("CLIENT_LIMIT_REACHED");
  });
  it("members endpoint never exposes invitation tokens after creation", async () => {
    const token = await invite("meet", orgA, "priya@x.com", "VIEWER");
    const list = await call(membersRoute.GET, req("GET", "/x", { as: "meet", org: orgA }));
    expect(JSON.stringify(list.json)).not.toContain(token);
    expect(list.json.data.invitations).toHaveLength(1);
  });
});
