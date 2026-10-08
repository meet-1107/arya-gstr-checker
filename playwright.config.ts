import { defineConfig, devices } from "@playwright/test";
import { NOT_FOUND_GSTIN, TIMEOUT_GSTIN } from "./e2e/gstins";

/**
 * End-to-end suite. It starts its OWN `next dev` server on its own port and its own dist folder (.next-e2e), so it never touches a
 * developer's server or .next. It must be a development server: the dev sign-in and the mock GST provider (what makes these tests possible
 * and deterministic) are refused by production builds by design. Everything is local and fake: in-memory store, dev sign-in, mock provider.
 * Nothing here proves Firebase, Firestore, a real GST provider or a production build (see README "End-to-end tests").
 *
 * Tests are independent: each creates its own user(s) and organization (unique emails), so they run in parallel against the one in-memory
 * server. Mock-provider scenarios are keyed by GSTIN (e2e/gstins.ts), never global, so one test cannot slow or break another.
 */
const PORT = Number(process.env.E2E_PORT ?? 3170);
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  outputDir: "test-results/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 2,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: { baseURL: BASE, trace: "retain-on-failure", screenshot: "only-on-failure", video: "off", actionTimeout: 20_000, navigationTimeout: 60_000 },
  projects: [
    { name: "desktop", testIgnore: /responsive\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "phone", testMatch: /responsive\.spec\.ts/, use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `${BASE}/api/health`,
    timeout: 180_000,
    reuseExistingServer: process.env.E2E_REUSE === "1",
    stdout: "ignore",
    stderr: "pipe",
    env: {
      NEXT_DIST_DIR: ".next-e2e",
      AUTH_MODE: "dev", NEXT_PUBLIC_AUTH_MODE: "dev", STORE: "memory", GST_PROVIDER: "mock",
      GST_RATE_LIMIT_PER_MIN: "1000000", GST_MAX_CONCURRENT: "10", GST_RETRIES: "0", GST_BACKOFF_BASE_MS: "1", GST_BACKOFF_MAX_MS: "2", GST_BREAKER_THRESHOLD: "100000",
      MOCK_NOT_FOUND: NOT_FOUND_GSTIN, MOCK_TIMEOUT: TIMEOUT_GSTIN, MOCK_DELAY_MS: "",
      VERIFY_ORG_PER_MINUTE: "100000", VERIFY_ORG_PER_DAY: "1000000",
      CRON_SECRET: "e2e-cron-secret", NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
