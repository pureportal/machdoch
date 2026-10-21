import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";

const storage = process.argv[2];
if (!storage) throw new Error("Provide the configured storage root");
const output = path.resolve(storage, "layout-control/editor");
await mkdir(output, { recursive: true });
const workspace = process.cwd();
await build({ configFile: false, root: path.resolve("docs/validation/layout-control/ui"), plugins: [react()], logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, build: { outDir: path.join(output, "site"), emptyOutDir: false, minify: false } });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("https://layout.test/**", async route => {
  const url = new URL(route.request().url());
  if (url.pathname === "/api/flow") {
    const saved = path.join(output, "saved-flow.json");
    if (route.request().method() === "POST") await writeFile(saved, route.request().postData());
    await route.fulfill({ contentType: "application/json", body: await readFile(saved) }); return;
  }
  if (url.pathname === "/api/adapter") {
    const request = route.request().postData();
    await writeFile(path.join(output, "adapter-request.json"), request);
    const result = spawnSync(path.join(workspace, "apps/client/src-tauri/python/runtime/Scripts/python.exe"), ["-c", "import json,sys;from media_image_layout import compile_native_layout;r=json.load(sys.stdin);print(json.dumps(compile_native_layout(r['imageLayout'],'moss-image-base'),ensure_ascii=False))"],
      { cwd: path.join(workspace, "apps/client/src-tauri/python"), input: request, encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } });
    await writeFile(path.join(output, "adapter-response.json"), result.stdout);
    await route.fulfill({ status: result.status === 0 ? 200 : 500, contentType: "application/json", body: result.status === 0 ? result.stdout : result.stderr }); return;
  }
  const target = path.resolve(output, "site", url.pathname === "/" ? "index.html" : `.${url.pathname}`);
  if (!target.startsWith(path.resolve(output, "site") + path.sep)) { await route.abort(); return; }
  await route.fulfill({ body: await readFile(target), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(target)] });
});
try {
  await page.goto("https://layout.test/");
  await page.getByRole("button", { name: "Add object", exact: true }).click();
  await page.getByLabel("Description", { exact: true }).fill("A blue robot");
  const element = page.locator("[data-element-id]").first();
  const id = await element.getAttribute("data-element-id");
  const rect = await element.boundingBox();
  await page.mouse.move(rect.x + 40, rect.y + 40);
  await page.mouse.down(); await page.mouse.move(rect.x + 140, rect.y + 100); await page.mouse.up();
  assert.ok(Number(await page.getByLabel("Left", { exact: true }).inputValue()) > 50);
  const handle = await page.getByLabel("Resize element").boundingBox();
  await page.mouse.move(handle.x + 5, handle.y + 5); await page.mouse.down(); await page.mouse.move(handle.x + 55, handle.y + 35); await page.mouse.up();
  await page.getByRole("button", { name: "Add text", exact: true }).click();
  const literal = "  {{title}}\nGrüße — مرحبا";
  await page.getByLabel("Text", { exact: true }).fill(literal);
  await page.getByRole("button", { name: "Add shape", exact: true }).click();
  await page.getByLabel("Shape", { exact: true }).selectOption("arrow");
  await page.getByRole("button", { name: "Send backward", exact: true }).click();
  await page.getByRole("button", { name: "Delete element", exact: true }).click();
  const digest = await page.getByLabel("Layout digest").textContent();
  await page.getByRole("button", { name: "Save workflow", exact: true }).click();
  await page.getByLabel("Workflow status").filter({ hasText: "Saved" }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Reopen workflow", exact: true }).click();
  await page.getByLabel("Workflow status").filter({ hasText: "Reopened" }).waitFor();
  assert.equal(await page.getByLabel("Layout digest").textContent(), digest);
  assert.equal(await page.locator("[data-element-id]").first().getAttribute("data-element-id"), id);
  await page.getByRole("button", { name: "Compile generation", exact: true }).click();
  await page.getByLabel("Workflow status").filter({ hasText: "Adapter compiled" }).waitFor();
  const compiled = JSON.parse(await readFile(path.join(output, "adapter-response.json"), "utf8"));
  assert.equal(JSON.parse(compiled.prompt).items.find(item => item.label === "text").text, literal);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export layout", exact: true }).click(),
  ]);
  assert.equal(await download.failure(), null);
  await download.saveAs(path.join(output, "exported-layout.json"));
  const exported = JSON.parse(await readFile(path.join(output, "exported-layout.json"), "utf8"));
  const request = JSON.parse(await readFile(path.join(output, "adapter-request.json"), "utf8"));
  assert.deepEqual(exported, request.imageLayout);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(output, "editor.png"), fullPage: true });
  await writeFile(path.join(output, "result.json"), JSON.stringify({ passed: true, digest, scope: "Production editor, workflow compiler, file persistence and Python native input adapter; no inference or Tauri database in this UI check." }, null, 2));
  console.log("Editor save/reopen/adapter check passed");
} catch (error) {
  await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true });
  console.error(JSON.stringify({ errors, body: await page.locator("body").innerText() }));
  throw error;
} finally { await browser.close(); }
