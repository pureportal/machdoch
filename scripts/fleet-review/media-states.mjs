import assert from "node:assert/strict";
import { capture, command } from "./browser.mjs";

export async function reviewMediaStates(page, size, fixture) {
  const shell = fixture.snapshot.shell;
  const original = shell.media;
  shell.media = {
    ...original,
    loading: true,
    assets: [],
    runs: [],
    assetCount: 0,
    runCount: 0,
  };
  await page
    .getByRole("button", { name: "Media Studio", exact: true })
    .filter({ visible: true })
    .click();
  const navigation = page.getByRole("navigation", {
    name: "Media Studio",
    exact: true,
  });
  await navigation.getByRole("button", { name: "Assets", exact: true }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Loading media…", { exact: true }).waitFor();
  assert.equal(await page.getByText("No assets", { exact: true }).count(), 0);
  shell.media.loading = false;
  shell.media.error = "Media could not be loaded. Try again.";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Media could not be loaded" })
    .waitFor();
  assert.equal(await page.getByText("No assets", { exact: true }).count(), 0);
  await capture(page, `${size}-media-load-error`);
  delete shell.media.error;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("No assets", { exact: true }).waitFor();
  await navigation
    .getByRole("button", { name: "Activity", exact: true })
    .click();
  await page.getByText("No activity", { exact: true }).waitFor();
  shell.media = original;
  shell.media.error = "The previous generation failed. Try again.";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await navigation.getByRole("button", { name: "Basic", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Prompt", exact: true })
    .fill("Generate a review image");
  const generate = page.getByRole("button", { name: "Generate", exact: true });
  await page
    .getByRole("alert")
    .filter({ hasText: "The previous generation failed" })
    .waitFor();
  assert(
    await generate.isEnabled(),
    "An earlier generation error must not prevent retrying with a ready model",
  );
  fixture.failNext = "generate-media";
  await generate.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Generate", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "could not complete" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Prompt", exact: true })
      .inputValue(),
    "Generate a review image",
  );
  await generate.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Generate", exact: true })
    .click();
  await command(fixture, "generate-media", page);
  const requests = fixture.commands.filter(
    (item) => item.kind === "generate-media",
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[1].prompt, "Generate a review image");
  const run = shell.media.runs[0];
  run.status = "running";
  shell.media.busy = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await navigation
    .getByRole("button", { name: "Activity", exact: true })
    .click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByText("canceled", { exact: true }).waitFor();
  await capture(page, `${size}-media-activity`);
  await page
    .getByRole("button", { name: "Chat", exact: true })
    .filter({ visible: true })
    .click();
  return `${size}: media loading/error/empty states, generation request failure/retry, activity cancellation (fixtures)`;
}
