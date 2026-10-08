/* eslint-disable @typescript-eslint/no-explicit-any -- test helper reads loosely-typed JSON envelopes */
import { describe, it, expect, beforeEach } from "vitest";
import { container, resetContainer } from "@/server/container";
import { computeGstinChecksum } from "@/lib/gstin";
import * as orgsRoute from "@/app/api/organizations/route";
import * as membersRoute from "@/app/api/members/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import * as clientsRoute from "@/app/api/clients/route";
import * as verifyRoute from "@/app/api/verify/route";
import * as alertsRoute from "@/app/api/alerts/route";
import * as alertsReadRoute from "@/app/api/alerts/read/route";
import * as reportRoute from "@/app/api/reports/[kind]/route";
import * as summaryRoute from "@/app/api/reports/summary/route";

const gst = (n: number) => { const b = `24AAAAA${String(n).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };
function req(method: string, path: string, o: { as?: string; org?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.as) headers.authorization = `Bearer dev:${o.as}:${o.as}@x.com`;
  if (o.org) headers["x-organization-id"] = o.org;
  return new Request(`http://localhost${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
}
async function call(h: unknown, r: Request, params: Record<string, string> = {}) {
  const res = await (h as (r: Request, x: { params: Promise<never> }) => Promise<Response>)(r, { params: Promise.resolve(params) as Promise<never> });
  const bytes = new Uint8Array(await res.clone().arrayBuffer());
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf; // fetch's text() strips a BOM, so check the raw bytes
  const text = await res.text();
  let json: { success: boolean; data?: any; error?: { code: string } } | null = null; try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: res.status, text, bom, headers: res.headers, json: json as { success: boolean; data?: any; error?: { code: string } } };
}
let org: string;
async function setup(plan = "firm") {
  resetContainer();
  const o = await call(orgsRoute.POST, req("POST", "/x", { as: "meet", body: { name: "Shah & Co.", plan } }));
  org = o.json.data.organization.id;
  if (plan !== "starter") for (const [uid, role] of [["priya", "ACCOUNTANT"], ["vik", "VIEWER"]]) {
    const inv = await call(membersRoute.POST, req("POST", "/x", { as: "meet", org, body: { email: `${uid}@x.com`, role } }));
    await call(acceptRoute.POST, req("POST", "/x", { as: uid, body: { token: inv.json.data.token } }));
  }
}
const verify = (n: number, mode = "auto") => call(verifyRoute.POST, req("POST", "/x", { as: "priya", org, body: { gstin: gst(n), mode } }));
beforeEach(() => { Object.assign(process.env, { AUTH_MODE: "dev", GST_PROVIDER: "mock", STORE: "memory", GST_RATE_LIMIT_PER_MIN: "1000000" }); });

describe("alerts API", () => {
  it("quota and run alerts show up; read state is shared; viewers read but cannot change it", async () => {
    await setup();
    await container().store.addAlert(org, { id: "q1", type: "QUOTA_NEAR_LIMIT", message: "You have used 80% of this month's GST checks.", at: new Date().toISOString(), read: false });
    await container().store.addAlert(org, { id: "q2", type: "IMPORT_COMPLETED", message: "CSV import finished.", at: new Date(Date.now() - 1000).toISOString(), read: false });
    const r = await call(alertsRoute.GET, req("GET", "/api/alerts", { as: "vik", org }));
    expect(r.status).toBe(200); expect(r.json.data).toMatchObject({ unreadCount: 2, hasMore: false }); expect(r.json.data.items.map((a: any) => a.id)).toEqual(["q1", "q2"]);
    expect((await call(alertsRoute.GET, req("GET", "/api/alerts?group=usage", { as: "vik", org }))).json.data.items.map((a: any) => a.id)).toEqual(["q1"]);
    expect((await call(alertsRoute.GET, req("GET", "/api/alerts?group=bogus", { as: "vik", org }))).status).toBe(400);
    expect((await call(alertsReadRoute.POST, req("POST", "/x", { as: "vik", org, body: { all: true } }))).status).toBe(403);
    const m = await call(alertsReadRoute.POST, req("POST", "/x", { as: "priya", org, body: { ids: ["q1"] } }));
    expect(m.json.data).toEqual({ changed: 1, unreadCount: 1 });
    expect((await call(alertsRoute.GET, req("GET", "/api/alerts?unread=1", { as: "vik", org }))).json.data.items.map((a: any) => a.id)).toEqual(["q2"]);
    expect((await call(alertsReadRoute.POST, req("POST", "/x", { as: "priya", org, body: {} }))).status).toBe(400);
  });
  it("a client's GSTIN getting worse raises an alert naming the client, end to end; unauthenticated requests are refused", async () => {
    await setup();
    // The mock decides status by hash: find a GSTIN it reports as cancelled or suspended.
    let n = 0, bad = "";
    for (n = 1; n < 60 && !bad; n++) { const v = (await verify(n, "live")).json.data.verification; if (v.outcome === "CANCELLED" || v.outcome === "SUSPENDED") bad = v.outcome; }
    const g = gst(n - 1);
    await call(clientsRoute.POST, req("POST", "/x", { as: "priya", org, body: { name: "Acme Traders", gstin: g } }));
    const rec = (await container().store.getVerification(org, g))!;
    await container().store.putVerification(org, { ...rec, outcome: "ACTIVE", verifiedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }); // what we knew before: active
    const live = (await verify(n - 1, "live")).json.data.verification;
    expect(live.change).toMatchObject({ from: "ACTIVE", to: bad, deteriorated: true });
    const a = (await call(alertsRoute.GET, req("GET", "/api/alerts", { as: "meet", org }))).json.data.items[0];
    expect(a).toMatchObject({ gstin: g, type: bad === "CANCELLED" ? "GSTIN_CANCELLED" : "GSTIN_SUSPENDED", read: false });
    expect(a.message).toContain("Acme Traders");
    expect((await call(alertsRoute.GET, req("GET", "/api/alerts", { org }))).status).toBe(401);
  });
});

describe("reports API", () => {
  it("previews as JSON (first rows, total, notes) and downloads CSV with BOM, attachment headers and an audit entry", async () => {
    await setup();
    for (const n of [1, 2, 3]) await call(clientsRoute.POST, req("POST", "/x", { as: "priya", org, body: { name: n === 1 ? "=SUM(1)" : `Client ${n}`, gstin: gst(n) } }));
    await verify(1); await verify(2);
    const p = await call(reportRoute.GET, req("GET", "/api/reports/clients", { as: "vik", org }), { kind: "clients" });
    expect(p.status).toBe(200); expect(p.json.data).toMatchObject({ kind: "clients", title: "Client GST status", total: 3, truncated: false }); expect(p.json.data.rows).toHaveLength(3);
    const csv = await call(reportRoute.GET, req("GET", "/api/reports/clients?format=csv", { as: "priya", org }), { kind: "clients" });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8"); expect(csv.headers.get("content-disposition")).toMatch(/^attachment; filename="clients-report-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(csv.headers.get("x-content-type-options")).toBe("nosniff"); expect(csv.headers.get("x-report-rows")).toBe("3");
    expect(csv.bom).toBe(true); expect(csv.text.startsWith("\"Client\",\"GSTIN\"")).toBe(true); expect(csv.text).toContain("\"'=SUM(1)\"");
    expect((await container().store.listAudit(org, 3))[0]).toMatchObject({ action: "REPORT_GENERATED", target: "clients" });
  });
  it("viewers cannot download; unknown reports are 404; filters validate; auth is required", async () => {
    await setup();
    expect((await call(reportRoute.GET, req("GET", "/x?format=csv", { as: "vik", org }), { kind: "clients" })).status).toBe(403);
    expect((await call(reportRoute.GET, req("GET", "/x", { as: "priya", org }), { kind: "payroll" })).status).toBe(404);
    expect((await call(reportRoute.GET, req("GET", "/x?returnType=GSTR9", { as: "priya", org }), { kind: "returns" })).status).toBe(400);
    expect((await call(reportRoute.GET, req("GET", "/x", { org }), { kind: "clients" })).status).toBe(401);
  });
  it("the printable summary is a plan feature (refused on Starter, available on Firm)", async () => {
    await setup("starter");
    const r = await call(summaryRoute.GET, req("GET", "/x", { as: "meet", org }));
    expect(r.status).toBe(403); expect(r.json.error?.code).toBe("FEATURE_NOT_AVAILABLE");
    await setup("firm");
    const ok = await call(summaryRoute.GET, req("GET", "/x", { as: "vik", org }));
    expect(ok.status).toBe(200); expect(ok.json.data.summary).toMatchObject({ organization: "Shah & Co.", portfolio: { total: 0 } });
  });
});
