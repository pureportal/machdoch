import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { productFixture } from "./fixtures/fleet-product.mjs";

const baseUrl = process.env.MACHDOCH_FLEET_UI_URL ?? "http://127.0.0.1:43188";
const username = process.env.MACHDOCH_FLEET_UI_USERNAME;
const password = process.env.MACHDOCH_FLEET_UI_PASSWORD;
const output = path.resolve(
  process.env.MACHDOCH_RESPONSIVE_OUTPUT ??
    "apps/fleet-manager/.cache/responsive-results",
);
if (
  !username ||
  !password ||
  process.env.MACHDOCH_FLEET_UI_FIXTURE !== "true"
) {
  throw new Error(
    "Use an isolated Fleet Manager and set MACHDOCH_FLEET_UI_USERNAME, MACHDOCH_FLEET_UI_PASSWORD, and MACHDOCH_FLEET_UI_FIXTURE=true. This check creates and removes its own instance and profile.",
  );
}
const candidates = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
let executablePath;
for (const candidate of candidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {}
}
assert.ok(executablePath, "Chrome or Edge was not found");
await mkdir(output, { recursive: true });
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args:
    process.env.MACHDOCH_FLEET_UI_ALLOW_INSECURE_TLS === "true"
      ? ["--ignore-certificate-errors"]
      : [],
});
const report = [];
const commands = [];
const errors = [];
let instanceId;
let profileId;
let page;

async function clickText(text, scope = "") {
  for (const element of await page.$$(
    `${scope}button, ${scope}[role="menuitem"]`,
  )) {
    if (
      (await element.evaluate(
        (element, text) => element.textContent?.trim() === text,
        text,
      )) &&
      (await element.isVisible())
    ) {
      await element.scrollIntoView();
      await element.click();
      return;
    }
    await element.dispose();
  }
  throw new Error(`Visible control not found: ${text}`);
}

async function bounds(selector) {
  await page.waitForSelector(selector, { visible: true });
  const rect = await page.$eval(selector, (element) => {
    const r = element.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  });
  const viewport = page.viewport();
  assert.ok(
    rect.left >= -1 &&
      rect.right <= viewport.width + 1 &&
      rect.top >= -1 &&
      rect.bottom <= viewport.height + 1 &&
      rect.width > 0 &&
      rect.height > 0,
    `${selector} leaves ${viewport.width}×${viewport.height}: ${JSON.stringify(rect)}`,
  );
}

async function layout(label, screenshot = true) {
  const viewport = page.viewport();
  const metrics = await page.evaluate(() => ({
    width: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    height: innerHeight,
  }));
  assert.equal(
    metrics.width,
    viewport.width,
    `${label}: mobile viewport expanded`,
  );
  assert.ok(
    metrics.documentWidth <= viewport.width + 1,
    `${label}: page has horizontal overflow (${metrics.documentWidth})`,
  );
  report.push({ label, viewport, ...metrics });
  if (screenshot)
    await page.screenshot({
      path: path.join(
        output,
        `${viewport.width}-${viewport.height}-${label}.png`,
      ),
    });
}

async function api(route, method = "GET", body) {
  return page.evaluate(
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
        throw new Error(`${route}: ${result.error ?? response.status}`);
      return result;
    },
    { route, method, body },
  );
}

try {
  page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle2" });
  await layout("login");
  await page.type("#username", username);
  await page.type("#password", password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => location.pathname === "/instances");
  const grant = await api("/api/enrollment-keys", "POST");
  const enrollment = await page.evaluate(
    async ({ key, secret }) => {
      const response = await fetch("/api/enroll", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          displayName:
            "MobileBuildHostWithAVeryLongUnbrokenProductionNameForLayoutChecks",
          instanceSecret: secret,
          productVersion: "10.1.1",
          protocolVersion: 4,
        }),
      });
      if (!response.ok) throw new Error("Fixture enrollment failed");
      return response.json();
    },
    {
      key: grant.enrollmentKey,
      secret: `mch_instance_${randomBytes(32).toString("base64url")}`,
    },
  );
  instanceId = enrollment.instanceId;
  const created = await api("/api/settings/profiles", "POST", {
    name: `LongProductionProfileNameWithoutAnyWordBreaksForMobile-${randomBytes(4).toString("hex")}`,
    description: "Responsive verification",
  });
  profileId = created.profile.profileId;
  const snapshot = productFixture();
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().endsWith("/product/snapshot"))
      void request.respond({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(snapshot),
      });
    else if (request.url().endsWith("/product/commands")) {
      commands.push(JSON.parse(request.postData() ?? "{}"));
      void request.respond({
        status: 202,
        contentType: "application/json",
        body: '{"commandId":"responsive-test","duplicate":false}',
      });
    } else void request.continue();
  });

  for (const width of [320, 390, 768, 900, 1024, 1440]) {
    await page.setViewport({
      width,
      height: 844,
      isMobile: width < 768,
      hasTouch: width <= 900,
    });
    for (const route of ["instances", "enrollment", "users", "settings"]) {
      await page.goto(`${baseUrl}/${route}`, { waitUntil: "networkidle2" });
      await layout(route);
      if (route === "settings") {
        await clickText("New profile");
        await bounds('[role="dialog"]');
        await layout("create-profile");
        await clickText("Cancel", '[role="dialog"] ');
        for (const tab of [
          "Instructions",
          "Context packs",
          "Prompts",
          "Secrets",
          "Instances",
          "History",
        ]) {
          // Select the profile editor's tab, not the dashboard navigation link.
          await clickText(tab);
          await layout(
            `settings-${tab.toLowerCase().replaceAll(" ", "-")}`,
            false,
          );
        }
      }
    }
    await page.goto(`${baseUrl}/instances/${instanceId}`, {
      waitUntil: "networkidle2",
    });
    await page.waitForSelector(".m-product-composer");
    await layout("chat");
    await bounds(".m-product-composer");
    await bounds('[aria-label="Task composer"]');
    if (width <= 900) {
      const touchTargets = await page.$$eval(
        ".m-product-topbar button, .m-product-back",
        (elements) =>
          elements
            .filter((element) => element.checkVisibility())
            .map((element) => ({
              name: element.getAttribute("aria-label"),
              height: element.getBoundingClientRect().height,
              width: element.getBoundingClientRect().width,
            })),
      );
      assert.ok(
        touchTargets.every(
          (target) => target.width >= 44 && target.height >= 44,
        ),
        JSON.stringify(touchTargets),
      );
      await page.click('[aria-label="Session actions"]');
      await bounds('[role="menu"]');
      await clickText("Rename session");
      await page.waitForSelector('[aria-label="Session title"]');
      assert.equal(
        await page.evaluate(() =>
          document.activeElement?.getAttribute("aria-label"),
        ),
        "Session title",
      );
      await page.keyboard.press("Escape");
      await page.click('[aria-label="Session actions"]');
      await clickText("Edit tags");
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute("aria-label") === "Session tags",
      );
      const tagCommandsBefore = commands.filter(
        ({ kind }) => kind === "tag-session",
      ).length;
      await page.keyboard.type(", cancelled-edit");
      await page.keyboard.press("Escape");
      assert.equal(
        commands.filter(({ kind }) => kind === "tag-session").length,
        tagCommandsBefore,
        "Escape saved cancelled tags",
      );
      for (const title of ["Sessions", "Activity"]) {
        await page.click(`button[aria-label="${title}"]`);
        await bounds('.m-product-panel[role="dialog"]');
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press("Tab");
          assert.ok(
            await page.evaluate(() =>
              Boolean(
                document.activeElement?.closest(
                  '.m-product-panel[role="dialog"]',
                ),
              ),
            ),
            `${title}: focus escaped`,
          );
        }
        await page.keyboard.press("Escape");
        await page.waitForSelector('.m-product-panel[role="dialog"]', {
          hidden: true,
        });
        assert.equal(
          await page.evaluate(() =>
            document.activeElement?.getAttribute("aria-label"),
          ),
          title,
        );
      }
      await page.click('[aria-label="Composer options"]');
      for (const summary of await page.$$(
        ".m-product-composer-toolbar summary",
      )) {
        await summary.scrollIntoView();
        await summary.click();
        await bounds(
          "details[open] :is(.m-product-option-popover, .m-product-menu-popover)",
        );
        await page.keyboard.press("Escape");
      }
      await page.click('[aria-label="Composer options"]');
    }
    await page.click('button[aria-label^="Session model:"]');
    await bounds('.m-composer-model-popover[role="dialog"]');
    await page.keyboard.press("Escape");
    const before = commands.length;
    await page.type('[aria-label="Task composer"]', "First line");
    if (width <= 900) {
      await page.keyboard.press("Enter");
      assert.equal(commands.length, before, "Touch Enter submitted a message");
      assert.match(
        await page.$eval(
          '[aria-label="Task composer"]',
          (element) => element.value,
        ),
        /\n/,
      );
    } else {
      await page.$eval('[aria-label="Task composer"]', (element) =>
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            isComposing: true,
            bubbles: true,
          }),
        ),
      );
      assert.equal(
        commands.length,
        before,
        "IME composition submitted a message",
      );
    }
    await page.click('[aria-label="Send message"]');
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Task composer"]').value === "",
    );
    assert.equal(commands.at(-1)?.kind, "submit-message");
    for (const [view, label] of [
      ["media", "Media Studio"],
      ["scheduler", "Smart Scheduler"],
      ["ralph", "RALPH"],
    ]) {
      await page.click(
        `${width <= 900 ? ".m-product-mobile-nav" : ".m-product-rail"} button[aria-label="${label}"]`,
      );
      await layout(view);
    }
    console.log(`Responsive checks passed at ${width}px`);
  }
  for (const viewport of [
    { width: 844, height: 390 },
    { width: 390, height: 360 },
  ]) {
    await page.setViewport({ ...viewport, isMobile: true, hasTouch: true });
    await page.goto(`${baseUrl}/instances/${instanceId}`, {
      waitUntil: "networkidle2",
    });
    await bounds('[aria-label="Task composer"]');
    await bounds('[aria-label="Send message"]');
    await layout("short-chat");
    await page.click('[aria-label="Composer options"]');
    await bounds('[aria-label="Task composer"]');
    await layout("short-chat-options");
    await page.goto(`${baseUrl}/settings`, { waitUntil: "networkidle2" });
    await clickText("New profile");
    await bounds('[role="dialog"]');
    await page.keyboard.press("Escape");
    for (const [tab, action] of [
      ["Instructions", "Add instruction"],
      ["Context packs", "Add context pack"],
      ["Prompts", "Add prompt"],
    ]) {
      await clickText(tab);
      await clickText(action);
      await bounds('[role="dialog"]');
      await layout(`short-${tab.toLowerCase().replaceAll(" ", "-")}`);
      await page.keyboard.press("Escape");
    }
  }
  assert.deepEqual(errors, [], "Browser errors");
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      { layouts: report, commands: commands.map(({ kind }) => kind), errors },
      null,
      2,
    ),
  );
  console.log(
    `Passed ${report.length} responsive layout/interaction checks; screenshots: ${output}`,
  );
} finally {
  if (page && !page.isClosed()) {
    if (profileId)
      await api(
        `/api/settings/profiles/${encodeURIComponent(profileId)}`,
        "DELETE",
      ).catch((error) => console.error(`Fixture cleanup: ${error.message}`));
    if (instanceId)
      await api(
        `/api/instances/${encodeURIComponent(instanceId)}`,
        "DELETE",
      ).catch((error) => console.error(`Fixture cleanup: ${error.message}`));
  }
  await browser.close();
}
