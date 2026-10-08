/* eslint-disable @typescript-eslint/no-explicit-any -- test helper reads loosely-typed JSON envelopes */
import { PLANS } from "@/config/plans";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { resetContainer } from "@/server/container";
import { computeGstinChecksum } from "@/lib/gstin";
import * as orgsRoute from "@/app/api/organizations/route";
import * as membersRoute from "@/app/api/members/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import * as verifyRoute from "@/app/api/verify/route";
import * as recentRoute from "@/app/api/verify/recent/route";
import * as saveRoute from "@/app/api/verify/save/route";
import * as healthRoute from "@/app/api/verify/health/route";

const gst = (n: number) => { const b = `24AAAAA${String(n).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };

interface Opt { as?: string; org?: string; body?: unknown; raw?: string }
function req(method: string, path: string, o: Opt = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.as) headers.authorization = `Bearer dev:${o.as}:${o.as}@x.com`;
  if (o.org) headers["x-organization-id"] = o.org;
  return new Request(`http://localhost${path}`, { method, headers, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) });
}
async function call(h: unknown, r: Request) {
  const res = await (h as (r: Request, x: { params: Promise<never> }) => Promise<Response>)(r, { params: Promise.resolve({}) as Promise<never> });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as { success: boolean; data?: any; error?: { code: string; message: string } } };
}
async function makeOrg(uid: string, name: string, plan = "professional") {
  const r = await call(orgsRoute.POST, req("POST", "/x", { as: uid, body: { name, plan } }));
  expect(r.status).toBe(201);
  return r.json.data.organization.id as string;
}
async function addMember(owner: string, org: string, uid: string, role: string) {
  const inv = await call(membersRoute.POST, req("POST", "/x", { as: owner, org, body: { email: `${uid}@x.com`, role } }));
  expect((await call(acceptRoute.POST, req("POST", "/x", { as: uid, body: { token: inv.json.data.token } }))).status).toBe(200);
}

let orgA: string, orgB: string;
const verify = (as: string | undefined, org: string | undefined, gstin: unknown, extra: object = {}) =>
  call(verifyRoute.POST, req("POST", "/api/verify", { as, org, body: { gstin, ...extra } }));

beforeAll(() => {
  Object.assign(process.env, {
    AUTH_MODE: "dev", GST_PROVIDER: "mock", STORE: "memory", GST_RATE_LIMIT_PER_MIN: "1000000", GST_BACKOFF_BASE_MS: "1", GST_BACKOFF_MAX_MS: "2",
    MOCK_NOT_FOUND: gst(7), MOCK_TIMEOUT: gst(8),
  });
});
beforeEach(async () => {
  resetContainer();
  orgA = await makeOrg("meet", "Shah & Co.");
  orgB = await makeOrg("zed", "Zed Tax");
  await addMember("meet", orgA, "priya", "ACCOUNTANT");
  await addMember("meet", orgA, "vik", "VIEWER");
});

describe("POST /api/verify", () => {
  it("requires authentication and an organization", async () => {
    expect((await verify(undefined, orgA, gst(1))).status).toBe(401);
    expect((await verify("priya", "not-my-org", gst(1))).json.error?.code).toBe("NOT_A_MEMBER");
  });
  it("viewers cannot verify", async () => {
    const r = await verify("vik", orgA, gst(1));
    expect(r.status).toBe(403); expect(r.json.error?.code).toBe("FORBIDDEN");
  });
  it("returns the typed result in the standard envelope, then serves the repeat from cache", async () => {
    const a = await verify("priya", orgA, gst(1));
    expect(a.status).toBe(200); expect(a.json.success).toBe(true);
    expect(a.json.data.verification).toMatchObject({ gstin: gst(1), formatValid: true, freshness: "live", source: "mock" });
    expect(["ACTIVE", "SUSPENDED", "CANCELLED"]).toContain(a.json.data.verification.outcome);
    expect(a.json.data.verification.details.legalName).toMatch(/^MOCK /);
    const b = await verify("priya", orgA, gst(1));
    expect(b.json.data.verification).toMatchObject({ freshness: "cached", outcome: a.json.data.verification.outcome });
    expect((await verify("priya", orgA, gst(1), { force: true })).json.data.verification.freshness).toBe("live");
  });
  it("an invalid GSTIN is a 200 INVALID_GSTIN outcome with a reason (not an HTTP error, not a quota use)", async () => {
    const r = await verify("priya", orgA, "24AAAAA0001A1ZX");
    expect(r.status).toBe(200); expect(r.json.data.verification).toMatchObject({ outcome: "INVALID_GSTIN", formatValid: false, invalidReason: "CHECKSUM" });
  });
  it("NOT_FOUND and a provider timeout are 200 outcomes — never 5xx, never 'invalid'", async () => {
    const nf = await verify("priya", orgA, gst(7));
    expect(nf.status).toBe(200); expect(nf.json.data.verification).toMatchObject({ outcome: "NOT_FOUND", formatValid: true, retryable: false });
    const to = await verify("priya", orgA, gst(8));
    expect(to.status).toBe(200); expect(to.json.data.verification).toMatchObject({ outcome: "TIMEOUT", formatValid: true, retryable: true, freshness: "none" });
    expect(to.text).not.toMatch(/stack|Error:/);
  });
  it("rejects malformed requests", async () => {
    expect((await call(verifyRoute.POST, req("POST", "/x", { as: "priya", org: orgA, raw: "not json" }))).status).toBe(400);
    const r = await verify("priya", orgA, 12345);
    expect(r.status).toBe(400); expect(r.json.error?.code).toBe("VALIDATION_ERROR");
  });
  it("tenant isolation: another organization never sees or reuses my result", async () => {
    await verify("priya", orgA, gst(2));
    expect((await verify("zed", orgB, gst(2))).json.data.verification.freshness).toBe("live");
    const recB = await call(recentRoute.GET, req("GET", "/api/verify/recent", { as: "zed", org: orgB }));
    expect(recB.json.data.items).toHaveLength(1);
  });
  it("quota exhaustion is an HTTP 402 (a billing problem, not a verification outcome)", async () => {
    const free = await makeOrg("solo", "Solo", "free");
    for (let i = 1; i <= PLANS.free.monthlyChecks!; i++) expect((await verify("solo", free, gst(100 + i))).status).toBe(200);
    const r = await verify("solo", free, gst(999));
    expect(r.status).toBe(402); expect(r.json.error?.code).toBe("QUOTA_EXHAUSTED");
  });
});

describe("GET /api/verify/recent and /health", () => {
  it("recent lists newest first with age; viewers may read it", async () => {
    await verify("priya", orgA, gst(1)); await new Promise((r) => setTimeout(r, 15)); await verify("priya", orgA, gst(2)); // distinct timestamps (real clock)
    const r = await call(recentRoute.GET, req("GET", "/api/verify/recent?limit=1", { as: "vik", org: orgA }));
    expect(r.status).toBe(200); expect(r.json.data.items).toHaveLength(1);
    expect(r.json.data.items[0]).toMatchObject({ gstin: gst(2), ageSeconds: expect.any(Number) });
  });
  it("health is for admins/owners and reflects what happened", async () => {
    await verify("priya", orgA, "bad"); await verify("priya", orgA, gst(1)); await verify("priya", orgA, gst(1)); await verify("priya", orgA, gst(8));
    expect((await call(healthRoute.GET, req("GET", "/x", { as: "priya", org: orgA }))).status).toBe(403);
    const h = await call(healthRoute.GET, req("GET", "/x", { as: "meet", org: orgA }));
    expect(h.status).toBe(200);
    expect(h.json.data.metrics).toMatchObject({ total: 4, byOutcome: expect.objectContaining({ INVALID_GSTIN: 1, TIMEOUT: 1 }) });
    expect(h.json.data.metrics.cacheHitRate).toBeGreaterThan(0);
    expect(h.json.data.provider).toHaveProperty("breaker");
  });
});

describe("POST /api/verify/save and GET /api/verify/recent?saved=1", () => {
  const save = (as: string, org: string, gstin: unknown, saved: unknown) => call(saveRoute.POST, req("POST", "/api/verify/save", { as, org, body: { gstin, saved } }));
  it("pins a verified GSTIN, lists it under saved, and the next verify reports saved", async () => {
    expect((await save("priya", orgA, gst(1), true)).status).toBe(404); // never verified
    await verify("priya", orgA, gst(1)); await verify("priya", orgA, gst(2));
    const s = await save("priya", orgA, gst(1), true);
    expect(s.status).toBe(200); expect(s.json.data).toEqual({ gstin: gst(1), saved: true });
    const list = await call(recentRoute.GET, req("GET", "/api/verify/recent?saved=1", { as: "vik", org: orgA }));
    expect(list.json.data.items.map((i: any) => i.gstin)).toEqual([gst(1)]);
    expect((await verify("priya", orgA, gst(1))).json.data.verification).toMatchObject({ saved: true, freshness: "cached" });
    await save("priya", orgA, gst(1), false);
    expect((await call(recentRoute.GET, req("GET", "/api/verify/recent?saved=1", { as: "vik", org: orgA }))).json.data.items).toEqual([]);
  });
  it("is role- and tenant-checked and validates input", async () => {
    await verify("priya", orgA, gst(1));
    expect((await save("vik", orgA, gst(1), true)).status).toBe(403);
    expect((await save("zed", orgB, gst(1), true)).status).toBe(404);
    expect((await save("priya", orgA, "nope", true)).json.error?.code).toBe("INVALID_GSTIN");
    expect((await save("priya", orgA, gst(1), "yes")).status).toBe(400);
  });
});

describe("POST /api/verify mode", () => {
  it("rejects an unknown mode; accepts auto, refresh and live; force is the legacy spelling of live", async () => {
    expect((await verify("priya", orgA, gst(1), { mode: "turbo" })).json.error?.code).toBe("VALIDATION_ERROR");
    const auto = await verify("priya", orgA, gst(1), { mode: "auto" });
    expect(auto.json.data.verification).toMatchObject({ freshness: "live" });
    expect((await verify("priya", orgA, gst(1), { mode: "auto" })).json.data.verification).toMatchObject({ freshness: "cached", staleness: "fresh" });
    expect((await verify("priya", orgA, gst(1), { mode: "live" })).json.data.verification.freshness).toBe("live");
    expect((await verify("priya", orgA, gst(1), { force: true })).json.data.verification.freshness).toBe("live");
    expect((await verify("priya", orgA, gst(1), { mode: "refresh" })).json.data.verification.freshness).toBe("live");
  });
  it("concurrent identical requests share one provider call", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => verify("priya", orgA, gst(40), { mode: "live" })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.json.data.verification.joined).length).toBe(4);
    const h = await call(healthRoute.GET, req("GET", "/x", { as: "meet", org: orgA }));
    expect(h.json.data.metrics).toMatchObject({ providerCalls: 1, joined: 4 });
    expect(h.json.data.providerHealth).toMatchObject({ state: "healthy" });
  });
});
