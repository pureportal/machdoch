import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("./ui", import.meta.url));
const workspace = path.resolve(root, "../../../..");
const output = await mkdtemp(path.join(tmpdir(), "machdoch-speech-controls-"));
const evidence = await mkdtemp(path.join(tmpdir(), "machdoch-speech-controls-images-"));
let browser;
const errors = [];

try {
  await build({
    configFile: false, root, plugins: [react()], logLevel: "error",
    resolve: { dedupe: ["react", "react-dom"], alias: [
      { find: /^@machdoch\/text-to-speech$/, replacement: path.join(workspace, "packages/text-to-speech/src/index.ts") },
      { find: /^@machdoch\/speech$/, replacement: path.join(workspace, "packages/speech/src/index.ts") },
    ] },
    build: { outDir: output, emptyOutDir: true, minify: false },
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });

  async function createPage() {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://speech.test/**", async route => {
      const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
      const target = path.resolve(output, pathname === "/" ? "index.html" : `.${pathname}`);
      if (!target.startsWith(output + path.sep)) return route.abort();
      const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(target)] ?? "application/octet-stream";
      try { await route.fulfill({ body: await readFile(target), contentType }); }
      catch { await route.fulfill({ status: 404, body: "Missing verification asset" }); }
    });
    await page.goto("https://speech.test/");
    return page;
  }

  async function theme(page) {
    await page.addStyleTag({ content: await readFile(path.join(workspace, "packages/product-ui/src/theme.css"), "utf8") });
    await page.addStyleTag({ content: `
      html, body { height: 100%; overflow: hidden; }
      body { margin: 0; display: flex; flex-direction: column; }
      #root { display: flex; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
    ` });
  }

  const button = (page, name) => page.getByRole("button", { name, exact: true });
  const summary = (page, name) => page.locator("summary").filter({ hasText: new RegExp(`^${name}$`, "u") });
  async function profiles(page) {
    await page.getByLabel("More tools", { exact: true }).click();
    await button(page, "Profiles").click();
  }
  async function createProject(page, name) {
    await page.getByLabel("Project name", { exact: true }).fill(name);
    await button(page, "Create project").click();
    await page.getByLabel("Title", { exact: true }).waitFor();
  }
  async function assertStationary(locator, before, description) {
    const after = await positionInStudio(locator);
    assert.ok(after && before, `${description}: visible`);
    for (const key of ["x", "y", "width", "height"]) {
      assert.ok(Math.abs(after[key] - before[key]) < 1, `${description}: ${key} changed from ${before[key]} to ${after[key]}`);
    }
  }
  async function positionInStudio(locator) {
    return locator.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const studio = element.closest(".tts-studio");
      return { x: bounds.x + studio.scrollLeft, y: bounds.y + studio.scrollTop, width: bounds.width, height: bounds.height };
    });
  }

  const local = await createPage();
  await local.evaluate(() => {
    const base = JSON.parse(localStorage.getItem("speech-fixture-profiles") ?? "null")?.[0] ?? { direction: "", temperature: 0.7, topP: 0.7, chunkLength: 300, minChunkLength: 50, latency: "normal", dictionaryIds: [], playbackRate: 1 };
    const profiles = [
      { ...base, id: "local", name: "Local narration", backend: "drama3", model: "drama-3", referenceAssetIds: [] },
      { ...base, id: "fish", name: "Fish narration", backend: "fish-cloud", model: "drama-3" },
      { ...base, id: "openai", name: "OpenAI narration", backend: "openai", model: "gpt-4o-mini-tts", voiceId: "cedar" },
      { ...base, id: "google", name: "Google narration", backend: "google", model: "gemini-3.1-flash-tts-preview", voiceId: "Kore" },
    ];
    const settings = { connections: profiles.map(profile => ({ backend: profile.backend, model: profile.model, configured: ["drama3", "openai"].includes(profile.backend), healthy: null, error: null, runtimeVersion: null, nativeRevision: false, maxTextBytes: null, maxSpeakers: null })), modelRoot: "D:\\Models\\machdoch", cloudConsent: true, maxConcurrent: 1, pricing: null, budgetLimit: null, answerBudgetLimit: null, answerCharacterLimit: 10000, cacheRetentionDays: 7 };
    localStorage.setItem("speech-fixture-profiles", JSON.stringify(profiles));
    localStorage.setItem("speech-fixture-settings", JSON.stringify(settings));
  });
  await local.reload();
  await theme(local);
  await createProject(local, "Local stories");
  assert.deepEqual(await local.getByLabel("Profile", { exact: true }).locator("option").allTextContents(), ["Select profile", "Local narration", "OpenAI narration"]);
  await profiles(local);
  assert.deepEqual(await local.getByLabel("Provider", { exact: true }).locator("option").allTextContents(), ["Select provider", "Drama 3 · Local", "OpenAI"]);
  assert.equal(await local.getByLabel("Provider", { exact: true }).inputValue(), "drama3");
  await local.getByLabel("Edit profile", { exact: true }).selectOption("fish");
  assert.equal(await local.getByLabel("Provider", { exact: true }).inputValue(), "");
  assert.equal(await button(local, "Save profile").isDisabled(), true);
  await button(local, "Voices").click();
  assert.equal(await local.getByRole("search", { name: "Voices" }).count(), 0);
  assert.equal(await local.getByRole("alert").count(), 0);
  assert.equal(await local.evaluate(() => window.speechFixture.calls.filter(call => ["listVoices", "getVoice", "listFavoriteVoices"].includes(call.operation)).length), 0);
  await summary(local, "Reference recordings").click();
  await local.getByLabel("Recording transcript", { exact: true }).waitFor();
  assert.equal(await local.getByRole("form", { name: "Voice design", exact: true }).count(), 0);
  assert.equal(await local.getByRole("form", { name: "Create voice", exact: true }).count(), 0);
  await button(local, "Settings").click();
  const fishConnection = local.locator(".tts-connection").filter({ has: local.locator("summary").filter({ hasText: /^Fish Audio/u }) });
  assert.equal(await fishConnection.getAttribute("open"), null);
  await local.screenshot({ path: path.join(evidence, "settings.png") });
  console.log("PASS configured providers and profiles only; no unsolicited Fish requests or warnings; local recordings remain available.");

  await button(local, "Script").click();
  await local.getByLabel("Profile", { exact: true }).selectOption("local");
  const editor = local.locator('.cm-content[contenteditable="true"]');
  await editor.fill("A quiet morning in the city.");
  await local.waitForFunction(() => document.querySelector(".tts-primary[aria-busy]")?.getAttribute("aria-busy") === "false");
  const actions = local.locator(".tts-render-actions");
  const actionBounds = await positionInStudio(actions);
  await summary(local, "Generation options").click();
  await local.getByLabel("Takes", { exact: true }).fill("2");
  await assertStationary(actions, actionBounds, "Opening generation options");
  await summary(local, "Generation options").focus();
  await local.keyboard.press("Escape");
  await local.getByLabel("Takes", { exact: true }).waitFor({ state: "hidden" });
  await local.evaluate(() => {
    const postMessage = Worker.prototype.postMessage;
    const pending = [];
    Worker.prototype.postMessage = function (...args) { pending.push(() => postMessage.apply(this, args)); };
    window.speechFixture.releaseScript = () => {
      Worker.prototype.postMessage = postMessage;
      pending.forEach(send => send());
    };
  });
  await editor.fill("The same quiet morning, with more words.");
  await local.waitForFunction(() => document.querySelector(".tts-primary[aria-busy]")?.getAttribute("aria-busy") === "true");
  await assertStationary(actions, actionBounds, "Script analysis pending");
  await local.evaluate(() => window.speechFixture.releaseScript());
  await local.waitForFunction(() => document.querySelector(".tts-primary[aria-busy]")?.getAttribute("aria-busy") === "false");
  await assertStationary(actions, actionBounds, "Script analysis completed");
  await local.screenshot({ path: path.join(evidence, "script.png") });
  console.log("PASS generation controls stay in place during options and asynchronous analysis.");

  const fish = await createPage();
  await theme(fish);
  await createProject(fish, "Cloud stories");
  await button(fish, "Choose voice").click();
  await fish.getByRole("heading", { name: "Comparison voice 1", exact: true }).waitFor();
  const results = fish.locator(".tts-voice-results");
  const resultBounds = await positionInStudio(results);
  const creation = summary(fish, "Create or clone a voice");
  const creationBounds = await positionInStudio(creation);
  await fish.evaluate(() => {
    const fixture = window.speechFixture;
    const execute = fixture.runtime.execute;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    fixture.releaseVoices = release;
    fixture.runtime.execute = async (operation, input) => {
      if (operation === "listVoices") await gate;
      return execute(operation, input);
    };
  });
  await fish.getByLabel("Search voices", { exact: true }).fill("Does not exist");
  await button(fish, "Search").click();
  await fish.locator('.tts-voice-list[aria-busy="true"]').waitFor();
  await assertStationary(results, resultBounds, "Voice results loading");
  await assertStationary(creation, creationBounds, "Controls below loading voices");
  await fish.evaluate(() => window.speechFixture.releaseVoices());
  await fish.getByText("No voices found.", { exact: true }).waitFor();
  await assertStationary(results, resultBounds, "Empty voice results");
  await assertStationary(creation, creationBounds, "Controls below empty voices");
  await button(fish, "Clear filters").click();
  await fish.getByRole("heading", { name: "Comparison voice 1", exact: true }).waitFor();
  await button(fish, "Next").click();
  await fish.getByRole("heading", { name: "Comparison voice 21", exact: true }).waitFor();
  await assertStationary(creation, creationBounds, "Last page of voices");
  await button(fish, "Previous").click();
  await fish.getByRole("heading", { name: "Comparison voice 1", exact: true }).waitFor();
  await fish.getByLabel("Find by voice ID", { exact: true }).click();
  await fish.getByLabel("Voice ID", { exact: true }).first().fill("missing-voice");
  await fish.getByLabel("Voice ID", { exact: true }).first().press("Enter");
  await fish.getByRole("alert").waitFor();
  assert.equal(await fish.locator(".tts-error").evaluate(element => getComputedStyle(element).position), "fixed");
  await assertStationary(results, resultBounds, "Provider error");
  await assertStationary(creation, creationBounds, "Controls below provider error");
  await button(fish, "Dismiss error").click();
  await fish.getByLabel("Find by voice ID", { exact: true }).click();
  await fish.getByLabel("Voice ID", { exact: true }).first().fill("fixture-voice-1");
  await button(fish, "Open voice").click();
  await button(fish, "Close voice").waitFor();
  await assertStationary(creation, creationBounds, "Voice lookup result");
  await button(fish, "Close voice").click();
  console.log("PASS loading, empty results, paging, ID lookup, and provider errors preserve layout.");

  for (const viewport of [{ width: 1365, height: 900 }, { width: 900, height: 600 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
    await fish.setViewportSize(viewport);
    await fish.getByLabel("Filters", { exact: true }).click();
    await fish.locator(".tts-voice-filters").getByLabel("Language", { exact: true }).waitFor();
    await fish.getByLabel("Filters", { exact: true }).focus();
    await fish.keyboard.press("Escape");
    assert.equal(await fish.locator(".tts-studio").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `Voices fit at ${viewport.width}px`);
    if (viewport.width === 390) await fish.screenshot({ path: path.join(evidence, "voices-mobile.png") });
    await button(fish, "Back to script").click();
    await fish.getByLabel("Profile", { exact: true }).selectOption("fixture-fish");
    await summary(fish, "Generation options").click();
    const menu = await fish.locator(".tts-render-options > .tts-menu-content").boundingBox();
    assert.ok(menu.x >= 0 && menu.y >= 0 && menu.x + menu.width <= viewport.width && menu.y + menu.height <= viewport.height, `Generation menu stays on screen at ${viewport.width}px`);
    await summary(fish, "Generation options").focus();
    await fish.keyboard.press("Escape");
    assert.equal(await fish.locator(".tts-studio").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, `Script fits at ${viewport.width}px`);
    await button(fish, "Choose voice").click();
  }
  await fish.setViewportSize({ width: 1365, height: 900 });
  await fish.locator(".tts-studio").evaluate(element => { element.scrollTop = 0; });
  await fish.screenshot({ path: path.join(evidence, "voices.png") });
  await fish.getByLabel("Options for Comparison voice 1", { exact: true }).click();
  await button(fish, "Compare voice").first().waitFor();
  await fish.getByLabel("Options for Comparison voice 1", { exact: true }).focus();
  await fish.keyboard.press("Escape");
  await button(fish, "Assign voice").first().click();
  await fish.locator(".tts-cast-voice").getByText("Comparison voice 1", { exact: true }).waitFor();
  await button(fish, "Change voice").waitFor();
  assert.deepEqual(errors, []);
  console.log(`PASS responsive controls at four window sizes; no browser errors. Screenshots: ${evidence}`);
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  const resolved = path.resolve(output);
  assert.ok(resolved.startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(resolved).startsWith("machdoch-speech-controls-"));
  await rm(resolved, { recursive: true, force: true });
}
