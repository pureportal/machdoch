import assert from "node:assert/strict";
import { capture } from "./browser.mjs";

export async function reviewSettingsAssignments(page, name, fixture, profile) {
  fixture.failNext("GET", "assignments");
  await page.getByRole("tab", { name: "Instances", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.getByText("No instances.", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  const select = page.getByLabel("Profile for Review host");
  await select.waitFor();
  fixture.failNext("PUT", "instances/instance_settings_review/assignment");
  await select.selectOption(profile.profileId);
  await page.getByRole("alert").waitFor();
  assert.equal(await select.inputValue(), "");
  const release = fixture.holdNext(
    "PUT",
    "instances/instance_settings_review/assignment",
  );
  await select.selectOption(profile.profileId);
  assert(await select.isDisabled());
  assert(
    await page.getByRole("tab", { name: "General", exact: true }).isDisabled(),
  );
  fixture.failNext("GET", "assignments");
  release();
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  assert.equal(await select.inputValue(), profile.profileId);
  assert(await select.isDisabled());
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("alert").waitFor({ state: "detached" });
  assert(await select.isEnabled());
  await capture(page, `${name}-settings-assignments`);
  await select.selectOption("");
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="Profile for Review host"]')
        ?.disabled === false,
  );
  assert.equal(fixture.assignments[0].profileId, null);
  if (name === "desktop") {
    fixture.failNext("GET", "assignments");
    await page.getByRole("alert").waitFor();
    assert(await select.isDisabled());
    await page.getByRole("alert").waitFor({ state: "detached" });
    assert(await select.isEnabled());
  }
  fixture.assignments[0].instanceStatus = "revoked";
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await page.getByRole("tab", { name: "Instances", exact: true }).click();
  await select.waitFor();
  assert(await select.isDisabled());
  fixture.assignments.splice(0);
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await page.getByRole("tab", { name: "Instances", exact: true }).click();
  await page.getByText("No instances.", { exact: true }).waitFor();
}

export async function reviewSettingsHistory(
  page,
  name,
  fixture,
  profile,
  path,
) {
  fixture.failNext("GET", `${path}/versions`);
  const release = fixture.holdNext("GET", `${path}/versions`);
  await page.getByRole("tab", { name: "History", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Loading history" })
    .waitFor();
  release();
  await page.getByRole("alert").waitFor();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  const restore = page
    .getByRole("button", { name: "Restore", exact: true })
    .last();
  await restore.waitFor();
  await restore.click();
  fixture.failNext("POST", `${path}/versions/1/restore`);
  const dialog = page.getByRole("alertdialog");
  await dialog
    .getByRole("button", { name: "Restore revision", exact: true })
    .click();
  await dialog.getByRole("alert").waitFor();
  await dialog
    .getByRole("button", { name: "Restore revision", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  await page
    .getByRole("heading", { name: "Review profile", exact: true })
    .waitFor();
  assert.equal(profile.document.instructions.length, 0);
  assert.equal(profile.document.contextPacks.length, 0);
  assert.equal(profile.document.prompts.length, 0);
  await capture(page, `${name}-settings-history`);
}
