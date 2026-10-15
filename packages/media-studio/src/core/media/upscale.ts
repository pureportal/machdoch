import type {
  MediaAssetRecord,
  MediaFlow,
  MediaFlowNode,
} from "./contracts.js";
import {
  createDefaultMediaNodeConfig,
  getMediaNodeDefinition,
} from "./node-registry.js";
import {
  serializeUpscaleSettings,
  type MediaUpscaleSettings,
} from "./upscale-settings.js";

export const MEDIA_UPSCALERS = [
  { id: "upscale-span", name: "SPAN", size: "9 MB" },
  { id: "upscale", name: "Real-ESRGAN", size: "67 MB" },
  { id: "upscale-swinir", name: "SwinIR", size: "17 MB" },
] as const;

export function createMediaUpscaleFlow(input: {
  asset: Pick<MediaAssetRecord, "id" | "kind">;
  modelPath: string;
  settings: MediaUpscaleSettings;
  id: string;
  createdAt: string;
}): MediaFlow {
  if (!["image", "video"].includes(input.asset.kind))
    throw new Error("Choose an image or video.");
  const video = input.asset.kind === "video";
  const port = video ? "video" : "image";
  const node = (
    id: string,
    type: MediaFlowNode["type"],
    config: Record<string, unknown>,
  ): MediaFlowNode => ({
    id,
    type,
    version: 1,
    label: getMediaNodeDefinition(type)!.displayName,
    layer: getMediaNodeDefinition(type)!.layer,
    config: { ...createDefaultMediaNodeConfig(type), ...config },
  });
  return {
    schemaVersion: 1,
    id: input.id,
    name: video ? "Upscale video" : "Upscale image",
    description: "",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    variables: [],
    variableBindings: {},
    presets: [],
    activePresetId: null,
    nodes: [
      node("source", video ? "source.video" : "source.image", {
        assetId: input.asset.id,
      }),
      node("upscale", video ? "operation.upscale-video" : "operation.upscale", {
        modelPath: input.modelPath,
        ...serializeUpscaleSettings(input.settings),
      }),
      node("output", video ? "output.video" : "output.asset", {}),
    ],
    edges: [
      ["source", "upscale"],
      ["upscale", "output"],
    ].map(([fromNodeId, toNodeId]) => ({
      id: `${fromNodeId}-${toNodeId}`,
      fromNodeId: fromNodeId!,
      fromPortId: port,
      toNodeId: toNodeId!,
      toPortId: port,
    })),
  };
}
