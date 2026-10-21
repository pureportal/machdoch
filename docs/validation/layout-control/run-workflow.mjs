import { build } from "vite";
import { chromium } from "playwright-core";
import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

const [storage, name, modelId, method, scenePath, steps, mode] = process.argv.slice(2);
const resume = mode === "resume";
const storeIndex = process.argv.indexOf("--store");
const mediaRoot = storeIndex < 0 ? path.resolve(storage, "layout-control/desktop-store") : path.resolve(process.argv[storeIndex + 1]);
if (!steps) throw new Error("Provide storage, run name, model ID, method, scene file and steps");
const output = path.resolve(storage, "layout-control/runs", name);
await mkdir(output, { recursive: resume });
const compiled = path.resolve(storage, "layout-control/compiler");
await build({ configFile: false, logLevel: "error", build: { outDir: compiled, emptyOutDir: false,
  lib: { entry: path.resolve("docs/validation/layout-control/workflow-api.ts"), formats: ["es"], fileName: () => "workflow-api.mjs" } } });
const api = await import(pathToFileURL(path.join(compiled, "workflow-api.mjs")));
const browser = await chromium.connectOverCDP("http://127.0.0.1:9239");
try {
  const context = browser.contexts()[0];
  const page = context.pages().find(page => page.url().includes("tauri.localhost")) ?? context.pages()[0] ?? await context.waitForEvent("page");
  await page.waitForURL(/tauri.localhost/);
  await page.waitForFunction(() => Boolean(window.__TAURI__?.core?.invoke));
  const invoke = (command, args) => page.evaluate(async ({ command, args }) => {
    try { return await window.__TAURI__.core.invoke(command, args); }
    catch (error) { throw new Error(JSON.stringify(error)); }
  }, { command, args });
  let request;
  if (resume) {
    request = JSON.parse(await readFile(path.join(output, "request.json"), "utf8")).request;
  } else {
    const imageLayout = JSON.parse(await readFile(scenePath, "utf8"));
    const catalog = await invoke("media_get_model_catalog", { configuredProviderIds: [], includeRuntimeReadiness: false });
    const flow = api.createImageRecipeFlow({ id: `layout-${name}`, createdAt: new Date().toISOString(), settings: {
      prompt: imageLayout.caption, imageLayout, layoutMethod: method, modelId, modelPolicy: "quality", providerPolicy: "local",
      outputCount: 1, outputFormat: "png", aspectRatio: "1:1", transparentBackground: false, qualityGateEnabled: false,
      referenceImages: [], baseImageAssetId: null, poseImageAssetId: null, poseStrength: 1, modelAddons: [], seed: 713,
      sampling: { numInferenceSteps: Number(steps) }, memoryProfile: "memory-saver",
    } });
    flow.name = name;
    if (["reference", "masked"].includes(method)) {
      const task = flow.nodes.find(node => node.id === "generate");
      task.type = "task.edit-image";
      task.label = "Edit image";
      task.config = { ...api.createDefaultMediaNodeConfig("task.edit-image"), ...task.config, editStrength: 0.35 };
      for (const key of Object.keys(task.config)) if (key.startsWith("svg") || key === "transparentBackground") delete task.config[key];
    }
    const layout = { schemaVersion: 1, flowId: flow.id, nodes: flow.nodes.map((node, index) => ({ nodeId: node.id, x: index * 300, y: 120 })), groups: [], comments: [] };
    const saved = await invoke("media_save_flow_revision", { request: { schemaVersion: 1, idempotencyKey: name, expectedHeadRevisionId: null, changeSummary: "Layout inference verification", flow, layout } });
    assert.deepEqual(saved.revision.flow.nodes.find(node => node.type === "source.image-layout").config.imageLayout, imageLayout);
    assert.equal(saved.revision.flow.nodes.find(node => node.id === "generate").config.numInferenceSteps, Number(steps));
    const plan = api.compileMediaFlow({ flow: saved.revision.flow, models: catalog.models, addons: catalog.addons, compiledAt: new Date().toISOString() });
    assert.equal(plan.status, "ready", JSON.stringify(plan.diagnostics));
    assert.equal(plan.flowFingerprint, saved.revision.executionDigest);
    request = { schemaVersion: 1, runId: `layout-${name}`, flowId: flow.id, flowRevisionId: saved.revision.revisionId, planId: plan.id,
      planSnapshot: { schemaVersion: 1, planId: plan.id, flowId: flow.id, flowFingerprint: plan.flowFingerprint, compiledAt: plan.compiledAt,
        nodes: flow.nodes.map(({ id, type, label, layer }) => ({ id, type, label, layer })), steps: plan.steps }, workspaceRoot: process.cwd(),
      modelBindings: Object.fromEntries(plan.runtimeBindings.map(binding => [binding.nodeId, binding.model.id])) };
    await writeFile(path.join(output, "request.json"), JSON.stringify({ flow: saved.revision.flow, request, imageLayoutDigest: api.mediaImageLayoutDigest(imageLayout) }, null, 2));
  }
  console.log(JSON.stringify({ runId: request.runId, method, modelId, steps: Number(steps) }));
  let executionError;
  if (!resume) void invoke("media_execute_workflow", { request }).catch(error => { executionError = error; });
  const deadline = Date.now() + 4 * 60 * 60 * 1000;
  let result;
  const progress = [];
  while (Date.now() < deadline) {
    try {
      const runs = await invoke("media_list_runs", { limit: 100 });
      const run = runs.find(run => run.id === request.runId);
      if (run && progress.at(-1)?.stage !== run.currentStep) {
        const event = { utc: new Date().toISOString(), stage: run.currentStep, progress: run.progress, status: run.status };
        progress.push(event);
        await writeFile(path.join(output, "progress.json"), JSON.stringify(progress, null, 2));
        console.log(JSON.stringify(event));
      }
      if (run && ["completed", "failed", "canceled"].includes(run.status)) {
        result = await invoke("media_get_run_detail", { runId: run.id });
        break;
      }
      if (!run && executionError) throw executionError;
    } catch (error) {
      if (!String(error).includes("Execution context was destroyed")) throw error;
    }
    await setTimeout(5000);
  }
  assert.ok(result, "Workflow did not finish before the deadline");
  const elapsedSeconds = (Date.parse(result.updatedAt) - Date.parse(result.createdAt)) / 1000;
  await writeFile(path.join(output, "response.json"), JSON.stringify({ elapsedSeconds, mediaRoot, result }, null, 2));
  for (const asset of result.assets ?? []) {
    if (asset.mimeType !== "image/png") continue;
    const source = path.resolve(mediaRoot, "blobs/sha256", asset.digest.slice(0, 2), asset.digest.slice(2, 4), asset.digest);
    await copyFile(source, path.join(output, `output-${asset.outputIndex}.png`));
  }
  console.log(JSON.stringify({ elapsedSeconds, runId: result.id, status: result.status, assets: result.assets?.map(asset => ({ id: asset.id, width: asset.width, height: asset.height, digest: asset.digest })) }));
  assert.equal(result.status, "completed", result.error?.slice(0, 2000) ?? "Workflow did not complete");
} catch (error) {
  await writeFile(path.join(output, "failure.txt"), String(error.stack));
  throw error;
} finally { await browser.close(); }
