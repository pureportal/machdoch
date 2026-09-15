import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../core/media/catalog.js";
import { compileMediaFlow } from "../../../core/media/compiler.js";
import type { MediaAssetRecord } from "../../../core/media/contracts.js";
import { DEFAULT_IMAGE_RECIPE_SETTINGS } from "./media-studio-store";
import {
  createBasicMediaRecipeFlow,
  compileBasicImageOutputBranches,
} from "./media-basic-generation";
import { assessRemoteEditExecution } from "./media-remote-edit-assessment";

const catalog = createMediaModelCatalogSnapshot({ isOpenAiConfigured: true });
const asset = {
  id: "source",
  digest: "a".repeat(64),
  kind: "image",
  mimeType: "image/png",
  byteSize: 1000,
  width: 512,
  height: 512,
  tags: [],
  sourceAssetIds: [],
  fixture: false,
  operation: null,
  runId: "run",
  outputIndex: 0,
  createdAt: "2026-09-15T00:00:00Z",
} satisfies MediaAssetRecord;

describe("Basic remote edit assessment", () => {
  it.each([false, true])(
    "allows base and reference edits with transparency %s",
    (transparentBackground) => {
      for (const input of [
        { baseImageAssetId: asset.id },
        {
          referenceImages: [
            { assetId: asset.id, role: "style" as const, influence: 1 },
          ],
        },
      ]) {
        const flow = createBasicMediaRecipeFlow({
          id: "review",
          createdAt: asset.createdAt,
          target: "image",
          settings: {
            ...DEFAULT_IMAGE_RECIPE_SETTINGS,
            prompt: "A blue teapot",
            modelId: "openai:gpt-image-2",
            transparentBackground,
            ...input,
          },
        });
        const plan = compileMediaFlow({
          flow,
          models: catalog.models,
          compiledAt: asset.createdAt,
        });
        expect(plan.status).toBe("ready");
        expect(compileBasicImageOutputBranches(flow)).toMatchObject([
          { format: "png", operations: [] },
        ]);
        const result = assessRemoteEditExecution({
          flow,
          plan,
          assets: [asset],
          runtimeMode: "native",
          directReferenceImageModelIds: ["openai:gpt-image-2"],
        });
        expect(result.supported).toBe(true);
        expect(result.manifest[0]?.role).toBe(
          "referenceImages" in input ? "style" : "base",
        );
        expect(
          assessRemoteEditExecution({
            flow,
            plan,
            assets: [],
            runtimeMode: "native",
            directReferenceImageModelIds: ["openai:gpt-image-2"],
          }).supported,
        ).toBe(false);
      }
    },
  );
});
