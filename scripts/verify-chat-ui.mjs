import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";

const clientUrl = process.env.MACHDOCH_CLIENT_UI_URL ?? "http://127.0.0.1:4173";
const fleetUrl = process.env.MACHDOCH_FLEET_UI_URL ?? "http://127.0.0.1:43188";
const username = process.env.MACHDOCH_FLEET_UI_USERNAME;
const password = process.env.MACHDOCH_FLEET_UI_PASSWORD;
const screenshotDirectory = process.env.MACHDOCH_CHAT_UI_SCREENSHOT_DIR;
const chromeCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

if (!username || !password) {
  throw new Error(
    "MACHDOCH_FLEET_UI_USERNAME and MACHDOCH_FLEET_UI_PASSWORD are required.",
  );
}

let executablePath;
for (const candidate of chromeCandidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {}
}
if (!executablePath) throw new Error("Chrome or Edge was not found.");

if (screenshotDirectory) {
  await mkdir(screenshotDirectory, { recursive: true });
}

const browser = await puppeteer.launch({ executablePath, headless: true });

const attachDiagnostics = (page) => {
  const diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  page.on("console", (message) => {
    if (message.type() === "error")
      diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "failed";
    if (
      !request.url().startsWith("data:") &&
      !(
        failure === "net::ERR_ABORTED" &&
        (request.url().endsWith("/product/snapshot") ||
          new URL(request.url()).searchParams.has("_rsc"))
      )
    ) {
      diagnostics.failedRequests.push(
        `${request.method()} ${request.url()} ${failure}`,
      );
    }
  });
  return diagnostics;
};

const measureComposer = async (page, rootSelector, optionSelector) =>
  page.$eval(
    rootSelector,
    (root, selectors) => {
      const rect = (selector) =>
        root.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null;
      const style = getComputedStyle(root);
      return {
        width: root.getBoundingClientRect().width,
        height: root.getBoundingClientRect().height,
        borderRadius: style.borderRadius,
        toolbarGap: getComputedStyle(
          root.querySelector(".app-composer-toolbar"),
        ).gap,
        model: rect(".m-composer-model-trigger"),
        option: rect(selectors.optionSelector),
        textarea: rect("textarea"),
        send: rect(".app-composer-send-button"),
        toggles: [...root.querySelectorAll(".app-composer-toggle-button")].map(
          (toggle) => ({
            label: toggle.getAttribute("aria-label"),
            pressed: toggle.getAttribute("aria-pressed"),
            disabled:
              toggle.hasAttribute("disabled") ||
              toggle.getAttribute("aria-disabled") === "true",
            rect: toggle.getBoundingClientRect().toJSON(),
          }),
        ),
      };
    },
    { optionSelector },
  );

const toggleAndRestore = async (page, selector) => {
  const original = await page.$eval(selector, (button) =>
    button.getAttribute("aria-pressed"),
  );
  await page.click(selector);
  await page.waitForFunction(
    (target, previous) =>
      document.querySelector(target)?.getAttribute("aria-pressed") !== previous,
    { timeout: 20_000 },
    selector,
    original,
  );
  await page.click(selector);
  await page.waitForFunction(
    (target, expected) =>
      document.querySelector(target)?.getAttribute("aria-pressed") === expected,
    { timeout: 20_000 },
    selector,
    original,
  );
};

const inspectClient = async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
  const diagnostics = attachDiagnostics(page);
  await page.goto(clientUrl, { waitUntil: "networkidle2" });
  const skipSetup = await page.$(
    'button[aria-label="Skip first-startup setup"]',
  );
  if (skipSetup) {
    await skipSetup.click();
    await page.waitForSelector(
      'button[aria-label="Skip first-startup setup"]',
      {
        hidden: true,
      },
    );
  }
  await page.waitForSelector(".app-agent-composer", { timeout: 20_000 });

  await page.click(".m-composer-model-trigger");
  await page.waitForSelector('.m-composer-model-popover[role="dialog"]');
  const picker = await page.$eval(".m-composer-model-popover", (popover) => ({
    providerTabs: popover.querySelectorAll('[role="tab"]').length,
    search: popover.querySelector('input[aria-label="Search models"]') !== null,
  }));
  await page.keyboard.press("Escape");

  await toggleAndRestore(
    page,
    '.app-agent-composer button[aria-label="Session memory"]',
  );
  const composer = await measureComposer(
    page,
    ".app-agent-composer",
    ".app-reasoning-picker-button",
  );
  if (screenshotDirectory) {
    await page.screenshot({
      path: path.join(screenshotDirectory, "client-chat.png"),
      fullPage: true,
    });
  }
  await page.close();
  return { composer, picker, diagnostics };
};

const findFleetInstancePath = async (page) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const instancePath = await page
      .$eval('a[href^="/instances/"]', (link) => link.getAttribute("href"))
      .catch(() => null);
    if (instancePath) return instancePath;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await page.reload({ waitUntil: "networkidle2" });
  }
  throw new Error("No online Fleet instance was available.");
};

const inspectFleet = async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
  const diagnostics = attachDiagnostics(page);
  await page.goto(`${fleetUrl}/login`, { waitUntil: "networkidle2" });
  if (new URL(page.url()).pathname === "/login") {
    await page.type("#username", username);
    await page.type("#password", password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click('button[type="submit"]'),
    ]);
  }
  const instancePath = await findFleetInstancePath(page);
  await page.goto(new URL(instancePath, fleetUrl).href, {
    waitUntil: "networkidle2",
  });
  await page.waitForSelector(".m-product-composer", { timeout: 30_000 });

  await page.click(".m-composer-model-trigger");
  await page.waitForSelector('.m-composer-model-popover[role="dialog"]');
  const picker = await page.$eval(".m-composer-model-popover", (popover) => ({
    providerTabs: popover.querySelectorAll('[role="tab"]').length,
    models: popover.querySelectorAll(".m-composer-model-option").length,
    search: popover.querySelector('input[aria-label="Search models"]') !== null,
  }));
  const selectedModel = await page.$(
    '.m-composer-model-option[data-active="true"]',
  );
  if (!selectedModel) throw new Error("The active Fleet model was not listed.");
  await selectedModel.click();
  await page.waitForSelector('.m-composer-model-popover[role="dialog"]', {
    hidden: true,
  });

  await toggleAndRestore(
    page,
    '.m-product-composer button[aria-label="Session memory"]',
  );
  const composer = await measureComposer(
    page,
    ".m-product-composer",
    '.m-product-option-menu > summary[aria-label^="Reasoning mode:"]',
  );
  if (screenshotDirectory) {
    await page.screenshot({
      path: path.join(screenshotDirectory, "fleet-chat.png"),
      fullPage: true,
    });
  }
  await page.close();
  return { composer, picker, diagnostics };
};

const assertComposer = (surface, result) => {
  const { composer, picker, diagnostics } = result;
  const squareControls = [
    composer.option,
    ...composer.toggles.map((item) => item.rect),
  ];
  if (
    composer.borderRadius !== "28px" ||
    composer.toolbarGap !== "8px" ||
    composer.model?.height !== 32 ||
    composer.textarea?.height < 56 ||
    composer.send?.width !== 44 ||
    composer.send?.height !== 44 ||
    composer.toggles.length !== 4 ||
    squareControls.some((rect) => rect?.width !== 32 || rect?.height !== 32) ||
    picker.providerTabs < 1 ||
    !picker.search ||
    diagnostics.consoleErrors.length ||
    diagnostics.pageErrors.length ||
    diagnostics.failedRequests.length
  ) {
    throw new Error(
      `${surface} composer is invalid: ${JSON.stringify(result)}`,
    );
  }
};

try {
  const client = await inspectClient();
  const fleet = await inspectFleet();
  assertComposer("Client", client);
  assertComposer("Fleet", fleet);
  if (
    fleet.picker.models < 1 ||
    Math.abs(client.composer.width - fleet.composer.width) > 4 ||
    Math.abs(client.composer.height - fleet.composer.height) > 4
  ) {
    throw new Error(
      `Composer surfaces diverged: ${JSON.stringify({ client, fleet })}`,
    );
  }
  process.stdout.write(`${JSON.stringify({ client, fleet }, null, 2)}\n`);
} finally {
  await browser.close();
}
