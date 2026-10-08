/* eslint-disable @typescript-eslint/no-explicit-any -- route modules are enumerated dynamically */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkProductionEnv } from "@/config/preflight";
import { resetContainer } from "@/server/container";
import nextConfig from "../next.config";

const root = path.resolve(__dirname, "..");
const walk = (dir: string, out: string[] = []): string[] => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else out.push(p); } return out; };

const GOOD: Record<string, string> = {
  STORE: "firestore", AUTH_MODE: "firebase", GST_PROVIDER: "someprovider-with-adapter",
  NEXT_PUBLIC_FIREBASE_API_KEY: "k", NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "p.firebaseapp.com", NEXT_PUBLIC_FIREBASE_PROJECT_ID: "p", FIREBASE_PROJECT_ID: "p",
  CRON_SECRET: "x".repeat(32),
};

describe("preflight (production configuration check)", () => {
  it("a bare / development environment fails, and says why", () => {
    const r = checkProductionEnv({ STORE: "memory", AUTH_MODE: "dev", GST_PROVIDER: "mock", NEXT_PUBLIC_AUTH_MODE: "dev" });
    expect(r.ok).toBe(false);
    const all = r.errors.join("\n");
    for (const needle of ["STORE=memory", "AUTH_MODE=dev", "NEXT_PUBLIC_AUTH_MODE=dev", "GST_PROVIDER=mock", "NEXT_PUBLIC_FIREBASE_API_KEY", "FIREBASE_PROJECT_ID"]) expect(all).toContain(needle);
  });
  it("a complete configuration passes (provider names without an adapter are tested separately), keeping its honest warnings", () => {
    const r = checkProductionEnv({ ...GOOD, GST_PROVIDER: "mock", ALLOW_MOCK_IN_PRODUCTION: "true-for-staging-only" });
    expect(r.errors).toEqual([]); expect(r.ok).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/FAKE/); expect(r.warnings.join("\n")).toMatch(/UNVERIFIED/); expect(r.warnings.join("\n")).toMatch(/in-process/);
  });
  it("real provider names still fail until an adapter exists; unknown names fail", () => {
    for (const p of ["gstinapi", "whitebooks"]) expect(checkProductionEnv({ ...GOOD, GST_PROVIDER: p }).errors.join()).toMatch(/no verified adapter/);
    expect(checkProductionEnv({ ...GOOD, GST_PROVIDER: "acme" }).errors.join()).toMatch(/not a known provider/);
  });
  it("catches half-set service accounts, malformed keys, project mismatch, dev switches, bad numbers and weak secrets", () => {
    const base = { ...GOOD, GST_PROVIDER: "mock", ALLOW_MOCK_IN_PRODUCTION: "true-for-staging-only" };
    expect(checkProductionEnv({ ...base, FIREBASE_CLIENT_EMAIL: "a@b.iam" }).errors.join()).toMatch(/set together/);
    expect(checkProductionEnv({ ...base, FIREBASE_CLIENT_EMAIL: "a@b.iam", FIREBASE_PRIVATE_KEY: "not a key" }).errors.join()).toMatch(/PEM/);
    expect(checkProductionEnv({ ...base, FIREBASE_CLIENT_EMAIL: "a@b.iam", FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----" }).ok).toBe(true);
    expect(checkProductionEnv({ ...base, FIREBASE_PROJECT_ID: "other" }).errors.join()).toMatch(/differ/);
    for (const k of ["MOCK_NOT_FOUND", "MOCK_TIMEOUT", "MOCK_DELAY_MS"]) expect(checkProductionEnv({ ...base, [k]: "1" }).errors.join()).toContain(k);
    expect(checkProductionEnv({ ...base, GST_TIMEOUT_MS: "abc" }).errors.join()).toMatch(/GST_TIMEOUT_MS/);
    expect(checkProductionEnv({ ...base, GST_RETRIES: "0" }).errors.join()).toMatch(/GST_RETRIES/);
    expect(checkProductionEnv({ ...base, CRON_SECRET: "short" }).errors.join()).toMatch(/CRON_SECRET/);
    expect(checkProductionEnv({ ...base, GST_TIMEOUT_MS: "60000" }).warnings.join()).toMatch(/20 s/);
    expect(checkProductionEnv({ ...base, BULK_CONCURRENCY: "9", GST_MAX_CONCURRENT: "3" }).warnings.join()).toMatch(/BULK_CONCURRENCY/);
  });
  it("never echoes secret values back", () => {
    const r = checkProductionEnv({ ...GOOD, GST_PROVIDER: "mock", FIREBASE_PRIVATE_KEY: "SUPER-SECRET-VALUE", FIREBASE_CLIENT_EMAIL: "svc@x", CRON_SECRET: "tiny-secret-1" });
    expect(JSON.stringify(r)).not.toContain("SUPER-SECRET-VALUE"); expect(JSON.stringify(r)).not.toContain("tiny-secret-1");
  });
});

describe("every API route is protected", () => {
  beforeAll(() => { Object.assign(process.env, { AUTH_MODE: "dev", STORE: "memory", GST_PROVIDER: "mock", CRON_SECRET: "a-cron-secret-that-is-long-enough-123", MOCK_NOT_FOUND: "", MOCK_TIMEOUT: "", MOCK_DELAY_MS: "" }); resetContainer(); });
  const routes = walk(path.join(root, "src/app/api")).filter((f) => f.endsWith("route.ts"));
  /** Routes that are intentionally NOT behind a user sign-in, with the status an anonymous caller must get. */
  const PUBLIC: Record<string, Record<string, number>> = {
    "health/route.ts": { GET: 200 }, "ready/route.ts": { GET: 200 },
    "internal/portfolio-due/route.ts": { POST: 404 }, // secret-protected scheduler hook; 404 hides its existence
  };
  it("finds the routes (guards against the glob silently matching nothing)", () => { expect(routes.length).toBeGreaterThan(50); });
  for (const file of routes) {
    const rel = path.relative(path.join(root, "src/app/api"), file).replace(/\\/g, "/");
    it(`/api/${rel.replace(/\/?route\.ts$/, "")}: anonymous callers get ${PUBLIC[rel] ? "the documented public answer" : "401"}`, async () => {
      const mod: any = await import(/* @vite-ignore */ file.replace(/\\/g, "/"));
      const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof mod[m] === "function");
      expect(methods.length, "route exports no HTTP method").toBeGreaterThan(0);
      for (const m of methods) {
        const res: Response = await mod[m](new Request("http://localhost/x", { method: m, headers: { "content-type": "application/json" }, body: m === "GET" || m === "DELETE" ? undefined : "{}" }), { params: Promise.resolve({ id: "x", gstin: "24AAAAA0001A1Z7" }) });
        const expected = PUBLIC[rel]?.[m] ?? 401;
        expect(res.status, `${m} ${rel}`).toBe(expected);
        const text = await res.text();
        expect(text).not.toMatch(/stack|at \S+ \(|node_modules|FIREBASE|PRIVATE KEY/i);   // errors never leak internals
      }
    });
  }
});

describe("health and readiness", () => {
  afterEach(() => { process.env.STORE = "memory"; process.env.AUTH_MODE = "dev"; resetContainer(); });
  it("liveness is a plain 200 with no data", async () => {
    const { GET } = await import("@/app/api/health/route");
    const r = await GET(); expect(r.status).toBe(200); expect(await r.json()).toEqual({ status: "ok" }); expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("readiness is 200 when the store answers", async () => {
    const { GET } = await import("@/app/api/ready/route");
    resetContainer(); const r = await GET(); expect(r.status).toBe(200); expect(await r.json()).toEqual({ status: "ready" });
  });
  it("readiness is 503 on a broken configuration and names only the failing check, not the reason", async () => {
    const { GET } = await import("@/app/api/ready/route");
    process.env.AUTH_MODE = "firebase"; process.env.STORE = "firestore"; delete process.env.FIREBASE_PROJECT_ID; delete process.env.FIREBASE_PRIVATE_KEY; resetContainer();
    const r = await GET(); const body = await r.json();
    expect(r.status).toBe(503); expect(body.status).toBe("unavailable"); expect(body.failing.length).toBeGreaterThan(0);
    expect(Object.keys(body).sort()).toEqual(["failing", "status"]); expect(JSON.stringify(body)).not.toMatch(/firebase|credential|project|key/i);
  });
});

describe("security headers", () => {
  it("are sent on every route with the values we rely on", async () => {
    const rules = await (nextConfig as any).headers();
    expect(rules).toHaveLength(1); expect(rules[0].source).toBe("/:path*");
    const h = Object.fromEntries(rules[0].headers.map((x: any) => [x.key, x.value]));
    expect(h["X-Content-Type-Options"]).toBe("nosniff"); expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toContain("camera=(self)");           // the scanner must keep working
    expect(h["Permissions-Policy"]).toMatch(/microphone=\(\)/); expect(h["Permissions-Policy"]).toMatch(/geolocation=\(\)/);
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin-allow-popups"); // Firebase popup sign-in
    const csp = h["Content-Security-Policy-Report-Only"];
    expect(csp).toContain("object-src 'none'"); expect(csp).toContain("base-uri 'self'"); expect(csp).toContain("form-action 'self'");
    expect(h["Content-Security-Policy"]).toBeUndefined();                  // report-only by design (see next.config.ts)
    expect((nextConfig as any).poweredByHeader).toBe(false);
  });
});

describe("error pages", () => {
  it("exist, and the error boundaries never render the error message or stack", () => {
    for (const f of ["error.tsx", "global-error.tsx", "not-found.tsx"]) expect(fs.existsSync(path.join(root, "src/app", f)), f).toBe(true);
    for (const f of ["error.tsx", "global-error.tsx"]) {
      const src = fs.readFileSync(path.join(root, "src/app", f), "utf8");
      expect(src).not.toMatch(/error\.message|error\.stack|\{error\}/);
      expect(src).toMatch(/error\.digest/);
    }
  });
});

describe("configuration hygiene", () => {
  const src = walk(path.join(root, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
  it("browser code reads only NEXT_PUBLIC_* (and NODE_ENV) from the environment — never a server secret", () => {
    const browser = src.filter((f) => /["']use client["']/.test(fs.readFileSync(f, "utf8").slice(0, 200)) || /[\\/](components|lib[\\/]client)[\\/]/.test(f));
    const bad: string[] = [];
    for (const f of browser) for (const m of fs.readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)) if (!/^NEXT_PUBLIC_|^NODE_ENV$/.test(m[1])) bad.push(`${path.relative(root, f)}: ${m[1]}`);
    expect(bad).toEqual([]);
  });
  it("every environment variable the server reads is documented in .env.example", () => {
    const documented = new Set([...fs.readFileSync(path.join(root, ".env.example"), "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]+)\s*=/gm)].map((m) => m[1]));
    const NOT_CONFIG = new Set(["NODE_ENV", "NEXT_RUNTIME", "NEXT_DIST_DIR", "FIRESTORE_EMULATOR_HOST", "CI"]);
    const used = new Map<string, string>();
    for (const f of src) for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]{2,})/g)) if (!NOT_CONFIG.has(m[1]) && !used.has(m[1])) used.set(m[1], path.relative(root, f));
    const missing = [...used].filter(([k]) => !documented.has(k)).map(([k, f]) => `${k} (${f})`);
    expect(missing, "add these to .env.example").toEqual([]);
  });
});

describe("client response guard", () => {
  it("accepts a real view and rejects malformed bodies and outcomes this build does not know", async () => {
    const { isVerificationView } = await import("@/lib/verification");
    const ok = { requestId: "r", gstin: "24AAAAA0001A1Z7", outcome: "ACTIVE", formatValid: true, freshness: "live", retryable: false, durationMs: 1 };
    expect(isVerificationView(ok)).toBe(true);
    for (const bad of [null, undefined, 1, "x", {}, { ...ok, outcome: "FROM_THE_FUTURE" }, { ...ok, outcome: "toString" }, { ...ok, gstin: 5 }, { ...ok, requestId: undefined }]) expect(isVerificationView(bad)).toBe(false);
  });
});
