import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { gstin } from "./gstins";

let counter = 0;
/** A unique, valid-looking email per call. Unique users keep tests independent on the shared in-memory server. */
export const uniqueEmail = (tag: string) => `${tag}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}@e2e.test`;

/** Mirrors the dev sign-in: uid is derived from the email, and the API accepts `dev:<uid>:<email>` as a bearer token. */
export const devUid = (email: string) => "dev-" + email.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const bearer = (email: string, verified = true) => `Bearer dev:${devUid(email)}:${email}${verified ? "" : ":unverified"}`;

export interface Workspace { email: string; name: string; orgId: string }

/** Creates a user's organization through the API (fast path for tests that are not about onboarding). */
export async function createWorkspace(request: APIRequestContext, o: { email?: string; plan?: string; firm?: string; name?: string } = {}): Promise<Workspace> {
  const email = o.email ?? uniqueEmail("owner");
  const res = await request.post("/api/organizations", { headers: { authorization: bearer(email) }, data: { name: o.firm ?? "E2E & Associates", plan: o.plan ?? "firm" } });
  expect(res.status(), await res.text()).toBe(201);
  const orgId = (await res.json()).data.organization.id as string;
  return { email, name: o.name ?? "E2E Owner", orgId };
}

/** Authenticated API call as `email` inside `orgId`. Returns parsed `data` and the status. */
export async function api(request: APIRequestContext, email: string, orgId: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, data?: unknown, headers: Record<string, string> = {}) {
  const res = await request.fetch(path, { method, headers: { authorization: bearer(email), "x-organization-id": orgId, ...headers }, data });
  const text = await res.text();
  let json: { success?: boolean; data?: any; error?: { code: string; message: string } } = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status(), data: json.data, error: json.error, text };
}

/** Adds `count` clients with distinct GSTINs starting at `from`. Returns their GSTINs. */
export async function addClients(request: APIRequestContext, w: Workspace, count: number, from = 100, prefix = "Client") {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const g = gstin(from + i);
    const r = await api(request, w.email, w.orgId, "POST", "/api/clients", { name: `${prefix} ${String(i + 1).padStart(2, "0")}`, gstin: g });
    expect(r.status, r.text).toBe(201);
    out.push(g);
  }
  return out;
}

/**
 * Signs the browser in as `email` before the first navigation (the dev sign-in keeps its session in localStorage). Runs once per tab, so a
 * test that signs out and reloads stays signed out.
 */
export async function signInAs(page: Page, email: string, o: { name?: string; verified?: boolean; theme?: "light" | "dark"; signedIn?: boolean; password?: string } = {}) {
  const acct = { uid: devUid(email), email, password: o.password ?? "E2e-password-1", name: o.name ?? "E2E User", verified: o.verified ?? true };
  await page.addInitScript(([a, theme, signedIn]) => {
    if (sessionStorage.getItem("e2e.seeded")) return;
    sessionStorage.setItem("e2e.seeded", "1");
    const all = JSON.parse(localStorage.getItem("ca.dev.accounts") ?? "{}"); all[a.email] = a;
    localStorage.setItem("ca.dev.accounts", JSON.stringify(all)); if (signedIn) localStorage.setItem("ca.dev.current", a.email); localStorage.setItem("ca.theme", theme);
  }, [acct, o.theme ?? "light", o.signedIn ?? true] as const);
}

/** Waits for the app shell (signed in, organization loaded). */
export async function appReady(page: Page) {
  await expect(page.locator("#main")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

/** Types into the GSTIN box the way a user does and submits. */
export async function verifyGstin(page: Page, value: string) {
  await page.getByLabel("GSTIN", { exact: true }).fill(value);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
}

/** A fresh browser context (a second person) signed in as `email`. Close it when done. */
export async function otherPerson(browser: import("@playwright/test").Browser, baseURL: string | undefined, email: string, o: { name?: string; theme?: "light" | "dark" } = {}) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signInAs(page, email, o);
  return { context, page };
}

/** The text of a download as UTF-8, with a flag for a leading byte-order mark (which `stream.toString()` would hide). */
export async function readDownload(download: import("@playwright/test").Download) {
  const path = await download.path();
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(path);
  return { bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, text: bytes.toString("utf8").replace(/^﻿/, ""), name: download.suggestedFilename() };
}
