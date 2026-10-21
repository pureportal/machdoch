import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import {
  compileMediaFlow,
  createMediaFlowLayout,
} from "../../../packages/media-studio/src/core/media/compiler.ts";
import { createDefaultMediaNodeConfig } from "../../../packages/media-studio/src/core/media/node-registry.ts";
import { createMediaUpscaleFlow } from "../../../packages/media-studio/src/core/media/upscale.ts";
import { extendMediaCatalogWithWorkspaceDiscovery } from "../../../packages/media-studio/src/core/media/discovered-model-profiles.ts";

const directory = path.resolve("docs/validation/upscalers");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9237");
const page = browser.contexts()[0].pages()[0];
await page.waitForFunction(() => Boolean(window.__TAURI__?.core));
const invoke = (command, args) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI__.core.invoke(command, args),
    { command, args },
  );
const runtime = await invoke("media_initialize_runtime");
const baseCatalog = await invoke("media_get_model_catalog", {
  configuredProviderIds: [],
  includeRuntimeReadiness: true,
});
const discovery = await invoke("media_discover_workspace_models", {
  workspaceRoot: "D:/Models/machdoch/verification/upscale-chain-workspace",
});
const catalog = extendMediaCatalogWithWorkspaceDiscovery({
  catalog: baseCatalog,
  discovery,
  runtime: runtime.localDiffusers,
});
await writeFile(
  path.join(directory, "native-catalog.json"),
  JSON.stringify(catalog, null, 2),
);
const imageModel = catalog.models.find(
  (model) => model.installed && model.displayName.startsWith("SD-Turbo"),
);
const videoModel = catalog.models.find(
  (model) => model.id === "local:ltx-video-0.9.8-2b-distilled-fp8",
);
assert.ok(imageModel, "The installed SD-Turbo fixture model is missing");
assert.ok(videoModel, "The installed LTX-Video 2B fixture model is missing");
const videoOnly = process.argv.includes("--video-only");
const runs = videoOnly
  ? JSON.parse(
      await readFile(path.join(directory, "generation-chains.json"), "utf8"),
    )
  : [];
for (const [kind, model] of videoOnly
  ? [["video", videoModel]]
  : [
      ["image", imageModel],
      ["video", videoModel],
    ]) {
  const createdAt = new Date().toISOString();
  const flow = createMediaUpscaleFlow({
    id: `upscale-chain-${kind}-${crypto.randomUUID()}`,
    createdAt,
    asset: { id: "asset:unused", kind },
    modelPath:
      "D:/Models/machdoch/models/workflow/upscale-span/4x-spanx4_ch48.safetensors",
    scale: "2",
    tileSize: 128,
  });
  const generation = flow.nodes[0];
  generation.type =
    kind === "image" ? "task.generate-image" : "task.generate-video";
  generation.layer = "task";
  generation.label = kind === "image" ? "Generate image" : "Generate video";
  generation.config = {
    ...createDefaultMediaNodeConfig(generation.type),
    providerPolicy: "local",
    modelId: model.id,
    transparentBackground: false,
    modelPolicy: "fast",
    numInferenceSteps: kind === "image" ? 2 : 8,
    guidanceScale: kind === "image" ? 0 : 1,
    aspectRatio: "1:1",
    ...(kind === "video"
      ? { numFrames: 17, fps: 8, resolution: "preview-512", loopMode: "none" }
      : { outputCount: 1 }),
  };
  flow.nodes.unshift({
    id: "prompt",
    type: "source.prompt",
    version: 1,
    layer: "source",
    label: "Prompt",
    config: {
      prompt:
        kind === "video"
          ? "A red ball rolls from left to right on a white tabletop, locked camera, clear motion"
          : "A red ball on a white tabletop, studio photograph",
    },
  });
  flow.edges.unshift({
    id: "prompt-generation",
    fromNodeId: "prompt",
    fromPortId: "prompt",
    toNodeId: "source",
    toPortId: "prompt",
  });
  if (kind === "video") {
    const image = runs.find((run) => run.kind === "image").input;
    flow.nodes.unshift({
      id: "frame",
      type: "source.image",
      version: 1,
      layer: "source",
      label: "Opening frame",
      config: {
        ...createDefaultMediaNodeConfig("source.image"),
        assetId: image.id,
      },
    });
    flow.edges.unshift({
      id: "frame-generation",
      fromNodeId: "frame",
      fromPortId: "image",
      toNodeId: "source",
      toPortId: "first-frame",
    });
  }
  const plan = compileMediaFlow({
    flow,
    models: catalog.models,
    addons: catalog.addons,
    compiledAt: createdAt,
  });
  assert.equal(plan.status, "ready", JSON.stringify(plan.diagnostics));
  const saved = await invoke("media_save_flow_revision", {
    request: {
      schemaVersion: 1,
      idempotencyKey: crypto.randomUUID(),
      expectedHeadRevisionId: null,
      changeSummary: "Verify generation followed by upscaling",
      flow,
      layout: createMediaFlowLayout(flow),
    },
  });
  assert.equal(saved.revision.executionDigest, plan.flowFingerprint);
  const runId = crypto.randomUUID();
  const request = {
    schemaVersion: 1,
    runId,
    flowId: flow.id,
    flowRevisionId: saved.revision.revisionId,
    planId: plan.id,
    workspaceRoot: "D:/Models/machdoch/verification/upscale-chain-workspace",
    modelBindings: Object.fromEntries(
      plan.runtimeBindings.map((binding) => [binding.nodeId, binding.model.id]),
    ),
    planSnapshot: {
      schemaVersion: 1,
      planId: plan.id,
      flowId: flow.id,
      flowFingerprint: plan.flowFingerprint,
      compiledAt: plan.compiledAt,
      nodes: flow.nodes.map(({ id, type, label, layer }) => ({
        id,
        type,
        label,
        layer,
      })),
      steps: plan.steps,
    },
  };
  console.log(
    JSON.stringify({
      kind,
      model: model.displayName,
      runId,
      state: "submitted",
    }),
  );
  const started = Date.now();
  const execution = invoke("media_execute_workflow", { request });
  const timer = setInterval(
    () =>
      console.log(
        JSON.stringify({
          kind,
          runId,
          elapsedSeconds: Math.round((Date.now() - started) / 1000),
        }),
      ),
    20000,
  );
  let detail;
  try {
    detail = await execution;
  } finally {
    clearInterval(timer);
  }
  await writeFile(
    path.join(directory, `generation-chain-${kind}-run.json`),
    JSON.stringify(detail, null, 2),
  );
  assert.equal(
    detail.status,
    "completed",
    JSON.stringify(detail.failure ?? detail.error),
  );
  const generated = detail.assets.find(
    (asset) => asset.operation?.sourceNodeId === "source",
  );
  const output = detail.assets.find(
    (asset) => asset.operation?.details.finalOutput === true,
  );
  assert.ok(generated);
  assert.ok(output);
  assert.equal(output.width, generated.width * 2);
  assert.equal(output.height, generated.height * 2);
  const extension = kind === "image" ? "png" : "webm";
  for (const [name, asset] of [
    ["source", generated],
    ["output", output],
  ]) {
    const destinationPath = path.join(
      directory,
      `generation-chain-${kind}-${runId}-${name}.${extension}`,
    );
    await invoke("media_export_asset", {
      request: {
        assetId: asset.id,
        destinationPath,
        mode: "verified-original",
      },
    });
  }
  runs.push({
    kind,
    runId,
    model: model.displayName,
    seconds: (Date.now() - started) / 1000,
    input: generated,
    output,
  });
  await writeFile(
    path.join(directory, "generation-chains.json"),
    JSON.stringify(runs, null, 2),
  );
  console.log(
    JSON.stringify({
      kind,
      runId,
      state: detail.status,
      width: output.width,
      height: output.height,
    }),
  );
}
await browser.close();
