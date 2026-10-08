/* eslint-disable @typescript-eslint/no-explicit-any -- test helper reads loosely-typed JSON envelopes */
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { resetContainer } from "@/server/container";
import { computeGstinChecksum } from "@/lib/gstin";
import * as orgsRoute from "@/app/api/organizations/route";
import * as membersRoute from "@/app/api/members/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import * as verifyRoute from "@/app/api/verify/route";
import * as annotateRoute from "@/app/api/verify/annotate/route";
import * as recentRoute from "@/app/api/verify/recent/route";
import * as forgetRoute from "@/app/api/verify/forget/route";
import * as historyRoute from "@/app/api/verify/history/route";
import * as concernsRoute from "@/app/api/concerns/route";
import * as concernRoute from "@/app/api/concerns/[id]/route";
import * as auditRoute from "@/app/api/audit-logs/route";
import * as auditExportRoute from "@/app/api/audit-logs/export/route";

const gst = (n: number) => { const b = `24AAAAA${String(n).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };
interface Opt { as?: string; org?: string; body?: unknown }
const req = (method: string, path: string, o: Opt = {}) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.as) headers.authorization = `Bearer dev:${o.as}:${o.as}@x.com`;
  if (o.org) headers["x-organization-id"] = o.org;
  return new Request(`http://localhost${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
};
async function call(h: unknown, r: Request, params?: Record<string, string>) {
  const res = await (h as (r: Request, x: { params: Promise<never> }) => Promise<Response>)(r, { params: Promise.resolve(params ?? {}) as Promise<never> });
  const text = await res.text();
  let json: { success: boolean; data?: any; error?: { code: string; message: string } } | null = null;
  try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: res.status, text, json: json!, headers: res.headers };
}
async function makeOrg(uid: string, name: string) { const r = await call(orgsRoute.POST, req("POST", "/x", { as: uid, body: { name, plan: "firm" } })); expect(r.status).toBe(201); return r.json.data.organization.id as string; }
async function addMember(owner: string, org: string, uid: string, role: string) {
  const inv = await call(membersRoute.POST, req("POST", "/x", { as: owner, org, body: { email: `${uid}@x.com`, role } }));
  expect((await call(acceptRoute.POST, req("POST", "/x", { as: uid, body: { token: inv.json.data.token } }))).status).toBe(200);
}
let orgA: string, orgB: string;
const verify = (as: string, org: string, g: string) => call(verifyRoute.POST, req("POST", "/x", { as, org, body: { gstin: g } }));
const report = (as: string, org: string | undefined, body: object) => call(concernsRoute.POST, req("POST", "/x", { as, org, body }));
const GOOD = { gstin: gst(1), category: "NOT_EXIST", description: "The counterparty gave this GSTIN but it is unknown to us." };

beforeAll(() => { Object.assign(process.env, { AUTH_MODE: "dev", GST_PROVIDER: "mock", STORE: "memory", GST_RATE_LIMIT_PER_MIN: "1000000", MOCK_NOT_FOUND: "", MOCK_TIMEOUT: "" }); });
beforeEach(async () => {
  resetContainer();
  orgA = await makeOrg("meet", "Shah & Co."); orgB = await makeOrg("zed", "Zed Tax");
  await addMember("meet", orgA, "priya", "ACCOUNTANT"); await addMember("meet", orgA, "vik", "VIEWER"); await addMember("meet", orgA, "ria", "ADMIN");
});

describe("/api/concerns", () => {
  it("201 on create, 200 + duplicate on a repeat, then listed; viewers and outsiders are refused", async () => {
    await verify("priya", orgA, gst(1));
    const a = await report("priya", orgA, GOOD);
    expect(a.status).toBe(201); expect(a.json.data).toMatchObject({ duplicate: false, concern: { status: "open", gstin: gst(1), snapshot: { outcome: expect.any(String), source: "mock" } } });
    const b = await report("priya", orgA, GOOD);
    expect(b.status).toBe(200); expect(b.json.data).toMatchObject({ duplicate: true }); expect(b.json.data.concern.id).toBe(a.json.data.concern.id);
    const list = await call(concernsRoute.GET, req("GET", "/api/concerns?status=open", { as: "ria", org: orgA }));
    expect(list.json.data.items).toHaveLength(1);
    expect((await report("vik", orgA, GOOD)).status).toBe(403);
    expect((await call(concernsRoute.GET, req("GET", "/x", { as: "vik", org: orgA }))).status).toBe(403);
    expect((await call(concernsRoute.GET, req("GET", "/x", { as: "zed", org: orgB }))).json.data.items).toEqual([]);
  });
  it("validates input with clear errors", async () => {
    expect((await report("priya", orgA, { ...GOOD, description: "short" })).json.error?.code).toBe("VALIDATION_ERROR");
    expect((await report("priya", orgA, { ...GOOD, category: "x" })).status).toBe(400);
    expect((await report("priya", orgA, { ...GOOD, gstin: "nope" })).json.error?.code).toBe("INVALID_GSTIN");
  });
  it("PATCH: admins review; accountants cannot; other orgs get 404", async () => {
    const id = (await report("priya", orgA, GOOD)).json.data.concern.id;
    const patch = (as: string, org: string, body: object) => call(concernRoute.PATCH, req("PATCH", "/x", { as, org, body }), { id });
    expect((await patch("priya", orgA, { status: "reviewed" })).status).toBe(403);
    const ok = await patch("ria", orgA, { status: "closed", resolution: "Client sent the certificate." });
    expect(ok.status).toBe(200); expect(ok.json.data.concern).toMatchObject({ status: "closed", resolution: "Client sent the certificate.", reviewedBy: expect.any(String) });
    expect((await patch("zed", orgB, { status: "closed" })).json.error?.code).toBe("CONCERN_NOT_FOUND");
    expect((await patch("ria", orgA, { status: "weird" })).status).toBe(400);
  });
});

describe("/api/audit-logs", () => {
  it("shows what happened to admins/owners only, filters by action, never leaks free text, exports CSV", async () => {
    await verify("priya", orgA, gst(1));
    await call(annotateRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { gstin: gst(1), note: "secret client detail", tags: ["VIP"] } }));
    await report("priya", orgA, GOOD);
    const all = await call(auditRoute.GET, req("GET", "/x", { as: "ria", org: orgA }));
    expect(all.status).toBe(200);
    const actions = all.json.data.items.map((i: any) => i.action);
    expect(actions).toEqual(expect.arrayContaining(["GST_VERIFY", "VERIFICATION_ANNOTATED", "CONCERN_REPORTED"]));
    expect(all.text).not.toContain("secret client detail"); expect(all.text).not.toContain("VIP"); expect(all.text).not.toContain("unknown to us");
    expect(all.json.data.items[0]).toMatchObject({ who: "priya@x.com", label: expect.any(String) });
    const only = await call(auditRoute.GET, req("GET", "/api/audit-logs?action=GST_VERIFY", { as: "meet", org: orgA }));
    expect(only.json.data.items.every((i: any) => i.action === "GST_VERIFY")).toBe(true);
    expect((await call(auditRoute.GET, req("GET", "/api/audit-logs?action=nope", { as: "ria", org: orgA }))).status).toBe(400);
    expect((await call(auditRoute.GET, req("GET", "/x", { as: "priya", org: orgA }))).status).toBe(403);
    expect((await call(auditRoute.GET, req("GET", "/x", { as: "zed", org: orgB }))).json.data.items).toEqual([]);
    const csv = await call(auditExportRoute.GET, req("GET", "/x", { as: "ria", org: orgA }));
    expect(csv.status).toBe(200); expect(csv.headers.get("content-type")).toContain("text/csv"); expect(csv.text).toContain("When (UTC)");
    expect((await call(auditExportRoute.GET, req("GET", "/x", { as: "priya", org: orgA }))).status).toBe(403);
  });
});

describe("privacy endpoints", () => {
  it("POST /api/verify/forget removes one lookup; DELETE /api/verify/history clears all (admins) and is audited", async () => {
    await verify("priya", orgA, gst(1)); await verify("priya", orgA, gst(2)); await verify("zed", orgB, gst(1));
    const f = await call(forgetRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { gstin: gst(1) } }));
    expect(f.json.data).toEqual({ gstin: gst(1), removed: true });
    expect((await call(forgetRoute.POST, req("POST", "/x", { as: "vik", org: orgA, body: { gstin: gst(2) } }))).status).toBe(403);
    expect((await call(forgetRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { gstin: "bad" } }))).status).toBe(400);
    expect((await call(historyRoute.DELETE, req("DELETE", "/x", { as: "priya", org: orgA }))).status).toBe(403);
    const c = await call(historyRoute.DELETE, req("DELETE", "/x", { as: "ria", org: orgA }));
    expect(c.json.data).toEqual({ removed: 1 });
    expect((await call(recentRoute.GET, req("GET", "/x", { as: "ria", org: orgA }))).json.data.items).toEqual([]);
    expect((await call(recentRoute.GET, req("GET", "/x", { as: "zed", org: orgB }))).json.data.items).toHaveLength(1);
    const log = (await call(auditRoute.GET, req("GET", "/api/audit-logs?action=VERIFICATION_HISTORY_CLEARED", { as: "ria", org: orgA }))).json.data.items;
    expect(log[0].metadata).toEqual({ removed: 1 });
  });
});
