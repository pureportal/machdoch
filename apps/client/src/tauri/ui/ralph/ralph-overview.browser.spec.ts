import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {} from "./__test__/ralph-overview.browser-fixture";

let browser: Browser;
let page: Page;
const diagnostics: string[] = [];

beforeAll(async () => {
  const result = await build({
    configFile: false,
    plugins: [react()],
    logLevel: "error",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve(
          "src/tauri/ui/ralph/__test__/ralph-overview.browser-fixture.tsx",
        ),
        name: "RalphOverviewFixture",
        formats: ["iife"],
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (output) => ("output" in output ? output.output : []),
  );
  const script = outputs
    .filter((output) => output.type === "chunk")
    .map((output) => output.code)
    .join("\n");
  const styles = outputs
    .flatMap((output) =>
      output.type === "asset" && output.fileName.endsWith(".css")
        ? [String(output.source)]
        : [],
    )
    .join("\n");
  browser = await puppeteer.launch({
    executablePath:
      process.env.CHROME_PATH ??
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    timeout: 60_000,
  });
  page = await browser.newPage();
  page.on("pageerror", (error) => diagnostics.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push(message.text());
  });
  await page.setContent(
    '<style>*{box-sizing:border-box}html,body,#root{height:100%;margin:0}body{font-family:system-ui}button{font:inherit;color:inherit;background:none;border:0}button,svg{vertical-align:middle}</style><div id="root"></div>',
  );
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  await page.waitForSelector(".ralph-overview-run").catch((error: unknown) => {
    throw new Error(`${String(error)}\n${diagnostics.join("\n")}`);
  });
}, 120_000);

afterAll(async () => {
  if (!browser) return;
  const browserProcess = browser.process();
  const timeout = setTimeout(() => browserProcess?.kill(), 5_000);
  try {
    await browser.close();
  } finally {
    clearTimeout(timeout);
  }
}, 60_000);

describe("RALPH overview browser layout", () => {
  it.each([
    { width: 1440, height: 900 },
    { width: 768, height: 800 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ])(
    "keeps running workspaces visible and content within $width pixels",
    async ({ width, height }) => {
      await page.setViewport({ width, height });
      const layout = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        running: [...document.querySelectorAll(".ralph-overview-run")].map(
          (element) => ({
            text: element.textContent,
            top: element.getBoundingClientRect().top,
            bottom: element.getBoundingClientRect().bottom,
            right: element.getBoundingClientRect().right,
          }),
        ),
        libraries: document.querySelectorAll(".ralph-overview-library").length,
      }));
      expect(layout.documentWidth).toBeLessThanOrEqual(width);
      expect(layout.documentHeight).toBeLessThanOrEqual(height);
      expect(layout.running).toHaveLength(2);
      expect(layout.running[0]?.text).toContain("C:/Development/commerce/api");
      expect(layout.running[1]?.text).toContain("C:/Development/payments/api");
      for (const run of layout.running) {
        expect(run.top).toBeGreaterThan(0);
        expect(run.bottom).toBeLessThan(height);
        expect(run.right).toBeLessThanOrEqual(width);
      }
      expect(layout.libraries).toBe(5);
      if (process.env.MACHDOCH_RALPH_SCREENSHOT_DIR) {
        await mkdir(process.env.MACHDOCH_RALPH_SCREENSHOT_DIR, {
          recursive: true,
        });
        await page.screenshot({
          path: resolve(
            process.env.MACHDOCH_RALPH_SCREENSHOT_DIR,
            `ralph-${width}.png`,
          ),
        });
      }
    },
  );

  it("opens the right workspace with keyboard input and updates activity without navigation", async () => {
    await page.focus(
      '.ralph-overview-run[aria-label="Open Release in C:/Development/payments/api"]',
    );
    await page.keyboard.press("Enter");
    expect(
      await page.evaluate(() => window.ralphOverviewFixture.selection),
    ).toMatchObject({
      workspaceRoot: "C:/Development/payments/api",
      flowId: "release",
      running: true,
    });
    await page.evaluate(() => window.ralphOverviewFixture.complete());
    await page.waitForFunction(
      () => document.querySelectorAll(".ralph-overview-run").length === 1,
    );
    expect(
      await page.$eval(
        '.ralph-overview-library[aria-label="C:/Development/commerce/api"]',
        (element) => element.textContent,
      ),
    ).toContain("Completed");
    expect(diagnostics).toEqual([]);
  });
});
