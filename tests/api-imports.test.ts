/* eslint-disable @typescript-eslint/no-explicit-any -- test helper reads loosely-typed JSON envelopes */
import { PLANS } from "@/config/plans";
import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { container, resetContainer } from "@/server/container";
import { computeGstinChecksum } from "@/lib/gstin";
import * as orgsRoute from "@/app/api/organizations/route";
import * as membersRoute from "@/app/api/members/route";
import * as acceptRoute from "@/app/api/invitations/accept/route";
import * as clientsRoute from "@/app/api/clients/route";
import * as dashRoute from "@/app/api/dashboard/route";
import * as importsRoute from "@/app/api/imports/route";
import * as previewRoute from "@/app/api/imports/preview/route";
import * as importRoute from "@/app/api/imports/[id]/route";
import * as resumeRoute from "@/app/api/imports/[id]/resume/route";
import * as failedRoute from "@/app/api/imports/[id]/failed-rows/route";
import * as bulkJobRoute from "@/app/api/bulk-checks/[id]/route";

const gst = (n: number) => { const b = `24AAAAA${String(n).padStart(4, "0")}A1Z`; return b + computeGstinChecksum(b); };
const HEAD = "client_name,gstin,email,phone\n";
const rows = (n: number, start = 1) => Array.from({ length: n }, (_, i) => `Client ${start + i},${gst(start + i)},c${start + i}@x.test,`).join("\n") + "\n";

interface Opt { as?: string; org?: string; body?: unknown; rawBody?: string; key?: string; headers?: Record<string, string> }
function req(method: string, path: string, o: Opt = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...o.headers };
  if (o.as) headers.authorization = `Bearer dev:${o.as}:${o.as}@x.com`;
  if (o.org) headers["x-organization-id"] = o.org;
  if (o.key) headers["idempotency-key"] = o.key;
  return new Request(`http://localhost${path}`, { method, headers, body: o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) });
}
async function raw(h: unknown, r: Request, params?: Record<string, string>) {
  return (h as (r: Request, x: { params: Promise<never> }) => Promise<Response>)(r, { params: Promise.resolve(params ?? {}) as Promise<never> });
}
async function call(h: unknown, r: Request, params?: Record<string, string>) {
  const res = await raw(h, r, params);
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: res.status, text, json: json as { success: boolean; data?: any; error?: { code: string; message: string } }, headers: res.headers };
}

let orgA: string, orgB: string;
const makeOrg = async (uid: string, name: string, plan?: string) => (await call(orgsRoute.POST, req("POST", "/x", { as: uid, body: { name, plan } }))).json.data.organization.id as string;
async function addMember(owner: string, org: string, uid: string, role: string) {
  const inv = await call(membersRoute.POST, req("POST", "/x", { as: owner, org, body: { email: `${uid}@x.com`, role } }));
  expect((await call(acceptRoute.POST, req("POST", "/x", { as: uid, body: { token: inv.json.data.token } }))).status).toBe(200);
}
const settle = () => container().queue.idle();

beforeAll(() => { Object.assign(process.env, { AUTH_MODE: "dev", GST_PROVIDER: "mock", STORE: "memory", GST_RATE_LIMIT_PER_MIN: "1000000", GST_MAX_CONCURRENT: "5" }); });
beforeEach(async () => {
  resetContainer();
  orgA = await makeOrg("meet", "Shah & Co.", "professional");
  orgB = await makeOrg("zed", "Zed Tax", "professional");
  await addMember("meet", orgA, "priya", "ACCOUNTANT");
  await addMember("meet", orgA, "vik", "VIEWER");
});

describe("import API: happy path", () => {
  it("preview → start (202) → background import → idempotent replay (200) → clients, dashboard, failed-rows CSV", async () => {
    const csv = HEAD + rows(6) + `=HYPERLINK("http://evil","x"),BAD,,\nDup Row,${gst(1)},,\n`;
    const pre = await call(previewRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { csv } }));
    expect(pre.status).toBe(200);
    expect(pre.json.data.preview).toMatchObject({ totalRows: 8, counts: { valid: 6, invalid: 1, duplicate: 1, existing: 0 }, capacity: { fits: true } });

    const a = await call(importsRoute.POST, req("POST", "/x", { as: "priya", org: orgA, key: "csv-import-0001", body: { csv, fileName: "clients.csv" } }));
    expect(a.status).toBe(202);
    expect(a.json.data.replay).toBe(false);
    expect(a.json.data.import).toMatchObject({ status: "queued", totalRows: 8, createdBy: "dev-priya".replace("dev-", "") });
    expect(JSON.stringify(a.json)).not.toMatch(/fingerprint|"failedRows"/);
    const b = await call(importsRoute.POST, req("POST", "/x", { as: "priya", org: orgA, key: "csv-import-0001", body: { csv, fileName: "clients.csv" } }));
    expect(b.status).toBe(200); expect(b.json.data.replay).toBe(true); expect(b.json.data.import.id).toBe(a.json.data.import.id);

    await settle();
    const id = a.json.data.import.id;
    const got = await call(importRoute.GET, req("GET", "/x", { as: "vik", org: orgA }), { id });
    expect(got.json.data.import).toMatchObject({ status: "completed_with_errors", progress: { percent: 100 }, counts: { imported: 6, invalid: 1, duplicate: 1 }, failedRowsCount: 2 });
    // retry after completion still replays (the file's rows now exist, but the key wins)
    const c = await call(importsRoute.POST, req("POST", "/x", { as: "priya", org: orgA, key: "csv-import-0001", body: { csv, fileName: "clients.csv" } }));
    expect(c.status).toBe(200); expect(c.json.data.import.id).toBe(id);

    expect((await call(clientsRoute.GET, req("GET", "/x?limit=50", { as: "vik", org: orgA }))).json.data.items).toHaveLength(6);
    const dash = (await call(dashRoute.GET, req("GET", "/x", { as: "meet", org: orgA }))).json.data.dashboard;
    expect(dash.clients.total).toBe(6); expect(dash.gstins.neverChecked).toBe(6);

    const f = await raw(failedRoute.GET, req("GET", "/x", { as: "vik", org: orgA }), { id });
    expect(f.status).toBe(200);
    expect(f.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(f.headers.get("content-disposition")).toMatch(/^attachment; filename="import-[0-9a-f]{8}-failed-rows\.csv"$/);
    expect(f.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await f.text();
    expect(body.split("\r\n")).toHaveLength(3);
    expect(body).toContain(`"'=HYPERLINK`);                                           // formula neutralised
    expect(body).not.toMatch(/,"=HYPERLINK/);
  });

  it("verification option creates a bulk job through the SAME queue; both finish in the background", async () => {
    const r = await call(importsRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { csv: HEAD + rows(8), verify: { includeReturns: false } } }));
    expect(r.status).toBe(202);
    await settle(); // waits for the import AND the nested bulk job it enqueues
    const id = r.json.data.import.id;
    const imp = (await call(importRoute.GET, req("GET", "/x", { as: "meet", org: orgA }), { id })).json.data.import;
    expect(imp).toMatchObject({ status: "completed", counts: { imported: 8 }, verify: { requested: true, includeReturns: false } });
    const job = await call(bulkJobRoute.GET, req("GET", "/x", { as: "meet", org: orgA }), { id: imp.verify.jobId });
    expect(job.json.data.job).toMatchObject({ status: "completed", total: 8, counts: { succeeded: 8 }, quota: { consumed: 8 } });
    const dash = (await call(dashRoute.GET, req("GET", "/x", { as: "meet", org: orgA }))).json.data.dashboard;
    expect(dash.gstins.neverChecked).toBe(0); expect(dash.quota).toMatchObject({ used: 8, reserved: 0 });
  });

  it("10 simultaneous submissions create exactly one import", async () => {
    const csv = HEAD + rows(4);
    const res = await Promise.all(Array.from({ length: 10 }, () => call(importsRoute.POST, req("POST", "/x", { as: "meet", org: orgA, key: "csv-import-race1", body: { csv } }))));
    expect(new Set(res.map((r) => r.json.data.import.id)).size).toBe(1);
    expect(res.filter((r) => r.status === 202)).toHaveLength(1);
    await settle();
    expect((await call(importsRoute.GET, req("GET", "/x", { as: "meet", org: orgA }))).json.data.imports).toHaveLength(1);
  });
});

describe("import API: security", () => {
  const csv = HEAD + rows(3);
  it("401 without credentials on every endpoint", async () => {
    for (const [h, m, p] of [[importsRoute.GET, "GET"], [importsRoute.POST, "POST"], [previewRoute.POST, "POST"], [importRoute.GET, "GET", { id: "x" }], [resumeRoute.POST, "POST", { id: "x" }], [failedRoute.GET, "GET", { id: "x" }]] as const) {
      const r = await call(h, req(m, "/x", { body: m === "POST" ? { csv } : undefined }), p as Record<string, string> | undefined);
      expect(r.status).toBe(401); expect(r.json.error!.code).toBe("UNAUTHENTICATED");
    }
  });
  it("viewer can read but not preview/start/resume; forged org header is rejected", async () => {
    const ok = await call(importsRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { csv } }));
    const id = ok.json.data.import.id;
    for (const r of [await call(previewRoute.POST, req("POST", "/x", { as: "vik", org: orgA, body: { csv } })), await call(importsRoute.POST, req("POST", "/x", { as: "vik", org: orgA, body: { csv: HEAD + rows(2, 100) } })), await call(resumeRoute.POST, req("POST", "/x", { as: "vik", org: orgA }), { id })]) {
      expect(r.status).toBe(403); expect(r.json.error!.code).toBe("FORBIDDEN");
    }
    expect((await call(importRoute.GET, req("GET", "/x", { as: "vik", org: orgA }), { id })).status).toBe(200);
    expect((await call(importsRoute.GET, req("GET", "/x", { as: "vik", org: orgA }))).json.data.imports).toHaveLength(1);
    for (const h of [importsRoute.GET, importsRoute.POST, previewRoute.POST]) {
      const isGet = h === importsRoute.GET;
      const r = await call(h, req(isGet ? "GET" : "POST", "/x", { as: "zed", org: orgA, body: isGet ? undefined : { csv } }));
      expect(r.status).toBe(403); expect(r.json.error!.code).toBe("NOT_A_MEMBER");
    }
    await settle();
  });
  it("organization B cannot read, export or resume organization A's import; nothing leaks across orgs", async () => {
    const ok = await call(importsRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { csv } }));
    const id = ok.json.data.import.id;
    await settle();
    for (const [h, m] of [[importRoute.GET, "GET"], [failedRoute.GET, "GET"], [resumeRoute.POST, "POST"]] as const) {
      const r = await call(h, req(m, "/x", { as: "zed", org: orgB }), { id });
      expect(r.status).toBe(404); expect(r.json.error!.code).toBe("IMPORT_NOT_FOUND");
      expect((await call(h, req(m, "/x", { as: "zed", org: orgA }), { id })).json.error!.code).toBe("NOT_A_MEMBER");
    }
    expect((await call(importsRoute.GET, req("GET", "/x", { as: "zed", org: orgB }))).json.data.imports).toEqual([]);
    const same = await call(importsRoute.POST, req("POST", "/x", { as: "zed", org: orgB, body: { csv } }));
    expect(same.status).toBe(202);                                  // the same GSTINs are fine in another firm
    await settle();
    expect((await call(dashRoute.GET, req("GET", "/x", { as: "zed", org: orgB }))).json.data.dashboard.clients.total).toBe(3);
  });
  it("request bodies cannot inject ownership, status or counters", async () => {
    const r = await call(importsRoute.POST, req("POST", "/x", { as: "priya", org: orgA, body: { csv, organizationId: orgB, createdBy: "someone-else", status: "completed", counts: { imported: 999 }, processed: 999 } }));
    expect(r.status).toBe(202);
    await settle();
    const imp = (await call(importRoute.GET, req("GET", "/x", { as: "priya", org: orgA }), { id: r.json.data.import.id })).json.data.import;
    expect(imp).toMatchObject({ organizationId: orgA, createdBy: "priya", status: "completed", counts: { imported: 3 }, processed: 3 });
    expect((await call(dashRoute.GET, req("GET", "/x", { as: "zed", org: orgB }))).json.data.dashboard.clients.total).toBe(0);
  });
  it("oversized uploads are refused (declared length, undeclared length, and CSV over 5 MB) with safe errors", async () => {
    const declared = await call(importsRoute.POST, req("POST", "/x", { as: "meet", org: orgA, rawBody: "{}", headers: { "content-length": "7000000" } }));
    expect(declared.status).toBe(413); expect(declared.json.error!.code).toBe("PAYLOAD_TOO_LARGE");
    const undeclared = await call(previewRoute.POST, req("POST", "/x", { as: "meet", org: orgA, rawBody: JSON.stringify({ csv: "a".repeat(6_100_000) }) }));
    expect(undeclared.status).toBe(413); expect(undeclared.json.error!.code).toBe("PAYLOAD_TOO_LARGE");
    const big = await call(previewRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { csv: "a".repeat(5_500_000) } }));
    expect(big.status).toBe(413); expect(big.json.error!.code).toBe("FILE_TOO_LARGE");
    const bad = await call(importsRoute.POST, req("POST", "/x", { as: "meet", org: orgA, rawBody: "{not json" }));
    expect(bad.status).toBe(400);
    expect(JSON.stringify([declared.json, undeclared.json, big.json, bad.json])).not.toMatch(/at\s.*\(|node_modules|SyntaxError/);
  });
});

describe("import API: limits and validation", () => {
  it("plan client limit: 402 unless the user opts into a partial import", async () => {
    const free = await makeOrg("fran", "Free Firm");
    const CAP = PLANS.free.clientLimit!;
    const csv = HEAD + rows(CAP + 5);
    const pre = await call(previewRoute.POST, req("POST", "/x", { as: "fran", org: free, body: { csv } }));
    expect(pre.json.data.preview.capacity).toMatchObject({ limit: CAP, remaining: CAP, fits: false, willSkip: 5 });
    const no = await call(importsRoute.POST, req("POST", "/x", { as: "fran", org: free, body: { csv } }));
    expect(no.status).toBe(402); expect(no.json.error!.code).toBe("CLIENT_LIMIT_REACHED");
    const yes = await call(importsRoute.POST, req("POST", "/x", { as: "fran", org: free, body: { csv, allowPartialClients: true } }));
    expect(yes.status).toBe(202);
    await settle();
    expect((await call(importRoute.GET, req("GET", "/x", { as: "fran", org: free }), { id: yes.json.data.import.id })).json.data.import).toMatchObject({ status: "completed_with_errors", counts: { imported: PLANS.free.clientLimit, skippedPlanLimit: 5 } });
  });
  it("structured validation errors", async () => {
    const p = (body: unknown) => call(previewRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body }));
    expect((await p({ csv: "name,email\nx,y@z.com\n" })).json.error!.code).toBe("MAPPING_REQUIRED");
    expect((await p({ csv: "client_name,gstin\n" })).json.error!.code).toBe("EMPTY_FILE");
    expect((await p({ csv: HEAD + rows(1), mapping: { gstin: 99 } })).json.error!.code).toBe("VALIDATION_ERROR");
    expect((await call(importsRoute.POST, req("POST", "/x", { as: "meet", org: orgA, body: { csv: HEAD + "Bad,NOPE,,\n" } }))).json.error!.code).toBe("NO_VALID_ROWS");
    expect((await call(importsRoute.POST, req("POST", "/x", { as: "meet", org: orgA, key: "short", body: { csv: HEAD + rows(1) } }))).json.error!.code).toBe("VALIDATION_ERROR");
  });
});
