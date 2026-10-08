import { expect, test } from "@playwright/test";
import { createWorkspace, readDownload, signInAs } from "./helpers";
import { gstin } from "./gstins";

test("paste a list → preview what will be paid for → run in the background → live progress → export", async ({ page, request }) => {
  const w = await createWorkspace(request, { plan: "firm" });
  await signInAs(page, w.email);
  const list = [gstin(701), gstin(702), gstin(703), gstin(701), "not-a-gstin", gstin(704).slice(0, 14) + "0", gstin(705)];

  await page.goto("/verify/bulk");
  await expect(page.getByRole("heading", { name: "Verify many GSTINs" })).toBeVisible();
  await page.getByRole("textbox").first().fill(list.join("\n"));
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("What starting this run would do.")).toBeVisible();
  // 4 distinct valid GSTINs; the repeat and the two bad lines are reported, never sent to the GST service.
  await expect(page.getByRole("button", { name: "Start verification" })).toBeEnabled();
  await expect(page.getByText(/duplicate/i).first()).toBeVisible();
  await expect(page.getByText(/invalid/i).first()).toBeVisible();

  await page.getByRole("button", { name: "Start verification" }).click();
  await expect(page).toHaveURL(/\/bulk-checks\/[^/]+$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: /GSTIN verification/ })).toBeVisible();
  await expect(page.getByRole("progressbar").first()).toBeVisible();                       // live progress while it runs
  await expect(page.getByRole("heading", { name: /GSTIN verification/ }).getByText(/Completed/)).toBeVisible({ timeout: 40_000 });

  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export CSV" }).click()]);
  const file = await readDownload(dl);
  expect(file.bom).toBe(true);
  for (const g of [gstin(701), gstin(702), gstin(703), gstin(705)]) expect(file.text).toContain(g);
  expect(file.text.split(/\r?\n/).filter(Boolean).length).toBe(1 + 4);                    // header + the 4 distinct valid GSTINs
  expect(file.text).toContain("Answer obtained at");

  // The answers are now stored: the same list is "already up to date" and would cost nothing.
  await page.goto("/verify/bulk");
  await page.getByRole("textbox").first().fill([gstin(701), gstin(702), gstin(703), gstin(705)].join("\n"));
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText(/already (verified|up to date)|from stored|stored result/i).first()).toBeVisible();
});

test("a CSV file can be uploaded instead of pasted", async ({ page, request }) => {
  const w = await createWorkspace(request, { plan: "firm" });
  await signInAs(page, w.email);
  await page.goto("/verify/bulk");
  const csv = `Party,GSTIN,City\nA,${gstin(711)},Pune\nB,${gstin(712)},Surat\n`;
  await page.locator('input[type="file"]').setInputFiles({ name: "parties.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("button", { name: "Start verification" })).toBeEnabled();
});
