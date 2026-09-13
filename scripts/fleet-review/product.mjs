import assert from "node:assert/strict";
import { fleetReviewFixture } from "../fixtures/fleet-review.mjs";
import { capture, command, contained, trapped } from "./browser.mjs";

export async function reviewProduct(page, size, instanceId) {
  const fixture = fleetReviewFixture();
  fixture.offline = true;
  await fixture.install(page);
  await page.goto(`/instances/${instanceId}`);
  await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
  assert(
    await page
      .getByRole("link", { name: "Instances", exact: true })
      .isVisible(),
  );
  await capture(page, `${size}-offline`);
  fixture.offline = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "Task composer" });
  await composer.waitFor();
  await contained(page, ".m-product-composer");
  await page.locator(".m-product-conversation").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.getByRole("button", { name: "Latest message" }).click();
  await page.waitForFunction(() => {
    const element = document.querySelector(".m-product-conversation");
    return element.scrollHeight - element.scrollTop - element.clientHeight < 3;
  });
  await capture(page, `${size}-chat`);
  fixture.delay = 250;
  await composer.pressSequentially("Review the task queue", { delay: 10 });
  const send = page.getByRole("button", { name: "Send message" });
  assert.equal(
    await send.isDisabled(),
    false,
    "Saving a draft must not disable Send",
  );
  fixture.failNext = "submit-message";
  await send.click();
  await page
    .getByRole("alert")
    .filter({ hasText: "could not complete" })
    .waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Task composer"]').value ===
      "Review the task queue",
  );
  assert(
    fixture.commands.filter((item) => item.kind === "update-draft").length < 10,
    "Draft writes were not coalesced",
  );
  await send.click();
  await command(fixture, "submit-message", page);
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Task composer"]').value === "",
  );
  assert.equal(
    fixture.commands.filter((item) => item.kind === "submit-message").length,
    2,
  );
  fixture.delay = 0;
  await composer.fill("Unsent draft");
  if (page.viewportSize().width <= 900)
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByLabel("Search sessions").fill("no-match");
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page
    .locator(".m-product-session-item")
    .filter({ hasText: "Second session" })
    .click();
  await page
    .getByRole("heading", { name: "Second session", exact: true })
    .waitFor();
  assert.equal(await composer.inputValue(), "");
  if (page.viewportSize().width <= 900)
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page
    .locator(".m-product-session-item")
    .filter({ hasText: "Product UI verification" })
    .click();
  await page
    .getByRole("heading", { name: "Product UI verification", exact: true })
    .waitFor();
  assert.equal(await composer.inputValue(), "Unsent draft");
  if (page.viewportSize().width <= 900) {
    await page
      .getByRole("button", { name: "Session actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Rename session", exact: true })
      .click();
  } else
    await page
      .getByRole("button", { name: "Rename session", exact: true })
      .click();
  await page
    .getByLabel("Session title", { exact: true })
    .fill("Keep original title");
  await page.getByLabel("Session title", { exact: true }).press("Escape");
  assert.equal(
    fixture.commands.filter((item) => item.kind === "rename-session").length,
    0,
  );
  if (page.viewportSize().width <= 900) {
    await page
      .getByRole("button", { name: "Session actions", exact: true })
      .click();
    await page
      .getByRole("menuitem", { name: "Delete session", exact: true })
      .click();
  } else
    await page
      .getByRole("button", { name: "Delete session", exact: true })
      .click();
  await trapped(page);
  fixture.failNext = "delete-session";
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete session", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  await capture(page, `${size}-session-dialog`);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page.getByRole("button", { name: /^Session model:/ }).click();
  await page.getByLabel("Search models").fill("5.5");
  await page.getByLabel("Search models").evaluate((input) =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert(
    await page
      .getByRole("dialog", { name: "Session model", exact: true })
      .isVisible(),
  );
  await page.getByLabel("Search models").press("Enter");
  await command(fixture, "set-session-model", page);
  await page
    .getByRole("button", { name: "Activity", exact: true })
    .filter({ visible: true })
    .click();
  const activity = page.getByRole("dialog", { name: "Activity", exact: true });
  await trapped(page);
  await activity.getByRole("tab", { name: "Tasks", exact: true }).focus();
  await page.keyboard.press("End");
  await activity
    .getByRole("tab", { name: "Instructions", exact: true, selected: true })
    .waitFor();
  await capture(page, `${size}-activity`);
  await page.keyboard.press("Escape");
  fixture.offline = true;
  await page.getByText("Disconnected", { exact: true }).waitFor();
  assert(await send.isDisabled());
  await composer.fill("Draft kept while disconnected");
  fixture.offline = false;
  await page
    .getByRole("alert")
    .filter({ hasText: "Instance is offline." })
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await page.getByText("Connected", { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), "Draft kept while disconnected");
  await page
    .getByRole("button", { name: "Smart Scheduler", exact: true })
    .filter({ visible: true })
    .click();
  const job = page
    .locator(".m-scheduler-card")
    .filter({ hasText: "Morning review" });
  await job.getByRole("button", { name: "Pause", exact: true }).click();
  await job.getByRole("button", { name: "Resume", exact: true }).waitFor();
  const deleteJob = job.getByRole("button", { name: "Delete", exact: true });
  await deleteJob.click();
  await trapped(page);
  await capture(page, `${size}-scheduler-dialog`);
  await page.keyboard.press("Escape");
  assert(
    await deleteJob.evaluate((element) => element === document.activeElement),
  );
  await deleteJob.click();
  fixture.failNext = "scheduler-delete";
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await job.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Runs", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await command(fixture, "scheduler-cancel-run", page);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await command(fixture, "scheduler-retry-run", page);
  await capture(page, `${size}-scheduler-runs`);
  await page
    .getByRole("button", { name: "RALPH", exact: true })
    .filter({ visible: true })
    .click();
  await page
    .getByRole("button", { name: "Run Release flow", exact: true })
    .click();
  await trapped(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Run", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  await page.getByLabel("environment", { exact: true }).fill("staging");
  await capture(page, `${size}-ralph-dialog`);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Run", exact: true })
    .click();
  await command(fixture, "ralph-run", page);
  await page
    .getByRole("button", { name: "Media Studio", exact: true })
    .filter({ visible: true })
    .click();
  await page
    .getByRole("button", { name: "Generate", exact: true })
    .filter({ visible: true })
    .click();
  await trapped(page);
  await capture(page, `${size}-media-dialog`);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Assets", exact: true })
    .filter({ visible: true })
    .click();
  await page.locator(".m-media-asset").first().click();
  await trapped(page);
  await capture(page, `${size}-asset-dialog`);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Chat", exact: true })
    .filter({ visible: true })
    .click();
  const currentSession = fixture.snapshot.shell.sessions[0];
  currentSession.runningTaskId = "review_running_task";
  fixture.snapshot.shell.composer.isExecuting = true;
  fixture.snapshot.sessions = [
    {
      taskId: "review_running_task",
      task: "Review task",
      mode: "machdoch",
      state: "running",
      message: "Working",
      cancellable: true,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      progressCount: 0,
      logs: [],
      timeline: [],
    },
  ];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Stop task", exact: true }).waitFor();
  await capture(page, `${size}-running-task`);
  await page.getByRole("button", { name: "Stop task", exact: true }).click();
  await page
    .getByRole("button", { name: "Stop task", exact: true })
    .waitFor({ state: "detached" });
  assert.equal(await composer.inputValue(), "Draft kept while disconnected");
  return fixture;
}
