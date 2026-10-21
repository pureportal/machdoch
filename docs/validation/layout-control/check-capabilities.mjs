import { build } from "vite";
import { chromium } from "playwright-core";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const storage = process.argv[2];
if (!storage) throw new Error("Provide the configured storage root");
const directory = path.resolve(storage, "layout-control/evidence");
await mkdir(directory, { recursive: true });
const compiled = path.resolve(storage, "layout-control/compiler");
await build({ configFile: false, logLevel: "error", build: { outDir: compiled, emptyOutDir: false,
  lib: { entry: path.resolve("docs/validation/layout-control/workflow-api.ts"), formats: ["es"], fileName: () => "workflow-api.mjs" } } });
const { resolveMediaImageLayoutCapabilities } = await import(pathToFileURL(path.join(compiled, "workflow-api.mjs")));
const layout = JSON.parse(await readFile("docs/artifacts/layout-control-2026-10-18/scene.json", "utf8"));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9239");
try {
  const page = browser.contexts()[0].pages().find(page => page.url().includes("tauri.localhost"));
  const catalog = await page.evaluate(() => window.__TAURI__.core.invoke("media_get_model_catalog", { configuredProviderIds: [], includeRuntimeReadiness: false }));
  const profiles = catalog.models.filter(model => model.providerId === "local-diffusers" && model.target === "local"
    && model.architecture !== "ideogram-4" && model.capabilities.some(capability => ["text-to-image", "image-to-image"].includes(capability)));
  const coverage = profiles.map(model => ({ id: model.id, architecture: model.architecture, installed: model.installed,
    runtimeReadiness: model.runtimeReadiness, methods: resolveMediaImageLayoutCapabilities(model, catalog.models, layout) }));
  assert.ok(coverage.length > 25);
  for (const model of coverage) {
    assert.equal(model.methods.length, 4);
    for (const method of model.methods) {
      assert.equal(method.modelId, model.id);
      if (!method.integrated || !model.installed) assert.ok(method.error);
      if (method.inference === "verified") assert.ok(method.verificationAssetId && method.revision);
    }
  }
  for (const architecture of ["moss-image-base", "moss-image-sft", "flux-3-image-klein"]) {
    const native = coverage.find(model => model.architecture === architecture)?.methods.find(method => method.method === "native");
    assert.ok(native?.integrated && native.published);
  }
  await writeFile(path.join(directory, "capability-coverage.json"), JSON.stringify({ checkedAt: new Date().toISOString(), scene: layout, profiles: coverage }, null, 2));
  console.log(JSON.stringify({ profiles: coverage.length, installed: coverage.filter(model => model.installed).length,
    verified: coverage.flatMap(model => model.methods.filter(method => method.inference === "verified").map(method => ({ modelId: model.id, method: method.method }))) }));
} finally {
  await browser.close();
}
