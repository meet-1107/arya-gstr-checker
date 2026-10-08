import { expect, test } from "@playwright/test";
import { addClients, createWorkspace, otherPerson, signInAs, uniqueEmail } from "./helpers";

test("owner invites a Viewer → Viewer accepts → can read but not verify, import, or manage the team", async ({ page, request, browser, baseURL }) => {
  const owner = await createWorkspace(request, { plan: "firm", firm: "Invites & Co." });
  await addClients(request, owner, 3);
  await signInAs(page, owner.email);

  // Owner creates the invitation in the UI and copies the link (there is no email delivery yet).
  const viewerEmail = uniqueEmail("viewer");
  await page.goto("/team");
  await page.getByRole("button", { name: "Invite member" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email").fill(viewerEmail);
  await dialog.getByLabel("Role").selectOption({ label: "Viewer" });
  await dialog.getByRole("button", { name: "Create invitation" }).click();
  await expect(dialog.getByText("Invitation created")).toBeVisible();
  const link = (await dialog.locator("p.font-mono").innerText()).trim();
  expect(link).toContain("/invite?token=");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Pending invitations").or(page.getByText(viewerEmail)).first()).toBeVisible();

  // The invited person signs in with that email and accepts.
  const { context, page: v } = await otherPerson(browser, baseURL, viewerEmail, { name: "Vera Viewer" });
  const u = new URL(link);
  await v.goto(u.pathname + u.search);
  await expect(v.getByRole("heading", { name: "Join your team" })).toBeVisible();
  await v.getByRole("button", { name: "Accept invitation" }).click();
  await expect(v).toHaveURL(/\/dashboard/);

  // What a Viewer can and cannot do.
  await expect(v.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Team" })).toHaveCount(0);
  await expect(v.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Billing" })).toHaveCount(0);
  await v.goto("/team");
  await expect(v.getByText("You don't have access to team management")).toBeVisible();
  await v.goto("/portfolio");
  await expect(v.getByRole("row", { name: /Client 01/ })).toBeVisible();            // can read clients
  await expect(v.getByRole("button", { name: /^Schedule/ })).toHaveCount(0);        // cannot change them
  await expect(v.getByRole("button", { name: /Refresh|Verify selected/ })).toHaveCount(0);
  await v.goto("/verify");
  await expect(v.getByText(/can view past results but can.t run new verifications/)).toBeVisible();
  await expect(v.getByLabel("GSTIN", { exact: true })).toBeDisabled();
  await v.goto("/verify/bulk");
  await expect(v.getByText("Your role can't run verifications")).toBeVisible();
  await v.goto("/reports");
  await expect(v.getByRole("button", { name: "Preview" }).first()).toBeVisible();   // can preview
  await expect(v.getByRole("button", { name: "Download CSV" })).toHaveCount(0);     // cannot download
  await context.close();

  // The owner now sees the new member.
  await page.goto("/team");
  await expect(page.getByRole("table").getByText(viewerEmail, { exact: true })).toBeVisible();
});

test("an invitation cannot be accepted by a different account", async ({ page, request, browser, baseURL }) => {
  const owner = await createWorkspace(request, { plan: "firm" });
  await signInAs(page, owner.email);
  const invited = uniqueEmail("invited");
  await page.goto("/team");
  await page.getByRole("button", { name: "Invite member" }).click();
  await page.getByRole("dialog").getByLabel("Email").fill(invited);
  await page.getByRole("dialog").getByRole("button", { name: "Create invitation" }).click();
  const link = (await page.getByRole("dialog").locator("p.font-mono").innerText()).trim();

  const { context, page: intruder } = await otherPerson(browser, baseURL, uniqueEmail("intruder"));
  const u = new URL(link);
  await intruder.goto(u.pathname + u.search);
  await intruder.getByRole("button", { name: "Accept invitation" }).click();
  await expect(intruder.getByText("Couldn't accept the invitation")).toBeVisible();
  await expect(intruder.getByRole("button", { name: "Sign in with a different account" })).toBeVisible();
  await context.close();
});
