import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { addClients, api, createWorkspace, signInAs } from "./helpers";
import { gstin, NOT_FOUND_GSTIN, TIMEOUT_GSTIN } from "./gstins";

// WCAG 2.0/2.1/2.2 A + AA and axe best practices, in both themes, on public pages and on the main app screens with real data.
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function audit(page: Page, label: string) {
  // Transitions off so a colour mid-fade is not measured.
  await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(r.violations.map((v) => `${v.id} x${v.nodes.length} ${v.nodes[0]?.target.join(" ")}`), label).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`accessibility — ${theme}`, () => {
    test("public pages", async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("ca.theme", t), theme);
      for (const route of ["/", "/pricing", "/login", "/register", "/forgot-password"]) {
        await page.goto(route);
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        await audit(page, `${route} (${theme})`);
      }
    });

    for (const route of ["/dashboard", "/verify", "/verify/bulk", "/portfolio", "/clients", "/gstins", "/bulk-checks", "/alerts", "/reports", "/reports/summary", "/team", "/billing", "/settings", "/audit-logs", "/concerns", "/clients/import"]) {
      test(`app screen ${route}`, async ({ page, request }) => {
        const w = await createWorkspace(request, { plan: "firm" });
        const gs = await addClients(request, w, 6, 1000 + (theme === "dark" ? 50 : 0), "A11y Client");
        for (const g of gs.slice(0, 4)) await api(request, w.email, w.orgId, "POST", "/api/verify", { gstin: g });
        await api(request, w.email, w.orgId, "POST", "/api/portfolio/schedule", { all: true, schedule: "weekly" });
        await signInAs(page, w.email, { theme });
        await page.goto(route);
        await expect(page.locator("#main")).toBeVisible();
        await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        await audit(page, `${route} (${theme})`);
      });
    }

    test("verification states: result, not found, timeout, invalid, scanner dialog", async ({ page, request }) => {
      const w = await createWorkspace(request, { plan: "firm" });
      await signInAs(page, w.email, { theme });
      await page.goto("/verify");
      const input = page.getByLabel("GSTIN", { exact: true });
      const verify = page.getByRole("button", { name: "Verify", exact: true });
      await input.fill(gstin(1200 + (theme === "dark" ? 1 : 0))); await verify.click();
      await expect(page.getByText("Verified live")).toBeVisible(); await audit(page, `result (${theme})`);
      await input.fill(NOT_FOUND_GSTIN); await verify.click();
      await expect(page.getByText("No matching registration found").first()).toBeVisible(); await audit(page, `not found (${theme})`);
      await input.fill(TIMEOUT_GSTIN); await verify.click();
      await expect(page.getByText("We couldn't verify this right now").first()).toBeVisible();
      await page.getByRole("button", { name: "Why did this happen?" }).click(); await audit(page, `timeout + why (${theme})`);
      await input.fill(gstin(1210).slice(0, 14) + "0"); await verify.click();
      await expect(page.getByText("Not a valid GSTIN")).toBeVisible(); await audit(page, `invalid (${theme})`);
      await page.getByRole("button", { name: "Scan a GSTIN or QR code" }).click();
      await expect(page.getByRole("dialog")).toBeVisible(); await audit(page, `scanner dialog (${theme})`);
    });

    test("dialogs: refresh and schedule", async ({ page, request }) => {
      const w = await createWorkspace(request, { plan: "firm" });
      await addClients(request, w, 4, 1300 + (theme === "dark" ? 10 : 0));
      await signInAs(page, w.email, { theme });
      await page.goto("/portfolio");
      await page.getByRole("button", { name: /Refresh \d+ that need it/ }).click();
      await expect(page.getByRole("dialog").getByText("Will be verified")).toBeVisible(); await audit(page, `refresh dialog (${theme})`);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Schedule", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible(); await audit(page, `schedule dialog (${theme})`);
    });
  });
}
