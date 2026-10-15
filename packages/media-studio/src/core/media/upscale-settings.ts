export interface MediaUpscaleSettings {
  sizeMode: "scale" | "dimensions" | "edges" | "short-edge";
  scale: number;
  minWidth: number;
  minHeight: number;
  minLongEdge: number;
  minShortEdge: number;
  tileMode: "automatic" | "manual" | "factor" | "full";
  tileSize: number;
  tileFactor: number;
}

export const DEFAULT_UPSCALE_SETTINGS: MediaUpscaleSettings = {
  sizeMode: "scale",
  scale: 2,
  minWidth: 1920,
  minHeight: 1024,
  minLongEdge: 1920,
  minShortEdge: 1024,
  tileMode: "automatic",
  tileSize: 256,
  tileFactor: 4,
};

export function serializeUpscaleSettings(
  value: MediaUpscaleSettings,
): MediaUpscaleSettings {
  return {
    ...DEFAULT_UPSCALE_SETTINGS,
    sizeMode: value.sizeMode,
    tileMode: value.tileMode,
    ...(value.sizeMode === "scale"
      ? { scale: value.scale }
      : value.sizeMode === "dimensions"
        ? { minWidth: value.minWidth, minHeight: value.minHeight }
        : value.sizeMode === "edges"
          ? { minLongEdge: value.minLongEdge, minShortEdge: value.minShortEdge }
          : { minShortEdge: value.minShortEdge }),
    ...(value.tileMode === "manual"
      ? { tileSize: value.tileSize }
      : value.tileMode === "factor"
        ? { tileFactor: value.tileFactor }
        : {}),
  };
}

export function validateUpscaleSettings(
  settings: MediaUpscaleSettings,
): string | null {
  const value = serializeUpscaleSettings(settings);
  if (!Number.isFinite(value.scale) || value.scale < 1 || value.scale > 8)
    return "Choose a scale from 1× to 8×.";
  if (
    [
      value.minWidth,
      value.minHeight,
      value.minLongEdge,
      value.minShortEdge,
    ].some((size) => !Number.isInteger(size) || size < 0 || size > 16384)
  )
    return "Enter whole pixel sizes from 0 to 16384.";
  if (
    (value.sizeMode === "dimensions" && !value.minWidth && !value.minHeight) ||
    (value.sizeMode === "edges" && !value.minLongEdge && !value.minShortEdge) ||
    (value.sizeMode === "short-edge" && !value.minShortEdge)
  )
    return "Enter at least one minimum size.";
  if (
    !Number.isInteger(value.tileSize) ||
    value.tileSize < 32 ||
    value.tileSize > 2048
  )
    return "Choose a tile size from 32 to 2048.";
  if (
    !Number.isInteger(value.tileFactor) ||
    value.tileFactor < 2 ||
    value.tileFactor > 16
  )
    return "Choose a tile divisor from 2 to 16.";
  return null;
}

export function resolveUpscaleSize(
  width: number,
  height: number,
  value: MediaUpscaleSettings,
) {
  if (width <= 0 || height <= 0) return null;
  const factor =
    value.sizeMode === "scale"
      ? value.scale
      : Math.max(
          1,
          ...(value.sizeMode === "dimensions"
            ? [value.minWidth / width, value.minHeight / height]
            : value.sizeMode === "edges"
              ? [
                  value.minLongEdge / Math.max(width, height),
                  value.minShortEdge / Math.min(width, height),
                ]
              : [value.minShortEdge / Math.min(width, height)]),
        );
  return {
    width: Math.ceil(width * factor),
    height: Math.ceil(height * factor),
    factor,
  };
}

export function summarizeUpscaleSize(value: MediaUpscaleSettings): string {
  if (value.sizeMode === "scale")
    return Number.isFinite(value.scale) ? `${value.scale}×` : "";
  const dimensions =
    value.sizeMode === "dimensions"
      ? ([
          ["Width", value.minWidth],
          ["Height", value.minHeight],
        ] as const)
      : value.sizeMode === "edges"
        ? ([
            ["Long edge", value.minLongEdge],
            ["Short edge", value.minShortEdge],
          ] as const)
        : ([["Shortest edge", value.minShortEdge]] as const);
  return dimensions
    .filter(([, size]) => size > 0)
    .map(([label, size]) => `${label} ≥ ${size}`)
    .join(" · ");
}

export function estimateUpscaleMemory(input: {
  width: number;
  height: number;
  modelId: string;
  settings: MediaUpscaleSettings;
  memoryBytes: number | null;
}) {
  const { width, height, modelId, settings, memoryBytes } = input;
  const bytesPerPixel =
    modelId === "upscale-span" ? 4096 : modelId === "upscale" ? 16384 : 24576;
  const overhead = 512 * 1024 ** 2;
  const budget = memoryBytes === null ? null : memoryBytes * 0.7;
  const automatic =
    budget === null
      ? 128
      : Math.max(
          32,
          Math.min(
            512,
            Math.floor(
              (Math.sqrt(Math.max(0, budget - overhead) / bytesPerPixel) - 64) /
                32,
            ) * 32,
          ),
        );
  const size = resolveUpscaleSize(width, height, settings);
  const nativeScale = modelId === "custom" ? null : 4;
  const passes =
    nativeScale && size
      ? Math.max(1, Math.ceil(Math.log(size.factor) / Math.log(nativeScale)))
      : 1;
  const passFactor = (nativeScale ?? 4) ** (passes - 1);
  const tileSize =
    settings.tileMode === "automatic"
      ? automatic
      : settings.tileMode === "manual"
        ? settings.tileSize
        : settings.tileMode === "factor"
          ? Math.max(
              32,
              Math.ceil(
                (Math.max(width, height) * passFactor) /
                  settings.tileFactor /
                  32,
              ) * 32,
            )
          : Math.max(width, height) * passFactor;
  const bytes =
    overhead +
    Math.min(width * passFactor, tileSize + 64) *
      Math.min(height * passFactor, tileSize + 64) *
      bytesPerPixel;
  const tooLarge = Boolean(
    size &&
    (size.width > 16384 ||
      size.height > 16384 ||
      size.width * size.height > 64_000_000 ||
      (nativeScale !== null &&
        size.factor > 1 &&
        width * height * nativeScale ** (2 * passes) > 64_000_000)),
  );
  return {
    tileSize,
    bytes,
    tooLarge,
    warning: budget !== null && bytes > budget,
    approximate: modelId === "custom",
  };
}
