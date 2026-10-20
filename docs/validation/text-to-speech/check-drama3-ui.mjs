import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const root = fileURLToPath(new URL("./drama3/", import.meta.url));
let output = await mkdtemp(path.join(tmpdir(), "machdoch-drama3-ui-"));
await build({ configFile: false, root, plugins: [react()], logLevel: "error", resolve: {
  dedupe: ["react", "react-dom"], alias: [{ find: /^@machdoch\/speech$/u, replacement: path.join(workspace, "packages/speech/src/index.ts") }],
}, build: { outDir: output, emptyOutDir: false } });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("https://speech.test/**", async route => {
  const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
  const target = path.resolve(output, pathname === "/" ? "index.html" : `.${pathname}`);
  assert.ok(target.startsWith(output + path.sep));
  await route.fulfill({ body: await readFile(target), contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(target)] });
});
const button = name => page.getByRole("button", { name, exact: true });
const checks = [];
try {
  await page.goto("https://speech.test/");
  await button("Download model").waitFor();
  assert.ok(await button("Download model").isDisabled());
  await page.getByRole("checkbox").check();
  await button("Download model").click();
  await page.getByRole("progressbar", { name: "Model download" }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.drama3.calls.find(call => call.operation === "runtimeInstallModel").input), { acceptLicense: true });
  checks.push("Model download requires acceptance and sends a structured native request");
  await page.evaluate(() => window.drama3.setStatus({ bytes: 5368709120 }));
  await page.getByRole("status").filter({ hasText: "5.0 / 15.9 GiB" }).waitFor();
  await button("Pause download").click();
  await button("Resume download").waitFor();
  await button("Resume download").click();
  await button("Pause download").waitFor();
  checks.push("Progress, pause and resume update without a server configuration");
  await page.evaluate(() => window.drama3.setStatus({ state: "verifying", bytes: 17053639872 }));
  await page.getByRole("status").filter({ hasText: "Verifying model…" }).waitFor();
  await page.evaluate(() => window.drama3.setStatus({ state: "installed" }));
  await page.getByRole("status").filter({ hasText: "Installed" }).waitFor();
  await page.waitForFunction(() => window.drama3.refreshes() > 0);
  checks.push("Verification completion refreshes speech settings");
  await page.getByText("Model storage", { exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await button("Remove model").click();
  await button("Download model").waitFor();
  checks.push("Model removal requires confirmation and returns to download state");
  await button("Download model").click();
  await page.evaluate(() => window.drama3.setStatus({ state: "failed", error: "The model download stopped. Resume to continue." }));
  await page.getByRole("alert").filter({ hasText: "Resume to continue" }).waitFor();
  await button("Resume download").waitFor();
  await page.setViewportSize({ width: 390, height: 700 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  checks.push("Download errors expose recovery and the card fits a narrow viewport");
  await page.goto("https://speech.test/?installed");
  await page.getByRole("status").filter({ hasText: "Installed" }).waitFor();
  await page.waitForFunction(() => window.drama3.refreshes() > 0);
  checks.push("Reopening settings recognizes a model installed in the background");
  output = await mkdtemp(path.join(tmpdir(), "machdoch-drama3-studio-"));
  await build({ configFile: false, root: fileURLToPath(new URL("./ui/", import.meta.url)), plugins: [react()], logLevel: "error", resolve: {
    dedupe: ["react", "react-dom"], alias: [
      { find: /^@machdoch\/speech$/u, replacement: path.join(workspace, "packages/speech/src/index.ts") },
      { find: /^@machdoch\/text-to-speech$/u, replacement: path.join(workspace, "packages/text-to-speech/src/index.ts") },
    ],
  }, build: { outDir: output, emptyOutDir: false } });
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("speech-fixture-profiles", JSON.stringify([{id:"local",name:"Drama 3 local",backend:"drama3",model:"drama-3",direction:"",temperature:0.7,topP:0.7,chunkLength:300,minChunkLength:50,latency:"normal",dictionaryIds:[],playbackRate:1}]));
    localStorage.setItem("speech-fixture-settings", JSON.stringify({connections:[{backend:"drama3",configured:true,healthy:true,error:null,runtimeVersion:"fixture",model:"drama-3",nativeRevision:false,maxTextBytes:null,maxSpeakers:16}],modelRoot:"D:\\Models\\machdoch",cloudConsent:false,maxConcurrent:1,pricing:null,budgetLimit:null,answerBudgetLimit:null,answerCharacterLimit:10000,cacheRetentionDays:7}));
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByLabel("Project name", { exact: true }).fill("Local speech");
  await button("Create project").click();
  await page.getByLabel("Profile", { exact: true }).selectOption("local");
  await page.locator('.cm-content[contenteditable="true"]').fill("Hello from Drama Three on AMD.");
  await page.evaluate(() => window.speechFixture.enableRenderTargets());
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.includes("Generate audio") && !button.disabled));
  await button("Generate audio").click();
  await page.waitForFunction(() => window.speechFixture.calls.some(call => call.operation === "render"));
  const render = await page.evaluate(() => window.speechFixture.calls.find(call => call.operation === "render").input);
  assert.equal(render.cloudConsent, false);
  assert.equal(render.profileId, "local");
  assert.deepEqual(render.segments[0].referenceAssetIds, []);
  assert.deepEqual(render.segments[0].voiceIds, []);
  assert.deepEqual(errors, []);
  checks.push("Studio queues local speech without a voice recording, API key or cloud consent");
  const evidence = { checks, browser: "Edge", backend: "fixture", errors };
  await writeFile(new URL("drama3-ui-result.json", import.meta.url), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { await browser.close(); }
