import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPSCALE_SETTINGS,
  estimateUpscaleMemory,
  resolveUpscaleSize,
  summarizeUpscaleSize,
  validateUpscaleSettings,
} from "./upscale-settings.js";
import { createMediaUpscaleFlow } from "./upscale.js";
import { compileMediaFlow } from "./compiler.js";
import {
  getMediaNodeDefinition,
  listVisibleMediaNodeFields,
} from "./node-registry.js";

describe("upscale sizing", () => {
  it.each([
    ["scale", "2.75×"],
    ["dimensions", "Width ≥ 1920 · Height ≥ 1024"],
    ["edges", "Long edge ≥ 290 · Short edge ≥ 200"],
    ["short-edge", "Shortest edge ≥ 200"],
  ] as const)(
    "summarizes the active %s target on Advanced cards",
    (sizeMode, summary) => {
      expect(
        summarizeUpscaleSize({
          ...DEFAULT_UPSCALE_SETTINGS,
          sizeMode,
          scale: 2.75,
          minLongEdge: 290,
          minShortEdge: 200,
        }),
      ).toBe(summary);
    },
  );
  it("rounds fractional factors upward", () => {
    expect(
      resolveUpscaleSize(97, 71, { ...DEFAULT_UPSCALE_SETTINGS, scale: 1.25 }),
    ).toEqual({ width: 122, height: 89, factor: 1.25 });
  });
  it.each([
    ["dimensions", 640, 480, 1920, 1440],
    ["dimensions", 480, 640, 1920, 2560],
    ["edges", 640, 480, 1920, 1440],
    ["edges", 480, 640, 1440, 1920],
    ["short-edge", 640, 480, 1366, 1024],
    ["short-edge", 480, 640, 1024, 1366],
    ["dimensions", 2560, 1440, 2560, 1440],
  ] as const)(
    "resolves %s for %s × %s",
    (sizeMode, width, height, outputWidth, outputHeight) => {
      expect(
        resolveUpscaleSize(width, height, {
          ...DEFAULT_UPSCALE_SETTINGS,
          sizeMode,
        }),
      ).toMatchObject({ width: outputWidth, height: outputHeight });
    },
  );
  it("allows one dimension to be unconstrained and rejects empty targets", () => {
    expect(
      resolveUpscaleSize(640, 480, {
        ...DEFAULT_UPSCALE_SETTINGS,
        sizeMode: "dimensions",
        minWidth: 0,
      }),
    ).toMatchObject({ width: 1366, height: 1024 });
    expect(
      validateUpscaleSettings({
        ...DEFAULT_UPSCALE_SETTINGS,
        sizeMode: "dimensions",
        minWidth: 0,
        minHeight: 0,
      }),
    ).toBe("Enter at least one minimum size.");
  });
  it.each([0, 9, NaN, Infinity])("rejects invalid scale %s", (scale) => {
    expect(
      validateUpscaleSettings({ ...DEFAULT_UPSCALE_SETTINGS, scale }),
    ).not.toBeNull();
  });
  it.each(["image", "video"] as const)(
    "carries all settings through the %s compiler",
    (kind) => {
      const settings = {
        ...DEFAULT_UPSCALE_SETTINGS,
        sizeMode: "edges" as const,
        tileMode: "factor" as const,
      };
      const flow = createMediaUpscaleFlow({
        asset: { id: "source", kind },
        modelPath: "span.safetensors",
        id: "test",
        createdAt: "2026-10-15T00:00:00Z",
        settings,
      });
      expect(flow.nodes[1]!.config).toMatchObject(settings);
      expect(
        compileMediaFlow({ flow, models: [], compiledAt: flow.createdAt })
          .status,
      ).toBe("ready");
      flow.nodes[1]!.config.sizeMode = "short-edge";
      flow.nodes[1]!.config.minShortEdge = 0;
      expect(
        compileMediaFlow({ flow, models: [], compiledAt: flow.createdAt })
          .status,
      ).toBe("blocked");
    },
  );
  it("shows only relevant Advanced fields", () => {
    const definition = getMediaNodeDefinition("operation.upscale")!;
    const fields = (sizeMode: string) =>
      listVisibleMediaNodeFields(
        definition,
        { ...DEFAULT_UPSCALE_SETTINGS, sizeMode },
        "Basic",
      ).map((field) => field.id);
    expect(fields("scale")).toEqual(["modelPath", "sizeMode", "scale"]);
    expect(fields("edges")).toEqual([
      "modelPath",
      "sizeMode",
      "minLongEdge",
      "minShortEdge",
    ]);
    expect(fields("short-edge")).toEqual([
      "modelPath",
      "sizeMode",
      "minShortEdge",
    ]);
  });
});

describe("upscale memory planning", () => {
  const estimate = (
    memoryBytes: number | null,
    settings = DEFAULT_UPSCALE_SETTINGS,
    modelId = "upscale-span",
  ) =>
    estimateUpscaleMemory({
      width: 1920,
      height: 1080,
      modelId,
      settings,
      memoryBytes,
    });
  it("uses smaller automatic tiles with less memory", () => {
    expect(estimate(1024 ** 3).tileSize).toBeLessThan(
      estimate(16 * 1024 ** 3).tileSize,
    );
    expect(estimate(null).tileSize).toBe(128);
  });
  it("warns for oversized tiles and full frames", () => {
    expect(
      estimate(
        4 * 1024 ** 3,
        { ...DEFAULT_UPSCALE_SETTINGS, tileMode: "manual", tileSize: 2048 },
        "upscale",
      ).warning,
    ).toBe(true);
    expect(
      estimate(
        4 * 1024 ** 3,
        { ...DEFAULT_UPSCALE_SETTINGS, tileMode: "full" },
        "upscale",
      ).warning,
    ).toBe(true);
    expect(estimate(4 * 1024 ** 3).warning).toBe(false);
    expect(estimate(null).warning).toBe(false);
  });
  it("divides the longest source edge and rounds to tile boundaries", () => {
    expect(
      estimate(null, { ...DEFAULT_UPSCALE_SETTINGS, tileMode: "factor" })
        .tileSize,
    ).toBe(480);
  });
});
