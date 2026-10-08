/* eslint-disable @typescript-eslint/no-explicit-any -- test helper reads loosely-typed JSON envelopes */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetContainer } from "@/server/container";
import { computeGstinChecksum } from "@/lib/gstin";
import * as orgsRoute from "@/app/api/organizations/route";
import * as membersRoute from "@/app/api/members/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import * as verifyRoute from "@/app/api/verify/route";
import * as costsRoute from "@/app/api/verify/costs/route";
import * as operatorRoute from "@/app/api/operator/provider/route";

const gst = (n: number) => { const b = `24AAAAA${String(n).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };
const ENV_KEYS = ["OPERATOR_UIDS", "PROVIDER_MONTHLY_CREDIT_BUDGET", "VERIFY_ORG_PER_MINUTE", "VERIFY_SHARED_CACHE", "PROVIDER_COST_PER_CREDIT_INR"];

function req(method: string, path: string, o: { as?: string; org?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.as) headers.authorization = `Bearer dev:${o.as}:${o.as}@x.com`;
  if (o.org) headers["x-organization-id"] = o.org;
  return new Request(`http://localhost${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
async function call(h: unknown, r: Request) {
  const res = await (h as (r: Request, x: { params: Promise<never> }) => Promise<Response>)(r, { params: Promise.resolve({}) as Promise<never> });
  return { status: res.status, json: JSON.parse(await res.text()) as { success: boolean; data?: any; error?: { code: string } } };
}
async function setup() {
  resetContainer();
  const o = await call(orgsRoute.POST, req("POST", "/x", { as: "meet", body: { name: "Shah & Co.", plan: "professional" } }));
  const org = o.json.data.organization.id as string;
  for (const [uid, role] of [["priya", "ACCOUNTANT"], ["vik", "VIEWER"]]) {
    const inv = await call(membersRoute.POST, req("POST", "/x", { as: "meet", org, body: { email: `${uid}@x.com`, role } }));
    await call(acceptRoute.POST, req("POST", "/x", { as: uid, body: { token: inv.json.data.token } }));
  }
  return org;
}
const verify = (org: string, gstin: string, mode = "auto") => call(verifyRoute.POST, req("POST", "/api/verify", { as: "priya", org, body: { gstin, mode } }));

beforeEach(() => { Object.assign(process.env, { AUTH_MODE: "dev", GST_PROVIDER: "mock", STORE: "memory", GST_RATE_LIMIT_PER_MIN: "1000000" }); for (const k of ENV_KEYS) delete process.env[k]; });
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; resetContainer(); });

describe("GET /api/verify/costs", () => {
  it("shows searches → paid calls → stored answers for admins; others are refused", async () => {
    const org = await setup();
    await verify(org, gst(1)); await verify(org, gst(1)); await verify(org, gst(1)); await verify(org, gst(2)); await verify(org, "bad");
    expect((await call(costsRoute.GET, req("GET", "/x", { as: "priya", org }))).status).toBe(403);
    const r = await call(costsRoute.GET, req("GET", "/x", { as: "meet", org }));
    expect(r.status).toBe(200);
    expect(r.json.data.costs.today).toMatchObject({ searches: 4, paidCalls: 2, cacheHits: 2, cacheMisses: 2, credits: 2, avoidedCallRate: 0.5, estimatedCostInr: null });
    expect(r.json.data.costs).toMatchObject({ sharedCache: false, costKnown: false });
  });
  it("estimates cost only when a credit price is configured", async () => {
    process.env.PROVIDER_COST_PER_CREDIT_INR = "0.4";
    const org = await setup(); await verify(org, gst(1)); await verify(org, gst(2));
    const r = await call(costsRoute.GET, req("GET", "/x", { as: "meet", org }));
    expect(r.json.data.costs.month.estimatedCostInr).toBe(0.8); expect(r.json.data.costs.costKnown).toBe(true);
  });
  it("is scoped to the organization", async () => {
    const org = await setup(); await verify(org, gst(1));
    const o2 = await call(orgsRoute.POST, req("POST", "/x", { as: "zed", body: { name: "Zed" } }));
    const r = await call(costsRoute.GET, req("GET", "/x", { as: "zed", org: o2.json.data.organization.id }));
    expect(r.json.data.costs.today.searches).toBe(0);
  });
});

describe("GET /api/operator/provider", () => {
  it("is invisible (404) to everyone but the configured operators, owners included", async () => {
    const org = await setup(); await verify(org, gst(1));
    expect((await call(operatorRoute.GET, req("GET", "/x", { as: "meet" }))).status).toBe(404);
    expect((await call(operatorRoute.GET, req("GET", "/x"))).status).toBe(401);
  });
  it("shows platform-wide spend, credit state and limits to an operator", async () => {
    process.env.OPERATOR_UIDS = "ops-1, meet"; process.env.PROVIDER_MONTHLY_CREDIT_BUDGET = "100";
    const org = await setup(); await verify(org, gst(1)); await verify(org, gst(2));
    const r = await call(operatorRoute.GET, req("GET", "/x", { as: "meet" }));
    expect(r.status).toBe(200);
    expect(r.json.data.provider.today).toMatchObject({ paidCalls: 2, credits: 2 });
    expect(r.json.data.provider.credits).toMatchObject({ state: "ok", budget: 100, used: 2, remaining: 98 });
    expect(r.json.data.provider).toMatchObject({ sharedCache: false, limits: { orgPerMinute: 120 } });
    expect(r.json.data.health).toHaveProperty("state");
  });
});

describe("protection surfaces as typed outcomes over HTTP", () => {
  it("an exhausted credit budget pauses live checks (200 CAPACITY_LIMITED) but still serves stored results", async () => {
    process.env.PROVIDER_MONTHLY_CREDIT_BUDGET = "2";
    const org = await setup(); await verify(org, gst(1)); await verify(org, gst(2));
    const v = await verify(org, gst(3));
    expect(v.status).toBe(200); expect(v.json.data.verification).toMatchObject({ outcome: "CAPACITY_LIMITED", retryable: true });
    expect((await verify(org, gst(1))).json.data.verification).toMatchObject({ freshness: "cached", provenance: "CACHE" });
  });
  it("the per-organization per-minute cap answers RATE_LIMITED with a retry hint", async () => {
    process.env.VERIFY_ORG_PER_MINUTE = "2";
    const org = await setup(); await verify(org, gst(1)); await verify(org, gst(2));
    const v = await verify(org, gst(3));
    expect(v.json.data.verification).toMatchObject({ outcome: "RATE_LIMITED", retryable: true }); expect(v.json.data.verification.retryAfterMs).toBeGreaterThan(0);
  });
});
