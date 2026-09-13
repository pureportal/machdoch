import assert from "node:assert/strict";
import { fleetSettingsFixture } from "../fixtures/fleet-settings.mjs";
import { activate, capture, contained, trapped } from "./browser.mjs";

import {
  reviewSettingsDocuments,
  reviewSettingsSecrets,
} from "./settings-editing.mjs";
import {
  reviewSettingsAssignments,
  reviewSettingsHistory,
} from "./settings-states.mjs";

export async function reviewSettings(page, name, mount) {
  const fixture = fleetSettingsFixture();
  await mount(page);
  await fixture.install(page);
  fixture.failNext("GET", "catalog");
  const releaseCatalog = fixture.holdNext("GET", "catalog");
  await page.goto("/__fleet_review_settings");
  await page
    .getByRole("status")
    .filter({ hasText: "Loading settings" })
    .waitFor();
  assert(
    await page
      .getByRole("button", { name: "New profile", exact: true })
      .isDisabled(),
  );
  releaseCatalog();
  await page.getByRole("alert").waitFor();
  assert.equal(
    await page.getByText("No profiles.", { exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").count(), 0);

  const releaseBeta = fixture.holdNext("GET", "profiles/profile_beta");
  await selectProfile(page, "Beta");
  await page.getByRole("status").waitFor();
  assert.equal(await page.getByLabel("Name", { exact: true }).count(), 0);
  await selectProfile(page, "Gamma");
  await page.getByRole("heading", { name: "Gamma", exact: true }).waitFor();
  const betaResponse = page.waitForResponse("**/profiles/profile_beta");
  releaseBeta();
  await betaResponse;
  await rendered(page);
  assert(
    await page.getByRole("heading", { name: "Gamma", exact: true }).isVisible(),
  );
  fixture.failNext("GET", "profiles/profile_beta");
  await selectProfile(page, "Beta");
  await page.getByRole("alert").waitFor();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("heading", { name: "Beta", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Secrets", exact: true }).click();
  await page.getByLabel("OpenAI value").fill("synthetic-unsaved-beta-key");
  await selectProfile(page, "Gamma");
  await page.getByRole("heading", { name: "Gamma", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Secrets", exact: true }).click();
  assert.equal(await page.getByLabel("OpenAI value").inputValue(), "");
  await capture(page, `${name}-settings-secrets`);

  await page.getByRole("tab", { name: "General", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page
    .getByRole("tab", { name: "Instructions", selected: true })
    .waitFor();
  await page.keyboard.press("End");
  await page.getByRole("tab", { name: "History", selected: true }).waitFor();
  await contained(
    page,
    page.getByRole("tab", { name: "History", exact: true }),
  );
  await page.keyboard.press("Home");
  await page.getByRole("tab", { name: "General", selected: true }).waitFor();

  const create = page.getByRole("button", { name: "New profile", exact: true });
  await activate(page, create);
  let dialog = page.getByRole("dialog");
  await trapped(page);
  await dialog.getByLabel("Name", { exact: true }).fill("Review profile");
  fixture.failNext("POST", "profiles");
  await dialog
    .getByRole("button", { name: "Create profile", exact: true })
    .click();
  await dialog.getByRole("alert").waitFor();
  const releaseCreate = fixture.holdNext("POST", "profiles");
  await dialog
    .getByRole("button", { name: "Create profile", exact: true })
    .click();
  assert(await dialog.getByLabel("Name", { exact: true }).isDisabled());
  assert(
    await dialog
      .getByRole("button", { name: "Cancel", exact: true })
      .isDisabled(),
  );
  assert(
    await dialog
      .getByRole("button", { name: "Close", exact: true })
      .isDisabled(),
  );
  await page.keyboard.press("Escape");
  assert(await dialog.isVisible());
  await dialog.locator("form").evaluate((form) => form.requestSubmit());
  releaseCreate();
  await dialog.waitFor({ state: "detached" });
  await page
    .getByRole("heading", { name: "Review profile", exact: true })
    .waitFor();
  assert.equal(
    fixture.requests.filter(
      (request) => request.method === "POST" && request.path === "profiles",
    ).length,
    2,
  );
  await rendered(page);
  assert(await create.evaluate((button) => button === document.activeElement));
  const profile = fixture.profiles.find(
    (item) => item.name === "Review profile",
  );
  const path = `profiles/${profile.profileId}`;

  await page.getByLabel("Name", { exact: true }).fill("Saved profile");
  await page.getByLabel("Provider", { exact: true }).selectOption("openai");
  await page.getByLabel("Model", { exact: true }).fill("fixture-model");
  await page.getByLabel("Executor turns", { exact: true }).fill("23");
  const releaseSave = fixture.holdNext("PUT", path);
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  assert(await page.getByLabel("Name", { exact: true }).isDisabled());
  assert(
    await page.getByRole("tab", { name: "Secrets", exact: true }).isDisabled(),
  );
  const profilesControl =
    page.viewportSize().width < 1024
      ? page.getByLabel("Profile", { exact: true })
      : page.getByRole("button", { name: "Alpha Revision 1", exact: true });
  assert(await profilesControl.isDisabled());
  releaseSave();
  await page
    .getByRole("heading", { name: "Saved profile", exact: true })
    .waitFor();
  assert.equal(profile.document.agentLimits.executorTurns, 23);
  assert.equal(profile.document.defaults.model, "fixture-model");

  profile.revision++;
  profile.name = "Changed elsewhere";
  await page.getByLabel("Name", { exact: true }).fill("Local draft");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page
    .getByRole("button", { name: "Reload profile", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Name", { exact: true }).inputValue(),
    "Local draft",
  );
  await page
    .getByRole("button", { name: "Reload profile", exact: true })
    .click();
  dialog = page.getByRole("alertdialog");
  await contained(page, dialog);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    await page.getByLabel("Name", { exact: true }).inputValue(),
    "Local draft",
  );
  await page
    .getByRole("button", { name: "Reload profile", exact: true })
    .click();
  fixture.failNext("GET", path);
  await dialog
    .getByRole("button", { name: "Reload profile", exact: true })
    .click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(
    await page.getByLabel("Name", { exact: true }).inputValue(),
    "Local draft",
  );
  await dialog
    .getByRole("button", { name: "Reload profile", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  await page
    .getByRole("heading", { name: "Changed elsewhere", exact: true })
    .waitFor();
  await rendered(page);
  assert(
    await page
      .getByRole("heading", { name: "Changed elsewhere", exact: true })
      .evaluate((heading) => heading === document.activeElement),
  );
  assert.equal(
    await page.getByLabel("Name", { exact: true }).inputValue(),
    "Changed elsewhere",
  );
  await page.getByLabel("Name", { exact: true }).fill("Review profile");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await page
    .getByRole("heading", { name: "Review profile", exact: true })
    .waitFor();
  assert.equal(
    fixture.requests
      .filter((request) => request.method === "PUT" && request.path === path)
      .at(-1).body.expectedRevision,
    3,
  );
  await capture(page, `${name}-settings-general`);

  await reviewSettingsDocuments(page, name, fixture, path);
  await reviewSettingsSecrets(page, name, fixture, profile, path);
  await reviewSettingsAssignments(page, name, fixture, profile);
  await reviewSettingsHistory(page, name, fixture, profile, path);

  fixture.failNext("DELETE", path);
  await page
    .getByRole("button", { name: `Delete ${profile.name}`, exact: true })
    .click();
  dialog = page.getByRole("alertdialog");
  await dialog
    .getByRole("button", { name: "Delete profile", exact: true })
    .click();
  await dialog.getByRole("alert").waitFor();
  await dialog
    .getByRole("button", { name: "Delete profile", exact: true })
    .click();
  await page.getByRole("heading", { name: "Alpha", exact: true }).waitFor();
  assert(!fixture.profiles.includes(profile));
  fixture.profiles.splice(0);
  await page.reload();
  await page.getByText("No profiles.", { exact: true }).waitFor();
  assert(
    await page
      .getByRole("button", { name: "New profile", exact: true })
      .isEnabled(),
  );
  await capture(page, `${name}-settings-empty`);
  return `${name}: Settings component fixtures: load retry/empty states, profile response ordering and secret isolation, keyboard tabs, pending/error dialogs, general save/conflict/reload, instructions/context packs/prompts, API-key save/remove, assignments and history recovery, restore/delete`;
}

async function selectProfile(page, name) {
  if (page.viewportSize().width < 1024)
    await page
      .getByLabel("Profile", { exact: true })
      .selectOption({ label: name });
  else
    await page
      .getByRole("button", { name: `${name} Revision 1`, exact: true })
      .click();
}

async function rendered(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
