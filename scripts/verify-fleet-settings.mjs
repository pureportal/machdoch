import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import { output, capture } from "./fleet-review/browser.mjs";
import { buildSettingsHarness } from "./fleet-review/settings-browser.mjs";
import { reviewSettings } from "./fleet-review/settings.mjs";

const baseURL = process.env.MACHDOCH_FLEET_UI_URL ?? "http://127.0.0.1:43188";
await mkdir(output, { recursive: true });
await writeFile(
  `${output}/settings-verification.json`,
  JSON.stringify(
    {
      passed: false,
      startedAt: new Date().toISOString(),
      phase: "Starting review",
    },
    null,
    2,
  ),
);
let browser;
const results = [];
const errors = [];
let failure;
try {
  assert.equal((await fetch(`${baseURL}/healthz`)).status, 200);
  const mount = await buildSettingsHarness();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : { channel: process.platform === "win32" ? "msedge" : "chrome" }),
  });
  for (const viewport of [
    { name: "desktop", width: 1440, height: 960 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "mobile", width: 390, height: 844 },
    { name: "narrow", width: 320, height: 640 },
  ]) {
    const context = await browser.newContext({
      baseURL,
      viewport,
      hasTouch: viewport.width <= 900,
      isMobile: viewport.width <= 900,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !message.text().startsWith("Failed to load resource:")
      )
        errors.push(message.text());
    });
    try {
      results.push(await reviewSettings(page, viewport.name, mount));
      console.log(`Completed ${viewport.name} Settings review`);
    } catch (reason) {
      await capture(page, `${viewport.name}-settings-failure`);
      throw reason;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
} catch (reason) {
  failure = reason;
} finally {
  await browser?.close();
  await writeFile(
    `${output}/settings-verification.json`,
    JSON.stringify(
      {
        passed: !failure,
        mode: "Production Settings components with intercepted HTML/assets and Settings APIs; live Settings configuration unchanged",
        results,
        errors,
        failure: failure?.message,
      },
      null,
      2,
    ),
  );
}
if (failure) throw failure;
