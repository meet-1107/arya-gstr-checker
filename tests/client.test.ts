import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { formatInr, formatNumber, greeting, initials, firstName, periodLabel, relativeTime } from "@/lib/client/format";
import { safeNext } from "@/lib/client/safe-next";

/** Minimal browser globals so the client-side modules can run under Node. */
function stubBrowser() {
  const store = new Map<string, string>();
  const win = new EventTarget() as EventTarget & { localStorage: Storage };
  win.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0 } as Storage;
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", win.localStorage);
  return win;
}

describe("formatting", () => {
  it("formats money, numbers and periods the Indian way", () => {
    expect(formatInr(0)).toBe("₹0");
    expect(formatInr(24990)).toBe("₹24,990");
    expect(formatInr(null)).toBe("Custom");
    expect(formatNumber(1375)).toBe("1,375");
    expect(formatNumber(1234567)).toBe("12,34,567");
    expect(formatNumber(undefined)).toBe("—");
    expect(periodLabel("082026")).toBe("Aug 2026");
    expect(periodLabel("032027")).toBe("Mar 2027");
  });
  it("relative time and greeting (IST)", () => {
    const now = Date.parse("2026-10-06T10:00:00Z");
    expect(relativeTime(undefined, now)).toBe("Never");
    expect(relativeTime("2026-10-06T09:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-10-06T09:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-10-05T10:00:00Z", now)).toBe("1 day ago");
    expect(greeting(new Date("2026-10-06T04:00:00Z"))).toBe("Good morning");   // 09:30 IST
    expect(greeting(new Date("2026-10-06T09:00:00Z"))).toBe("Good afternoon"); // 14:30 IST
    expect(greeting(new Date("2026-10-06T14:00:00Z"))).toBe("Good evening");   // 19:30 IST
  });
  it("names and initials", () => {
    expect(initials("Meet Patel")).toBe("MP");
    expect(initials(undefined, "priya.shah@x.com")).toBe("PS");
    expect(firstName("Meet Patel")).toBe("Meet");
    expect(firstName(undefined, "priya@x.com")).toBe("priya");
    expect(firstName()).toBe("there");
  });
});

describe("safeNext (open-redirect guard)", () => {
  it("allows same-site paths only", () => {
    expect(safeNext("/dashboard")).toBe("/dashboard");
    expect(safeNext("/invite?token=abc")).toBe("/invite?token=abc");
    for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "javascript:alert(1)", "evil.com", "", null, undefined, "/ok\nSet-Cookie:x"]) {
      expect(safeNext(bad as string | null)).toBeNull();
    }
  });
});

describe("dev auth client", () => {
  beforeEach(() => { vi.resetModules(); stubBrowser(); });
  afterEach(() => vi.unstubAllGlobals());

  it("registers, issues unverified then verified dev tokens, and rejects bad credentials", async () => {
    const { getAuthClient } = await import("@/lib/client/auth-client");
    const c = getAuthClient();
    expect(c.mode).toBe("dev");
    expect(await c.getToken()).toBeNull();
    await c.signUp("Meet@PatelCA.test", "pw-12345678", "Meet Patel");
    expect(await c.getToken()).toBe("dev:dev-meet-patelca-test:meet@patelca.test:unverified");
    await expect(c.signUp("meet@patelca.test", "x12345678")).rejects.toMatchObject({ code: "auth/email-already-in-use" });
    await c.devVerifyEmail!();
    expect(await c.getToken()).toBe("dev:dev-meet-patelca-test:meet@patelca.test");
    await c.signOut();
    expect(await c.getToken()).toBeNull();
    await expect(c.signIn("meet@patelca.test", "wrong")).rejects.toMatchObject({ code: "auth/invalid-credential", message: "Incorrect email or password." });
    await expect(c.signIn("nobody@x.com", "whatever")).rejects.toMatchObject({ message: "Incorrect email or password." }); // same message: no account enumeration
    await c.signIn("meet@patelca.test", "pw-12345678");
    expect(await c.getToken()).toContain("dev:dev-meet-patelca-test");
  });
  it("notifies subscribers and supports password reset", async () => {
    const { getAuthClient } = await import("@/lib/client/auth-client");
    const c = getAuthClient();
    const seen: (string | null)[] = [];
    const off = c.subscribe((u) => seen.push(u?.email ?? null));
    await Promise.resolve(); // let the initial state be delivered first (in the app, subscribe happens at mount)
    await c.signUp("a@x.com", "password-1");
    await c.signOut();
    off();
    expect(seen).toEqual([null, "a@x.com", null]);
    const { devLink } = await c.sendPasswordReset("A@x.com");
    expect(devLink).toContain("/reset-password?code=");
    const code = decodeURIComponent(devLink!.split("code=")[1]);
    await expect(c.confirmPasswordReset("dev:ghost@x.com", "newpassword1")).rejects.toMatchObject({ code: "auth/invalid-action-code" });
    await c.confirmPasswordReset(code, "newpassword1");
    await c.signIn("a@x.com", "newpassword1");
    expect(await c.getToken()).toContain("a@x.com");
  });
  it("Firebase-less PRODUCTION build fails closed: nobody can sign in, but the site still builds/renders", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_AUTH_MODE", "dev"); // must be ignored in production
    const { getAuthClient } = await import("@/lib/client/auth-client");
    const c = getAuthClient();
    expect(c.mode).toBe("unconfigured");
    expect(await c.getToken()).toBeNull();
    await expect(c.signIn("a@x.com", "b")).rejects.toMatchObject({ code: "auth/not-configured" });
    await expect(c.signUp("a@x.com", "b")).rejects.toMatchObject({ code: "auth/not-configured" });
    vi.unstubAllEnvs();
  });
});

describe("api() envelope handling", () => {
  beforeEach(() => { vi.resetModules(); stubBrowser(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends bearer + org selector, unwraps data", async () => {
    const { getAuthClient } = await import("@/lib/client/auth-client");
    const { api } = await import("@/lib/client/api");
    const c = getAuthClient(); await c.signUp("a@x.com", "password-1"); await c.devVerifyEmail!();
    const fetchMock = vi.fn().mockResolvedValue(json(200, { success: true, data: { hello: "world" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await api<{ hello: string }>("/api/x", { org: "org-1", method: "POST", body: { a: 1 } })).toEqual({ hello: "world" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("/api/x");
    expect(init.headers.authorization).toMatch(/^Bearer dev:dev-a-x-com:a@x\.com$/);
    expect(init.headers["x-organization-id"]).toBe("org-1");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.method).toBe("POST");
    expect(init.cache).toBe("no-store");
  });
  it("maps structured errors, network failures and non-JSON responses to ApiError", async () => {
    const { api, ApiError, errorMessage } = await import("@/lib/client/api");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(402, { success: false, error: { code: "QUOTA_EXHAUSTED", message: "Not enough GST checks remaining this month." } })));
    const e = await api("/api/x").catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ code: "QUOTA_EXHAUSTED", status: 402 });
    expect(errorMessage(e)).toBe("Not enough GST checks remaining this month.");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("fetch failed: ECONNREFUSED 127.0.0.1")));
    const n = (await api("/api/x").catch((x) => x)) as Error;
    expect(n).toMatchObject({ code: "NETWORK_ERROR", status: 0 });
    expect(n.message).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("<html>Bad gateway</html>", { status: 502 })));
    const h = (await api("/api/x").catch((x) => x)) as Error;
    expect(h).toMatchObject({ code: "SERVER_ERROR", status: 502 });
    expect(h.message).not.toMatch(/html|gateway/i);
    expect(errorMessage(new Error("internal secret"))).toBe("Something went wrong. Please try again.");
  });
  it("a 401 signals the session to sign out", async () => {
    const { api, UNAUTHORIZED_EVENT } = await import("@/lib/client/api");
    const heard = vi.fn();
    (window as unknown as EventTarget).addEventListener(UNAUTHORIZED_EVENT, heard);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(401, { success: false, error: { code: "UNAUTHENTICATED", message: "Please sign in." } })));
    await expect(api("/api/me")).rejects.toMatchObject({ status: 401 });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
