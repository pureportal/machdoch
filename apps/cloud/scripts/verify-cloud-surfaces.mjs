import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import axe from "axe-core";
import {
  acceptPasswordInvitation,
  cloudApi,
  cloudBrowserFixture,
  createPasswordInvitation,
} from "./cloud-browser-fixture.mjs";
import { seedCloudDesign } from "./cloud-design-fixture.mjs";

const fixture = await cloudBrowserFixture();
const output = resolve(
  process.env.CLOUD_DESIGN_OUTPUT ?? "../../.tmp/cloud-surfaces",
);
const page = await fixture.ownerContext.newPage();
const api = (path, method, data) =>
  cloudApi(fixture, fixture.ownerContext, path, method, data);
const captures = [];
const checks = [];
const accessibility = [];
page.setDefaultTimeout(30000);
await mkdir(output, { recursive: true });

async function capture(name, target = page) {
  await target.evaluate(() => document.fonts.ready);
  const { overflow, offenders } = await target.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - innerWidth,
    offenders: [...document.querySelectorAll("body *")]
      .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 8)
      .map((element) => `${element.tagName}.${element.className}`),
  }));
  assert.ok(
    overflow <= 1,
    `${name}: page overflows by ${overflow}px: ${offenders.join(", ")}`,
  );
  await target.evaluate(axe.source);
  const violations = await target.evaluate(async () =>
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
  await target.screenshot({
    path: join(output, `${name}.png`),
    fullPage: true,
  });
  captures.push(name);
  process.stdout.write(`CAPTURE ${name}\n`);
}

function passed(name) {
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

async function appearance(mode) {
  await page.goto(`${fixture.origin}/cloud/account`);
  await page
    .getByRole("button", {
      name: mode.includes("light") ? "Light" : "Dark",
      exact: true,
    })
    .click();
  await page
    .locator(`html[data-theme="${mode.includes("light") ? "light" : "dark"}"]`)
    .waitFor();
  await page.setViewportSize(
    mode.startsWith("mobile")
      ? { width: 390, height: 844 }
      : { width: 1440, height: 1000 },
  );
}

async function connectClient(projectId) {
  const profile = await api("execution-profiles", "POST", {
    projectId,
    name: "Local Claude Code",
    target: "client",
    agent: "claude-cli",
    repository: "https://github.com/example/cloud-workspace",
    baseCommit: "a".repeat(40),
    maxDurationSeconds: 1800,
    maxTokens: 10000,
    requiredChecks: [
      { name: "Unit tests", command: "pnpm test", timeoutSeconds: 120 },
    ],
  });
  const runner = await api("execution-workers", "POST", {
    profileId: profile.id,
    name: "Andrea's laptop",
  });
  await fixture.database.query(
    "UPDATE cloud_execution_workers SET workspace_binding=$2,last_seen_at=clock_timestamp() WHERE id=$1",
    [
      runner.id,
      JSON.stringify({
        workspaceId: "11111111-1111-4111-8111-111111111111",
        name: "cloud-workspace",
        repository: "https://github.com/example/cloud-workspace",
      }),
    ],
  );
  return profile;
}

try {
  await api("auth/login", "POST", {
    email: "owner@example.test",
    password: fixture.password,
  });
  const data = await seedCloudDesign(fixture);
  await connectClient(data.project.id);

  await appearance("dark");
  await page.goto(`${fixture.origin}/cloud/projects/${data.project.id}`);
  const clients = page.locator(".cloud-project-runs", {
    hasText: "Connected clients",
  });
  await clients.getByText("cloud-workspace", { exact: true }).waitFor();
  await clients.getByText("Online", { exact: true }).waitFor();
  assert.equal(await clients.getByText("Andrea's laptop").count(), 0);
  passed("Project shows its connected client workspace and presence");

  await page.getByRole("button", { name: "Add milestone" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("Private beta");
  await page.getByRole("dialog").getByLabel("Target date").fill("2026-11-20");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add milestone" })
    .click();
  const milestone = page.getByRole("checkbox", { name: "Private beta" });
  await milestone.waitFor();
  await milestone.click();
  await page
    .locator('.cloud-milestone-check[aria-checked="true"]')
    .waitFor();
  passed("Milestones can be created and completed");

  const [first, second] = data.issues;
  await page.getByLabel(`Select ${first.identifier}`, { exact: true }).check();
  await page.getByLabel(`Select ${second.identifier}`, { exact: true }).check();
  const bulk = page.getByRole("toolbar", { name: "Selected issues" });
  await bulk.getByText("2 selected", { exact: true }).waitFor();
  await capture("project-bulk-dark");
  await bulk.getByRole("button", { name: "Priority", exact: true }).click();
  await page.getByRole("option", { name: "Urgent" }).click();
  await page.getByText("2 issues updated", { exact: true }).waitFor();
  assert.equal((await api(`issues/${first.id}`)).priority, "urgent");
  assert.equal((await api(`issues/${second.id}`)).priority, "urgent");
  await page.keyboard.press("Escape");
  await bulk.waitFor({ state: "hidden" });
  passed("Project issues support bulk edits and Escape clears the selection");

  await page.goto(`${fixture.origin}/cloud/issues/${data.issues[4].id}`);
  await page.getByRole("button", { name: "Delegate", exact: true }).click();
  await page.getByRole("group", { name: "Cloud sandbox" }).waitFor();
  await page
    .getByRole("option", { name: /Local Claude Code · Claude Code/ })
    .waitFor();
  await capture("issue-delegate-dark");
  await page.keyboard.press("Escape");
  passed("Delegate offers both the sandbox and the connected client");

  await page.goto(`${fixture.origin}/cloud/providers`);
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Claude Code on host");
  await dialog.getByLabel("Provider").selectOption("claude-code-cli");
  await dialog.getByLabel("Models").fill("sonnet");
  await capture("provider-cli-dialog-dark");
  await dialog.getByRole("button", { name: "Save provider" }).click();
  await dialog.waitFor({ state: "hidden" });
  const card = page.locator(".cloud-card", {
    hasText: "Claude Code on host",
  });
  await card.getByRole("button", { name: "Edit provider" }).click();
  await dialog.getByLabel("Replace API key").check();
  await dialog.getByRole("button", { name: "Save provider" }).click();
  await dialog.waitFor({ state: "hidden" });
  passed("A CLI provider saves and re-saves without an API key");

  await page.goto(`${fixture.origin}/cloud/execution`);
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  assert.equal(
    await dialog
      .getByLabel("Provider")
      .locator("option", { hasText: "Claude Code on host" })
      .count(),
    0,
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  passed("Sandbox profiles do not offer CLI providers");

  const memberContext = await fixture.createContext();
  const invite = await createPasswordInvitation(fixture, fixture.ownerContext, {
    email: "member@example.test",
    role: "member",
  });
  await acceptPasswordInvitation(fixture, memberContext, invite.url, {
    name: "Jordan Rivera",
    password: fixture.password,
  });
  await cloudApi(fixture, memberContext, "auth/login", "POST", {
    email: "member@example.test",
    password: fixture.password,
  });
  const member = (await cloudApi(fixture, memberContext, "workspace")).actor;
  await api("issues/changes", "POST", {
    issues: [{ id: data.issues[5].id }],
    changes: { assigneeId: member.id },
  });
  const memberPage = await memberContext.newPage();
  memberPage.setDefaultTimeout(30000);
  await memberPage.goto(`${fixture.origin}/cloud/inbox`);
  const entry = memberPage
    .getByRole("list", { name: "Notifications" })
    .getByRole("listitem")
    .first();
  await entry.getByText("Owner assigned you").waitFor();
  await capture("inbox-member", memberPage);
  await entry.getByRole("link").click();
  await memberPage.waitForURL(`**/cloud/issues/${data.issues[5].id}`);
  await memberPage.goto(`${fixture.origin}/cloud/inbox`);
  await memberPage
    .getByRole("list", { name: "Notifications" })
    .getByRole("listitem")
    .first()
    .waitFor();
  assert.equal(await memberPage.locator("[data-unread]").count(), 0);
  passed("Assignment reaches the member's inbox and opening it marks it read");

  for (const mode of ["dark", "light", "mobile-dark"]) {
    await appearance(mode);
    for (const [name, path] of [
      ["project", `projects/${data.project.id}`],
      ["roadmap", "roadmap"],
      ["issues", "issues"],
      ["board", "issues?view=board"],
      ["cycle", `cycles/${data.cycle.id}`],
      ["cycle-plan", `cycles/${data.cycle.id}/plan`],
      ["task", `tasks/${data.task.id}`],
      ["inbox", "inbox"],
      ["ask", "chat"],
    ]) {
      await page.goto(`${fixture.origin}/cloud/${path}`);
      await page.locator("main h1").waitFor();
      await capture(`${name}-${mode}`);
    }
  }
  assert.deepEqual(fixture.pageErrors, []);
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
        captures,
        checks,
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
