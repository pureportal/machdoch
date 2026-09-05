import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer, { type Page } from "puppeteer-core";
import { FleetCliProductRuntime } from "../apps/client/src/cli/_helpers/cli-fleet-product.ts";
import { runFleetGatewayConnection } from "../apps/client/src/cli/_helpers/cli-fleet-gateway.ts";
import { loadRuntimeConfig } from "../apps/client/src/core/config.ts";

const baseUrl = process.env.MACHDOCH_FLEET_UI_URL ?? "http://127.0.0.1:43188";
const username = process.env.MACHDOCH_FLEET_UI_USERNAME;
const password = process.env.MACHDOCH_FLEET_UI_PASSWORD;
assert.ok(
  username && password && process.env.MACHDOCH_FLEET_UI_FIXTURE === "true",
  "Use an isolated seeded Fleet Manager and set MACHDOCH_FLEET_UI_USERNAME, MACHDOCH_FLEET_UI_PASSWORD, and MACHDOCH_FLEET_UI_FIXTURE=true.",
);
const candidates = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean) as string[];
let executablePath: string | undefined;
for (const candidate of candidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {}
}
assert.ok(executablePath, "Install Chrome/Edge or set CHROME_PATH.");
const output = path.resolve(
  process.env.MACHDOCH_PROJECTS_OUTPUT ??
    "apps/fleet-manager/.cache/projects-results",
);
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), "machdoch-project-browser-"));
process.env.MACHDOCH_USER_CONFIG_DIR = path.join(root, "config");
process.env.MACHDOCH_WORKSPACE_ROOT = path.join(root, "projects");
const browser = await puppeteer.launch({ executablePath, headless: true });
let page: Page;
const errors: string[] = [];
const controller = new AbortController();
let gateway: Promise<unknown> | undefined;
let instanceId: string | undefined;
let runtime: FleetCliProductRuntime | undefined;
const createRuntime = () =>
  FleetCliProductRuntime.create(root, {
    loadRuntimeConfig: async (...args) => ({
      ...(await loadRuntimeConfig(...args)),
      provider: "openai",
      model: "fixture-model",
      offline: false,
      providerAvailability: [{ provider: "openai", configured: true }],
    }),
    createTaskExecutionController: (task, config) => ({
      signal: new AbortController().signal,
      cancel: () => undefined,
      execute: async () => {
        await writeFile(
          path.join(config.workspaceRoot, "fleet-browser-task.txt"),
          "Task reached the selected project.",
        );
        return {
          task,
          mode: config.mode,
          status: "executed",
          summary: "The task reached the selected project.",
          executedTools: [],
          outputSections: [],
        };
      },
    }),
  });

async function api(route: string, method = "GET", body?: unknown) {
  return await page.evaluate(
    async ({ route, method, body }) => {
      const csrf = document.cookie
        .split(";")
        .map((part) => part.trim().split("="))
        .find(([key]) => key === "__Host-machdoch_fleet_csrf")?.[1];
      const response = await fetch(route, {
        method,
        headers: {
          "X-Machdoch-Fleet-CSRF": csrf ?? "",
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? `HTTP ${response.status}`);
      return result;
    },
    { route, method, body },
  );
}

async function click(label: string, scope = "") {
  for (const element of await page.$$(`${scope}button`)) {
    if (
      (await element.evaluate(
        (element, label) => element.textContent?.trim() === label,
        label,
      )) &&
      (await element.isVisible())
    ) {
      await element.scrollIntoView();
      await element.click();
      return;
    }
    await element.dispose();
  }
  throw new Error(`Control not found: ${label}`);
}

async function checkLayout(label: string) {
  const viewport = page.viewport()!;
  const width = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  assert.equal(
    width.viewport,
    viewport.width,
    `${label}: expanded mobile viewport`,
  );
  assert.ok(
    width.document <= viewport.width + 1,
    `${label}: horizontal overflow`,
  );
  const dialog = await page.$('[role="dialog"]');
  if (dialog) {
    const rect = await dialog.boundingBox();
    assert.ok(
      rect &&
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + rect.width <= viewport.width + 1 &&
        rect.y + rect.height <= viewport.height + 1,
      `${label}: dialog overflow`,
    );
  }
  await page.screenshot({
    path: path.join(
      output,
      `${viewport.width}-${viewport.height}-${label}.png`,
    ),
  });
}

try {
  page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  runtime = await createRuntime();
  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle2" });
  await page.type("#username", username);
  await page.type("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname === "/instances");
  const grant = await api("/api/enrollment-keys", "POST");
  const instanceSecret = `mch_instance_${randomBytes(32).toString("base64url")}`;
  const response = await fetch(`${baseUrl}/api/enroll`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${grant.enrollmentKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      displayName: "Project browser verification",
      instanceSecret,
      productVersion: "10.1.1",
      protocolVersion: 4,
    }),
  });
  assert.ok(response.ok, `Enrollment failed: ${response.status}`);
  const enrollment = await response.json();
  instanceId = enrollment.instanceId;
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => {
    connected = resolve;
  });
  gateway = runFleetGatewayConnection({
    config: {
      schemaVersion: 1,
      enabled: true,
      managerUrl: baseUrl,
      managerId: enrollment.managerId,
      instanceId: instanceId!,
      displayName: "Project browser verification",
      instanceSecret,
    },
    signal: controller.signal,
    productVersion: "10.1.1",
    handleRequest: (request) => runtime!.handleRequest(request),
    onConnected: connected,
  });
  await Promise.race([
    ready,
    gateway.then((result) => {
      throw new Error(`Gateway stopped: ${JSON.stringify(result)}`);
    }),
  ]);
  await page.goto(`${baseUrl}/instances/${instanceId}`, {
    waitUntil: "networkidle2",
  });
  await page.waitForSelector(".m-project-library");
  await checkLayout("empty-library");
  await click("Empty project");
  await page.type('[aria-label="Project folder name"]', "new-project");
  await click("Create project");
  await page.waitForFunction(() =>
    document
      .querySelector('article[aria-label="new-project"]')
      ?.textContent?.includes("Ready"),
  );
  await click("New task", 'article[aria-label="new-project"] ');
  await page.waitForSelector('[aria-label="Task composer"]');
  await page.type(
    '[aria-label="Task composer"]',
    "Create a file in this project",
  );
  await page.click('[aria-label="Send message"]');
  await page.waitForFunction(() =>
    document
      .querySelector(".m-product-conversation")
      ?.textContent?.includes("The task reached the selected project."),
  );
  assert.equal(
    await readFile(
      path.join(root, "projects", "new-project", "fleet-browser-task.txt"),
      "utf8",
    ),
    "Task reached the selected project.",
  );
  await checkLayout("task-in-project");
  await page.click('.m-product-mobile-nav [aria-label="Projects"]');
  await click("Clone repository");
  await page.type(
    '[aria-label="Repository URL"]',
    process.env.MACHDOCH_FLEET_TEST_REPOSITORY ??
      "https://github.com/octocat/Hello-World.git",
  );
  await page.$eval('[aria-label="Project folder name"]', (element) => {
    (element as HTMLInputElement).select();
  });
  await page.type('[aria-label="Project folder name"]', "cloned-repository");
  await page.click("label.m-project-checkbox input");
  await click("Clone project");
  await page.waitForSelector('article[aria-label="cloned-repository"]');
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForFunction(
    () =>
      document
        .querySelector('article[aria-label="cloned-repository"]')
        ?.textContent?.includes("Ready"),
    { timeout: 90_000 },
  );
  await access(
    path.join(root, "projects", "cloned-repository", ".git", "HEAD"),
  );
  await mkdir(path.join(root, "projects", "existing-folder"));
  await writeFile(
    path.join(root, "projects", "existing-folder", "keep.txt"),
    "preserved",
  );
  await click("Import folder");
  await page.type('[aria-label="Project folder name"]', "existing-folder");
  await click("Import project");
  await page.waitForFunction(() =>
    document
      .querySelector('article[aria-label="existing-folder"]')
      ?.textContent?.includes("Ready"),
  );
  for (const viewport of [
    { width: 320, height: 844 },
    { width: 390, height: 844 },
    { width: 768, height: 844 },
    { width: 1440, height: 900 },
    { width: 390, height: 360 },
  ]) {
    await page.setViewport({
      ...viewport,
      isMobile: viewport.width < 768,
      hasTouch: viewport.width <= 900,
    });
    await checkLayout("projects");
    for (const label of [
      "Clone repository",
      "Empty project",
      "Import folder",
    ]) {
      await click(label);
      await checkLayout(label.toLowerCase().replaceAll(" ", "-"));
      await page.keyboard.press("Escape");
      assert.equal(await page.$('[role="dialog"]'), null);
    }
  }
  await click("Remove entry", 'article[aria-label="existing-folder"] ');
  await page.waitForFunction(
    () => !document.querySelector('article[aria-label="existing-folder"]'),
  );
  assert.equal(
    await readFile(
      path.join(root, "projects", "existing-folder", "keep.txt"),
      "utf8",
    ),
    "preserved",
  );
  assert.deepEqual(errors, []);
  console.log(
    `Passed project creation, real Git clone, reload, import, agent task routing, removal, and 20 responsive project/form checks. Screenshots: ${output}`,
  );
} finally {
  controller.abort();
  const stopped = await Promise.allSettled([gateway, runtime?.shutdown()]);
  if (instanceId)
    await api(
      `/api/instances/${encodeURIComponent(instanceId)}`,
      "DELETE",
    ).catch(() => undefined);
  await browser.close();
  const relative = path.relative(path.resolve(tmpdir()), path.resolve(root));
  assert.ok(
    relative.startsWith("machdoch-project-browser-") &&
      !relative.includes(path.sep),
    "Refusing to remove unexpected test directory",
  );
  await rm(root, { recursive: true, force: true });
  assert.ok(
    stopped.every((result) => result.status === "fulfilled"),
    "Fixture shutdown failed",
  );
}
