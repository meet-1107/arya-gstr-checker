import { expect, test } from "@playwright/test";
import { addClients, api, createWorkspace, signInAs } from "./helpers";

// Runs in the "phone" project (Pixel 7 emulation: touch, narrow viewport).
const ROUTES = ["/dashboard", "/verify", "/verify/bulk", "/portfolio", "/clients", "/gstins", "/bulk-checks", "/alerts", "/reports", "/settings"];

test("phone: every main screen fits the screen (no sideways scrolling) and the bottom bar and drawer work", async ({ page, request }) => {
  const w = await createWorkspace(request, { plan: "firm" });
  const gs = await addClients(request, w, 6, 900, "Phone Client");
  for (const g of gs.slice(0, 3)) await api(request, w.email, w.orgId, "POST", "/api/verify", { gstin: g });
  await signInAs(page, w.email);

  for (const route of ROUTES) {
    await page.goto(route);
    await expect(page.locator("#main")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect.soft(overflow, `${route} overflows horizontally by ${overflow}px`).toBeLessThanOrEqual(0);
    await expect(page.getByRole("navigation", { name: "Quick navigation" }), `${route}: bottom bar`).toBeVisible();
  }

  // Drawer: opens from the top bar, lists the whole navigation, closes, and navigating from it works.
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  await expect(drawer.getByRole("link", { name: "Portfolio" })).toBeVisible();
  await expect(drawer.getByRole("link", { name: "Alerts" })).toBeVisible();
  await drawer.getByRole("link", { name: "Reports" }).click();
  await expect(page).toHaveURL(/\/reports/);
  await expect(drawer).toBeHidden();
});

test("phone: tables become cards, tap targets are large enough, and the result card fits", async ({ page, request }) => {
  const w = await createWorkspace(request, { plan: "firm" });
  const gs = await addClients(request, w, 4, 920, "Card Client");
  await api(request, w.email, w.orgId, "POST", "/api/verify", { gstin: gs[0] });
  await signInAs(page, w.email);

  await page.goto("/portfolio");
  await expect(page.locator("table").first()).toBeHidden();                         // no wide table on a phone
  const first = page.getByRole("list", { name: "Client portfolio" }).getByRole("listitem").first();
  await expect(first).toBeVisible();
  await expect(first).toContainText("GSTIN");
  const box = await first.boundingBox();
  expect(box!.width).toBeGreaterThan(300);                                          // the card uses the screen width

  for (const name of ["Add client"]) {
    const b = await page.getByRole("link", { name }).first().boundingBox();
    expect(b!.height, `${name} is at least 36px tall`).toBeGreaterThanOrEqual(36);
  }

  await page.goto(`/verify?gstin=${gs[0]}`);
  await expect(page.getByText(/Stored result|Verified live/).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
