import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const [storage, scenePath, expectedBounds] = process.argv.slice(2);
if (!scenePath) throw new Error("Provide storage and a layout with retained cutout assets");
const output = path.resolve(storage, "layout-control/editor-assets");
await mkdir(output, { recursive: true });
await build({ configFile: false, root: path.resolve("docs/validation/layout-control/ui"), plugins: [react()], logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, build: { outDir: path.join(output, "site"), emptyOutDir: false, minify: false } });
const desktop = await chromium.connectOverCDP("http://127.0.0.1:9239");
const nativePage = desktop.contexts()[0].pages().find(page => page.url().includes("tauri.localhost"));
const scene = JSON.parse(await readFile(scenePath, "utf8"));
const previews = new Map();
for (const element of scene.elements.filter(element => element.kind === "object" && element.assetId)) {
  const bytes = await nativePage.evaluate(async assetId => Array.from(new Uint8Array(await window.__TAURI__.core.invoke("media_read_asset_preview", { assetId, maxEdge: 768 }))), element.assetId);
  previews.set(element.assetId, bytes);
  await writeFile(path.join(output, `${element.id}.webp`), new Uint8Array(bytes));
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
const errors = [];
try {
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.isTauri = true;
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command !== "media_read_asset_preview") throw new Error(`Unexpected command: ${command}`);
      return (await fetch(`/preview?asset=${encodeURIComponent(args.assetId)}`)).arrayBuffer();
    } };
  });
  await page.route("https://layout.test/**", async route => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/preview") {
      assert.ok(previews.has(url.searchParams.get("asset")));
      await route.fulfill({ body: Buffer.from(previews.get(url.searchParams.get("asset"))), contentType: "image/webp" });
      return;
    }
    const target = path.resolve(output, "site", pathname === "/" ? "index.html" : `.${pathname}`);
    assert.ok(target.startsWith(path.resolve(output, "site") + path.sep));
    await route.fulfill({ body: await readFile(target), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(target)] });
  });
  await page.goto("https://layout.test/");
  await page.getByLabel("Import layout").setInputFiles(path.resolve(scenePath));
  const subject = scene.elements.find(element => element.kind === "object" && element.assetId && element.cutout !== false);
  assert.ok(subject);
  const preview = page.locator(`[data-element-id="${subject.id}"] svg`);
  await preview.waitFor();
  const cropped = (await preview.getAttribute("viewBox")).split(" ").map(Number);
  if (expectedBounds) assert.deepEqual(cropped, JSON.parse(expectedBounds));
  const full = await preview.locator("image").evaluate(image => [0, 0, Number(image.getAttribute("width")), Number(image.getAttribute("height"))]);
  assert.ok(cropped[0] > 0 && cropped[1] > 0 && cropped[2] < full[2] && cropped[3] < full[3]);
  await page.getByLabel("Layer", { exact: true }).selectOption(subject.id);
  assert.equal(await page.getByLabel("Asset", { exact: true }).inputValue(), subject.assetId);
  await page.getByLabel("Cut out subject").uncheck();
  assert.equal(await preview.getAttribute("viewBox"), full.join(" "));
  await page.getByLabel("Cut out subject").check();
  assert.equal(await preview.getAttribute("viewBox"), cropped.join(" "));
  await page.getByLabel("Fit", { exact: true }).selectOption("cover");
  assert.equal(await preview.getAttribute("preserveAspectRatio"), "xMidYMid slice");
  await page.getByLabel("Fit", { exact: true }).selectOption("stretch");
  assert.equal(await preview.getAttribute("preserveAspectRatio"), "none");
  await page.getByLabel("Fit", { exact: true }).selectOption("contain");
  assert.equal(await preview.getAttribute("preserveAspectRatio"), "xMidYMid meet");
  await page.getByLabel("Transparent", { exact: true }).check();
  assert.equal(await page.getByLabel("Background", { exact: true }).isDisabled(), true);
  assert.ok((await page.getByLabel("Image layout canvas").getAttribute("style")).includes("conic-gradient"));
  await page.getByLabel("Transparent", { exact: true }).uncheck();
  assert.equal(await page.getByLabel("Background", { exact: true }).isDisabled(), false);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, "editor.png"), fullPage: true });
  const result = { passed: true, assetId: subject.assetId, cutoutViewBox: cropped, fullViewBox: full,
    scope: "Production editor in a headless browser with captured actual desktop CAS previews; cutout bounds and fit changes; no new inference." };
  await writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
  const details = { error: String(error), errors, body: await page.locator("body").innerText() };
  await writeFile(path.join(output, "failure.json"), JSON.stringify(details, null, 2));
  console.error(JSON.stringify(details));
  throw error;
} finally { await browser.close(); await desktop.close(); }
