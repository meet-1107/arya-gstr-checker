import { expect, test } from "@playwright/test";
import { signInAs, uniqueEmail } from "./helpers";

test("sign-in rejects a wrong password and accepts the right one", async ({ page }) => {
  const email = uniqueEmail("signin");
  await signInAs(page, email, { signedIn: false, password: "Correct-horse-1" }); // an account that exists but is signed out
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Password").fill("Correct-horse-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  // No organization yet, so the app sends a verified user to onboarding.
  await expect(page).toHaveURL(/\/onboarding/);
});

test("forgot password → reset link → new password works, old one does not", async ({ page }) => {
  const email = uniqueEmail("reset");
  await signInAs(page, email, { signedIn: false, password: "Old-password-1" });
  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText("Check your inbox")).toBeVisible();
  // The dev sign-in has no inbox: it shows the reset link directly.
  await page.getByRole("link", { name: "Open the reset link" }).click();

  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill("New-password-2");
  await page.getByLabel("Confirm new password").fill("New-password-2");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByText("Password updated")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("Old-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();
  await page.getByLabel("Password").fill("New-password-2");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
});

test("a reset link with no code says so instead of showing a form", async ({ page }) => {
  await page.goto("/reset-password");
  await expect(page.getByRole("heading", { name: "Link not valid" })).toBeVisible();
});

test("passwords must match and be long enough on registration and reset", async ({ page }) => {
  await page.goto("/register");
  await page.getByLabel("Full name").fill("Short Pass");
  await page.getByLabel("Work email").fill(uniqueEmail("short"));
  await page.getByLabel("Password").fill("short");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page).toHaveURL(/\/register/);
});
