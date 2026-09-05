import { productFixture } from "./fixtures/fleet-product.mjs";
import { access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer-core";

const baseUrl = process.env.MACHDOCH_FLEET_UI_URL ?? "http://127.0.0.1:43188";
const username = process.env.MACHDOCH_FLEET_UI_USERNAME;
const password = process.env.MACHDOCH_FLEET_UI_PASSWORD;
const screenshot = process.env.MACHDOCH_FLEET_UI_SCREENSHOT;
const useFixture = process.env.MACHDOCH_FLEET_UI_FIXTURE === "true";
const allowInsecureTls =
  process.env.MACHDOCH_FLEET_UI_ALLOW_INSECURE_TLS === "true";
const explicitPath = process.env.MACHDOCH_FLEET_UI_PATH;
const sessionToken = process.env.MACHDOCH_FLEET_UI_SESSION_TOKEN;
const chromeCandidates = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

if (!sessionToken && (!username || !password)) {
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

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: allowInsecureTls ? ["--ignore-certificate-errors"] : [],
});
let page;
let createdFixtureInstanceId;
try {
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
  if (sessionToken) {
    await page.setExtraHTTPHeaders({
      Cookie: `__Host-machdoch_fleet_session=${sessionToken}`,
    });
  }
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const productCommands = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
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
      failedRequests.push(`${request.method()} ${request.url()} ${failure}`);
    }
  });

  await page.goto(sessionToken ? `${baseUrl}/instances` : `${baseUrl}/login`, {
    waitUntil: "networkidle2",
  });
  if (!sessionToken && new URL(page.url()).pathname === "/login") {
    await page.type("#username", username);
    await page.type("#password", password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click('button[type="submit"]'),
    ]);
  }
  await page.waitForFunction(() => location.pathname === "/instances");

  let instancePath =
    explicitPath ??
    (process.env.MACHDOCH_FLEET_UI_INSTANCE_ID
      ? `/instances/${encodeURIComponent(process.env.MACHDOCH_FLEET_UI_INSTANCE_ID)}`
      : undefined);
  const deadline = Date.now() + (useFixture ? 5_000 : 60_000);
  while (!instancePath && Date.now() < deadline) {
    instancePath = await page
      .$eval('a[href^="/instances/"]', (link) => link.getAttribute("href"))
      .catch(() => null);
    if (!instancePath) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await page.reload({ waitUntil: "networkidle2" });
    }
  }
  if (!instancePath && useFixture) {
    const instanceId = await page
      .$$eval("p", (elements) =>
        elements
          .map((element) => element.textContent?.trim())
          .find((value) => value?.startsWith("instance_")),
      )
      .catch(() => undefined);
    if (instanceId)
      instancePath = `/instances/${encodeURIComponent(instanceId)}`;
  }
  if (!instancePath && useFixture) {
    const instanceSecret = `mch_instance_${randomBytes(32).toString("base64url")}`;
    const createdFixture = await page.evaluate(async (secret) => {
      const csrfToken = document.cookie
        .split(";")
        .map((part) => part.trim().split("="))
        .find(([name]) => name === "__Host-machdoch_fleet_csrf")
        ?.slice(1)
        .join("=");
      if (!csrfToken) throw new Error("Fleet CSRF token was not available.");

      const keyResponse = await fetch("/api/enrollment-keys", {
        method: "POST",
        headers: { "X-Machdoch-Fleet-CSRF": csrfToken },
      });
      const keyBody = await keyResponse.json();
      if (!keyResponse.ok) {
        throw new Error(keyBody.error ?? "Could not create an enrollment key.");
      }

      const enrollmentResponse = await fetch("/api/enroll", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keyBody.enrollmentKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName: "RALPH UI fixture",
          instanceSecret: secret,
          productVersion: "7.0.6",
          protocolVersion: 4,
        }),
      });
      const enrollmentBody = await enrollmentResponse.json();
      if (!enrollmentResponse.ok) {
        throw new Error(
          enrollmentBody.error ?? "Could not enroll an instance.",
        );
      }
      return {
        instanceId: enrollmentBody.instanceId,
        path: `/instances/${encodeURIComponent(enrollmentBody.instanceId)}`,
      };
    }, instanceSecret);
    createdFixtureInstanceId = createdFixture.instanceId;
    instancePath = createdFixture.path;
  }
  if (!instancePath) throw new Error("No online Fleet instance was available.");

  if (useFixture) {
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().endsWith("/product/snapshot")) {
        void request.respond({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(productFixture()),
        });
        return;
      }
      if (request.url().endsWith("/product/commands")) {
        const command = JSON.parse(request.postData() ?? "{}");
        productCommands.push(command);
        void request.respond({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ commandId: "ui-check", duplicate: false }),
        });
        return;
      }
      void request.continue();
    });
  }

  await page.goto(new URL(instancePath, baseUrl).href, {
    waitUntil: "networkidle2",
  });
  const productRoot = await page
    .waitForSelector(".machdoch-product", { timeout: 10_000 })
    .catch(() => null);
  if (!productRoot) {
    throw new Error(
      JSON.stringify(
        {
          url: page.url(),
          title: await page.title(),
          body: (
            await page.$eval("body", (element) => element.innerText)
          ).slice(0, 2_000),
          consoleErrors,
          pageErrors,
        },
        null,
        2,
      ),
    );
  }
  await page.waitForFunction(
    () =>
      document.querySelector(".m-product-layout") !== null ||
      document.querySelector(".m-product-connection-error") !== null,
    { timeout: 30_000 },
  );
  const connectionError = await page
    .$eval(".m-product-connection-error span", (element) => element.textContent)
    .catch(() => null);
  if (connectionError) throw new Error(connectionError);

  const desktop = await page.evaluate(() => ({
    title: document.querySelector(".m-product-instance strong")?.textContent,
    sessions: document.querySelectorAll(".m-product-session-item").length,
    messages: document.querySelectorAll(".m-product-message").length,
    composer: document.querySelector(".m-product-composer") !== null,
    markdown: document.querySelector(".app-markdown strong") !== null,
    markdownTable: document.querySelector(".m-markdown-table") !== null,
    promptEnhancement: document.querySelectorAll(".m-prompt-enhancement")
      .length,
    activity: document.querySelector(".m-product-activity") !== null,
    activityOpen:
      document.querySelector(".m-product-activity")?.hasAttribute("open") ??
      false,
    activityRows: document.querySelectorAll(".m-product-activity-row").length,
    retry: [
      ...document.querySelectorAll(".m-product-message-actions button"),
    ].some((button) => button.textContent?.trim() === "Retry"),
    packs: [...document.querySelectorAll(".m-product-menu summary")].some(
      (summary) => summary.textContent?.includes("Packs"),
    ),
    workspace: [...document.querySelectorAll(".m-product-menu summary")].some(
      (summary) => summary.textContent?.includes("machdoch"),
    ),
    sessionFilters: document.querySelectorAll(
      ".m-product-session-filter-group button",
    ).length,
    statusIcon:
      document.querySelector(".m-product-session-status svg") !== null,
    topbarHeight: document
      .querySelector(".m-product-topbar")
      ?.getBoundingClientRect().height,
    railWidth: document
      .querySelector(".m-product-rail")
      ?.getBoundingClientRect().width,
    sidebarWidth: document
      .querySelector(".m-product-sidebar")
      ?.getBoundingClientRect().width,
    mainWidth: document
      .querySelector(".m-product-main")
      ?.getBoundingClientRect().width,
    composerFooterWidth: document
      .querySelector(".m-product-composer-wrap")
      ?.getBoundingClientRect().width,
    composerWidth: document
      .querySelector(".m-product-composer")
      ?.getBoundingClientRect().width,
    mainBackground: getComputedStyle(document.querySelector(".m-product-main"))
      .backgroundColor,
    composerInputBackground: getComputedStyle(
      document.querySelector(".m-product-composer textarea"),
    ).backgroundColor,
    inspectorVisible:
      document.querySelector(".m-product-inspector")?.getBoundingClientRect()
        .left < window.innerWidth,
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  if (
    !desktop.title ||
    !desktop.markdown ||
    !desktop.markdownTable ||
    desktop.promptEnhancement !== 1 ||
    !desktop.activity ||
    !desktop.activityOpen ||
    desktop.activityRows < 3 ||
    !desktop.retry ||
    !desktop.packs ||
    !desktop.workspace ||
    desktop.topbarHeight !== 40 ||
    desktop.railWidth !== 80 ||
    desktop.sidebarWidth !== 336 ||
    desktop.sessionFilters < 4 ||
    !desktop.statusIcon ||
    desktop.mainWidth !== desktop.composerFooterWidth ||
    desktop.composerWidth > 1024 ||
    desktop.mainBackground !== "rgb(17, 19, 24)" ||
    desktop.composerInputBackground === "rgba(0, 0, 0, 0)" ||
    desktop.inspectorVisible ||
    desktop.documentWidth > desktop.viewportWidth + 1
  ) {
    throw new Error(`Desktop layout is invalid: ${JSON.stringify(desktop)}`);
  }
  const statusFilter = await page.$(
    '.m-product-session-status-filters button[aria-label^="Status:"]',
  );
  if (!statusFilter) throw new Error("No session status filter was rendered.");
  await statusFilter.click();
  await page.waitForFunction(
    () =>
      document.querySelector(
        '.m-product-session-status-filters button[aria-label^="Status:"][aria-pressed="true"]',
      ) !== null,
  );
  await page.click(
    '.m-product-session-status-filters button[aria-label="Any status"]',
  );
  await page.click('.m-product-rail-button[aria-label="Activity"]');
  await page.waitForFunction(
    () =>
      document.querySelector(".m-product-inspector")?.getBoundingClientRect()
        .left < window.innerWidth,
  );
  await page.click('[aria-label="Close activity"]');
  await page.waitForFunction(
    () => !document.querySelector(".m-product-inspector"),
  );

  await page.click('.m-product-rail-button[aria-label="Media Studio"]');
  await page.waitForSelector(".m-media-surface");
  const desktopMedia = await inspectFeatureViewport(page, "media");
  assertFeatureViewport("Desktop Media Studio", desktopMedia);
  if (screenshot) {
    await page.screenshot({
      path: featureScreenshotPath(screenshot, "media"),
      fullPage: true,
    });
  }
  await page.click(".m-media-prompt textarea");
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.type(
    ".m-media-prompt textarea",
    "A cobalt paper sculpture with soft shadows",
  );
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const preservedMediaPrompt = await page.$eval(
    ".m-media-prompt textarea",
    (element) => element.value,
  );
  if (preservedMediaPrompt !== "A cobalt paper sculpture with soft shadows") {
    throw new Error(
      "Media Studio replaced an in-progress prompt while polling.",
    );
  }
  await page.click(".m-media-create-actions .m-product-primary-button");
  await page.waitForSelector('.m-media-modal[role="dialog"]');
  await page.click(".m-media-modal .m-product-secondary-button");
  await page.click('.m-media-navigation button[aria-label="Assets"]');
  await page.waitForSelector(".m-media-asset");
  await page.click(".m-media-asset");
  await page.waitForSelector('.m-media-asset-dialog[role="dialog"]');
  await page.click(".m-media-asset-dialog .m-media-modal-close");
  await page.click('.m-media-navigation button[aria-label="Activity"]');
  const mediaRuns = await page.$$(".m-media-run");
  if (mediaRuns.length !== 2) {
    throw new Error(`Media activity is incomplete: ${mediaRuns.length}`);
  }

  await page.click('.m-product-rail-button[aria-label="Smart Scheduler"]');
  await page.waitForSelector(".m-scheduler");
  const desktopScheduler = await inspectFeatureViewport(page, "scheduler");
  assertFeatureViewport("Desktop Smart Scheduler", desktopScheduler);
  if (screenshot) {
    await page.screenshot({
      path: featureScreenshotPath(screenshot, "scheduler"),
      fullPage: true,
    });
  }
  const schedulerJobs = await page.$$(".m-scheduler-card");
  if (schedulerJobs.length !== 2) {
    throw new Error(`Scheduler jobs are incomplete: ${schedulerJobs.length}`);
  }
  await page.click(".m-scheduler-card .m-scheduler-danger");
  await page.waitForSelector("#m-scheduler-delete-title");
  await page.click(".m-media-modal .m-product-secondary-button");
  await page.$$eval(".m-feature-tabs button", (buttons) => {
    const runs = buttons.find(
      (button) => button.textContent?.trim() === "Runs",
    );
    if (!(runs instanceof HTMLElement)) throw new Error("Runs tab is missing.");
    runs.click();
  });
  await page.waitForSelector(".m-scheduler-run");
  const schedulerRuns = await page.$$(".m-scheduler-run");
  if (schedulerRuns.length !== 2) {
    throw new Error(`Scheduler runs are incomplete: ${schedulerRuns.length}`);
  }
  await page.click('.m-product-rail-button[aria-label="RALPH"]');
  await page.waitForSelector(".m-ralph");
  const desktopRalph = await inspectFeatureViewport(page, "ralph");
  assertFeatureViewport("Desktop RALPH", desktopRalph);
  const ralphFlows = await page.$$(".m-ralph-card");
  if (ralphFlows.length !== 2) {
    throw new Error(`RALPH flows are incomplete: ${ralphFlows.length}`);
  }
  const activeFlowRunDisabled = await page.$eval(
    'button[aria-label="Run Dependency review"]',
    (button) => button.disabled,
  );
  if (!activeFlowRunDisabled) {
    throw new Error("RALPH allows an already active flow to start again.");
  }
  await page.click('button[aria-label^="RALPH run model:"]');
  await page.waitForSelector(
    '.m-composer-model-popover[aria-label="RALPH run model"]',
  );
  const modelPickerBounds = await page.$eval(
    '.m-composer-model-popover[aria-label="RALPH run model"]',
    (element) => {
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    },
  );
  if (
    modelPickerBounds.top < 0 ||
    modelPickerBounds.left < 0 ||
    modelPickerBounds.right > modelPickerBounds.viewportWidth ||
    modelPickerBounds.bottom > modelPickerBounds.viewportHeight
  ) {
    throw new Error(
      `RALPH model picker is outside the viewport: ${JSON.stringify(modelPickerBounds)}`,
    );
  }
  await page.keyboard.press("Escape");
  if (useFixture) {
    await page.click('button[aria-label="Run Release flow"]');
    await page.waitForSelector(".m-ralph-modal");
    await page.click(".m-ralph-modal .m-product-primary-button");
    await page.waitForSelector(".m-ralph-validation");
    await page.type('.m-ralph-parameters input[type="text"]', "production");
    await page.click(".m-ralph-modal .m-product-primary-button");
    await page.waitForFunction(
      () => document.querySelector(".m-ralph-run") !== null,
    );
    await page.click(".m-ralph-run button");
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".m-ralph-run button")].some(
        (button) => button.textContent?.trim() === "Resume" && !button.disabled,
      ),
    );
    await page.$$eval(".m-ralph-run button", (buttons) => {
      const resume = buttons.find(
        (button) => button.textContent?.trim() === "Resume",
      );
      if (!(resume instanceof HTMLElement)) {
        throw new Error("RALPH resume action is missing.");
      }
      resume.click();
    });
    const commandDeadline = Date.now() + 5_000;
    while (
      Date.now() < commandDeadline &&
      !["ralph-run", "cancel", "ralph-resume-run"].every((kind) =>
        productCommands.some((command) => command.kind === kind),
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const runCommand = productCommands.find(
      (command) => command.kind === "ralph-run",
    );
    const cancelCommand = productCommands.find(
      (command) => command.kind === "cancel",
    );
    const resumeCommand = productCommands.find(
      (command) => command.kind === "ralph-resume-run",
    );
    if (
      runCommand?.workspace !== "C:\\Development\\machdoch" ||
      runCommand.scope !== "workspace" ||
      runCommand.flowId !== "release-flow" ||
      runCommand.parameters?.environment !== "production" ||
      runCommand.provider !== "openai" ||
      runCommand.model !== "gpt-5.6" ||
      runCommand.reasoning !== "high" ||
      runCommand.maxTransitions !== 48 ||
      cancelCommand?.taskId !== "ralph_task_dependency_review" ||
      resumeCommand?.runId !== "ralph_run_crashed" ||
      resumeCommand.scope !== "workspace" ||
      resumeCommand.workspace !== "C:\\Development\\machdoch" ||
      resumeCommand.provider !== "openai" ||
      resumeCommand.model !== "gpt-5.6" ||
      resumeCommand.reasoning !== "high"
    ) {
      throw new Error(
        `RALPH commands are invalid: ${JSON.stringify(productCommands)}`,
      );
    }
  }
  if (screenshot) {
    await page.screenshot({
      path: featureScreenshotPath(screenshot, "ralph"),
      fullPage: true,
    });
  }
  await page.click('.m-product-rail-button[aria-label="Chat"]');
  await page.waitForSelector(".m-product-composer");
  if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });

  await page.setViewport({ width: 1217, height: 681, deviceScaleFactor: 1 });
  const compact = await inspectChatViewport(page);
  assertChatViewport("Compact", compact);

  await page.setViewport({ width: 430, height: 650, deviceScaleFactor: 1 });
  await page.waitForSelector(".m-product-sidebar-toggle", { visible: true });
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  const mobile = await inspectChatViewport(page);
  assertChatViewport("Mobile", mobile, true);
  await page.click('.m-product-mobile-nav button[aria-label="Media Studio"]');
  await page.waitForSelector(".m-media-surface");
  const mobileMedia = await inspectFeatureViewport(page, "media");
  assertFeatureViewport("Mobile Media Studio", mobileMedia, true);
  if (screenshot) {
    await page.screenshot({
      path: featureScreenshotPath(screenshot, "mobile-media"),
      fullPage: true,
    });
  }
  await page.click(
    '.m-product-mobile-nav button[aria-label="Smart Scheduler"]',
  );
  await page.waitForSelector(".m-scheduler");
  const mobileScheduler = await inspectFeatureViewport(page, "scheduler");
  assertFeatureViewport("Mobile Smart Scheduler", mobileScheduler, true);
  if (screenshot) {
    await page.screenshot({
      path: featureScreenshotPath(screenshot, "mobile-scheduler"),
      fullPage: true,
    });
  }
  await page.click('.m-product-mobile-nav button[aria-label="RALPH"]');
  await page.waitForSelector(".m-ralph");
  const mobileRalph = await inspectFeatureViewport(page, "ralph");
  assertFeatureViewport("Mobile RALPH", mobileRalph, true);
  if (screenshot) {
    await page.screenshot({
      path: featureScreenshotPath(screenshot, "mobile-ralph"),
      fullPage: true,
    });
  }
  await page.click('.m-product-mobile-nav button[aria-label="Chat"]');
  await page.waitForSelector(".m-product-conversation");
  const beforePolling = await page.$eval(
    ".m-product-conversation",
    (conversation) => {
      const maximumScroll =
        conversation.scrollHeight - conversation.clientHeight;
      conversation.scrollTop = Math.max(0, maximumScroll - 160);
      return { maximumScroll, scrollTop: conversation.scrollTop };
    },
  );
  if (beforePolling.maximumScroll <= 64) {
    throw new Error(
      `Mobile conversation did not overflow: ${JSON.stringify(beforePolling)}`,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 3_500));
  const afterPolling = await page.$eval(
    ".m-product-conversation",
    (conversation) => ({
      scrollTop: conversation.scrollTop,
      windowScrollY: window.scrollY,
    }),
  );
  if (
    Math.abs(afterPolling.scrollTop - beforePolling.scrollTop) > 1 ||
    afterPolling.windowScrollY !== 0
  ) {
    throw new Error(
      `Mobile scroll position changed during polling: ${JSON.stringify({ beforePolling, afterPolling })}`,
    );
  }
  await page.click(".m-product-sidebar-toggle");
  await page.waitForFunction(
    () =>
      document.querySelector(".m-product-sidebar")?.getBoundingClientRect()
        .left >= 0,
  );
  await page.click(".m-product-panel-scrim", {
    offset: { x: 400, y: 300 },
  });
  await page.waitForFunction(
    () => !document.querySelector(".m-product-sidebar"),
  );
  await page.click(".m-product-inspector-toggle");
  await page.waitForFunction(
    () =>
      document.querySelector(".m-product-inspector")?.getBoundingClientRect()
        .left < window.innerWidth,
  );
  await page.click(".m-product-panel-scrim", {
    offset: { x: 20, y: 300 },
  });
  await page.waitForFunction(
    () => !document.querySelector(".m-product-inspector"),
  );

  await page.setViewport({ width: 320, height: 568, deviceScaleFactor: 1 });
  const narrow = await inspectChatViewport(page);
  assertChatViewport("Narrow mobile", narrow, true);
  await page.click('.m-product-mobile-nav button[aria-label="Media Studio"]');
  await page.waitForSelector(".m-media-surface");
  const narrowMedia = await inspectFeatureViewport(page, "media");
  assertFeatureViewport("Narrow Media Studio", narrowMedia, true);
  await page.click('.m-product-mobile-nav button[aria-label="Chat"]');
  await page.waitForSelector(".m-product-conversation");

  await page.setViewport({ width: 390, height: 400, deviceScaleFactor: 1 });
  const short = await inspectChatViewport(page);
  assertChatViewport("Short mobile", short, true);

  if (consoleErrors.length || pageErrors.length || failedRequests.length) {
    throw new Error(
      JSON.stringify({ consoleErrors, pageErrors, failedRequests }, null, 2),
    );
  }
  process.stdout.write(
    `${JSON.stringify({ desktop, desktopMedia, desktopScheduler, desktopRalph, compact, mobile, mobileMedia, mobileScheduler, mobileRalph, narrow, narrowMedia, short, beforePolling, afterPolling, productCommands, fixture: useFixture }, null, 2)}\n`,
  );
} finally {
  if (page && createdFixtureInstanceId) {
    await deleteFixtureInstance(page, createdFixtureInstanceId).catch(
      (error) => {
        process.stderr.write(
          `Failed to remove Fleet UI fixture: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    );
  }
  await browser.close();
}

async function deleteFixtureInstance(page, instanceId) {
  await page.evaluate(async (id) => {
    const csrfToken = document.cookie
      .split(";")
      .map((part) => part.trim().split("="))
      .find(([name]) => name === "__Host-machdoch_fleet_csrf")
      ?.slice(1)
      .join("=");
    if (!csrfToken) throw new Error("Fleet CSRF token was not available.");

    const response = await fetch(`/api/instances/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "X-Machdoch-Fleet-CSRF": csrfToken },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? "Could not remove the fixture instance.");
    }
  }, instanceId);
}

async function inspectChatViewport(page) {
  return page.evaluate(() => {
    const composer = document
      .querySelector(".m-product-composer-wrap")
      ?.getBoundingClientRect();
    const textarea = document
      .querySelector(".m-product-composer textarea")
      ?.getBoundingClientRect();
    const conversation = document.querySelector(".m-product-conversation");
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      windowScrollY: window.scrollY,
      composerTop: composer?.top,
      composerBottom: composer?.bottom,
      textareaTop: textarea?.top,
      textareaBottom: textarea?.bottom,
      conversationHeight: conversation?.clientHeight,
      conversationScrollHeight: conversation?.scrollHeight,
      sidebarToggleVisible:
        getComputedStyle(document.querySelector(".m-product-sidebar-toggle"))
          .display !== "none",
    };
  });
}

function assertChatViewport(label, viewport, expectMobileNavigation = false) {
  if (
    viewport.documentWidth > viewport.viewportWidth + 1 ||
    viewport.documentHeight > viewport.viewportHeight + 1 ||
    viewport.windowScrollY !== 0 ||
    viewport.composerTop === undefined ||
    viewport.composerBottom === undefined ||
    viewport.composerTop < 0 ||
    viewport.composerBottom > viewport.viewportHeight + 1 ||
    viewport.textareaTop === undefined ||
    viewport.textareaBottom === undefined ||
    viewport.textareaTop < 0 ||
    viewport.textareaBottom > viewport.viewportHeight + 1 ||
    !viewport.conversationHeight ||
    (expectMobileNavigation && !viewport.sidebarToggleVisible)
  ) {
    throw new Error(`${label} layout is invalid: ${JSON.stringify(viewport)}`);
  }
}

async function inspectFeatureViewport(page, feature) {
  return page.evaluate((activeFeature) => {
    const main = document
      .querySelector(".m-product-feature-main")
      ?.getBoundingClientRect();
    const surface = document
      .querySelector(
        activeFeature === "media"
          ? ".m-media-surface"
          : activeFeature === "ralph"
            ? ".m-ralph"
            : ".m-scheduler",
      )
      ?.getBoundingClientRect();
    const mediaNavigation = document
      .querySelector(".m-media-navigation")
      ?.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      windowScrollY: window.scrollY,
      mainLeft: main?.left,
      mainRight: main?.right,
      mainTop: main?.top,
      mainBottom: main?.bottom,
      surfaceLeft: surface?.left,
      surfaceRight: surface?.right,
      surfaceTop: surface?.top,
      surfaceBottom: surface?.bottom,
      navigationWidth: mediaNavigation?.width,
      navigationHeight: mediaNavigation?.height,
      mobileNavigationVisible:
        getComputedStyle(document.querySelector(".m-product-mobile-nav"))
          .display !== "none",
    };
  }, feature);
}

function assertFeatureViewport(
  label,
  viewport,
  expectMobileNavigation = false,
) {
  if (
    viewport.documentWidth > viewport.viewportWidth + 1 ||
    viewport.documentHeight > viewport.viewportHeight + 1 ||
    viewport.windowScrollY !== 0 ||
    viewport.mainLeft === undefined ||
    viewport.mainRight === undefined ||
    viewport.mainTop === undefined ||
    viewport.mainBottom === undefined ||
    viewport.surfaceLeft === undefined ||
    viewport.surfaceRight === undefined ||
    viewport.surfaceTop === undefined ||
    viewport.surfaceBottom === undefined ||
    viewport.mainLeft < 0 ||
    viewport.mainRight > viewport.viewportWidth + 1 ||
    viewport.mainTop < 0 ||
    viewport.mainBottom > viewport.viewportHeight + 1 ||
    viewport.surfaceLeft < viewport.mainLeft - 1 ||
    viewport.surfaceRight > viewport.mainRight + 1 ||
    viewport.surfaceTop < viewport.mainTop - 1 ||
    Math.abs(viewport.surfaceBottom - viewport.mainBottom) > 1 ||
    (expectMobileNavigation && !viewport.mobileNavigationVisible)
  ) {
    throw new Error(`${label} layout is invalid: ${JSON.stringify(viewport)}`);
  }
}

function featureScreenshotPath(basePath, feature) {
  const parsed = path.parse(basePath);
  return path.join(parsed.dir, `${parsed.name}-${feature}${parsed.ext}`);
}
