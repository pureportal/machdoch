import type {
  MediaGenerationAssetMetadata,
  MediaModelAddonDescriptor,
} from "./contracts.js";

const normalizeHttpsUrl = (value: string): URL | null => {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.port === ""
      ? url
      : null;
  } catch {
    return null;
  }
};

export const normalizeMediaExternalLink = (value: string): string | null =>
  normalizeHttpsUrl(value)?.href ?? null;

export const isMediaCivitaiSourceUrl = (value: string): boolean => {
  const url = normalizeHttpsUrl(value);
  return (
    url !== null &&
    [
      "civitai.com",
      "www.civitai.com",
      "civitai.red",
      "www.civitai.red",
    ].includes(url.hostname)
  );
};

export const normalizeMediaTriggerWords = (
  value: string | readonly string[],
): string => {
  const source = typeof value === "string" ? value : value.join(",");
  const triggerWords: string[] = [];
  const seen = new Set<string>();
  for (const candidate of source.split(/[,\r\n]+/u)) {
    if (triggerWords.length >= 32) break;
    const normalized = candidate
      .replaceAll(/\p{Cc}/gu, " ")
      .replaceAll(/\s+/gu, " ")
      .trim()
      .slice(0, 128);
    const comparisonValue = normalized.toLocaleLowerCase();
    if (!normalized || seen.has(comparisonValue)) continue;
    seen.add(comparisonValue);
    triggerWords.push(normalized);
  }
  return triggerWords.join(", ");
};

export const parseMediaTriggerWords = (value: string): string[] => {
  const normalized = normalizeMediaTriggerWords(value);
  return normalized ? normalized.split(", ") : [];
};

export const createEmptyMediaGenerationAssetMetadata =
  (): MediaGenerationAssetMetadata => ({
    categoryIds: [],
    tags: [],
    triggerWords: "",
    sourceUrl: null,
    sampleAssetIds: [],
    sampleImages: [],
  });

export const applyMediaAssetMetadataToAddon = (
  addon: MediaModelAddonDescriptor,
  metadata: MediaGenerationAssetMetadata | undefined,
): MediaModelAddonDescriptor => {
  if (!metadata) return addon;
  const triggerWords = parseMediaTriggerWords(metadata.triggerWords);
  return {
    ...addon,
    triggerWords,
    defaultToken:
      addon.kind === "textual-inversion"
        ? (triggerWords[0] ?? null)
        : addon.defaultToken,
  };
};

export const normalizeMediaCivitaiSampleImageUrl = (
  value: string,
): string | null => {
  const url = normalizeHttpsUrl(value);
  if (
    !url ||
    (url.hostname !== "image.civitai.com" &&
      url.hostname !== "imagecache.civitai.com")
  ) {
    return null;
  }
  return url.href;
};
