import { expect, test } from "@playwright/test";
import { createWorkspace, signInAs, verifyGstin } from "./helpers";
import { gstin, NOT_FOUND_GSTIN, TIMEOUT_GSTIN } from "./gstins";

test.describe("quick verify", () => {
  test.beforeEach(async ({ page, request }) => {
    const w = await createWorkspace(request, { plan: "firm" });
    await signInAs(page, w.email);
    await page.goto("/verify");
    await expect(page.getByRole("heading", { name: "Verify a GSTIN" })).toBeVisible();
  });

  test("a valid GSTIN is verified live, then served from storage with its age and a refresh option", async ({ page }) => {
    const g = gstin(11);
    await verifyGstin(page, g);
    await expect(page.getByText("Verified live")).toBeVisible();
    await expect(page.getByText(g).first()).toBeVisible();
    await expect(page.getByText(/MOCK .* PRIVATE LIMITED/).first()).toBeVisible();
    await expect(page.getByText("mock data (development)")).toBeVisible();   // never presented as a real result

    await verifyGstin(page, g);                                                // same GSTIN again: no second paid lookup
    await expect(page.getByText(/Stored result · verified/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Verify live now" })).toBeVisible();
  });

  test("a mistyped GSTIN is explained locally and nothing is looked up", async ({ page }) => {
    const bad = gstin(12).slice(0, 14) + "0";
    let calls = 0;
    page.on("request", (r) => { if (r.url().endsWith("/api/verify") && r.method() === "POST") calls++; });
    await page.getByLabel("GSTIN", { exact: true }).fill(bad);
    await expect(page.getByText(/check character doesn't match|doesn't match/)).toBeVisible();    // live hint while typing
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    await expect(page.getByText("Not a valid GSTIN")).toBeVisible();
    await expect(page.getByText(/nothing was used from your quota/i)).toBeVisible();
    expect(calls).toBe(0);
  });

  test("'no registration found' is not called fraud, and offers a retry", async ({ page }) => {
    await verifyGstin(page, NOT_FOUND_GSTIN);
    await expect(page.getByText("No matching registration found").first()).toBeVisible();
    await expect(page.getByText(/not proof of fraud/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("a provider timeout says it is not about the GSTIN, and explains itself", async ({ page }) => {
    await verifyGstin(page, TIMEOUT_GSTIN);
    await expect(page.getByText("We couldn't verify this right now").first()).toBeVisible();
    await expect(page.getByText("This does not mean the GSTIN is fake.")).toBeVisible();
    await expect(page.getByText("Your GSTIN format is valid")).toBeVisible();
    await page.getByRole("button", { name: "Why did this happen?" }).click();
    await expect(page.getByText(/Reference:/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("offline is detected before any request, and recovers", async ({ page, context }) => {
    let calls = 0;
    page.on("request", (r) => { if (r.url().endsWith("/api/verify") && r.method() === "POST") calls++; });
    await context.setOffline(true);
    await expect(page.getByText("You're offline").first()).toBeVisible();
    await verifyGstin(page, gstin(13));
    await expect(page.getByRole("heading", { name: "You're offline" })).toBeVisible();
    await expect(page.getByText("Your GSTIN has not been checked")).toBeVisible();
    expect(calls).toBe(0);
    await context.setOffline(false);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Verified live")).toBeVisible();
  });

  test("a slow service shows 'taking longer than usual' with choices, then still finishes", async ({ page }) => {
    await page.route("**/api/verify", async (route) => { await new Promise((r) => setTimeout(r, 6_500)); await route.continue(); });
    await verifyGstin(page, gstin(14));
    await expect(page.getByText("GSTIN format verified").first()).toBeVisible();
    await expect(page.getByText("Taking longer than usual")).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole("button", { name: "Keep waiting" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await page.getByRole("button", { name: "Keep waiting" }).click();
    await expect(page.getByText("Verified live")).toBeVisible({ timeout: 10_000 });
  });

  test("pasting text that contains a GSTIN finds it and verifies straight away", async ({ page }) => {
    const g = gstin(15);
    const input = page.getByLabel("GSTIN", { exact: true });
    await input.focus();
    await input.evaluate((el, text) => {
      const dt = new DataTransfer(); dt.setData("text", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, `Tax invoice 55\nSupplier GSTIN : ${g.toLowerCase()}\nPlace of supply 27`);
    await expect(input).toHaveValue(g);
    await expect(page.getByText("Verified live")).toBeVisible();
  });

  test("save → the Saved tab; the result can be copied and shared as text", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const g = gstin(16);
    await verifyGstin(page, g);
    await expect(page.getByText("Verified live")).toBeVisible();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Saved" }).click();
    await expect(page.getByRole("tabpanel").getByText(g)).toBeVisible();

    await page.getByRole("button", { name: "Share this result" }).click();
    await page.getByRole("menuitem", { name: "Copy text" }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`GSTIN: ${g}`); expect(copied).toContain("verify again before relying on it"); expect(copied).toContain("MOCK DATA");
  });

  test("the camera is never requested until the user opens the scanner and taps Open camera", async ({ page }) => {
    await page.evaluate(() => {
      (window as unknown as { __gum: number }).__gum = 0;
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { (window as unknown as { __gum: number }).__gum++; const e = new Error("denied"); e.name = "NotAllowedError"; throw e; };
    });
    await page.getByRole("button", { name: "Scan a GSTIN or QR code" }).click();
    await expect(page.getByRole("dialog").getByText(/not recorded or uploaded/)).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __gum: number }).__gum)).toBe(0);
    await page.getByRole("dialog").getByRole("button", { name: "Enter GSTIN manually" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByLabel("GSTIN", { exact: true })).toBeVisible();
  });
});
