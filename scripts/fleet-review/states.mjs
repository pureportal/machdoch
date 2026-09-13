import assert from "node:assert/strict";
import { fleetRunsFixture } from "../fixtures/fleet-review.mjs";
import { capture, command, trapped } from "./browser.mjs";

export async function reviewFeatureStates(page, size, fixture) {
  const shell = fixture.snapshot.shell;
  for (const feature of [
    {
      key: "scheduler",
      name: "Smart Scheduler",
      collection: "jobs",
      noun: "jobs",
      unavailable: "Jobs unavailable",
    },
    {
      key: "ralph",
      name: "RALPH",
      collection: "flows",
      noun: "flows",
      unavailable: "Flows unavailable",
    },
  ]) {
    const original = shell[feature.key];
    shell[feature.key] = {
      ...original,
      [feature.collection]: [],
      runs: [],
      loading: true,
    };
    await page
      .getByRole("button", { name: feature.name, exact: true })
      .filter({ visible: true })
      .click();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText(new RegExp(`^Loading ${feature.noun}`)).waitFor();
    shell[feature.key].loading = false;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText(`No ${feature.noun}`, { exact: true }).waitFor();
    shell[feature.key].error = "Could not load this view. Try again.";
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByText(feature.unavailable, { exact: true }).waitFor();
    assert.equal(
      await page.getByText(`No ${feature.noun}`, { exact: true }).count(),
      0,
    );
    await capture(page, `${size}-${feature.key}-error`);
    shell[feature.key] = original;
  }
  await page
    .getByRole("button", { name: "Chat", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const code = page.locator(".m-markdown-code-block").first();
  await code.scrollIntoViewIfNeeded();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new DOMException("Clipboard denied", "NotAllowedError");
        },
      },
    }),
  );
  await code.getByRole("button", { name: "Copy code block" }).click();
  await code.getByRole("alert").waitFor();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.reviewCopiedText = text;
        },
      },
    }),
  );
  await code.getByRole("button", { name: "Copy code block" }).click();
  await code.getByRole("button", { name: "Copied code block" }).waitFor();
  assert.equal(await code.getByRole("alert").count(), 0);
  assert(await page.evaluate(() => window.reviewCopiedText.length > 0));
  return `${size}: loading/empty/error states and clipboard denial/retry`;
}

export async function reviewProjects(page, size, fixture) {
  const shell = fixture.snapshot.shell;
  const workspace = shell.workspaces[0].root;
  shell.projectLibrary = {
    root: workspace,
    maximumProjects: 100,
    maximumConcurrentOperations: 2,
    projects: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "review-project",
        kind: "git",
        status: "ready",
        repository: "https://github.com/example/review.git",
        workspace,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  };
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("button", { name: "Projects", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByLabel("Search projects").fill("does-not-exist");
  await page.getByRole("heading", { name: "No matching projects" }).waitFor();
  await page.getByLabel("Search projects").fill("");
  await page
    .getByRole("button", { name: "Empty project", exact: true })
    .click();
  await trapped(page);
  await page.getByLabel("Project folder name").fill("../invalid");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert(!fixture.commands.some((item) => item.kind === "create-project"));
  await page.getByLabel("Project folder name").fill("review-created");
  fixture.failNext = "create-project";
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await command(fixture, "create-project", page);
  await page
    .getByRole("dialog")
    .getByRole("alert")
    .filter({ hasText: "could not complete" })
    .waitFor();
  assert.equal(
    await page.getByLabel("Project folder name").inputValue(),
    "review-created",
  );
  await capture(page, `${size}-project-error`);
  fixture.delay = 500;
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.getByRole("button", { name: /^Preparing/ }).waitFor();
  await page.keyboard.press("Escape");
  assert(
    await page.getByRole("dialog").isVisible(),
    "A pending form must stay open",
  );
  await page.getByRole("dialog").waitFor({ state: "detached" });
  fixture.delay = 0;
  await page
    .getByRole("heading", { name: "review-created", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Clone repository", exact: true })
    .click();
  await page
    .getByLabel("Repository URL")
    .fill("https://github.com/example/review-clone.git");
  assert.equal(
    await page.getByLabel("Project folder name").inputValue(),
    "review-clone",
  );
  await trapped(page);
  await capture(page, `${size}-clone-dialog`);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Import folder", exact: true })
    .click();
  await page.getByLabel("Project folder name").fill("existing-folder");
  await trapped(page);
  await page.keyboard.press("Escape");
  await capture(page, `${size}-projects`);
  await page
    .getByRole("article", { name: "review-project", exact: true })
    .getByRole("button", { name: "Resume", exact: true })
    .click();
  await page.getByLabel("Task composer").waitFor();
  await page
    .getByRole("button", { name: "Projects", exact: true })
    .filter({ visible: true })
    .click();
  await page
    .getByRole("article", { name: "review-project", exact: true })
    .getByRole("button", { name: "New task", exact: true })
    .click();
  await page.getByRole("heading", { name: "New task", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Task composer").inputValue(), "");
  await page.getByLabel("Task composer").fill("Review this project");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page
    .locator(".m-product-message")
    .filter({ hasText: "Review this project" })
    .waitFor();
  await capture(page, `${size}-new-task`);
  return `${size}: project search, create validation/failure/retry, clone/import forms, new/resumed tasks`;
}

export async function reviewServices(page, size, instanceId, fixture) {
  let statusFailed = false;
  await page.route("**/runs?*", async (route) => {
    assert.equal(
      route.request().method(),
      "GET",
      "Review must not launch real services.",
    );
    await route.fulfill({
      status: statusFailed ? 503 : 200,
      json: statusFailed
        ? { error: "Service status unavailable. Try again." }
        : fleetRunsFixture(fixture.snapshot.shell.workspaces[0].root),
    });
  });
  fixture.offline = true;
  await page.goto(`/instances/${instanceId}/runs`);
  await page
    .getByRole("alert")
    .filter({ hasText: "Instance is offline." })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Refresh", exact: true })
      .isDisabled(),
    false,
  );
  await capture(page, `${size}-services-offline`);
  fixture.offline = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("heading", { name: "Frontend", exact: true }).waitFor();
  statusFailed = true;
  await page
    .getByRole("alert")
    .filter({ hasText: "Service status unavailable." })
    .waitFor();
  statusFailed = false;
  await page
    .getByRole("alert")
    .filter({ hasText: "Service status unavailable." })
    .waitFor({ state: "detached" });
  await page.getByText("Logs", { exact: true }).click();
  await page.getByLabel("Frontend logs").waitFor();
  await capture(page, `${size}-services`);
  const workspaces = fixture.snapshot.shell.workspaces;
  fixture.snapshot.shell.workspaces = [];
  await page.reload();
  await page.getByText("No projects.", { exact: true }).waitFor();
  assert.equal(await page.getByText(/^Loading services/).count(), 0);
  fixture.snapshot.shell.workspaces = workspaces;
  return `${size}: service initial-load retry, poll recovery, logs, empty projects (no processes started)`;
}
