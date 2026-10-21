import { build } from "vite";
import { chromium } from "playwright-core";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import path from "node:path";
import assert from "node:assert/strict";

const [storage, name, mode] = process.argv.slice(2);
const resume = mode === "resume";
const directory = path.resolve(storage, "layout-control/runs", name);
await mkdir(directory, { recursive: resume });
const compiled = path.resolve(storage, "layout-control/compiler");
await build({ configFile: false, logLevel: "error", build: { outDir: compiled, emptyOutDir: false,
  lib: { entry: path.resolve("docs/validation/layout-control/workflow-api.ts"), formats: ["es"], fileName: () => "workflow-api.mjs" } } });
const api = await import(pathToFileURL(path.join(compiled, "workflow-api.mjs")));
const imageLayout = JSON.parse(await readFile("docs/artifacts/layout-control-2026-10-18/dense-infographic.json", "utf8"));
imageLayout.elements = imageLayout.elements.filter(element => element.kind !== "object");
delete imageLayout.relations;
const literal = imageLayout.elements.find(element => element.kind === "text");
literal.text = "  {{unchanged}}  \nExact text";
const digest = api.mediaImageLayoutDigest(imageLayout);
function verifyRetry(result) {
  assert.equal(result.status, "failed");
  assert.match(result.error, /after 2 attempts/);
  const generated = result.assets.filter(asset => asset.operation?.details?.provenance?.imageLayout);
  assert.equal(generated.length, 2);
  for (const asset of generated) {
    const evidence = asset.operation.details.provenance.imageLayout;
    assert.deepEqual(evidence.layout, imageLayout);
    assert.equal(evidence.digest, digest);
    assert.equal(asset.operation.details.prompt, imageLayout.caption);
  }
  assert.deepEqual(generated.map(asset => asset.operation.details.seed).sort((a, b) => a - b), [713, 714]);
  assert.equal(result.nodeExecutions.find(node => node.nodeId === "generate").attempt, 2);
}
const browser = await chromium.connectOverCDP("http://127.0.0.1:9239");
try {
  const page = browser.contexts()[0].pages().find(page => page.url().includes("tauri.localhost"));
  const invoke = (command, args) => page.evaluate(({ command, args }) => window.__TAURI__.core.invoke(command, args), { command, args });
  const catalog = await invoke("media_get_model_catalog", { configuredProviderIds: [], includeRuntimeReadiness: false });
  for (const scenario of ["retry", "cancel"]) {
    if (resume && scenario === "retry") {
      verifyRetry(JSON.parse(await readFile(path.join(directory, "retry-response.json"), "utf8")).result);
      console.log(JSON.stringify({ scenario, verified: true, source: "saved-production-response" }));
      continue;
    }
    const runId = `${name}-${scenario}`;
    const flow = api.createImageRecipeFlow({ id: runId, createdAt: new Date().toISOString(), settings: {
      prompt: imageLayout.caption, imageLayout, layoutMethod: "composition", modelId: "local:moss-image-sft", modelPolicy: "quality", providerPolicy: "local",
      outputCount: 1, outputFormat: "png", aspectRatio: "1:1", transparentBackground: false, qualityGateEnabled: scenario === "retry",
      referenceImages: [], baseImageAssetId: null, poseImageAssetId: null, poseStrength: 1, modelAddons: [], seed: 713, memoryProfile: "memory-saver",
    } });
    if (scenario === "retry") {
      Object.assign(flow.nodes.find(node => node.id === "quality-gate").config, { minWidth: 2048, minHeight: 1, maxClipping: 1, onUnknown: "pass", onFailure: "repeat" });
      flow.nodes.push({ id: "repeat", type: "control.repeat", version: 1, layer: "control", label: "Repeat", config: {
        startNodeId: "generate", maxIterations: 2, seedStep: 1, feedback: true, stopOnRepeatedImage: false, inputMode: "original",
      } });
    }
    const layout = { schemaVersion: 1, flowId: flow.id, nodes: flow.nodes.map((node, index) => ({ nodeId: node.id, x: index * 300, y: 120 })), groups: [], comments: [] };
    const saved = await invoke("media_save_flow_revision", { request: { schemaVersion: 1, idempotencyKey: runId, expectedHeadRevisionId: null, changeSummary: "Layout lifecycle verification", flow, layout } });
    const plan = api.compileMediaFlow({ flow: saved.revision.flow, models: catalog.models, addons: catalog.addons, compiledAt: new Date().toISOString() });
    assert.equal(plan.status, "ready", JSON.stringify(plan.diagnostics));
    const request = { schemaVersion: 1, runId, flowId: flow.id, flowRevisionId: saved.revision.revisionId, planId: plan.id,
      planSnapshot: { schemaVersion: 1, planId: plan.id, flowId: flow.id, flowFingerprint: plan.flowFingerprint, compiledAt: plan.compiledAt,
        nodes: flow.nodes.map(({ id, type, label, layer }) => ({ id, type, label, layer })), steps: plan.steps }, workspaceRoot: process.cwd(),
      modelBindings: Object.fromEntries(plan.runtimeBindings.map(binding => [binding.nodeId, binding.model.id])) };
    await writeFile(path.join(directory, `${scenario}-request.json`), JSON.stringify({ flow, request }, null, 2));
    const pending = invoke("media_execute_workflow", { request });
    let canceledAt;
    if (scenario === "cancel") {
      const deadline = Date.now() + 120000;
      while (true) {
        const runs = await invoke("media_list_runs", { limit: 100 });
        if (runs.some(run => run.id === runId)) break;
        assert.ok(Date.now() < deadline, "Run did not start");
        await setTimeout(250);
      }
      canceledAt = performance.now();
      await invoke("media_cancel_run", { runId });
    }
    const result = await pending;
    const cancellationSeconds = canceledAt === undefined ? null : (performance.now() - canceledAt) / 1000;
    await writeFile(path.join(directory, `${scenario}-response.json`), JSON.stringify({ result, cancellationSeconds }, null, 2));
    if (scenario === "retry") verifyRetry(result);
    else assert.equal(result.status, "canceled");
    console.log(JSON.stringify({ scenario, status: result.status, cancellationSeconds }));
  }
} finally { await browser.close(); }
