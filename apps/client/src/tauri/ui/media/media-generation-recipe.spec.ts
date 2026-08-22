import { describe, expect, it } from "vitest";
import {
  countMediaImageRecipeOutputs,
  formatMediaImageRecipeOutput,
  normalizeMediaFlowForPersistence,
  normalizeMediaSubmissionText,
} from "./media-generation-recipe";
import { DEFAULT_MEDIA_STUDIO_STATE } from "./media-studio-store";
import { createImageRecipeFlow } from "../../../core/media/compiler.js";
import { updateMediaFlowNodeLabel } from "../../../core/media/node-registry.js";
import type { MediaImageOutputBranch } from "../../../core/media/contracts.js";

describe("media generation text normalization", () => {
  it.each([
    ["trailing:", "trailing:"],
    ["punctuation!?...", "punctuation!?..."],
    ["  outer whitespace  ", "outer whitespace"],
    ["\n\t  ", ""],
    ["", ""],
  ])("normalizes %j without changing valid endings", (input, expected) => {
    expect(normalizeMediaSubmissionText(input)).toBe(expected);
  });

  it("normalizes persisted prompt fields without changing the editor recipe", () => {
    const settings = {
      ...DEFAULT_MEDIA_STUDIO_STATE.recipe,
      prompt: "  preserve internal\ntext trailing:  ",
    };
    const flow = createImageRecipeFlow({
      id: "flow-normalized",
      createdAt: "2026-08-20T10:00:00.000Z",
      settings,
    });
    const normalized = normalizeMediaFlowForPersistence(flow);

    expect(
      normalized.nodes.find((node) => node.type === "source.prompt")?.config
        .prompt,
    ).toBe("preserve internal\ntext trailing:");
    expect(settings.prompt).toBe("  preserve internal\ntext trailing:  ");
  });

  it("retains an edited node name through persistence normalization", () => {
    const flow = updateMediaFlowNodeLabel({
      flow: createImageRecipeFlow({
        id: "flow-node-name",
        createdAt: "2026-08-21T10:00:00.000Z",
        settings: DEFAULT_MEDIA_STUDIO_STATE.recipe,
      }),
      nodeId: "generate",
      label: "Strong detail",
      updatedAt: "2026-08-21T10:00:01.000Z",
    });

    expect(
      normalizeMediaFlowForPersistence(flow).nodes.find(
        (node) => node.id === "generate",
      )?.label,
    ).toBe("Strong detail");
  });

  it("summarizes independently processed image output branches", () => {
    const settings = {
      ...DEFAULT_MEDIA_STUDIO_STATE.recipe,
      outputCount: 1,
      outputFormat: "png" as const,
    };
    const branches: MediaImageOutputBranch[] = [
      {
        id: "cropped-png",
        outputNodeId: "png-output",
        format: "png" as const,
        quality: 95,
        jpegBackground: "#ffffff",
        operations: [
          {
            kind: "crop" as const,
            nodeId: "crop",
            x: 0,
            y: 0,
            width: 768,
            height: 768,
          },
        ],
      },
      {
        id: "disclaimer-webp",
        outputNodeId: "webp-output",
        format: "webp" as const,
        quality: 90,
        jpegBackground: "#ffffff",
        operations: [
          {
            kind: "text-overlay" as const,
            nodeId: "disclaimer",
            text: "AI Image Disclaimer",
            position: "bottom-right" as const,
            margin: 24,
            fontSize: 24,
            color: "#ffffff",
            backgroundColor: "#000000",
            backgroundOpacity: 0.55,
          },
        ],
      },
    ];

    expect(countMediaImageRecipeOutputs(settings, branches)).toBe(2);
    expect(formatMediaImageRecipeOutput(settings, branches)).toBe(
      "1:1 · 2 outputs · PNG + WEBP",
    );
  });
});
