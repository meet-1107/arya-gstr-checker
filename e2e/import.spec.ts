import { expect, test } from "@playwright/test";
import { createWorkspace, readDownload, signInAs } from "./helpers";
import { gstin } from "./gstins";

const BAD_CHECKSUM = gstin(603).slice(0, 14) + "0";

test("a messy CSV: check → review → import in the background → result with a downloadable list of skipped rows", async ({ page, request }) => {
  const w = await createWorkspace(request, { plan: "firm" });
  await signInAs(page, w.email);
  const csv = [
    "client_name,gstin,email",
    `Aarav Textiles,${gstin(601)},aarav@example.com`,
    `Bharat Steel,${gstin(602).toLowerCase()},`,          // lowercase is normalised
    `Typo Traders,${BAD_CHECKSUM},typo@example.com`,      // fails the check character
    `Bharat Steel again,${gstin(602)},`,                  // repeated in the file
    `=SUM(1+1) Exports,${gstin(604)},evil@example.com`,   // a formula-looking name (must stay safe in downloads)
    `No Gstin Ltd,,none@example.com`,
  ].join("\n");

  await page.goto("/clients/import");
  await page.locator('input[type="file"]').setInputFiles({ name: "clients.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByText("Match your columns")).toBeVisible();
  await page.getByRole("button", { name: "Check my file" }).click();
  await expect(page.getByText("Review before importing")).toBeVisible();
  await expect(page.getByText("Nothing has been imported yet.")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Ready to import")).toBeVisible();
  await page.getByRole("button", { name: /^Import 3 clients$/ }).click();

  await expect(page).toHaveURL(/\/clients\/import\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByText(/3 clients imported, 3 rows? skipped|3 clients imported, 3 rows skipped/)).toBeVisible({ timeout: 30_000 });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Download skipped rows/ }).click()]);
  const file = await readDownload(dl);
  expect(file.bom).toBe(true);
  expect(file.text).toContain(BAD_CHECKSUM);                                   // the typo is listed so it can be fixed…
  expect(file.text.split(/\r?\n/).filter(Boolean).length).toBe(1 + 3);         // …with the other skipped rows (header + 3)
  expect(file.text).toMatch(/CHECKSUM/); expect(file.text).toMatch(/DUPLICATE_IN_FILE/); expect(file.text).toMatch(/EMPTY|LENGTH/);

  await page.goto("/clients");
  await expect(page.getByRole("link", { name: "Aarav Textiles" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Bharat Steel", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Typo Traders/ })).toHaveCount(0);
  await expect(page.getByRole("table").getByText("=SUM(1+1) Exports")).toBeVisible();              // shown as text, never evaluated
});

test("a file without a usable GSTIN column is refused with a clear reason", async ({ page, request }) => {
  const w = await createWorkspace(request, { plan: "firm" });
  await signInAs(page, w.email);
  await page.goto("/clients/import");
  await page.locator('input[type="file"]').setInputFiles({ name: "nothing.csv", mimeType: "text/csv", buffer: Buffer.from("colour,size\nred,large\n") });
  await expect(page.getByText("Match your columns")).toBeVisible();
  await page.getByRole("button", { name: "Check my file" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByText("Review before importing")).toHaveCount(0);
});
