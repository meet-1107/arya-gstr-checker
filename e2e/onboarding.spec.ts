import { expect, test } from "@playwright/test";
import { uniqueEmail } from "./helpers";
import { gstin } from "./gstins";

test("register → verify email → onboarding → dashboard, with the first client in the portfolio", async ({ page }) => {
  const email = uniqueEmail("founder");
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Meet Patel");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("E2e-password-1");
  await page.getByRole("button", { name: "Create account" }).click();

  // The dev sign-in has no inbox, so it offers a "Verify now" shortcut for the email link.
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await page.getByRole("button", { name: "Verify now" }).click();
  await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
  await page.getByRole("link", { name: "Continue" }).click();

  // Onboarding: firm → practice/plan → (free plan has 1 user, so no team step) → first client → ready.
  await expect(page.getByRole("heading", { name: "Name your firm" })).toBeVisible();
  await page.getByLabel("Firm name").fill("Patel & Associates");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "About your practice" })).toBeVisible();
  await page.getByRole("radio", { name: /^Free/ }).check({ force: true });
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page.getByRole("heading", { name: "Add your first client" })).toBeVisible();
  await page.getByLabel("Client name").fill("ABC Industries Pvt Ltd");
  await page.getByLabel("GSTIN", { exact: false }).fill(gstin(501));
  await page.getByRole("button", { name: "Add client" }).click();
  await expect(page.getByRole("heading", { name: /Patel & Associates is ready/ })).toBeVisible();
  await page.getByRole("button", { name: "Go to dashboard" }).click();

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Meet");
  // The client added during onboarding is in the portfolio, not yet verified.
  await page.goto("/portfolio");
  await expect(page.getByRole("heading", { name: "Client portfolio" })).toBeVisible();
  await expect(page.getByRole("link", { name: "ABC Industries Pvt Ltd" })).toBeVisible();
  await expect(page.getByRole("row", { name: /ABC Industries/ }).getByText("Not verified")).toBeVisible();
});

test("a signed-out visitor is sent to sign in and returns to the page they wanted", async ({ page }) => {
  await page.goto("/portfolio");
  await expect(page).toHaveURL(/\/login\?next=%2Fportfolio/);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
});
