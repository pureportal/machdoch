import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("./ui", import.meta.url));
const workspace = path.resolve(root, "../../../..");
const output = await mkdtemp(path.join(tmpdir(), "machdoch-speech-scroll-"));
let browser;

try {
  await build({
    configFile: false,
    root,
    plugins: [react()],
    logLevel: "error",
    resolve: {
      dedupe: ["react", "react-dom"],
      alias: [
        { find: /^@machdoch\/text-to-speech$/, replacement: path.join(workspace, "packages/text-to-speech/src/index.ts") },
        { find: /^@machdoch\/speech$/, replacement: path.join(workspace, "packages/speech/src/index.ts") },
      ],
    },
    build: { outDir: output, emptyOutDir: true, minify: false },
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("https://speech.test/**", async route => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    const target = path.resolve(output, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!target.startsWith(output + path.sep)) {
      await route.abort();
      return;
    }
    const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(target)] ?? "application/octet-stream";
    try {
      await route.fulfill({ body: await readFile(target), contentType });
    } catch {
      await route.fulfill({ status: 404, body: "Missing scroll fixture asset" });
    }
  });

  async function load() {
    await page.goto("https://speech.test/");
    await page.addStyleTag({ content: `
      html, body { height: 100%; overflow: hidden; }
      body { margin: 0; display: flex; flex-direction: column; }
      body::before { content: ""; flex: 0 0 48px; }
      #root { display: flex; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
    ` });
  }

  async function openPanel(name) {
    if (name === "Profiles" || name === "Dictionaries") {
      await page.getByLabel("More tools", { exact: true }).click();
    }
    await page.getByRole("button", { name, exact: true }).click();
  }

  async function checkScroll(name) {
    const studio = page.locator(".tts-studio");
    const metrics = await studio.evaluate(element => {
      element.scrollTop = 0;
      const bounds = element.getBoundingClientRect();
      return {
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflow: getComputedStyle(element).overflowY,
        x: bounds.right - 8,
        y: bounds.top + bounds.height / 2,
        bottom: bounds.bottom,
      };
    });
    assert.equal(metrics.overflow, "auto", `${name}: studio must own its scrolling`);
    assert.ok(metrics.bottom <= page.viewportSize().height, `${name}: studio must fit inside the app`);
    assert.ok(metrics.scrollWidth <= metrics.width + 1, `${name}: content must fit the available width`);
    if (metrics.scrollHeight > metrics.height + 1) {
      await page.mouse.move(metrics.x, metrics.y);
      await page.mouse.wheel(0, metrics.scrollHeight);
      await page.waitForFunction(() => {
        const element = document.querySelector(".tts-studio");
        return element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
      });
      assert.equal(await page.evaluate(() => document.scrollingElement.scrollTop), 0, `${name}: the app shell must stay in place`);
    }
    return metrics.scrollHeight > metrics.height + 1;
  }

  await load();
  await page.getByLabel("Project name", { exact: true }).fill("Scroll check");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).waitFor();
  await page.evaluate(() => window.speechFixture.prepareProductionHistory());
  await load();
  await page.getByRole("button", { name: "Scroll check", exact: true }).click();

  let overflowingPanels = 0;
  for (const viewport of [{ width: 1365, height: 900 }, { width: 900, height: 600 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const name of ["Script", "Takes", "Export", "Voices", "Profiles", "Dictionaries", "Settings"]) {
      await openPanel(name);
      if (name === "Voices") {
        await page.locator(".tts-voice").first().waitFor();
      }
      if (await checkScroll(`${name} at ${viewport.width}x${viewport.height}`)) overflowingPanels++;
      if (name === "Voices") {
        const creation = page.getByText("Create or clone a voice", { exact: true });
        await creation.click();
        assert.equal(await checkScroll(`Voice creation at ${viewport.width}x${viewport.height}`), true);
        const create = page.getByRole("form", { name: "Create voice", exact: true });
        const bounds = await create.boundingBox();
        assert.ok(bounds.y + bounds.height <= viewport.height + 1, "Voice creation controls must be reachable");
        await creation.click();
      }
    }
    process.stdout.write(`Scrolling verified at ${viewport.width}x${viewport.height}.\n`);
  }
  assert.ok(overflowingPanels >= 12, "Exercise overflowing views at multiple window sizes");
  assert.deepEqual(errors, []);
  process.stdout.write("Speech scrolling checks passed across seven views and voice creation at three window sizes; no server started.\n");
} finally {
  await browser?.close();
  await rm(output, { recursive: true, force: true });
}
