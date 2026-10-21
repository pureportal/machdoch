import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("./ui", import.meta.url));
const workspace = path.resolve(root, "../../../..");
const output = await mkdtemp(path.join(tmpdir(), "machdoch-speech-cleanup-"));
const evidence = fileURLToPath(new URL("./ui-cleanup", import.meta.url));
const require = createRequire(path.join(workspace, "apps/client/package.json"));
const axe = require("axe-core");
await mkdir(evidence, { recursive: true });
await build({
  configFile: false, root, plugins: [react()], logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"], alias: [
    { find: /^@machdoch\/text-to-speech$/, replacement: path.join(workspace, "packages/text-to-speech/src/index.ts") },
    { find: /^@machdoch\/speech$/, replacement: path.join(workspace, "packages/speech/src/index.ts") },
  ] },
  build: { outDir: output, emptyOutDir: false, minify: false },
});

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
const checks = [];
page.on("pageerror", error => errors.push(error.message));
await page.route("https://speech.test/**", async route => {
  const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
  const target = path.resolve(output, pathname === "/" ? "index.html" : `.${pathname}`);
  if (!target.startsWith(output + path.sep)) { await route.abort(); return; }
  const contentType = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(target)] ?? "application/octet-stream";
  try { await route.fulfill({ body: await readFile(target), contentType }); }
  catch { await route.fulfill({ status: 404, body: "Missing verification asset" }); }
});

const button = name => page.getByRole("button", { name, exact: true });
const field = name => page.getByLabel(name, { exact: true });
const summary = name => page.locator("summary").filter({ hasText: new RegExp(`^${name}$`, "u") });
const screenshot = name => page.screenshot({ path: path.join(evidence, `${name}.png`), fullPage: true });
const check = name => { checks.push(name); console.log(`PASS ${name}`); };
const noOverflow = async label => {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: horizontal overflow`);
};
async function theme() {
  await page.addStyleTag({ content: await readFile(path.join(workspace, "packages/product-ui/src/theme.css"), "utf8") });
  await page.addStyleTag({ content: "body { margin: 0; background: var(--app-bg); }" });
}

try {
  await page.goto("https://speech.test/");
  await theme();
  await field("Project name").waitFor();
  await field("Project file path").waitFor({ state: "hidden" });
  await button("Profiles").waitFor({ state: "hidden" });
  await screenshot("empty-desktop");
  for (const width of [1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(`New project at ${width}px`);
    const bounds = await page.getByRole("complementary", { name: "Projects", exact: true }).boundingBox();
    assert.ok(bounds && Math.abs(bounds.x + bounds.width / 2 - width / 2) < 2, `New project is centered at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await field("Project name").fill("Weekend stories");
  await button("Create project").click();
  await field("Title").waitFor();
  await field("Project name").waitFor({ state: "hidden" });
  await button("Edit profiles").waitFor();
  await field("Profile").selectOption("fixture-fish");
  const editor = page.locator('.cm-content[contenteditable="true"]');
  const source = "# A quiet morning\nThe city was still asleep. Somewhere beyond the window, the first birds began to sing.\n\nIt was the perfect moment to begin a new story.";
  await editor.fill(source);
  await button("Save").click();
  await page.waitForFunction(() => window.speechFixture.projects[0]?.source.includes("perfect moment"));
  await field("Phonemes").waitFor({ state: "hidden" });
  await field("Takes").waitFor({ state: "hidden" });
  await button("Archive").waitFor({ state: "hidden" });
  await page.locator("summary[aria-label='Editor options']").click();
  await field("Phonemes").waitFor();
  await field("Editor mode").selectOption("structured");
  await button("Source").click();
  await editor.waitFor();
  await page.locator("summary[aria-label='Editor options']").focus();
  await page.keyboard.press("Escape");
  await field("Phonemes").waitFor({ state: "hidden" });
  check("Project creation, editing, saving, and default disclosure");

  await summary("Generation options").click();
  await field("Takes").fill("2");
  await summary("Generation options").click();
  await button("Choose voice").click();
  await button("Back to script").waitFor();
  await page.getByText("Choose a voice for Narrator", { exact: true }).waitFor();
  await field("Assign to").waitFor({ state: "hidden" });
  await button("Back to script").click();
  assert.equal(await button("Save").isDisabled(), true, "Cancelling the picker leaves the project unchanged");
  assert.equal(await button("Choose voice").evaluate(element => element === document.activeElement), true);
  await button("Choose voice").click();
  await field("Voice ID").first().waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Voices", exact: true }).waitFor();
  await button("Assign voice").first().waitFor();
  await page.getByRole("textbox", { name: "Rights evidence", exact: true }).last().waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Voice-language reviews", exact: true }).waitFor({ state: "hidden" });
  await field("Search voices").fill("A voice that does not exist");
  await button("Search").click();
  await button("Clear filters").click();
  await page.getByRole("heading", { name: "Comparison voice 1", exact: true }).waitFor();
  await button("Favorite voice").first().click();
  await page.getByLabel("Filters", { exact: true }).click();
  await field("Favorites").check();
  await button("Apply filters").click();
  await page.waitForFunction(() => document.querySelectorAll(".tts-voice-list .tts-voice").length === 1);
  await field("Favorites").waitFor({ state: "hidden" });
  await page.getByLabel("Filters", { exact: true }).click();
  await field("Favorites").uncheck();
  await button("Apply filters").click();
  await page.getByRole("heading", { name: "Comparison voice 2", exact: true }).waitFor();
  await page.locator("summary[aria-label='Options for Comparison voice 1']").click();
  await button("Compare voice").first().waitFor();
  await page.keyboard.press("Escape");
  await button("Compare voice").first().waitFor({ state: "hidden" });
  check("Voice search recovery, favorite filtering, and compact options menus");
  await screenshot("voices-desktop");
  await button("Assign voice").first().click();
  await editor.waitFor();
  await button("Save").click();
  await page.waitForFunction(() => window.speechFixture.projects[0]?.cast[0]?.voiceId === "fixture-voice-1");
  await page.locator(".tts-cast-voice").getByText("Comparison voice 1", { exact: true }).waitFor();
  await field("Speaker name").waitFor({ state: "hidden" });
  await summary("Speaker settings").click();
  await field("Speaker name").fill("Storyteller");
  await summary("Speaker settings").click();
  await button("Change voice").click();
  await page.getByText("Choose a voice for Storyteller", { exact: true }).waitFor();
  await button("Back to script").click();
  assert.equal(await button("Change voice").evaluate(element => element === document.activeElement), true);
  await page.waitForFunction(() => window.speechFixture.projects[0]?.cast[0]?.name === "Storyteller");
  await button("Add speaker").click();
  await page.getByText("Choose a voice for new speaker", { exact: true }).waitFor();
  await button("Back to script").click();
  assert.equal(await button("Save").isDisabled(), true, "Cancelling an added speaker leaves the cast unchanged");
  await editor.fill("<|speaker:missing|>This speaker is missing.");
  await page.locator(".cm-lintRange-error").first().waitFor();
  await editor.fill(source);
  await page.locator(".tts-diagnostics").waitFor({ state: "hidden" });
  await page.locator(".cm-lint-marker-error").first().waitFor({ state: "hidden" });
  await page.locator(".cm-lintRange-error").first().waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector(".tts-save-state").textContent === "Saved" && window.speechFixture.projects[0]?.source.includes("perfect moment"));
  await screenshot("script-desktop");
  check("Script errors appear for missing speakers and clear immediately after correction");
  check("Voice picking cancels without changes, assigns on selection, and restores keyboard focus");

  await page.locator("summary[aria-label='More tools']").click();
  await button("Profiles").click();
  await field("Temperature").waitFor({ state: "hidden" });
  await summary("Advanced settings").filter({ visible: true }).click();
  await field("Temperature").fill("0.8");
  await summary("Advanced settings").filter({ visible: true }).click();
  await button("Script").click();
  await page.locator("summary[aria-label='Project actions']").click();
  await button("Duplicate").click();
  await field("Copy name").waitFor();
  await button("Cancel").click();
  assert.equal(await page.locator("summary[aria-label='Project actions']").evaluate(element => element === document.activeElement), true);
  check("Advanced profile controls and project actions remain accessible");

  await page.evaluate(() => window.speechFixture.enableRenderTargets());
  await button("Generate audio").click();
  await page.getByRole("heading", { name: "Audio takes", exact: true }).waitFor();
  await page.waitForFunction(() => window.speechFixture.calls.some(call => call.operation === "render"));
  assert.equal(await page.evaluate(() => window.speechFixture.calls.find(call => call.operation === "render").input.takes), 2);
  await summary("Queue controls").click();
  await button("Pause queue").click();
  await summary("Queue controls").click();
  await button("Resume queue").waitFor();
  await page.keyboard.press("Escape");
  check("Generation options reach the render request and queue controls work");

  await page.evaluate(() => window.speechFixture.prepareProviderResponses());
  await summary("Queue controls").click();
  await button("Refresh jobs").click();
  await page.locator(".tts-take").first().waitFor();
  await page.getByRole("textbox", { name: "Notes", exact: true }).first().waitFor({ state: "hidden" });
  await field("A").waitFor({ state: "hidden" });
  await summary("Review tools").click();
  await field("A").waitFor();
  await summary("Review tools").click();
  await button("Audition").first().click();
  await button("Stop audio").click();
  await screenshot("takes-desktop");
  await button("Add to timeline").first().click();
  await page.getByRole("heading", { name: "Timeline", exact: true }).waitFor();
  check("Take playback and timeline handoff work with review tools collapsed");

  await page.getByRole("navigation", { name: "Studio", exact: true }).getByRole("button", { name: "Export", exact: true }).click();
  await field("Output path").waitFor();
  await field("Sample rate (Hz)").waitFor({ state: "hidden" });
  await field("Export preset").selectOption("podcast");
  assert.equal(await field("Export preset").inputValue(), "podcast");
  assert.equal(await field("Format").inputValue(), "mp3");
  await field("Start (s)").waitFor({ state: "hidden" });
  await summary("Clip settings").first().click();
  await field("Start (s)").waitFor();
  await summary("Clip settings").first().click();
  await summary("Advanced export settings").click();
  assert.equal(await field("Loudness (LUFS)").inputValue(), "-16");
  await button("Save export settings").click();
  await page.waitForFunction(() => window.speechFixture.projects[0]?.exportSettings?.loudnessLufs === -16);
  await summary("Advanced export settings").click();
  await screenshot("export-desktop");
  await field("Format").selectOption("wav");
  assert.equal(await field("Export preset").inputValue(), "");
  await field("Export preset").selectOption("podcast");
  assert.equal(await field("Export preset").inputValue(), "podcast");
  check("Export presets keep their selection, custom changes are reflected, and clip settings stay collapsed");

  await button("Settings").click();
  await field("Concurrent jobs").waitFor({ state: "hidden" });
  await field("Budget limit").fill("5");
  await button("Save settings").click();
  await page.waitForFunction(() => window.speechFixture.calls.some(call => call.operation === "saveSettings" && call.input.settings.budgetLimit === 5));
  await page.getByRole("alert").waitFor({ state: "hidden" });
  await screenshot("settings-desktop");
  await button("Script").click();
  await page.addScriptTag({ content: axe.source });
  const accessibility = await page.evaluate(async () => (await window.axe.run(".tts-studio", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations);
  assert.deepEqual(accessibility.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => node.target) })), []);
  check("Settings save hidden defaults and the script passes WCAG A/AA checks");

  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await screenshot("script-light");
  const lightAccessibility = await page.evaluate(async () => (await window.axe.run(".tts-studio", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })).violations);
  assert.deepEqual(lightAccessibility.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), []);
  check("Light theme uses the app palette and passes WCAG A/AA checks");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  for (const width of [1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width < 400 ? 844 : 900 });
    await noOverflow(`Script at ${width}px`);
    await button("Generate audio").waitFor();
    assert.equal(await button("Settings").locator("svg").isVisible(), true);
    if (width === 390) {
      await page.getByRole("complementary", { name: "Projects", exact: true }).waitFor({ state: "hidden" });
      await button("Projects").click();
      await page.getByRole("complementary", { name: "Projects", exact: true }).waitFor();
      await button("Projects").click();
    }
    if (width < 400) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForFunction(() => {
        const bounds = document.querySelector(".tts-render .tts-primary").getBoundingClientRect();
        return bounds.top >= 0 && bounds.bottom <= innerHeight;
      });
      await summary("Generation options").click();
      await field("Takes").waitFor();
      await noOverflow(`Generation options at ${width}px`);
      await summary("Generation options").click();
      if (width === 390) await screenshot("script-mobile");
    }
    await page.getByRole("navigation", { name: "Studio", exact: true }).getByRole("button", { name: "Export", exact: true }).click();
    await noOverflow(`Export at ${width}px`);
    await button("Voices").click();
    await noOverflow(`Voices at ${width}px`);
    await button("Script").click();
  }
  check("Responsive layouts at 1024, 768, 390, and 320px, mobile project switching, and generation visible without scrolling");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await theme();
  await button("Weekend stories").click();
  assert.equal(await page.evaluate(() => window.speechFixture.projects[0].source), source);
  assert.equal((await editor.locator(".cm-line").allTextContents()).join("\n"), source);
  check("Project content survives reload and reopening");
  await button("Voices").click();
  await page.evaluate(() => window.speechFixture.prepareDeletionVoice());
  await page.getByLabel("Filters", { exact: true }).click();
  await field("My voices").check();
  await button("Apply filters").click();
  const ownedVoice = page.locator(".tts-voice-list .tts-voice").filter({ has: page.getByRole("heading", { name: "Deletion voice", exact: true }) });
  await ownedVoice.locator("summary[aria-label='Options for Deletion voice']").click();
  await ownedVoice.getByRole("button", { name: "Edit voice", exact: true }).click();
  await ownedVoice.getByLabel("Voice name", { exact: true }).fill("Renamed voice");
  await ownedVoice.getByRole("button", { name: "Cancel edit", exact: true }).click();
  await ownedVoice.getByLabel("Voice name", { exact: true }).waitFor({ state: "hidden" });
  await ownedVoice.getByRole("button", { name: "Edit voice", exact: true }).click();
  await ownedVoice.getByLabel("Voice name", { exact: true }).fill("Renamed voice");
  page.once("dialog", dialog => dialog.accept());
  await ownedVoice.getByRole("button", { name: "Save voice", exact: true }).click();
  await page.getByRole("heading", { name: "Renamed voice", exact: true }).waitFor();
  check("Owned voice editing and cancellation work inside the compact options menu");
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ status: "passed", browser: "Edge / Playwright", runtime: "Existing synthetic speech fixture; no native or paid synthesis", checks, errors }, null, 2));
} catch (error) {
  await screenshot("failure");
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ status: "failed", checks, error: String(error), errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
