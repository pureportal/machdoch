import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import axe from "axe-core";
import {
  assertEventually,
  cloudApi,
  cloudBrowserFixture,
} from "./cloud-browser-fixture.mjs";
import { seedCloudDesign } from "./cloud-design-fixture.mjs";

const fixture = await cloudBrowserFixture();
const output = resolve(
  process.env.CLOUD_DESIGN_OUTPUT ?? "../../.tmp/cloud-design-refinement",
);
const page = await fixture.ownerContext.newPage();
const api = (path, method, data) =>
  cloudApi(fixture, fixture.ownerContext, path, method, data);
const captures = [];
const checks = [];
const accessibility = [];
page.setDefaultTimeout(15000);
await mkdir(output, { recursive: true });

async function capture(name) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    `${name}: page overflow`,
  );
  await page.evaluate(axe.source);
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({
        target,
        failureSummary,
      })),
    })),
  );
  if (violations.length) accessibility.push({ name, violations });
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  captures.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const data = await seedCloudDesign(fixture);
  const workspace = await api("workspace");
  const { profiles } = await api("execution-profiles");
  const profile = profiles[0];
  const worker = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Cloud runner · Europe",
  });
  const results = [];
  for (const [state, title, summary] of [
    [
      "succeeded",
      "Review workspace permissions",
      "Reviewed project access and validated the permission checks. All requested checks passed.",
    ],
    [
      "failed",
      "Validate the release candidate",
      "The required checks did not pass. Review the test output before starting another task.",
    ],
  ]) {
    const run = await api("runs", "POST", {
      profileId: profile.id,
      subject: {
        kind: "project",
        id: data.project.id,
        revision: workspace.projects.find(
          (project) => project.id === data.project.id,
        ).revision,
        purpose: "test",
        objective: title,
        acceptanceCriteria:
          "Validate the configured checks and provide a reviewable result.",
      },
    });
    await fixture.database.query(
      "UPDATE cloud_runs SET state=$2,summary=$3,stop_message=$4,stop_reason=CASE WHEN $2='failed' THEN 'failed' ELSE NULL END,epoch=1,revision=revision+1 WHERE id=$1",
      [
        run.id,
        state,
        summary,
        state === "failed"
          ? "A required check failed. Review the result before retrying."
          : null,
      ],
    );
    await fixture.database.query(
      "INSERT INTO cloud_run_attempts (organization_id,id,run_id,worker_id,claim_id,epoch,state,lease_expires_at) VALUES ($1,$2,$3,$4,$5,1,'stopped',clock_timestamp())",
      [
        workspace.organization.id,
        randomUUID(),
        run.id,
        worker.id,
        randomUUID(),
      ],
    );
    results.push({ ...run, state, title });
  }

  const views = [
    ["issues", "/cloud/issues"],
    ["issue-detail", `/cloud/issues/${data.issues[0].id}`],
    ["tasks", "/cloud/tasks"],
    ["task-queued", `/cloud/tasks/${data.task.id}`],
    ...results.map((run) => [`task-${run.state}`, `/cloud/tasks/${run.id}`]),
    ["schedules", "/cloud/schedules"],
    ["providers", "/cloud/providers"],
    ["execution", "/cloud/execution"],
    ["projects", "/cloud/projects"],
    ["teams", "/cloud/teams"],
    ["cycles", "/cloud/cycles"],
  ];
  for (const mode of ["dark", "light", "mobile"]) {
    await page.goto(`${fixture.origin}/cloud/account`);
    const theme = mode === "light" ? "Light" : "Dark";
    await page.getByRole("button", { name: theme, exact: true }).click();
    await page.locator(`html[data-theme="${theme.toLowerCase()}"]`).waitFor();
    await page.setViewportSize(
      mode === "mobile"
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 },
    );
    for (const [name, path] of views) {
      await page.goto(`${fixture.origin}${path}`);
      await page.locator("main h1").first().waitFor();
      if (name === "tasks")
        await page.locator(".cloud-task-list li").first().waitFor();
      if (name === "issue-detail")
        await page.getByLabel("Title", { exact: true }).waitFor();
      await capture(`${name}-${mode}`);
      if (mode === "mobile" && name === "issues") {
        const rows = page.getByRole("table").getByRole("row");
        assert.equal(await rows.count(), data.issues.length + 1);
        for (const row of await rows.all()) {
          for (const cell of await row.getByRole("cell").all()) {
            const box = await cell.boundingBox();
            assert.ok(
              box && box.x >= 0 && box.x + box.width <= 390,
              "Issue cell outside mobile viewport",
            );
          }
        }
        passed("All issue columns fit the mobile viewport");
      }
      if (mode === "mobile" && name === "issue-detail") {
        assert.ok(
          await page
            .getByLabel("Title", { exact: true })
            .evaluate(
              (element) => element.scrollHeight <= element.clientHeight + 1,
            ),
          "Title is clipped",
        );
        passed("Issue title wraps without clipping");
      }
    }
  }

  await page.goto(`${fixture.origin}/cloud/tasks`);
  const list = page.getByRole("list", { name: "AI tasks", exact: true });
  await page.getByLabel("Search tasks", { exact: true }).fill("permissions");
  assert.equal(await list.getByRole("listitem").count(), 1);
  await page.getByLabel("Filter tasks by status").selectOption("failed");
  await page.getByText("No matching tasks.", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  assert.equal(await list.getByRole("listitem").count(), 4);
  await page.getByLabel("Filter tasks by status").selectOption("succeeded");
  assert.equal(await list.getByRole("listitem").count(), 1);
  const resultLink = list.getByRole("link");
  await resultLink.focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(`**/cloud/tasks/${results[0].id}`);
  await page.getByRole("heading", { name: "Result", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Cancel task", exact: true })
      .count(),
    0,
  );
  const repository = page.locator("summary").filter({ hasText: "Repository" });
  await repository.focus();
  await page.keyboard.press("Enter");
  await page.getByText(profile.repository, { exact: true }).waitFor();
  await capture("task-repository-mobile");
  passed("Task search, status filtering, reset and keyboard navigation");

  await page.goto(`${fixture.origin}/cloud/tasks/${data.task.id}`);
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByText("This task will be removed from the queue.", { exact: true })
    .waitFor();
  await capture("task-cancel-mobile");
  await dialog
    .getByRole("button", { name: "Cancel task", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("status").filter({ hasText: "canceled" }).waitFor();
  assert.equal((await api(`runs/${data.task.id}`)).state, "canceled");
  passed("Task cancellation persists");

  await page.goto(`${fixture.origin}/cloud/issues/${data.issues[0].id}`);
  const updatedTitle =
    "Reconnect clients across interrupted sessions and preserve the selected workspace and pending changes";
  await page.getByLabel("Title", { exact: true }).fill(updatedTitle);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await assertEventually(
    async () =>
      (await api(`issues/${data.issues[0].id}`)).title === updatedTitle,
  );
  await page.reload();
  const title = page.getByLabel("Title", { exact: true });
  assert.equal(await title.inputValue(), updatedTitle);
  assert.ok(
    await title.evaluate(
      (element) => element.scrollHeight <= element.clientHeight + 1,
    ),
  );
  await page.getByRole("tab", { name: "AI tasks", exact: true }).click();
  await page.locator(".cloud-issue-tasks .cloud-task-row").first().waitFor();
  await capture("issue-tasks-mobile");
  passed("Wrapped title saves and embedded task list remains usable");

  await page.goto(`${fixture.origin}/cloud/schedules`);
  const schedule = page.getByRole("region", {
    name: "Weekly dependency review",
    exact: true,
  });
  await schedule.getByRole("button", { name: "History", exact: true }).click();
  await schedule.getByText("No occurrences yet.", { exact: true }).waitFor();
  await capture("schedule-history-mobile");
  await schedule
    .getByRole("button", { name: "Edit schedule", exact: true })
    .click();
  await dialog.getByLabel("Name", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  passed("Schedule history and edit actions");

  await page.goto(`${fixture.origin}/cloud/providers`);
  await page.getByRole("button", { name: "Token usage", exact: true }).click();
  await dialog.getByRole("heading").waitFor();
  await capture("provider-usage-mobile");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Edit provider", exact: true })
    .click();
  await dialog.getByLabel("Name", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  passed("Provider actions remain accessible");

  await page.goto(`${fixture.origin}/cloud/execution`);
  await page.getByRole("button", { name: "Runners", exact: true }).click();
  await page.getByText("Cloud runner · Europe", { exact: true }).waitFor();
  await capture("execution-runners-mobile");
  passed("Execution runner controls remain accessible");

  const firstPaintContext = await fixture.createContext({
    storageState: await fixture.ownerContext.storageState(),
  });
  try {
    await firstPaintContext.addInitScript(() => {
      localStorage.setItem(
        "machdoch.desktop.appearance-state",
        JSON.stringify({ version: 1, theme: "light" }),
      );
    });
    await firstPaintContext.route("**/_next/static/**/*.js", (route) =>
      route.abort(),
    );
    const firstPaint = await firstPaintContext.newPage();
    await firstPaint.goto(`${fixture.origin}/cloud/tasks`);
    await firstPaint
      .getByRole("heading", { name: "AI tasks", exact: true })
      .waitFor();
    assert.equal(
      await firstPaint.locator("html").getAttribute("data-theme"),
      "light",
    );
    assert.equal(
      await firstPaint
        .locator(".cloud-workspace")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
      "rgb(255, 255, 255)",
    );
    passed("Saved light theme is applied before hydration");
  } finally {
    await firstPaintContext.close();
  }

  await writeFile(
    join(output, "results.json"),
    JSON.stringify(
      { captures, checks, accessibility, pageErrors: fixture.pageErrors },
      null,
      2,
    ),
  );
  assert.deepEqual(
    accessibility,
    [],
    "Accessibility findings; see results.json",
  );
  assert.deepEqual(fixture.pageErrors, []);
  process.stdout.write(
    `Verified ${captures.length} views and ${checks.length} interactions.\n`,
  );
} catch (error) {
  await writeFile(
    join(output, "failure.json"),
    JSON.stringify(
      {
        message: error.message,
        url: page.url(),
        accessibility,
        pageErrors: fixture.pageErrors,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: join(output, "failure.png"), fullPage: true });
  throw error;
} finally {
  await fixture.close();
}
