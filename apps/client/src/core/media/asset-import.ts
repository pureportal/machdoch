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
  return null;
};
