/* eslint-disable @typescript-eslint/no-explicit-any -- test helper reads loosely-typed JSON envelopes */
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { container, resetContainer } from "@/server/container";
import { computeGstinChecksum } from "@/lib/gstin";
import * as orgsRoute from "@/app/api/organizations/route";
import * as membersRoute from "@/app/api/members/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import * as verifyRoute from "@/app/api/verify/route";
import * as annotateRoute from "@/app/api/verify/annotate/route";
import * as recentRoute from "@/app/api/verify/recent/route";
import * as previewRoute from "@/app/api/bulk-verify/preview/route";
import * as startRoute from "@/app/api/bulk-verify/route";
import * as jobRoute from "@/app/api/bulk-checks/[id]/route";
import * as itemsRoute from "@/app/api/bulk-checks/[id]/items/route";
import * as exportRoute from "@/app/api/bulk-checks/[id]/export/route";

const gst = (n: number) => { const b = `24AAAAA${String(n).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };
const list = (n: number, from = 1) => Array.from({ length: n }, (_, i) => gst(from + i));

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
  let json: { success: boolean; data?: any; error?: { code: string; message: string } } | null = null;
  try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: res.status, text, json: json!, headers: res.headers };
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
const preview = (as: string | undefined, org: string, gstins: unknown, extra: object = {}) => call(previewRoute.POST, req("POST", "/x", { as, org, body: { gstins, ...extra } }));
const start = (as: string, org: string, gstins: unknown, o: { key?: string } & object = {}) => { const { key, ...extra } = o as { key?: string }; return call(startRoute.POST, req("POST", "/x", { as, org, key, body: { gstins, ...extra } })); };
const idle = () => container().queue.idle();

beforeAll(() => {
  Object.assign(process.env, {
    AUTH_MODE: "dev", GST_PROVIDER: "mock", STORE: "memory", GST_RATE_LIMIT_PER_MIN: "1000000", GST_BACKOFF_BASE_MS: "1", GST_BACKOFF_MAX_MS: "2",
    MOCK_NOT_FOUND: gst(7), MOCK_TIMEOUT: "",
  });
});
beforeEach(async () => {
  resetContainer();
  orgA = await makeOrg("meet", "Shah & Co.");
  orgB = await makeOrg("zed", "Zed Tax");
  await addMember("meet", orgA, "priya", "ACCOUNTANT");
  await addMember("meet", orgA, "vik", "VIEWER");
});

describe("POST /api/bulk-verify/preview", () => {
  it("reports valid / invalid / duplicates / cache and consumes nothing", async () => {
    await call(verifyRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { gstin: gst(1) } }));
    const r = await preview("priya", orgA, [gst(1), gst(2), gst(2), "nope", gst(3).slice(0, 14) + "Q"]);
    expect(r.status).toBe(200);
    expect(r.json.data.preview).toMatchObject({ lines: 5, valid: 2, duplicates: 1, invalidCount: 2, servedFromCache: 1, needsLiveCheck: 1, bulkAllowed: true });
    expect(r.json.data.preview.invalid.map((i: any) => i.reason).sort()).toEqual(["CHECKSUM", "LENGTH"]);
    expect(container().verificationMetrics.snapshot(orgA).total).toBe(1);                 // preview made no verification
  });
  it("requires auth, an organization, checks:run and a well-formed body", async () => {
    expect((await preview(undefined, orgA, [gst(1)])).status).toBe(401);
    expect((await preview("vik", orgA, [gst(1)])).status).toBe(403);
    expect((await preview("priya", orgA, [])).json.error?.code).toBe("VALIDATION_ERROR");
    expect((await preview("priya", orgA, "x")).status).toBe(400);
    expect((await preview("zed", orgA, [gst(1)])).json.error?.code).toBe("NOT_A_MEMBER");
  });
});

describe("POST /api/bulk-verify and the shared job endpoints", () => {
  it("runs end to end: 202, progress, per-item answers (incl. NOT_FOUND), usage, then idempotent replay", async () => {
    const key = "bulk-verify-key-001";
    const s = await start("priya", orgA, [...list(6), "bad"], { key });
    expect(s.status).toBe(202);
    expect(s.json.data).toMatchObject({ replay: false, rejected: { invalidCount: 1, duplicates: 0 }, job: { kind: "verify", total: 6, includeReturns: false } });
    const id = s.json.data.job.id as string;
    await idle();
    const j = await call(jobRoute.GET, req("GET", "/x", { as: "vik", org: orgA }), { id });
    expect(j.json.data.job).toMatchObject({ kind: "verify", status: "completed", progress: { percent: 100 } });
    const items = await call(itemsRoute.GET, req("GET", "/x", { as: "vik", org: orgA }), { id });
    expect(items.json.data.items).toHaveLength(6);
    const by = Object.fromEntries(items.json.data.items.map((i: any) => [i.gstin, i]));
    expect(by[gst(7)]).toBeUndefined(); // only 1..6 were sent
    expect(by[gst(1)].verification.details.legalName).toMatch(/^MOCK /);
    expect(by[gst(1)].clientId).toBe("");
    const again = await start("priya", orgA, [...list(6), "bad"], { key });
    expect(again.status).toBe(200); expect(again.json.data.replay).toBe(true); expect(again.json.data.job.id).toBe(id);
  });
  it("NOT_FOUND is a result; the run completes without errors and costs only the found ones", async () => {
    const s = await start("priya", orgA, [gst(5), gst(6), gst(7)]);
    await idle();
    const id = s.json.data.job.id;
    const j = (await call(jobRoute.GET, req("GET", "/x", { as: "priya", org: orgA }), { id })).json.data.job;
    expect(j.status).toBe("completed"); expect(j.quota).toMatchObject({ consumed: 2, released: 1 });
    const items = (await call(itemsRoute.GET, req("GET", "/x", { as: "priya", org: orgA }), { id })).json.data.items;
    expect(items.find((i: any) => i.gstin === gst(7)).verification.outcome).toBe("NOT_FOUND");
  });
  it("refuses: no valid entries (400), viewer (403), bad key (400), other org's job (404)", async () => {
    expect((await start("priya", orgA, ["a", "b"])).json.error?.code).toBe("NO_VALID_GSTINS");
    expect((await start("vik", orgA, [gst(1)])).status).toBe(403);
    expect((await start("priya", orgA, [gst(1)], { key: "short" })).json.error?.code).toBe("VALIDATION_ERROR");
    const s = await start("priya", orgA, list(2));
    await idle();
    expect((await call(jobRoute.GET, req("GET", "/x", { as: "zed", org: orgB }), { id: s.json.data.job.id })).json.error?.code).toBe("JOB_NOT_FOUND");
  });
  it("Free plan: a list of many is a plan feature (403), a single GSTIN is allowed", async () => {
    const free = await makeOrg("solo", "Solo", "free");
    expect((await start("solo", free, list(3))).json.error?.code).toBe("FEATURE_NOT_AVAILABLE");
    expect((await start("solo", free, [gst(1)])).status).toBe(202);
  });
});

describe("GET /api/bulk-checks/{id}/export", () => {
  it("downloads a formula-safe CSV with answers, notes and tags; only for verification runs; per organization", async () => {
    const s = await start("priya", orgA, [gst(1), gst(2), gst(7)]);
    await idle();
    const id = s.json.data.job.id;
    expect((await call(annotateRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { gstin: gst(1), note: "+1 call", tags: ["Monthly", "Gujarat"] } }))).status).toBe(200);
    const r = await call(exportRoute.GET, req("GET", "/x", { as: "vik", org: orgA }), { id });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/csv"); expect(r.headers.get("content-disposition")).toContain("attachment");
    const raw = new Uint8Array(await (await (exportRoute.GET as unknown as (r: Request, x: { params: Promise<{ id: string }> }) => Promise<Response>)(req("GET", "/x", { as: "vik", org: orgA }), { params: Promise.resolve({ id }) })).arrayBuffer());
    expect([...raw.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);                              // UTF-8 BOM so Excel reads it (fetch's text() strips it)
    const lines = r.text.split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('"GSTIN","Result"');
    const row = lines.find((l) => l.startsWith(`"${gst(1)}"`))!;
    expect(row).toContain('"Monthly; Gujarat"'); expect(row).toContain(`"'+1 call"`);
    expect(lines.find((l) => l.startsWith(`"${gst(7)}"`))).toContain("No matching registration found");
    expect((await call(exportRoute.GET, req("GET", "/x", { as: "zed", org: orgB }), { id })).status).toBe(404);
    expect((await call(exportRoute.GET, req("GET", "/x", { org: orgA }), { id })).status).toBe(401);
  });
});

describe("POST /api/verify/annotate and tag filtering", () => {
  const annotate = (as: string, org: string, body: object) => call(annotateRoute.POST, req("POST", "/x", { as, org, body }));
  it("validates, stores, filters by tag, and is role/tenant checked", async () => {
    expect((await annotate("priya", orgA, { gstin: gst(1), note: "x" })).json.error?.code).toBe("VERIFICATION_NOT_FOUND");
    await call(verifyRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { gstin: gst(1) } }));
    const ok = await annotate("priya", orgA, { gstin: gst(1), note: "  call Monday ", tags: ["Taxes", "taxes"] });
    expect(ok.json.data).toEqual({ gstin: gst(1), note: "call Monday", tags: ["Taxes", "taxes"] }); // 's' is preserved (regression: whitespace regex)
    expect((await annotate("priya", orgA, { gstin: gst(1), tags: ["a", "b", "c", "d", "e", "f"] })).status).toBe(400);
    expect((await annotate("vik", orgA, { gstin: gst(1), note: "n" })).status).toBe(403);
    expect((await annotate("zed", orgB, { gstin: gst(1), note: "n" })).json.error?.code).toBe("VERIFICATION_NOT_FOUND");
    const tagged = await call(recentRoute.GET, req("GET", "/api/verify/recent?tag=Taxes", { as: "vik", org: orgA }));
    expect(tagged.json.data.items.map((i: any) => i.gstin)).toEqual([gst(1)]);
    expect((await call(recentRoute.GET, req("GET", "/api/verify/recent?tag=Nope", { as: "vik", org: orgA }))).json.data.items).toEqual([]);
  });
});
