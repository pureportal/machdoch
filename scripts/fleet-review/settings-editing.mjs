import assert from "node:assert/strict";
import { activate, capture, contained, trapped } from "./browser.mjs";

export async function reviewSettingsDocuments(page, name, fixture, path) {
  for (const item of [
    {
      tab: "Instructions",
      add: "Add instruction",
      save: "Save instruction",
      fields: { Name: "Review instruction", Content: "Review the changes." },
      result: "Review instruction",
    },
    {
      tab: "Context packs",
      add: "Add context pack",
      save: "Save context pack",
      fields: { Name: "Review pack", Instructions: "Check the task result." },
      result: "Review pack",
    },
    {
      tab: "Prompts",
      add: "Add prompt",
      save: "Save prompt",
      fields: { Path: "review.prompt.md", Content: "Review this task." },
      result: "review.prompt.md",
    },
  ]) {
    await activate(
      page,
      page.getByRole("tab", { name: item.tab, exact: true }),
    );
    await activate(
      page,
      page.getByRole("button", { name: item.add, exact: true }),
    );
    const dialog = page.getByRole("dialog");
    await trapped(page);
    for (const [label, value] of Object.entries(item.fields))
      await dialog.getByLabel(label, { exact: true }).fill(value);
    if (item.tab === "Prompts") {
      await dialog
        .getByLabel("Path", { exact: true })
        .fill("../outside.prompt.md");
      await dialog
        .getByRole("button", { name: item.save, exact: true })
        .click();
      await dialog.getByRole("alert").waitFor();
      await dialog.getByLabel("Path", { exact: true }).fill(item.fields.Path);
    }
    fixture.failNext("PUT", path);
    await dialog.getByRole("button", { name: item.save, exact: true }).click();
    await dialog.getByRole("alert").waitFor();
    await page.waitForFunction(
      (label) => document.activeElement?.textContent === label,
      item.save,
    );
    await contained(
      page,
      dialog.getByRole("button", { name: item.save, exact: true }),
    );
    await capture(
      page,
      `${name}-settings-${item.tab.toLowerCase().replaceAll(" ", "-")}-dialog`,
    );
    const release = fixture.holdNext("PUT", path);
    await dialog.getByRole("button", { name: item.save, exact: true }).click();
    assert(
      await dialog
        .getByRole("button", { name: "Cancel", exact: true })
        .isDisabled(),
    );
    await page.keyboard.press("Escape");
    assert(await dialog.isVisible());
    release();
    await dialog.waitFor({ state: "detached" });
    await page
      .getByRole("button", { name: `Edit ${item.result}`, exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: `Edit ${item.result}`, exact: true })
      .click();
    const content = item.tab === "Context packs" ? "Instructions" : "Content";
    await dialog
      .getByLabel(content, { exact: true })
      .fill("Updated review content.");
    await dialog.getByRole("button", { name: item.save, exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await capture(
      page,
      `${name}-settings-${item.tab.toLowerCase().replaceAll(" ", "-")}`,
    );
  }
}

export async function reviewSettingsSecrets(
  page,
  name,
  fixture,
  profile,
  path,
) {
  await page.getByRole("tab", { name: "Secrets", exact: true }).click();
  const value = page.getByLabel("OpenAI value");
  const form = value.locator("..");
  await value.fill("synthetic-review-key-1234");
  fixture.failNext("PUT", `${path}/secrets/openai`);
  await value.press("Enter");
  await form.getByRole("alert").waitFor();
  assert.equal(await value.inputValue(), "synthetic-review-key-1234");
  const release = fixture.holdNext("PUT", `${path}/secrets/openai`);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  assert(await value.isDisabled());
  assert(
    await page.getByRole("tab", { name: "General", exact: true }).isDisabled(),
  );
  release();
  await page
    .getByRole("button", { name: "Remove OpenAI", exact: true })
    .waitFor();
  assert.equal(await value.inputValue(), "");
  assert.equal(profile.secrets[0].lastFour, "1234");
  await capture(page, `${name}-settings-secret-saved`);
  await page
    .getByRole("button", { name: "Remove OpenAI", exact: true })
    .click();
  fixture.failNext("DELETE", `${path}/secrets/openai`);
  const dialog = page.getByRole("alertdialog");
  await dialog
    .getByRole("button", { name: "Remove secret", exact: true })
    .click();
  await dialog.getByRole("alert").waitFor();
  await dialog
    .getByRole("button", { name: "Remove secret", exact: true })
    .click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(profile.secrets.length, 0);
}
