import { describe, expect, it } from "vitest";
import {
  createOpenMediaModels,
  OPEN_MEDIA_MODEL_PROFILES,
} from "./open-model-profiles.js";
import { compileMediaFlow, createImageToVideoFlow } from "./compiler.js";
import {
  resolveMediaVideoDimensions,
  resolveMediaVideoQualityPresetSettings,
  MEDIA_VIDEO_QUALITY_PRESETS,
} from "./video-quality.js";
import manifests from "../../../../../apps/client/src-tauri/src/media/open_model_manifests.json" with { type: "json" };

const readyModel = (architecture: string) => {
  const model = createOpenMediaModels("test").find(
    (entry) => entry.architecture === architecture,
  )!;
  return {
    ...model,
    id: `local:${architecture}` as const,
    installed: true,
    installationStatus: "installed" as const,
    runtimeReadiness: "ready" as const,
    installedRevision: "revision",
  };
};

describe("open media generation contracts", () => {
  it.each(
    OPEN_MEDIA_MODEL_PROFILES.filter((profile) =>
      profile.capabilities.includes("text-to-video"),
    ),
  )("compiles $displayName without image conditions", (profile) => {
    const model = readyModel(profile.architecture);
    const settings = resolveMediaVideoQualityPresetSettings(
      MEDIA_VIDEO_QUALITY_PRESETS[1]!,
      profile.architecture,
    );
    const flow = createImageToVideoFlow({
      id: "text-video",
      createdAt: "2026-10-02T10:00:00Z",
      prompt: "A bird flies over the sea",
      settings: {
        ...settings,
        modelId: model.id,
        loopMode: "none",
        transparentBackground: false,
      },
    });
    const plan = compileMediaFlow({
      flow,
      models: [model],
      compiledAt: "2026-10-02T10:00:01Z",
    });
    expect(
      plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    ).toEqual([]);
    expect(flow.nodes.some((node) => node.type === "source.image")).toBe(false);
  });

  it("requires an image for the Wan I2V model", () => {
    const model = readyModel("wan-2.2-i2v-a14b");
    const flow = createImageToVideoFlow({
      id: "i2v",
      createdAt: "2026-10-02T10:00:00Z",
      prompt: "A bird flies",
      settings: { modelId: model.id },
    });
    const plan = compileMediaFlow({
      flow,
      models: [model],
      compiledAt: "2026-10-02T10:00:01Z",
    });
    expect(
      plan.diagnostics.some(
        (diagnostic) => diagnostic.code === "SOURCE_ASSET_REQUIRED",
      ),
    ).toBe(true);
  });

  it("supports one published opening image without requiring a closing image", () => {
    const model = readyModel("cogvideox-1.5-5b-i2v");
    const flow = createImageToVideoFlow({
      id: "i2v",
      createdAt: "2026-10-02T10:00:00Z",
      sourceAssetId: "source:bird",
      prompt: "The bird flies",
      settings: { modelId: model.id },
    });
    flow.edges = flow.edges.filter((edge) => edge.toPortId !== "last-frame");
    const plan = compileMediaFlow({
      flow,
      models: [model],
      compiledAt: "2026-10-02T10:00:01Z",
    });
    expect(
      plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    ).toEqual([]);
  });

  it("offers downloads only for complete pinned packages", () => {
    const models = createOpenMediaModels("test");
    for (const manifest of manifests) {
      const model = models.find((entry) => entry.id === manifest.modelId)!;
      expect(model.management.acquisition).toBe("managed-install");
      expect(manifest.revision).toMatch(/^[a-f0-9]{40}$/u);
      expect(new Set(manifest.files.map((file) => file.path)).size).toBe(
        manifest.files.length,
      );
      expect(
        manifest.files.some((file) => file.path === "model_index.json"),
      ).toBe(true);
      expect(
        manifest.files.some((file) => file.sha256 === manifest.licenseDigest),
      ).toBe(true);
      for (const file of manifest.files) {
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(file.byteSize).toBeGreaterThan(0);
        expect(file.path).not.toMatch(/(?:^|\/)\.\.(?:\/|$)|\.(?:bin|pt|py)$/u);
      }
    }
    expect(
      models.find((model) => model.architecture === "ltx-2.5")?.management
        .acquisition,
    ).toBe("file-import");
  });

  it("keeps LTX audio video presets and dimensions compatible", () => {
    const settings = resolveMediaVideoQualityPresetSettings(
      MEDIA_VIDEO_QUALITY_PRESETS[2]!,
      "ltx-2.5",
    );
    expect(settings).toMatchObject({
      numInferenceSteps: 8,
      guidanceScale: 1,
      fps: 24,
    });
    expect(
      resolveMediaVideoDimensions("16:9", "quality-768", "ltx-2.5"),
    ).toEqual([768, 448]);
    expect(
      resolveMediaVideoDimensions("16:9", "quality-768", "wan-2.2-t2v-a14b"),
    ).toEqual([768, 432]);
  });
});
