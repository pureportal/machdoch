import assert from "node:assert/strict";
import { capture, contained, trapped } from "./browser.mjs";

async function sessionAction(page, name) {
  if (page.viewportSize().width <= 900) {
    await page
      .getByRole("button", { name: "Session actions", exact: true })
      .click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  } else await page.getByRole("button", { name, exact: true }).click();
}

async function sessionsPanel(page) {
  if (page.viewportSize().width <= 900)
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
  return page.getByRole("complementary", { name: "Sessions", exact: true });
}

export async function reviewSessionActions(page, size, fixture) {
  const shell = fixture.snapshot.shell;
  const initial = shell.sessions[0];
  const title = initial.title;
  await sessionAction(page, "Rename session");
  const titleInput = page.getByLabel("Session title", { exact: true });
  await titleInput.fill("Retained title edit");
  fixture.failNext = "rename-session";
  await titleInput.press("Enter");
  await page
    .getByRole("alert")
    .filter({ hasText: "could not complete" })
    .waitFor();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  assert.equal(await titleInput.inputValue(), "Retained title edit");
  await titleInput.press("Enter");
  await page
    .getByRole("heading", { name: "Retained title edit", exact: true })
    .waitFor();
  initial.title = title;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("heading", { name: title, exact: true }).waitFor();

  if (page.viewportSize().width <= 900) await sessionAction(page, "Edit tags");
  const tags = page.getByLabel("Session tags", { exact: true });
  await tags.fill("release, review");
  fixture.failNext = "tag-session";
  await tags.press("Enter");
  await page
    .getByRole("alert")
    .filter({ hasText: "could not complete" })
    .waitFor();
  assert.equal(await tags.inputValue(), "release, review");
  await tags.press("Enter");
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Updating"]'),
  );

  await sessionAction(page, "Archive session");
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Updating"]'),
  );
  assert(initial.archivedAt);
  await sessionAction(page, "Restore session");
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Updating"]'),
  );
  assert.equal(initial.archivedAt, undefined);
  fixture.delay = 700;
  await sessionAction(page, "Pin session");
  await page.getByLabel("Updating", { exact: true }).waitFor();
  assert(
    await page
      .getByRole("button", {
        name:
          page.viewportSize().width <= 900
            ? "Session actions"
            : "Duplicate session",
        exact: true,
      })
      .isDisabled(),
  );
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Updating"]'),
  );
  fixture.delay = 0;
  await sessionAction(page, "Unpin session");
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Updating"]'),
  );

  for (const action of ["Duplicate session", "Branch session"]) {
    await sessionAction(page, action);
    await page
      .getByRole("heading", { name: `${title} copy`, exact: true })
      .waitFor();
    assert.equal(await page.getByLabel("Task composer").inputValue(), "");
    await sessionAction(page, "Delete session");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete session", exact: true })
      .click();
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
  }

  const sidebar = await sessionsPanel(page);
  fixture.failNext = "activate-session";
  await sidebar
    .getByRole("button")
    .filter({ hasText: "Second session" })
    .click();
  await sidebar
    .getByRole("alert")
    .filter({ hasText: "could not be opened" })
    .waitFor();
  await page.getByLabel("Updating").waitFor({ state: "detached" });
  assert(
    await sidebar.isVisible(),
    "A failed selection must leave sessions open",
  );
  await sidebar
    .getByRole("button")
    .filter({ hasText: "Second session" })
    .click();
  await page
    .getByRole("heading", { name: "Second session", exact: true })
    .waitFor();
  const nextSidebar = await sessionsPanel(page);
  await nextSidebar.getByRole("button").filter({ hasText: title }).click();
  await page.getByRole("heading", { name: title, exact: true }).waitFor();

  if (page.viewportSize().width <= 900)
    await page
      .getByRole("button", { name: "Composer options", exact: true })
      .click();
  await page.getByRole("button", { name: /^Session model:/ }).click();
  fixture.offline = true;
  await page.getByText("Disconnected", { exact: true }).waitFor();
  await page
    .getByRole("dialog", { name: "Session model", exact: true })
    .waitFor({ state: "detached" });
  assert(
    await page.getByRole("button", { name: /^Session model:/ }).isDisabled(),
  );
  assert(
    await page
      .getByRole("button", { name: "Global memory", exact: true })
      .isDisabled(),
  );
  const offlineSidebar = await sessionsPanel(page);
  assert(
    await offlineSidebar
      .getByRole("button", { name: "New", exact: true })
      .isDisabled(),
  );
  assert(
    await offlineSidebar
      .getByRole("button")
      .filter({ hasText: "Second session" })
      .isDisabled(),
  );
  if (page.viewportSize().width <= 900) await page.keyboard.press("Escape");
  await page
    .locator(".m-product-message")
    .filter({ hasText: "shared Markdown" })
    .scrollIntoViewIfNeeded();
  assert(
    await page
      .locator(".m-product-message-actions")
      .getByRole("button", { name: "Retry", exact: true })
      .first()
      .isDisabled(),
  );
  await capture(page, `${size}-disconnected-controls`);
  fixture.offline = false;
  await page
    .getByRole("alert")
    .filter({ hasText: "Instance is offline." })
    .getByRole("button", { name: "Retry", exact: true })
    .click();
  await page.getByText("Connected", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Task composer").inputValue(),
    "Draft kept while disconnected",
  );
  return `${size}: title/tag failure retention, archive/restore, pin, duplicate/branch/delete, failed session selection, disconnected controls`;
}

export async function reviewActivity(page, size, fixture) {
  const shell = fixture.snapshot.shell;
  const tasks = fixture.snapshot.sessions;
  fixture.snapshot.sessions = [
    {
      taskId: "task_activity_details",
      task: "Review a project with detailed progress",
      mode: "machdoch",
      state: "failed",
      message:
        "A dependency could not be loaded. Check the logs before retrying.",
      cancellable: false,
      startedAt: Date.now() - 20000,
      updatedAt: Date.now(),
      progressCount: 1,
      timeline: [
        {
          createdAt: Date.now(),
          kind: "progress",
          phase: "working",
          label: "Checking project",
          detail: "Read project configuration",
        },
      ],
      logs: [
        {
          createdAt: Date.now(),
          stream: "stderr",
          chunk: `Missing dependency: ${"long-path/".repeat(24)}module\n${"Task output\n".repeat(40)}`,
        },
      ],
    },
  ];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("button", { name: "Activity", exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole("tab", { name: "Tasks", exact: true }).click();
  await page.getByText("Task details", { exact: true }).click();
  await page.getByLabel("Task logs", { exact: true }).waitFor();
  fixture.snapshot.sessions[0].logs.push({
    createdAt: Date.now(),
    stream: "stdout",
    chunk: "Newest task output",
  });
  await page
    .getByLabel("Task logs", { exact: true })
    .filter({ hasText: "Newest task output" })
    .waitFor();
  await page.getByLabel("Task logs", { exact: true }).focus();
  await page.keyboard.press("End");
  await capture(page, `${size}-task-details`);
  assert(
    await page
      .getByLabel("Task logs")
      .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  );
  assert(
    await page
      .getByLabel("Task logs")
      .evaluate((element) => element.scrollTop > 0),
  );
  for (const feature of [
    {
      key: "instructions",
      tab: "Instructions",
      empty: "No instructions",
      loading: "Loading instructions…",
      emptyValue: { profiles: [] },
    },
    {
      key: "scheduler",
      tab: "Scheduler",
      empty: "No scheduled work",
      loading: "Loading scheduled work…",
      emptyValue: { jobs: [], runs: [] },
    },
  ]) {
    const original = shell[feature.key];
    shell[feature.key] = { ...original, ...feature.emptyValue, loading: true };
    await page.getByRole("tab", { name: feature.tab, exact: true }).click();
    await page.getByText(feature.loading, { exact: true }).waitFor();
    shell[feature.key].loading = false;
    shell[feature.key].error = `${feature.tab} could not be loaded. Try again.`;
    await page.getByRole("tabpanel").getByRole("alert").waitFor();
    assert.equal(
      await page.getByText(feature.empty, { exact: true }).count(),
      0,
    );
    delete shell[feature.key].error;
    await page
      .getByRole("tabpanel")
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await page.getByText(feature.empty, { exact: true }).waitFor();
    shell[feature.key] = original;
  }
  const packs = shell.contextPacks;
  shell.contextPacks = [
    {
      id: "review_context_pack",
      name: "Review context",
      instructionsPreview: "Project instructions",
      promptPreview: "",
      attachmentCount: 0,
      variables: [],
      matched: false,
    },
  ];
  await page.getByRole("tab", { name: "Context", exact: true }).click();
  const pack = page.getByRole("article", {
    name: "Review context",
    exact: true,
  });
  await pack.getByRole("button", { name: "Apply", exact: true }).click();
  await pack.getByRole("button", { name: "Applied", exact: true }).waitFor();
  await pack.getByRole("button", { name: "Delete", exact: true }).click();
  await trapped(page);
  fixture.failNext = "delete-context-pack";
  await page
    .getByRole("dialog", { name: "Delete Review context?", exact: true })
    .getByRole("button", { name: "Delete context pack", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Delete Review context?", exact: true })
    .getByRole("alert")
    .waitFor();
  await capture(page, `${size}-context-delete-error`);
  fixture.delay = 500;
  await page
    .getByRole("dialog", { name: "Delete Review context?", exact: true })
    .getByRole("button", { name: "Delete context pack", exact: true })
    .click();
  await page.keyboard.press("Escape");
  assert(
    await page
      .getByRole("dialog", { name: "Delete Review context?", exact: true })
      .isVisible(),
  );
  await pack.waitFor({ state: "detached" });
  await page
    .getByRole("dialog", { name: "Delete Review context?", exact: true })
    .waitFor({ state: "detached" });
  assert(
    await page
      .getByRole("dialog", { name: "Activity", exact: true })
      .evaluate((element) => element.contains(document.activeElement)),
    "Focus must return to Activity after deletion",
  );
  fixture.delay = 0;
  shell.contextPacks = packs;
  fixture.snapshot.sessions = tasks;
  await page.keyboard.press("Escape");

  shell.composer.sessionMemory = [
    {
      id: "review_memory",
      content: "Use the existing project configuration.",
      createdAt: Date.now(),
    },
  ];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  if (
    page.viewportSize().width <= 900 &&
    (await page
      .getByRole("button", { name: "Composer options", exact: true })
      .getAttribute("aria-expanded")) === "false"
  )
    await page
      .getByRole("button", { name: "Composer options", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Manage session memory", exact: true })
    .click();
  await trapped(page);
  await contained(page, "dialog[open]");
  await page.getByRole("button", { name: "Forget", exact: true }).click();
  await page.getByText("No session memory saved.", { exact: true }).waitFor();
  await capture(page, `${size}-session-memory`);
  await page.keyboard.press("Escape");
  return `${size}: Activity task progress/logs, loading/error retry, context apply/delete failure recovery, session memory`;
}
