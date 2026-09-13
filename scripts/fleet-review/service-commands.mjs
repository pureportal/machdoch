import assert from "node:assert/strict";
import { fleetRunsFixture } from "../fixtures/fleet-review.mjs";
import { capture } from "./browser.mjs";

export async function reviewServiceCommands(page, size, instanceId, fixture) {
  const data = fleetRunsFixture(fixture.snapshot.shell.workspaces[0].root);
  const commands = [];
  let statusFailed = false;
  let rejectSave = true;
  await page.route("**/runs?*", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: statusFailed ? 503 : 200,
        json: statusFailed
          ? { error: "Service status unavailable. Try again." }
          : data,
      });
      return;
    }
    assert.equal(route.request().method(), "POST");
    const command = route.request().postDataJSON();
    commands.push(command);
    if (command.action === "save") {
      if (rejectSave) {
        data.snapshot.revision = "review-conflict-recovered";
        await route.fulfill({
          status: 409,
          json: { error: "Configuration changed. Refresh and try again." },
        });
        return;
      }
      data.snapshot.document = command.document;
      data.snapshot.revision = `review-${commands.length}`;
      const template = data.snapshot.statuses[0];
      data.snapshot.statuses = command.document.configurations.map(
        (config) => ({ ...template, id: config.id }),
      );
      statusFailed = true;
    } else {
      const status = data.snapshot.statuses.find(
        (item) => item.id === command.configurationId,
      );
      status.state = command.action === "stop" ? "stopped" : "running";
      status.pid = command.action === "stop" ? null : 12345;
    }
    await route.fulfill({
      status: 202,
      json: { commandId: command.commandId, duplicate: false },
    });
  });
  await page.goto(`/instances/${instanceId}/runs`);
  await page.getByRole("heading", { name: "Frontend", exact: true }).waitFor();
  await page.getByText("Add service", { exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Review worker");
  await page.getByLabel("Command", { exact: true }).fill("node worker.js");
  await page.getByRole("button", { name: "Save service", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Configuration changed" })
    .waitFor();
  assert.equal(
    await page.getByLabel("Name", { exact: true }).inputValue(),
    "Review worker",
  );
  rejectSave = false;
  await page
    .getByRole("alert")
    .filter({ hasText: "Configuration changed" })
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Configuration changed" })
    .waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Save service", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Service saved." })
    .waitFor();
  assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "");
  assert.equal(
    commands.filter((command) => command.action === "save").length,
    2,
  );
  assert.equal(commands[1].expectedRevision, "review-conflict-recovered");
  for (const label of ["Start", "Restart", "Save service", "Edit run.json"])
    assert(
      await page
        .getByRole("button", { name: label, exact: true })
        .first()
        .isDisabled(),
    );
  statusFailed = false;
  await page
    .getByRole("alert")
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Review worker", exact: true })
    .waitFor();
  const worker = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Review worker", exact: true }),
  });
  await worker.getByRole("button", { name: "Start", exact: true }).click();
  await worker.getByText("running", { exact: true }).waitFor();
  assert(
    await page
      .getByRole("button", { name: "Save service", exact: true })
      .isDisabled(),
  );
  await worker.getByRole("button", { name: "Restart", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document
        .querySelector("button:disabled")
        ?.textContent?.includes("Refresh"),
  );
  await worker.getByRole("button", { name: "Stop", exact: true }).click();
  await worker.getByText("stopped", { exact: true }).waitFor();
  assert.deepEqual(
    commands.slice(-3).map((command) => command.action),
    ["start", "restart", "stop"],
  );
  await capture(page, `${size}-service-commands`);
  await page
    .getByRole("button", { name: "Edit run.json", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "run.json", exact: true })
    .fill("{ invalid json");
  await page
    .getByRole("button", { name: "Save configuration", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Enter valid JSON." })
    .waitFor();
  await capture(page, `${size}-configuration-error`);
  assert.equal(commands.length, 5, "Invalid JSON must not reach the host");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  return `${size}: service save conflict/retry, accepted save with failed refresh, stale controls, start/restart/stop, invalid configuration (fixtures; no processes started)`;
}
