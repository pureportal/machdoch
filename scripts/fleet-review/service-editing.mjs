import assert from "node:assert/strict";
import { fleetRunsFixture } from "../fixtures/fleet-review.mjs";
import { capture, contained } from "./browser.mjs";

export async function reviewServiceEditing(page, size, instanceId, fixture) {
  const data = fleetRunsFixture(fixture.snapshot.shell.workspaces[0].root);
  const commands = [];
  let loadFailed = false;
  await page.route("**/runs?*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: loadFailed ? 503 : 200,
        json: loadFailed
          ? { error: "Configuration could not be loaded. Try again." }
          : data,
      });
      return;
    }
    const command = route.request().postDataJSON();
    assert.equal(command.action, "save");
    commands.push(command);
    if (commands.length === 1) {
      data.snapshot.revision = "external-edit";
      data.snapshot.document.configurations[0].name = "Updated frontend";
      await route.fulfill({
        status: 409,
        json: { error: "Configuration changed. Refresh and try again." },
      });
      return;
    }
    assert.equal(command.expectedRevision, "external-edit");
    data.snapshot.document = command.document;
    data.snapshot.revision = "saved-edit";
    await route.fulfill({
      status: 202,
      json: { commandId: command.commandId, duplicate: false },
    });
  });
  await page.goto(`/instances/${instanceId}/runs`);
  await page
    .getByRole("button", { name: "Edit run.json", exact: true })
    .click();
  const editor = page.getByRole("textbox", {
    name: "run.json",
    exact: true,
    includeHidden: true,
  });
  const editedDocument = JSON.parse(await editor.inputValue());
  editedDocument.configurations[0].command = "node changed.js";
  const draft = JSON.stringify(editedDocument, null, 2);
  await editor.fill(draft);
  await page
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Reload it before saving" })
    .waitFor();
  assert.equal(await editor.inputValue(), draft);
  assert(
    await page
      .getByRole("button", { name: "Save configuration", exact: true })
      .isDisabled(),
  );
  const reload = page.getByRole("button", {
    name: "Reload configuration",
    exact: true,
  });
  await reload.click();
  const dialog = page.getByRole("alertdialog");
  await contained(page, dialog);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await editor.inputValue(), draft);
  assert(
    await reload.evaluate((element) => element === document.activeElement),
  );
  await reload.click();
  loadFailed = true;
  await dialog
    .getByRole("button", { name: "Reload configuration", exact: true })
    .click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(await editor.inputValue(), draft);
  await capture(page, `${size}-configuration-reload-error`);
  loadFailed = false;
  await dialog
    .getByRole("button", { name: "Reload configuration", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  await editor.and(page.locator(":focus")).waitFor();
  await page
    .getByRole("status")
    .filter({ hasText: "Reload it before saving" })
    .waitFor({ state: "detached" });
  const latest = JSON.parse(await editor.inputValue());
  assert.equal(latest.configurations[0].name, "Updated frontend");
  assert.equal(latest.configurations[0].command, "pnpm run dev");
  latest.configurations[0].command = "node changed.js";
  await editor.fill(JSON.stringify(latest, null, 2));
  await page
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  await editor.waitFor({ state: "detached" });
  assert.equal(commands.length, 2);
  assert.equal(
    data.snapshot.document.configurations[0].command,
    "node changed.js",
  );
  await capture(page, `${size}-configuration-saved`);
  return `${size}: configuration conflict retains draft, confirmed reload cancel/failure/retry, save with latest revision (fixtures)`;
}
