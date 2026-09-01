import type { MediaLocalModelArchitecture } from "./contracts.js";

export type MediaAssetImportType =
  | "model"
  | "lora"
  | "embedding"
  | "image"
  | "video"
  | "svg";

export interface MediaAssetFolderTypeRule {
  type: MediaAssetImportType;
  folders: readonly string[];
}

export interface MediaAssetImportProgress {
  operationId: string;
  stage: "inspect" | "hash" | "duplicate-check" | "copy" | "register";
  progress: number;
  bytesProcessed: number;
  bytesTotal: number;
}

export const MEDIA_ASSET_FOLDER_TYPE_RULES: readonly MediaAssetFolderTypeRule[] =
  [
    {
      type: "model",
      folders: ["checkpoint", "checkpoints", "model", "models"],
    },
    {
      type: "lora",
      folders: ["lora", "loras", "lycoris"],
    },
    {
      type: "embedding",
      folders: [
        "embedding",
        "embeddings",
        "textual-inversion",
        "textual_inversion",
      ],
    },
    { type: "image", folders: ["image", "images"] },
    { type: "video", folders: ["video", "videos"] },
    { type: "svg", folders: ["svg", "vector", "vectors"] },
  ];

const IMPORT_TYPES_BY_EXTENSION: Readonly<
  Record<string, readonly MediaAssetImportType[]>
> = {
  safetensors: ["model", "lora", "embedding"],
  png: ["image"],
  jpg: ["image"],
  jpeg: ["image"],
  webp: ["image"],
  webm: ["video"],
  svg: ["svg"],
};

export interface MediaAssetImportFilenamePrefill {
  displayName: string;
  importType: MediaAssetImportType | null;
  architecture: MediaLocalModelArchitecture | null;
}

const ARCHITECTURE_FILENAME_RULES: ReadonlyArray<{
  pattern: RegExp;
  architecture: MediaLocalModelArchitecture;
}> = [
  { pattern: /\bkrea\s*2\b/iu, architecture: "krea-2" },
  { pattern: /\bflux\s*2\b/iu, architecture: "flux-2" },
  {
    pattern: /\bflux\s*(?:1|dev|schnell)\b/iu,
    architecture: "flux-1",
  },
  {
    pattern: /\b(?:sdxl|stable\s+diffusion\s+xl)\b/iu,
    architecture: "stable-diffusion-xl",
  },
  {
    pattern: /\b(?:sd\s*3(?:\.5)?|stable\s+diffusion\s+3)\b/iu,
    architecture: "stable-diffusion-3",
  },
  {
    pattern: /\b(?:sd\s*2(?:\.1)?|stable\s+diffusion\s+2)\b/iu,
    architecture: "stable-diffusion-2",
  },
  {
    pattern: /\b(?:sd\s*1(?:\.5)?|stable\s+diffusion\s+1)\b/iu,
    architecture: "stable-diffusion-1",
  },
];

const DISPLAY_TOKEN_NAMES: Readonly<Record<string, string>> = {
  bf16: "BF16",
  fp8: "FP8",
  fp16: "FP16",
  krea: "Krea",
  lora: "LoRA",
  sd: "SD",
  sdxl: "SDXL",
};

const filenameWords = (stem: string): string =>
  stem
    .replace(/[_-]+/gu, " ")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/\b(krea|flux|sd)(?=\d)/giu, "$1 ")
    .replace(/(\d)([A-Za-z])/gu, "$1 $2")
    .replace(/\.(?=\D|$)/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

const importTypeFromFilename = (
  stem: string,
  extension: string,
): MediaAssetImportType | null => {
  if (extension !== "safetensors") return null;
  if (/(?:^|[._ -])(?:lora|lycoris|locon|dora)(?:[._ -]|$)/iu.test(stem)) {
    return "lora";
  }
  if (
    /(?:^|[._ -])(?:embedding|embeddings|textual[._ -]?inversion)(?:[._ -]|$)/iu.test(
      stem,
    )
  ) {
    return "embedding";
  }
  return "model";
};

const displayNameFromFilename = (stem: string): string =>
  filenameWords(stem)
    .split(" ")
    .map((token) => {
      const normalized = token.toLocaleLowerCase();
      if (DISPLAY_TOKEN_NAMES[normalized])
        return DISPLAY_TOKEN_NAMES[normalized];
      if (/^v\d+(?:\.\d+)*$/iu.test(token)) return normalized;
      return `${token.charAt(0).toLocaleUpperCase()}${token.slice(1)}`;
    })
    .join(" ");

export const parseMediaAssetImportFilename = (
  path: string,
): MediaAssetImportFilenamePrefill => {
  const name = path.split(/[\\/]/u).at(-1) ?? path;
  const extensionSeparator = name.lastIndexOf(".");
  const extension =
    extensionSeparator < 0
      ? ""
      : name.slice(extensionSeparator + 1).toLocaleLowerCase();
  const stem =
    extensionSeparator < 0 ? name : name.slice(0, extensionSeparator);
  const searchableStem = filenameWords(stem);
  return {
    displayName: displayNameFromFilename(stem) || "Imported asset",
    importType: importTypeFromFilename(stem, extension),
    architecture:
      ARCHITECTURE_FILENAME_RULES.find(({ pattern }) =>
        pattern.test(searchableStem),
      )?.architecture ?? null,
  };
};

export const getMediaAssetImportExtension = (path: string): string => {
  const fileName = path.split(/[\\/]/u).at(-1) ?? "";
  const separatorIndex = fileName.lastIndexOf(".");
  return separatorIndex < 0
    ? ""
    : fileName.slice(separatorIndex + 1).toLocaleLowerCase();
};

export const listCompatibleMediaAssetImportTypes = (
  path: string,
): readonly MediaAssetImportType[] =>
  IMPORT_TYPES_BY_EXTENSION[getMediaAssetImportExtension(path)] ?? [];

export const inferMediaAssetImportType = (
  path: string,
  rules: readonly MediaAssetFolderTypeRule[] = MEDIA_ASSET_FOLDER_TYPE_RULES,
): MediaAssetImportType | null => {
  const compatibleTypes = listCompatibleMediaAssetImportTypes(path);
  if (compatibleTypes.length === 0) return null;
  if (compatibleTypes.length === 1) return compatibleTypes[0] ?? null;

  const folderLookup = new Map<string, MediaAssetImportType>();
  for (const rule of rules) {
    for (const folder of rule.folders) {
      folderLookup.set(folder.toLocaleLowerCase(), rule.type);
    }
  }

  const segments = path.split(/[\\/]/u).filter(Boolean);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const inferredType = folderLookup.get(
      segments[index]!.trim().toLocaleLowerCase(),
    );
    if (inferredType && compatibleTypes.includes(inferredType)) {
      return inferredType;
    }
  }
  return parseMediaAssetImportFilename(path).importType;
};
