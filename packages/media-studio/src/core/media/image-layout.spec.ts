import { describe, expect, it } from "vitest";
import sceneFixture from "../../../../../docs/artifacts/layout-control-2026-10-18/scene.json";
import { compileFlux3ImageLayout, compileMossImageLayout } from "./image-layout-native.js";
import { mediaImageLayoutDigest, mediaImageLayoutError, parseMediaImageLayout, resizeMediaImageLayout, type MediaImageLayout } from "./image-layout.js";
import { resolveMediaFlowVariables } from "./variables.js";
import { compileMediaFlow, compileMediaImageOutputBranches, createImageRecipeFlow } from "./compiler.js";
import { isConnectedMediaFlow } from "./workflow-compiler.js";
import { createDefaultMediaNodeConfig, validateMediaFlowDocument } from "./node-registry.js";
import { createMediaModelCatalog } from "./catalog.js";
import { resolveMediaImageLayoutCapabilities } from "./image-layout-capabilities.js";
import type { MediaFlowNode } from "./contracts.js";

const scene = () => parseMediaImageLayout(structuredClone(sceneFixture));

describe("image layout contract", () => {
  it("rejects lossy and pixel-changing masked-layout output while allowing metadata removal", () => {
    const layout = scene();
    layout.elements = layout.elements.map(element => ({ ...element, assetId: `asset:${element.id}`, cutout: false }));
    const model = { ...createMediaModelCatalog({ isOpenAiConfigured: false }).find(entry => entry.architecture === "moss-image-base")!,
      architecture: "stable-diffusion-xl", installed: true, configured: true,
      capabilities: ["text-to-image" as const, "image-to-image" as const, "masked-image-edit" as const] };
    const flow = createImageRecipeFlow({ id: "masked-output", createdAt: "2026-10-21T00:00:00Z", settings: {
      prompt: "", imageLayout: layout, layoutMethod: "masked", modelId: model.id, modelPolicy: "quality", providerPolicy: "local",
      outputCount: 1, outputFormat: "png", aspectRatio: "1:1", transparentBackground: false, qualityGateEnabled: false,
      referenceImages: [], baseImageAssetId: null, poseImageAssetId: null, poseStrength: 1, modelAddons: [],
    } });
    const task = flow.nodes.find(node => node.id === "generate")!;
    const output = flow.nodes.find(node => node.type === "output.asset")!;
    expect(compileMediaImageOutputBranches(flow)[0]!.format).toBe("png");
    task.config.outputFormat = "jpeg";
    output.config.format = "jpeg";
    expect(() => compileMediaImageOutputBranches(flow)).toThrow(/Masked layouts require PNG/);
    expect(compileMediaFlow({ flow, models: [model], compiledAt: "2026-10-21T00:00:00Z" }).diagnostics.some(diagnostic => diagnostic.message === "Masked layouts require PNG output.")).toBe(true);
    task.config.outputFormat = "png";
    output.config.format = "webp";
    expect(() => compileMediaImageOutputBranches(flow)).toThrow(/Masked layouts require PNG/);
    output.config.format = "png";
    const edge = flow.edges.find(entry => entry.toNodeId === output.id && entry.toPortId === "image")!;
    const operation: MediaFlowNode = { id: "post", type: "operation.resize", layer: "operation", version: 1, label: "Resize", config: createDefaultMediaNodeConfig("operation.resize") };
    flow.nodes.push(operation);
    flow.edges.push({ id: "post-input", fromNodeId: edge.fromNodeId, fromPortId: edge.fromPortId, toNodeId: operation.id, toPortId: "image" });
    edge.fromNodeId = operation.id;
    expect(() => compileMediaImageOutputBranches(flow)).toThrow(/pixel-changing operations/);
    operation.type = "operation.metadata-strip";
    operation.config = createDefaultMediaNodeConfig("operation.metadata-strip");
    expect(compileMediaImageOutputBranches(flow)[0]!.operations.map(entry => entry.kind)).toEqual(["metadata-strip"]);
  });

  it("routes layout-guided editing without a redundant base image and selects editing capabilities", () => {
    const layout = scene();
    layout.elements = layout.elements.map(element => ({ ...element, assetId: `asset:${element.id}`, cutout: false }));
    const model = { ...createMediaModelCatalog({ isOpenAiConfigured: false }).find(entry => entry.architecture === "moss-image-base")!,
      id: "local:layout-edit-test", architecture: "stable-diffusion-xl", displayName: "Layout editing fixture",
      installed: true, configured: true, capabilities: ["image-to-image" as const] };
    const flow = createImageRecipeFlow({ id: "layout-edit", createdAt: "2026-10-21T00:00:00Z", settings: {
      prompt: "", imageLayout: layout, layoutMethod: "reference", modelId: model.id, modelPolicy: "quality", providerPolicy: "local",
      outputCount: 1, outputFormat: "png", aspectRatio: "1:1", transparentBackground: false, qualityGateEnabled: false,
      referenceImages: [], baseImageAssetId: null, poseImageAssetId: null, poseStrength: 1, modelAddons: [],
    } });
    const task = flow.nodes.find(node => node.id === "generate")!;
    task.type = "task.edit-image";
    task.config = { ...createDefaultMediaNodeConfig("task.edit-image"), ...task.config, editStrength: 0.35 };
    for (const key of Object.keys(task.config)) if (key.startsWith("svg") || key === "transparentBackground") delete task.config[key];
    expect(validateMediaFlowDocument(flow)).toEqual([]);
    const plan = compileMediaFlow({ flow, models: [model], compiledAt: "2026-10-21T00:00:00Z" });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
    expect(plan.runtimeBindings.map(binding => binding.model.id)).toContain(model.id);
    flow.nodes.push({ id: "base", type: "source.image", layer: "source", version: 1, label: "Base", config: {
      ...createDefaultMediaNodeConfig("source.image"), assetId: "asset:base",
    } });
    flow.edges.push({ id: "base-to-edit", fromNodeId: "base", fromPortId: "image", toNodeId: task.id, toPortId: "image" });
    expect(compileMediaFlow({ flow, models: [model], compiledAt: "2026-10-21T00:00:00Z" }).diagnostics.some(diagnostic => diagnostic.message.includes("Use layer assets"))).toBe(true);
  });

  it("resolves every local image profile without promoting registrations to verified inference", () => {
    const catalog = createMediaModelCatalog({ isOpenAiConfigured: true });
    const profiles = catalog.filter((model) => model.providerId === "local-diffusers" && model.capabilities.includes("text-to-image") && model.architecture !== "ideogram-4");
    expect(profiles.length).toBeGreaterThanOrEqual(30);
    expect(profiles.map((model) => model.architecture)).toEqual(expect.arrayContaining(["moss-image-base", "moss-image-sft", "flux-3-image-klein"]));
    for (const model of profiles) {
      const methods = resolveMediaImageLayoutCapabilities(model, catalog, scene());
      expect(methods.map((method) => method.method)).toEqual(["native", "composition", "reference", "masked"]);
      expect(methods.find((method) => method.method === "composition")!.integrated).toBe(true);
      expect(methods.every((method) => method.inference === "unverified")).toBe(true);
      expect(methods.find((method) => method.method === "native")!.integrated).toBe(["moss-image-base", "moss-image-sft", "flux-3-image-klein"].includes(model.architecture!));
    }
    for (const model of catalog.filter((model) => model.target !== "local" || model.architecture === "ideogram-4")) {
      expect(resolveMediaImageLayoutCapabilities(model, catalog).every((method) => !method.integrated)).toBe(true);
    }
  });

  it("requires installed prerequisites and receipts for the exact model revision, method and worker", () => {
    const catalog = createMediaModelCatalog({ isOpenAiConfigured: false });
    const model = { ...catalog.find((entry) => entry.architecture === "moss-image-base")!, installed: true, configured: true, installedRevision: "revision-a" };
    const receipt = { method: "native" as const, revision: "revision-a", workerVersion: "media-diffusers-worker/1.113.0", assetId: "asset:verified", runId: "run:verified", deviceLabel: "RX 9070", createdAt: "2026-10-21" };
    const methods = resolveMediaImageLayoutCapabilities({ ...model, layoutVerifications: [receipt] }, catalog, scene());
    expect(methods[0]!.inference).toBe("verified");
    expect(methods[1]!.inference).toBe("unverified");
    expect(methods[1]!.error).toMatch(/BiRefNet/);
    expect(resolveMediaImageLayoutCapabilities({ ...model, layoutVerifications: [{ ...receipt, revision: "revision-b" }] }, catalog)[0]!.inference).toBe("unverified");
    expect(resolveMediaImageLayoutCapabilities({ ...model, runtimeReadiness: "failed", runtimeReadinessDiagnostic: "Missing component" }, catalog)[0]!.error).toBe("Missing component");
    const assetsOnly = scene();
    assetsOnly.elements = assetsOnly.elements.map((element) => ({ ...element, assetId: `asset:${element.id}` }));
    expect(resolveMediaImageLayoutCapabilities(model, catalog, assetsOnly)[1]!.error).toMatch(/BiRefNet/);
    assetsOnly.elements = assetsOnly.elements.map((element) => ({ ...element, cutout: false }));
    expect(resolveMediaImageLayoutCapabilities(model, catalog, assetsOnly)[1]!.error).toBeNull();
    expect(resolveMediaImageLayoutCapabilities(model, catalog, assetsOnly)[0]!.error).toMatch(/composition/);
  });

  it("preserves overlaps and rejects invalid coordinates, duplicate IDs and unknown fields", () => {
    const layout = scene();
    expect(mediaImageLayoutError(layout)).toBeNull();
    for (const box of [[0, 0, 0, 1], [-1, 0, 10, 10], [0, 0, 1025, 10], [0, 0, NaN, 10], [0, 0, 1.5, 10]]) {
      expect(mediaImageLayoutError({ ...layout, elements: [{ ...layout.elements[0], box }] })).not.toBeNull();
    }
    expect(mediaImageLayoutError({ ...layout, elements: [layout.elements[0], layout.elements[0]] })).not.toBeNull();
    expect(mediaImageLayoutError({ ...layout, x: 1 })).not.toBeNull();
  });

  it("scales boxes explicitly, anchors without changing them and rejects clipped or collapsed geometry", () => {
    const layout = scene();
    expect(resizeMediaImageLayout(layout, 512, 384, "scale").elements[1]!.box).toEqual([80, 80, 200, 280]);
    expect(resizeMediaImageLayout(layout, 2048, 1024, "anchor").elements).toEqual(layout.elements);
    expect(() => resizeMediaImageLayout(layout, 512, 384, "anchor")).toThrow(/inside/);
    expect(() => resizeMediaImageLayout(layout, 1, 1, "scale")).toThrow(/positive/);
  });

  it("compiles reviewed MOSS yxyx coordinates and serialization order without inserting unsupported IDs", () => {
    const result = compileMossImageLayout(scene());
    const prompt = JSON.parse(result.prompt);
    expect(Object.keys(prompt)).toEqual(["summary", "items", "bbox_coord_space", "bbox_format"]);
    expect(result.elementIds).toEqual(["table_1", "robot_1", "plant_1", "cube_1"]);
    expect(prompt.items[1]).toEqual({ label: "object", caption: scene().elements[1]!.description, bbox: [-224, -352, 176, -112] });
    expect(Object.keys(prompt.items[1])).toEqual(["label", "caption", "bbox"]);
    expect(prompt.bbox_coord_space).toBe("abs_centralized");
    expect(prompt.bbox_format).toBe("yxyx");
  });

  it("compiles local FLUX normalized yxyx and rejects boxes lost to model quantization", () => {
    const boxes = compileFlux3ImageLayout(scene());
    expect(boxes[1]).toMatchObject({ id: "robot_1", bbox: [160 / 768, 160 / 1024, 560 / 768, 400 / 1024] });
    const layout = scene();
    layout.canvas = { width: 8192, height: 8192 };
    layout.elements[0]!.box = [0, 0, 1, 1];
    expect(() => compileFlux3ImageLayout(layout)).toThrow(/collapses/);
  });

  it("snapshots without aliasing and retains literal text through JSON and variable resolution", () => {
    const layout: MediaImageLayout = scene();
    layout.elements.push({ id: "title", kind: "text", description: "Title", box: [0, 0, 1024, 100], zIndex: 4,
      text: "  {{title}}\nGrüße — مرحبا", font: "Arial", fontSize: 32, color: "#112233", align: "left", direction: "ltr" });
    const snapshot = parseMediaImageLayout(layout);
    expect(compileMossImageLayout(snapshot).prompt).toContain(JSON.stringify(layout.elements[4]!.kind === "text" ? layout.elements[4].text : ""));
    const digest = mediaImageLayoutDigest(snapshot);
    layout.elements[0]!.box[0] = 0;
    expect(mediaImageLayoutDigest(snapshot)).toBe(digest);
    expect(mediaImageLayoutDigest(layout)).not.toBe(digest);
    const flow = createImageRecipeFlow({ id: "test", createdAt: "2026-10-21T00:00:00Z", settings: {
      prompt: "Scene", modelId: null, modelPolicy: "balanced", providerPolicy: "local", outputCount: 1,
      outputFormat: "png", aspectRatio: "1:1", transparentBackground: false, qualityGateEnabled: false,
      referenceImages: [], baseImageAssetId: null, poseImageAssetId: null, poseStrength: 1, modelAddons: [],
    } });
    flow.nodes.push({ id: "layout", type: "source.image-layout", version: 1, layer: "source", label: "Layout", config: { ...createDefaultMediaNodeConfig("source.image-layout"), imageLayout: snapshot } });
    flow.edges.push({ id: "layout-edge", fromNodeId: "layout", fromPortId: "layout", toNodeId: "generate", toPortId: "layout" });
    flow.nodes.find((node) => node.id === "generate")!.config.layoutMethod = "composition";
    const restored = JSON.parse(JSON.stringify(flow));
    const resolved = resolveMediaFlowVariables(restored);
    expect(resolved.issues).toEqual([]);
    expect(resolved.flow.nodes.find((node) => node.id === "layout")!.config.imageLayout).toEqual(snapshot);
    expect(validateMediaFlowDocument(restored)).toEqual([]);
    expect(isConnectedMediaFlow(restored)).toBe(true);
    const model = { ...createMediaModelCatalog({ isOpenAiConfigured: false }).find((entry) => entry.architecture === "moss-image-base")!, installed: true, configured: true };
    restored.nodes.find((node: { id: string }) => node.id === "generate").config.modelId = model.id;
    restored.nodes.find((node: { id: string }) => node.id === "generate").config.layoutMethod = "native";
    const plan = compileMediaFlow({ flow: restored, models: [model], compiledAt: "2026-10-21T00:00:00Z" });
    expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(plan.runtimeBindings.map((binding) => binding.model.id)).toContain(model.id);
    expect(plan.steps.some((step) => step.kind === "resolve-layout")).toBe(true);
  });
});
