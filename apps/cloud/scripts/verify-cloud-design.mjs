import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import axe from "axe-core";
import { cloudApi, cloudBrowserFixture } from "./cloud-browser-fixture.mjs";
import { seedCloudDesign } from "./cloud-design-fixture.mjs";
import { verifyDesignInteractions } from "./cloud-design-interactions.mjs";

const fixture = await cloudBrowserFixture({ initialize: false });
const output = resolve(
  process.env.CLOUD_DESIGN_OUTPUT ?? "../../.tmp/cloud-design",
);
const results = [],
  accessibility = [];
const api = (path, method, data) =>
  cloudApi(fixture, fixture.ownerContext, path, method, data);
await mkdir(output, { recursive: true });
const page = await fixture.ownerContext.newPage();
page.setDefaultTimeout(15000);

async function capture(name, { audit = false } = {}) {
  await page.evaluate(() => document.fonts.ready);
  await page
    .getByText(
      /^Loading (poker|comments|keys|devices|workspaces|settings|profiles|sessions|providers|connections|conversations).*$/,
    )
    .first()
    .waitFor({ state: "hidden" });
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
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
  if (audit) {
    await page.evaluate(axe.source);
    const violations = await page.evaluate(async () =>
      (
        await window.axe.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
        })
      ).violations.map((item) => ({
        id: item.id,
        impact: item.impact,
        description: item.description,
        nodes: item.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      })),
    );
    if (violations.length) accessibility.push({ name, violations });
  }
  results.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

try {
  await page.goto(`${fixture.origin}/cloud/setup`);
  await page
    .getByLabel("Organization", { exact: true })
    .fill("Northstar Studio");
  await page.getByLabel("Name", { exact: true }).fill("Alex Morgan");
  await page.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await capture("setup", { audit: true });
  await page
    .getByRole("button", { name: "Create organization", exact: true })
    .click();
  await page.waitForURL("**/cloud/issues");
  const data = await seedCloudDesign(fixture);
  const { team, cycle, issues, task, chatId } = data;
  const views = [
    ["issues", "/cloud/issues"],
    ["issues-active", "/cloud/issues?scope=active"],
    ["board", `/cloud/issues?view=board&teamId=${team.id}`],
    ["issue-detail", `/cloud/issues/${issues[0].id}`],
    ["ask-issue", `/cloud/chat?issue=${issues[0].id}`],
    ["projects", "/cloud/projects"],
    ["teams", "/cloud/teams"],
    ["cycles", "/cloud/cycles"],
    ["cycle-detail", `/cloud/cycles/${cycle.id}`],
    ["tasks", "/cloud/tasks"],
    ["task-detail", `/cloud/tasks/${task.id}`],
    ["schedules", "/cloud/schedules"],
    ["chat", "/cloud/chat"],
    ["conversation", `/cloud/chat/${chatId}`],
    ["settings", "/cloud/settings"],
    ["providers", "/cloud/providers"],
    ["execution", "/cloud/execution"],
    ["connections", "/cloud/connections"],
    ["account", "/cloud/account"],
    ["clients", "/instances"],
    ["workspaces", "/workspaces"],
    ["copilot", "/copilot"],
    ["enrollment", "/enrollment"],
    ["profiles", "/settings"],
    ["privacy", "/privacy"],
  ];
  async function visit(name, path) {
    await page.goto(`${fixture.origin}${path}`);
    await page.locator("main h1").first().waitFor();
    if (name === "conversation")
      await page.locator(".cloud-chat-answer").waitFor();
    if (name === "account")
      await page.getByRole("button", { name: "Light", exact: true }).waitFor();
    assert.ok(
      !(await page.locator("main").innerText()).includes("Application error"),
      `${name}: application error`,
    );
  }
  for (const [name, path] of views) {
    await visit(name, path);
    await capture(name, { audit: true });
  }
  await verifyDesignInteractions({ fixture, page, api, data, capture });
  await page.goto(`${fixture.origin}/cloud/account`);
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.locator('html[data-theme="light"]').waitFor();
  for (const [name, path] of views) {
    await visit(name, path);
    await capture(`${name}-light`, { audit: true });
  }
  await page.goto(`${fixture.origin}/cloud/account`);
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.locator('html[data-theme="dark"]').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, path] of views) {
    await visit(name, path);
    await capture(`${name}-mobile`);
  }
  await page.goto(`${fixture.origin}/cloud/issues`);
  const opener = page.getByRole("button", { name: "Open navigation" });
  await opener.click();
  const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });
  await drawer.getByRole("link", { name: "Projects", exact: true }).waitFor();
  await capture("mobile-navigation", { audit: true });
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "hidden" });
  assert.ok(
    await opener.evaluate((element) => element === document.activeElement),
  );
  await opener.click();
  await drawer.getByRole("link", { name: "Projects", exact: true }).click();
  await drawer.waitFor({ state: "hidden" });
  await page.waitForURL("**/cloud/projects");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Mobile project");
  await capture("mobile-project-dialog", { audit: true });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .getByRole("link", { name: "Mobile project", exact: true })
    .waitFor();
  await opener.click();
  await drawer.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.waitForURL("**/cloud/login");
  await page.getByLabel("Username or email", { exact: true }).waitFor();
  await capture("login-mobile", { audit: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture("login", { audit: true });
  for (const path of ["join", "sign-in", "sso", "authorize"]) {
    await page.goto(`${fixture.origin}/cloud/${path}`);
    await page.locator("main").getByRole("alert").waitFor();
    await capture(`auth-${path}`, { audit: true });
  }
  assert.deepEqual(fixture.pageErrors, []);
  await writeFile(
    join(output, "results.json"),
    JSON.stringify({ captures: results, accessibility }, null, 2),
  );
  assert.deepEqual(
    accessibility,
    [],
    "Accessibility violations; see results.json",
  );
  process.stdout.write(`Screenshots and results: ${output}\n`);
} catch (error) {
  await writeFile(
    join(output, "failure.json"),
    JSON.stringify(
      {
        message: error.message,
        url: page.url(),
        pageErrors: fixture.pageErrors,
        accessibility,
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
