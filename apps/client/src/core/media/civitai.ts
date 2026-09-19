import type {
  MediaCivitaiModelAddonInspection,
  MediaGenerationAssetMetadata,
  MediaLocalModelImportInspection,
  MediaModelAddonImportInspection,
  MediaLocalModelArchitecture,
} from "./contracts.js";
import {
  normalizeMediaAssetTags,
  normalizeMediaCivitaiSampleImageUrl,
  normalizeMediaTriggerWords,
} from "./asset-metadata.js";

export interface CivitaiPreview {
  url: string;
  width: number | null;
  height: number | null;
  nsfw: boolean;
  nsfwLevel: number | null;
  type: string | null;
  meta: { prompt: string | null; negativePrompt: string | null } | null;
}

export interface CivitaiFile {
  id: number;
  name: string;
  type: string;
  sizeKB: number;
  primary: boolean;
  hashes: { SHA256: string | null } | null;
  metadata: {
    format: string | null;
    fp: string | null;
    size: string | null;
  } | null;
  pickleScanResult: string | null;
  virusScanResult: string | null;
}

export interface CivitaiVersion {
  id: number;
  name: string;
  baseModel: string | null;
  publishedAt: string | null;
  trainedWords: string[];
  files: CivitaiFile[];
  images: CivitaiPreview[];
}

export interface CivitaiModel {
  description: string | null;
  matchedVersionId: number | null;
  id: number;
  name: string;
  type: string;
  nsfw: boolean;
  tags: string[];
  creator: { username: string } | null;
  modelVersions: CivitaiVersion[];
  stats: { downloadCount: number | null; thumbsUpCount: number | null } | null;
}

export interface CivitaiSearch {
  query: string;
  modelType: string;
  baseModel: string;
  sort: string;
  period: string;
  tag: string;
  username: string;
  nsfw: boolean;
  favorites: boolean;
  cursor: string | null;
}

export interface CivitaiSearchPage {
  items: CivitaiModel[];
  nextCursor: string | null;
}

export interface CivitaiOptions {
  modelTypes: string[];
  baseModels: string[];
  baseModelsByType: Record<string, string[]>;
}

export const civitaiImportArchitecture = (
  detected: MediaLocalModelArchitecture | null,
  suggested: MediaLocalModelArchitecture | null,
): MediaLocalModelArchitecture | null => {
  const pipeline = (value: MediaLocalModelArchitecture) =>
    value === "pony" ? "stable-diffusion-xl" : value;
  if (detected && suggested && pipeline(detected) !== pipeline(suggested)) {
    throw new Error(
      "The downloaded model does not match Civitai's base model. Choose another version.",
    );
  }
  return suggested ?? detected;
};
export interface CivitaiInspection extends MediaCivitaiModelAddonInspection {
  canDownload: boolean;
  reviewToken: string;
  resourceType: string;
}
export interface CivitaiDownloadedResource {
  model: MediaLocalModelImportInspection | null;
  addon: MediaModelAddonImportInspection | null;
  metadata: CivitaiInspection;
}
export interface CivitaiDownloadProgress {
  operationId: string;
  received: number;
  total: number;
}

export const CIVITAI_DEFAULT_SEARCH: CivitaiSearch = {
  query: "",
  modelType: "",
  baseModel: "",
  sort: "Most Downloaded",
  period: "AllTime",
  tag: "",
  username: "",
  nsfw: false,
  favorites: false,
  cursor: null,
};

export const civitaiModelUrl = (
  model: Pick<CivitaiModel, "id" | "nsfw">,
  versionId?: number,
): string =>
  `https://${model.nsfw ? "civitai.red" : "civitai.com"}/models/${model.id}${versionId ? `?modelVersionId=${versionId}` : ""}`;

export const isCivitaiLookup = (query: string): boolean =>
  /^(?:https:\/\/|urn:air:|\d+(?:@\d+)?$|[a-f\d]{64}$)/iu.test(query.trim());

export const civitaiRequestedVersion = (source: string): number | null => {
  const airVersion = /@(\d+)$/u.exec(source)?.[1];
  if (airVersion) return Number(airVersion);
  try {
    const url = new URL(source);
    const version =
      url.searchParams.get("modelVersionId") ??
      /\/(?:model-versions|api\/download\/models|versions)\/(\d+)/u.exec(
        url.pathname,
      )?.[1];
    return version && /^\d+$/u.test(version) ? Number(version) : null;
  } catch {
    return null;
  }
};

export const civitaiVisibleImages = (
  model: CivitaiModel,
  version: CivitaiVersion | undefined,
  mature: boolean,
): CivitaiPreview[] =>
  (version?.images ?? []).filter(
    (image) =>
      normalizeMediaCivitaiSampleImageUrl(image.url) &&
      image.type !== "video" &&
      (mature || (!model.nsfw && !image.nsfw && (image.nsfwLevel ?? 1) <= 1)),
  );

export const civitaiImportMetadata = (
  inspection: CivitaiInspection,
  images: readonly CivitaiPreview[],
): MediaGenerationAssetMetadata => ({
  categoryIds: [],
  tags: normalizeMediaAssetTags(inspection.tags.join(",")),
  triggerWords: normalizeMediaTriggerWords(inspection.trainedWords),
  sourceUrl: inspection.sourceUrl,
  sampleAssetIds: [],
  sampleImages: images
    .slice(0, 12)
    .map(({ url, width, height }) => ({ url, width, height })),
});

export const civitaiFileSize = (bytes: number): string =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
    bytes / (bytes >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2),
  ) + (bytes >= 1024 ** 3 ? " GB" : " MB");
