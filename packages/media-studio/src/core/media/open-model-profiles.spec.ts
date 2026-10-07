import { describe, expect, it } from "vitest";
import {
  createOpenMediaModels,
  OPEN_MEDIA_MODEL_PROFILES,
  openMediaModelProfile,
} from "./open-model-profiles.js";
import {
  compileMediaFlow,
  createImageRecipeFlow,
  createImageToVideoFlow,
} from "./compiler.js";
import {
  resolveMediaVideoDimensions,
  resolveMediaVideoQualityPresetSettings,
  MEDIA_VIDEO_QUALITY_PRESETS,
} from "./video-quality.js";
import manifests from "../../../../../apps/client/src-tauri/src/media/open_model_manifests.json" with { type: "json" };
import studentManifests from "../../../../../apps/client/src-tauri/src/media/student_model_manifests.json" with { type: "json" };
import { DEFAULT_MEDIA_STUDIO_STATE } from "../../tauri/ui/media/media-studio-store.js";

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
    OPEN_MEDIA_MODEL_PROFILES.filter(
      (profile) => profile.distillation?.sampler === "lcm",
    ),
  )(
    "compiles the SDXL student and rejects manual overrides for $displayName",
    (profile) => {
      const model = readyModel(profile.architecture);
      expect(model.license.sourceUrl).toBe(profile.license.sourceUrl);
      expect(model.addonCapabilities).toEqual([]);
      const flow = createImageRecipeFlow({
        id: "sdxl-student",
        createdAt: "2026-10-06T10:00:00Z",
        settings: {
          ...DEFAULT_MEDIA_STUDIO_STATE.recipe,
          prompt: "a photo of a cat",
          modelId: model.id,
          transparentBackground: false,
          qualityGateEnabled: false,
        },
      });
      const task = flow.nodes.find(
        (node) => node.type === "task.generate-image",
      )!;
      const compile = () =>
        compileMediaFlow({
          flow,
          models: [model],
          compiledAt: "2026-10-06T10:00:01Z",
        });
      expect(
        compile().diagnostics.filter(
          (diagnostic) => diagnostic.severity === "error",
        ),
      ).toEqual([]);
      for (const [field, value, message] of [
        ["numInferenceSteps", 8, "sampling steps"],
        ["guidanceScale", 5, "guidance"],
      ] as const) {
        task.config[field] = value;
        expect(
          compile().diagnostics.some(
            (diagnostic) =>
              diagnostic.severity === "error" &&
              diagnostic.message.includes(message),
          ),
        ).toBe(true);
        task.config[field] = null;
      }
      task.config.negativePrompt = "blur";
      expect(
        compile().diagnostics.some(
          (diagnostic) =>
            diagnostic.severity === "error" &&
            diagnostic.message.includes("negative prompts"),
        ),
      ).toBe(true);
    },
  );
  it.each(
    OPEN_MEDIA_MODEL_PROFILES.filter(
      (profile) => profile.distillation && profile.video,
    ),
  )("uses the published student contract for $displayName", (profile) => {
    const model = createOpenMediaModels("test").find(
      (entry) => entry.id === profile.id,
    )!;
    expect(model.license).toMatchObject({
      spdxId: null,
      commercialUse: "review-required",
      requiresAcceptance: true,
      sourceUrl:
        "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
    });
    expect(model.addonCapabilities).toEqual([]);
    expect(model.management.acquisition).toBe("file-import");
    for (const preset of MEDIA_VIDEO_QUALITY_PRESETS) {
      const settings = resolveMediaVideoQualityPresetSettings(
        preset,
        profile.architecture,
      );
      expect(settings.numInferenceSteps).toBe(profile.steps);
      expect(settings.guidanceScale).toBe(1);
      expect(settings.fps).toBe(24);
      expect((settings.numFrames - 124) % 17).toBe(0);
    }
  });

  it.each(
    OPEN_MEDIA_MODEL_PROFILES.filter(
      (profile) => profile.distillation && profile.video,
    ),
  )(
    "rejects unsupported student settings for $displayName before execution",
    (profile) => {
      const model = readyModel(profile.architecture);
      const settings = resolveMediaVideoQualityPresetSettings(
        MEDIA_VIDEO_QUALITY_PRESETS[1]!,
        profile.architecture,
      );
      const flow = createImageToVideoFlow({
        id: "student-video",
        createdAt: "2026-10-06T10:00:00Z",
        prompt: "A bird flies",
        settings: { ...settings, modelId: model.id },
      });
      const task = flow.nodes.find(
        (node) => node.type === "task.generate-video",
      )!;
      const validConfig = task.config;
      for (const [key, value, message] of [
        ["fps", 30, "24 fps"],
        ["negativePrompt", "blur", "negative prompt"],
        ["numInferenceSteps", 8, "sampling steps"],
        ["guidanceScale", 5, "guidance"],
        ["numFrames", 362, "frame count"],
      ] as const) {
        task.config = { ...validConfig, [key]: value };
        const plan = compileMediaFlow({
          flow,
          models: [model],
          compiledAt: "2026-10-06T10:00:01Z",
        });
        expect(
          plan.diagnostics.some(
            (diagnostic) =>
              diagnostic.severity === "error" &&
              diagnostic.message.includes(message),
          ),
        ).toBe(true);
      }
    },
  );

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
    for (const manifest of [...manifests, ...studentManifests]) {
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
        const student = openMediaModelProfile(model.architecture)?.distillation;
        if (file.path === student?.checkpointFile) {
          expect(file.byteSize).toBe(student.checkpointByteSize);
          expect(file.sha256).toBe(student.checkpointSha256);
        } else {
          expect(file.path).not.toMatch(
            /(?:^|\/)\.\.(?:\/|$)|\.(?:bin|pt|py)$/u,
          );
        }
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
