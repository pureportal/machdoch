import assert from "node:assert/strict";
import { capture, contained } from "./browser.mjs";

export async function reviewDashboard(page, size, inventory) {
  let inventoryMode = "error";
  await page.route("**/api/instances", (route) =>
    route.fulfill({
      status: inventoryMode === "error" ? 503 : 200,
      json:
        inventoryMode === "error"
          ? { error: "Instances could not be loaded. Try again." }
          : { instances: inventoryMode === "empty" ? [] : inventory },
    }),
  );
  await page.goto("/instances");
  await page
    .getByRole("alert")
    .filter({ hasText: "Instances could not be loaded." })
    .waitFor();
  assert.equal(await page.getByText("No instances enrolled.").count(), 0);
  inventoryMode = "empty";
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("No instances enrolled.").waitFor();
  await capture(page, `${size}-instances-empty`);
  inventoryMode = "loaded";
  await page.reload();
  await page.getByLabel("Search instances").waitFor();
  assert.equal(
    await page
      .getByText("Revoked", { exact: true })
      .filter({ visible: true })
      .count(),
    0,
  );
  await page.getByLabel("Instance status").selectOption("revoked");
  await page
    .getByRole("heading", { name: "Revoked review instance", exact: true })
    .waitFor();
  await page.getByLabel("Instance status").selectOption("active");
  await page.getByLabel("Search instances").fill("no-matching-instance");
  await page.getByText("No matching instances.").waitFor();
  await page.getByLabel("Search instances").fill("");
  await page.route(`**/api/instances/${inventory[0].instanceId}`, (route) =>
    route.fulfill({
      status: 409,
      json: { error: "Revocation failed. Try again." },
    }),
  );
  const revoke = page.getByRole("button", {
    name: `Revoke ${inventory[0].displayName}`,
    exact: true,
  });
  await revoke.click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Revoke instance", exact: true })
    .click();
  await page.getByRole("alertdialog").getByRole("alert").waitFor();
  await contained(page, '[role="alertdialog"]');
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert(
    await revoke.evaluate((element) => element === document.activeElement),
  );
  await capture(page, `${size}-instances`);
  await page.getByRole("link", { name: "Enrollment", exact: true }).click();
  await page.getByRole("heading", { name: "Unused enrollment keys" }).waitFor();
  await capture(page, `${size}-enrollment`);
  await page.getByRole("link", { name: "Users", exact: true }).click();
  await page.getByLabel("Username", { exact: true }).waitFor();
  await page.waitForFunction(() =>
    Boolean(document.querySelector("#owner-username")?.value),
  );
  await page.route("**/api/auth/account", async (route) => {
    if (route.request().method() === "PUT")
      await route.fulfill({
        status: 400,
        json: { error: "Current password is incorrect." },
      });
    else await route.continue();
  });
  await page
    .getByLabel("Current password", { exact: true })
    .fill("review-invalid-password");
  await page
    .getByLabel("New password", { exact: true })
    .fill("review-new-password-not-saved");
  await page.getByRole("button", { name: "Update owner" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Current password is incorrect." })
    .waitFor();
  await page.getByLabel("Current password", { exact: true }).fill("");
  await page.getByLabel("New password", { exact: true }).fill("");
  await capture(page, `${size}-users`);
  return `${size}: dashboard navigation, filters, empty/error recovery, revocation dialog, account validation`;
}
