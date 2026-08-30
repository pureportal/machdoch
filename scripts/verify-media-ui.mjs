import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";

const clientUrl = process.env.MACHDOCH_CLIENT_UI_URL ?? "http://127.0.0.1:4173";
const screenshotDirectory = process.env.MACHDOCH_MEDIA_UI_SCREENSHOT_DIR;
const chromeCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

let executablePath;
for (const candidate of chromeCandidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {}
}
if (!executablePath) throw new Error("Chrome or Edge was not found.");
if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });

const browser = await puppeteer.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  const diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  page.on("console", (message) => {
    if (message.type() === "error")
      diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    if (!request.url().startsWith("data:")) {
      diagnostics.failedRequests.push(
        `${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
      );
    }
  });

  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
  await page.goto(clientUrl, { waitUntil: "networkidle2" });
  const skipSetup = await page.$(
    'button[aria-label="Skip first-startup setup"]',
  );
  if (skipSetup) {
    await skipSetup.click();
    await page.waitForSelector(
      'button[aria-label="Skip first-startup setup"]',
      { hidden: true },
    );
  }
  await page.waitForSelector(
    '.app-shell-rail button[aria-label^="Media Studio"]',
    {
      timeout: 20_000,
    },
  );
  await page.click('.app-shell-rail button[aria-label^="Media Studio"]');
  await page.waitForSelector(".m-media-studio-layout .m-media-navigation", {
    timeout: 20_000,
  });

  const desktop = await inspectMediaViewport(page);
  assertMediaViewport("Desktop", desktop, "column");
  for (const section of ["Advanced", "Assets", "Activity", "Basic"]) {
    await page.click(`.m-media-navigation button[aria-label="${section}"]`);
    await page.waitForFunction(
      (label) =>
        document
          .querySelector(`.m-media-navigation button[aria-label="${label}"]`)
          ?.getAttribute("aria-current") === "page",
      {},
      section,
    );
  }
  if (screenshotDirectory) {
    await page.screenshot({
      path: path.join(screenshotDirectory, "client-media-desktop.png"),
      fullPage: true,
    });
  }

  await page.setViewport({ width: 430, height: 650, deviceScaleFactor: 1 });
  const mobile = await inspectMediaViewport(page);
  assertMediaViewport("Mobile", mobile, "row");
  await page.click('.m-media-navigation button[aria-label="Assets"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.m-media-navigation button[aria-label="Assets"]')
        ?.getAttribute("aria-current") === "page",
  );
  if (screenshotDirectory) {
    await page.screenshot({
      path: path.join(screenshotDirectory, "client-media-mobile.png"),
      fullPage: true,
    });
  }

  await page.setViewport({ width: 320, height: 568, deviceScaleFactor: 1 });
  const narrow = await inspectMediaViewport(page);
  assertMediaViewport("Narrow mobile", narrow, "row");

  if (
    diagnostics.consoleErrors.length ||
    diagnostics.pageErrors.length ||
    diagnostics.failedRequests.length
  ) {
    throw new Error(
      `Client Media Studio diagnostics failed: ${JSON.stringify(diagnostics)}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ desktop, mobile, narrow, diagnostics }, null, 2)}\n`,
  );
} finally {
  await closeBrowser(browser);
}

async function closeBrowser(browser) {
  const browserProcess = browser.process();
  const forceCloseTimeout = setTimeout(() => browserProcess?.kill(), 5_000);
  try {
    await browser.close();
  } finally {
    clearTimeout(forceCloseTimeout);
  }
}

async function inspectMediaViewport(page) {
  return page.evaluate(() => {
    const layout = document
      .querySelector(".m-media-studio-layout")
      ?.getBoundingClientRect();
    const navigation = document
      .querySelector(".m-media-navigation")
      ?.getBoundingClientRect();
    const nav = document.querySelector(".m-media-navigation nav");
    const buttons = [
      ...document.querySelectorAll(".m-media-navigation button"),
    ];
    const active = document.querySelector(
      '.m-media-navigation button[aria-current="page"]',
    );
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      windowScrollY: window.scrollY,
      layoutLeft: layout?.left,
      layoutRight: layout?.right,
      layoutTop: layout?.top,
      layoutBottom: layout?.bottom,
      navigationWidth: navigation?.width,
      navigationHeight: navigation?.height,
      navigationDirection: nav ? getComputedStyle(nav).flexDirection : null,
      labels: buttons.map((button) => button.getAttribute("aria-label")),
      minimumButtonHeight: Math.min(
        ...buttons.map((button) => button.getBoundingClientRect().height),
      ),
      activeBackground: active
        ? getComputedStyle(active).backgroundColor
        : null,
      activeColor: active ? getComputedStyle(active).color : null,
    };
  });
}

function assertMediaViewport(label, viewport, expectedDirection) {
  if (
    viewport.documentWidth > viewport.viewportWidth + 1 ||
    viewport.documentHeight > viewport.viewportHeight + 1 ||
    viewport.windowScrollY !== 0 ||
    viewport.layoutLeft === undefined ||
    viewport.layoutRight === undefined ||
    viewport.layoutTop === undefined ||
    viewport.layoutBottom === undefined ||
    viewport.layoutLeft < 0 ||
    viewport.layoutRight > viewport.viewportWidth + 1 ||
    viewport.layoutTop < 0 ||
    viewport.layoutBottom > viewport.viewportHeight + 1 ||
    viewport.navigationDirection !== expectedDirection ||
    viewport.labels.join(",") !== "Basic,Advanced,Assets,Activity" ||
    viewport.minimumButtonHeight < 48 ||
    viewport.activeBackground === "rgba(0, 0, 0, 0)" ||
    !viewport.activeColor
  ) {
    throw new Error(
      `${label} Media Studio layout is invalid: ${JSON.stringify(viewport)}`,
    );
  }
}
