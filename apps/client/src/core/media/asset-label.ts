import type { MediaAssetRecord } from "./contracts.js";

export const mediaAssetLabel = (
  asset: MediaAssetRecord,
  index = asset.outputIndex,
): string =>
  (asset.operation?.kind === "local-import"
    ? asset.operation.sourceFileName
    : null) ||
  asset.tags.find((tag) => tag.source === "user")?.label ||
  `${asset.kind === "vector" ? "SVG" : asset.kind === "video" ? "Video" : "Image"} ${index + 1}`;
