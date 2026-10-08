import { expect, test } from "@playwright/test";
import { addClients, api, createWorkspace, readDownload, signInAs } from "./helpers";

test("portfolio: refresh only what needs it, schedule, filter — and the run raises an alert and fills the reports", async ({ page, request }) => {
  const w = await createWorkspace(request, { plan: "firm" });
  const gs = await addClients(request, w, 8, 800, "Firm Client");
  for (const g of gs.slice(0, 5)) expect((await api(request, w.email, w.orgId, "POST", "/api/verify", { gstin: g })).status).toBe(200);   // 5 verified, 3 never
  await signInAs(page, w.email);

  await page.goto("/portfolio");
  await expect(page.getByRole("heading", { name: "Client portfolio" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Clients", exact: true }).first()).toBeVisible();
  const cards = page.locator("main a[href^='/portfolio']");
  await expect(cards.filter({ hasText: "Clients" }).first()).toContainText("8");
  await expect(cards.filter({ hasText: "To refresh" })).toContainText("3");
  await expect(page.getByRole("row", { name: /Firm Client 08/ })).toContainText("Not verified");
  await expect(page.getByRole("row", { name: /Firm Client 01/ })).toContainText("Fresh");

  // "Verify all", the cost-aware way: the dialog says what will be paid for before anything starts.
  await page.getByRole("button", { name: /Refresh 3 that need it/ }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByText("Already up to date")).toBeVisible();
  await expect(dlg.locator("dd").nth(0)).toHaveText("3");           // clients in this refresh (only those that need it)
  await expect(dlg.locator("dd").nth(1)).toHaveText("0");           // already up to date (the 5 fresh ones are not even included)
  await expect(dlg.locator("dd").nth(2)).toHaveText("3");           // will be verified
  await dlg.getByRole("button", { name: "Verify 3 now" }).click();
  await expect(page).toHaveURL(/\/bulk-checks\/[^/]+$/);
  await expect(page.getByRole("heading", { name: /GSTIN verification/ }).getByText(/Completed/)).toBeVisible({ timeout: 40_000 });

  await page.goto("/portfolio");
  await expect(cards.filter({ hasText: "To refresh" })).toContainText("0");
  await expect(page.getByRole("row", { name: /Firm Client 08/ })).toContainText("Fresh");
  await expect(page.getByRole("button", { name: /^Refresh/ })).toContainText(/Refresh$/);           // nothing left to refresh

  // Scheduling.
  await page.getByRole("button", { name: "Schedule", exact: true }).click();
  await page.getByRole("dialog").getByRole("radio", { name: /Weekly/ }).check({ force: true });
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Weekly verification set")).toBeVisible();
  await expect(page.getByRole("row", { name: /Firm Client 01/ })).toContainText("Weekly");

  // Filters.
  await page.locator("#pq").fill("client 03");
  await expect(page.getByRole("row", { name: /Firm Client 03/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Firm Client 04/ })).toHaveCount(0);
  await page.locator("#pq").fill("");
  await page.getByLabel("Freshness").selectOption("never");
  await expect(page.getByText("No clients match these filters")).toBeVisible();

  // The run finished → an alert, and the bell counts it.
  await page.goto("/alerts");
  await expect(page.getByRole("heading", { name: "Alerts" })).toBeVisible();
  await expect(page.getByText(/Bulk GST check completed: 3 checked/)).toBeVisible();
  await page.getByRole("button", { name: "Mark read", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mark unread" })).toBeVisible();

  // Reports: counts match, and the CSV is real.
  await page.goto("/reports");
  await expect(page.getByRole("heading", { name: "Client GST status" })).toBeVisible();
  await expect(page.getByText("8 rows").first()).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).first().click()]);
  const f = await readDownload(dl);
  expect(f.bom).toBe(true); expect(f.name).toMatch(/^clients-report.*\.csv$/);
  expect(f.text.split(/\r?\n/).filter(Boolean).length).toBe(1 + 8);
  expect(f.text).toContain("Firm Client 08"); expect(f.text).toContain("Weekly");
});

test("the monthly summary prints a one-page overview (plan feature)", async ({ page, request }) => {
  const w = await createWorkspace(request, { plan: "firm" });
  await addClients(request, w, 3, 850);
  await signInAs(page, w.email);
  await page.goto("/reports/summary");
  await expect(page.getByRole("article", { name: "Monthly summary" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "E2E & Associates" })).toBeVisible();
  await expect(page.getByText(/not a statement by or on behalf of the GST authorities/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Print / Save as PDF" })).toBeEnabled();
});

test("the printable summary is refused on a plan without it, with a way forward", async ({ page, request }) => {
  const w = await createWorkspace(request, { plan: "starter" });
  await signInAs(page, w.email);
  await page.goto("/reports/summary");
  await expect(page.getByText("The printable summary isn't included in your plan")).toBeVisible();
  await expect(page.getByRole("link", { name: "View plans" })).toBeVisible();
});

test("the scheduler endpoint is invisible without the secret and runs due clients with it", async ({ request, page }) => {
  const w = await createWorkspace(request, { plan: "firm" });
  await addClients(request, w, 2, 870);
  expect((await api(request, w.email, w.orgId, "POST", "/api/portfolio/schedule", { all: true, schedule: "daily" })).status).toBe(200);
  expect((await request.post("/api/internal/portfolio-due")).status()).toBe(404);
  expect((await request.post("/api/internal/portfolio-due", { headers: { authorization: "Bearer wrong" } })).status()).toBe(404);
  const ok = await request.post("/api/internal/portfolio-due", { headers: { authorization: "Bearer e2e-cron-secret" } });
  expect(ok.status()).toBe(200);
  const mine = ((await ok.json()).data.results as { orgId: string; due: number; started: boolean }[]).find((r) => r.orgId === w.orgId);
  expect(mine).toMatchObject({ due: 2, started: true });
  await signInAs(page, w.email);
  await page.goto("/portfolio");
  await expect(page.getByRole("row", { name: /Client 01/ })).toContainText("Daily");
});
