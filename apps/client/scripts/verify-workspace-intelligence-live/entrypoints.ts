import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startVerificationFleet } from "./fleet.ts";

const artifactBase = fileURLToPath(
  new URL("../../../../.machdoch/validation/", import.meta.url),
);
const assets = fileURLToPath(
  new URL("../../../fleet-manager/public/media-studio/", import.meta.url),
);
await mkdir(artifactBase, { recursive: true });
const artifacts = await mkdtemp(join(artifactBase, "fleet-entrypoints-"));
const root = join(artifacts, "workspace");
await mkdir(root);
await writeFile(
  join(root, "research.txt"),
  "Northern Lights research evidence.\r\nThe prototype uses local source references.\r\n",
);
const originalConfig = process.env.MACHDOCH_USER_CONFIG_DIR;
process.env.MACHDOCH_USER_CONFIG_DIR = join(artifacts, "config");
const errors: string[] = [];
const checks: string[] = [];
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  artifacts,
  checks,
  errors,
};
let fleet: Awaited<ReturnType<typeof startVerificationFleet>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page:
  | Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>>
  | undefined;
try {
  fleet = await startVerificationFleet(root);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  const response = await page.request.post(`${fleet.origin}/api/auth/login`, {
    headers: { Origin: fleet.origin },
    data: fleet.owner,
  });
  assert.equal(response.status(), 200);
  await page.route(`${fleet.origin}/media-studio/**`, async (route) => {
    const path = resolve(
      assets,
      decodeURIComponent(
        new URL(route.request().url()).pathname.slice("/media-studio/".length),
      ),
    );
    assert.ok(path.startsWith(resolve(assets) + sep));
    await route.fulfill({ path });
  });
  const query = new URLSearchParams({
    instance: fleet.instanceId,
    workspace: root,
  });
  const instructionsUrl = `${fleet.origin}/media-studio/instructions.html?${query}`;
  await page.goto(instructionsUrl);
  await page.getByRole("tab", { name: "Instructions", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Skills",
  );
  await page.keyboard.press("Enter");
  const skills = page.getByRole("region", { name: "Skills", exact: true });
  await skills.getByRole("button", { name: "New skill", exact: true }).click();
  await skills.getByLabel("Name", { exact: true }).fill("entrypoint-evidence");
  await skills
    .getByLabel("Description", { exact: true })
    .fill("Check saved research evidence.");
  await skills
    .getByLabel("Content", { exact: true })
    .fill("Read the selected research source before reporting its result.");
  const cancelledTab = page
    .waitForEvent("dialog")
    .then((dialog) => dialog.dismiss());
  await page.getByRole("tab", { name: "Instructions", exact: true }).click();
  await cancelledTab;
  assert.equal(
    await skills.getByLabel("Name", { exact: true }).inputValue(),
    "entrypoint-evidence",
  );
  await skills.getByRole("button", { name: "Save", exact: true }).click();
  await skills
    .getByRole("button", { name: "entrypoint-evidence", exact: true })
    .waitFor();
  await page.reload();
  await page.getByRole("tab", { name: "Skills", exact: true }).click();
  await skills
    .getByRole("button", { name: "entrypoint-evidence", exact: true })
    .click();
  assert.equal(
    await skills.getByLabel("Description", { exact: true }).inputValue(),
    "Check saved research evidence.",
  );
  checks.push(
    "Built Instructions/Skills entrypoint loads through Fleet, protects a draft on tab navigation, and persists the skill after reload.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await skills.getByLabel("Content", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(artifacts, "skills-mobile.png"),
    fullPage: true,
  });
  report.skillsLayout = await page.evaluate(() => ({
    width: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    rootWidth: document.getElementById("root")!.scrollWidth,
  }));
  assert.ok(
    (report.skillsLayout as { documentWidth: number }).documentWidth <= 391,
    "Skills page overflows horizontally.",
  );

  await page.goto(`${fleet.origin}/media-studio/workspaces.html?${query}`);
  await page.getByRole("tab", { name: "Knowledge", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(
    () => document.activeElement?.textContent === "Research",
  );
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const controlStyles = [];
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
      document.documentElement.classList.toggle("dark", value === "dark");
    }, theme);
    await page.getByLabel("Title", { exact: true }).focus();
    const primary = await page
      .getByRole("button", { name: "New project", exact: true })
      .evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        foreground: getComputedStyle(element).color,
      }));
    const field = await page
      .getByLabel("Title", { exact: true })
      .evaluate((element) => ({
        border: getComputedStyle(element).borderColor,
        ring: getComputedStyle(element).getPropertyValue("--tw-ring-color"),
        focusVisible: element.matches(":focus-visible"),
      }));
    assert.notEqual(
      primary.background,
      "rgba(0, 0, 0, 0)",
      "Primary action has no fill.",
    );
    assert.notEqual(
      primary.background,
      primary.foreground,
      "Primary action has no text contrast.",
    );
    assert.ok(
      field.focusVisible && field.ring.trim(),
      "Focused field has no visible focus ring.",
    );
    controlStyles.push({ theme, primary, field });
  }
  report.controlStyles = controlStyles;
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.classList.add("dark");
  });
  await page.getByLabel("Title", { exact: true }).fill("Northern Lights");
  await page
    .getByLabel("Research question", { exact: true })
    .fill("What does the local evidence establish?");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.getByRole("button", { name: /Northern Lights/ }).waitFor();
  await page.getByRole("tab", { name: "Knowledge", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search workspace knowledge" })
    .fill("Northern");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: /^research\.txt:/ }).waitFor();
  await page
    .getByRole("button", { name: "Save to research", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Research project" })
    .selectOption({ label: "Northern Lights" });
  await page.getByRole("button", { name: "Save source", exact: true }).click();
  await page
    .getByRole("button", { name: "Save source", exact: true })
    .waitFor({ state: "detached" });
  await page.reload();
  await page.getByRole("tab", { name: "Research", exact: true }).click();
  await page.getByRole("button", { name: /Northern Lights/ }).click();
  assert.match(
    await page.getByLabel("Excerpt", { exact: true }).inputValue(),
    /Northern Lights research evidence/,
  );
  await page.mouse.move(300, 600);
  await page.mouse.wheel(0, 2400);
  await page.waitForFunction(
    () => document.querySelector("main")!.scrollTop > 0,
  );
  const saveBounds = await page
    .getByRole("button", { name: "Save project", exact: true })
    .boundingBox();
  assert.ok(
    saveBounds && saveBounds.y >= 0 && saveBounds.y + saveBounds.height <= 844,
    "Research actions cannot be reached by scrolling.",
  );
  report.researchScroll = await page.locator("main").evaluate((element) => ({
    top: element.scrollTop,
    height: element.clientHeight,
    contentHeight: element.scrollHeight,
  }));
  await page.screenshot({
    path: join(artifacts, "research-mobile.png"),
    fullPage: true,
  });
  report.researchLayout = await page.evaluate(() => ({
    width: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    rootWidth: document.getElementById("root")!.scrollWidth,
  }));
  assert.ok(
    (report.researchLayout as { documentWidth: number }).documentWidth <= 391,
    "Research page overflows horizontally.",
  );
  checks.push(
    "Built workspace entrypoint saves a project and local search evidence, retains both after reload, and fits a narrow viewport.",
  );
  checks.push(
    "Arrow keys move between library tabs, Enter activates them, and the research editor scrolls to its actions.",
  );
  checks.push(
    "Primary buttons have a visible fill and focused inputs have a focus ring in both light and dark themes.",
  );
  assert.deepEqual(errors, []);
  report.http = fleet.requests;
  report.passed = true;
} catch (error) {
  if (page) {
    await page.screenshot({
      path: join(artifacts, "failure.png"),
      fullPage: true,
    });
    report.pageText = await page.locator("body").innerText();
    report.textareaLabels = await page
      .locator("textarea")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          labels: Array.from((element as HTMLTextAreaElement).labels ?? []).map(
            (label) => label.textContent,
          ),
          value: (element as HTMLTextAreaElement).value,
        })),
      );
  }
  report.http = fleet?.requests;
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await browser?.close();
  await fleet?.stop();
  if (originalConfig === undefined) delete process.env.MACHDOCH_USER_CONFIG_DIR;
  else process.env.MACHDOCH_USER_CONFIG_DIR = originalConfig;
  report.finishedAt = new Date().toISOString();
  await writeFile(
    join(artifacts, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`Fleet entrypoint verification: ${artifacts}`);
}
