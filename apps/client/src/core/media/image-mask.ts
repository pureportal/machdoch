import type {
  MediaImageMask,
  MediaImageMaskPoint,
  MediaImageMaskStroke,
} from "./contracts.js";

export const MEDIA_IMAGE_MASK_MAX_STROKES = 256;
export const MEDIA_IMAGE_MASK_MAX_POINTS = 8_192;
export const MEDIA_IMAGE_MASK_MIN_BRUSH_SIZE = 0.0025;
export const MEDIA_IMAGE_MASK_MAX_BRUSH_SIZE = 0.5;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => Object.keys(value).every((key) => keys.includes(key));

const isPoint = (value: unknown): value is MediaImageMaskPoint =>
  isRecord(value) &&
  hasOnlyKeys(value, ["x", "y"]) &&
  typeof value.x === "number" &&
  Number.isFinite(value.x) &&
  value.x >= 0 &&
  value.x <= 1 &&
  typeof value.y === "number" &&
  Number.isFinite(value.y) &&
  value.y >= 0 &&
  value.y <= 1;

const isStroke = (value: unknown): value is MediaImageMaskStroke =>
  isRecord(value) &&
  hasOnlyKeys(value, ["mode", "size", "points"]) &&
  (value.mode === "paint" || value.mode === "erase") &&
  typeof value.size === "number" &&
  Number.isFinite(value.size) &&
  value.size >= MEDIA_IMAGE_MASK_MIN_BRUSH_SIZE &&
  value.size <= MEDIA_IMAGE_MASK_MAX_BRUSH_SIZE &&
  Array.isArray(value.points) &&
  value.points.length >= 1 &&
  value.points.length <= MEDIA_IMAGE_MASK_MAX_POINTS &&
  value.points.every(isPoint);

export const isMediaImageMask = (value: unknown): value is MediaImageMask => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "sourceAssetId",
      "inverted",
      "strokes",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.sourceAssetId !== "string" ||
    value.sourceAssetId.length < 1 ||
    value.sourceAssetId.length > 256 ||
    value.sourceAssetId !== value.sourceAssetId.trim() ||
    typeof value.inverted !== "boolean" ||
    !Array.isArray(value.strokes) ||
    value.strokes.length > MEDIA_IMAGE_MASK_MAX_STROKES ||
    !value.strokes.every(isStroke)
  ) {
    return false;
  }
  return (
    value.strokes.reduce((total, stroke) => total + stroke.points.length, 0) <=
    MEDIA_IMAGE_MASK_MAX_POINTS
  );
};

export const normalizeMediaImageMask = (
  value: unknown,
): MediaImageMask | null => (isMediaImageMask(value) ? value : null);

export const hasMediaImageMaskContent = (
  value: MediaImageMask | null | undefined,
): value is MediaImageMask =>
  value !== null && value !== undefined && value.strokes.length > 0;
