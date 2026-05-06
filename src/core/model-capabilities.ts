import type { AgentModelImageMediaType, ModelProvider } from "./types.js";

const IMAGE_EXTENSION_MEDIA_TYPES: Record<string, AgentModelImageMediaType> = {
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const PROVIDER_IMAGE_MEDIA_TYPES: Record<
  Exclude<ModelProvider, "unconfigured">,
  ReadonlySet<AgentModelImageMediaType>
> = {
  anthropic: new Set([
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]),
  google: new Set([
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]),
  openai: new Set([
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]),
};

const getExtension = (path: string): string | undefined => {
  const fileName = path.trim().replace(/\\/gu, "/").split("/").at(-1) ?? "";
  const lastDotIndex = fileName.lastIndexOf(".");

  if (lastDotIndex < 0 || lastDotIndex === fileName.length - 1) {
    return undefined;
  }

  return fileName.slice(lastDotIndex + 1).toLowerCase();
};

const normalizeModel = (model: string): string => {
  return model.trim().toLowerCase();
};

const openAIModelSupportsImageInput = (model: string): boolean => {
  const normalizedModel = normalizeModel(model);

  return (
    /^gpt-5(?:\.\d+)?(?:-(?:mini|nano|pro))?(?:-\d{4}-\d{2}-\d{2})?$/u.test(
      normalizedModel,
    ) ||
    /^gpt-4\.1(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/u.test(
      normalizedModel,
    ) ||
    /^gpt-4o(?:-(?:mini))?(?:-\d{4}-\d{2}-\d{2})?$/u.test(
      normalizedModel,
    ) ||
    /^o[34](?:-(?:mini))?(?:-\d{4}-\d{2}-\d{2})?$/u.test(normalizedModel) ||
    normalizedModel === "computer-use-preview"
  );
};

const anthropicModelSupportsImageInput = (model: string): boolean => {
  const normalizedModel = normalizeModel(model);

  return (
    /^claude-3(?:-[\w-]+)?$/u.test(normalizedModel) ||
    /^claude-(?:opus|sonnet|haiku)-4(?:-[\w-]+)?$/u.test(normalizedModel)
  );
};

const googleModelSupportsImageInput = (model: string): boolean => {
  const normalizedModel = normalizeModel(model);

  return (
    normalizedModel.startsWith("gemini-") &&
    !/(?:embedding|imagen|veo|tts|audio)/u.test(normalizedModel)
  );
};

export const getImageInputMediaTypeForPath = (
  path: string,
): AgentModelImageMediaType | undefined => {
  const extension = getExtension(path);

  return extension ? IMAGE_EXTENSION_MEDIA_TYPES[extension] : undefined;
};

export const getSupportedImageInputExtensions = (
  provider: ModelProvider,
): string[] => {
  if (provider === "unconfigured") {
    return [];
  }

  const mediaTypes = PROVIDER_IMAGE_MEDIA_TYPES[provider];

  return Object.entries(IMAGE_EXTENSION_MEDIA_TYPES)
    .flatMap(([extension, mediaType]) =>
      mediaTypes.has(mediaType) ? [extension] : [],
    )
    .sort();
};

export const providerSupportsImageInputMediaType = (
  provider: ModelProvider,
  mediaType: AgentModelImageMediaType,
): boolean => {
  return provider !== "unconfigured"
    ? PROVIDER_IMAGE_MEDIA_TYPES[provider].has(mediaType)
    : false;
};

export const modelSupportsImageInput = (
  provider: ModelProvider,
  model: string,
): boolean => {
  switch (provider) {
    case "anthropic":
      return anthropicModelSupportsImageInput(model);
    case "google":
      return googleModelSupportsImageInput(model);
    case "openai":
      return openAIModelSupportsImageInput(model);
    case "unconfigured":
      return false;
  }
};

export const createImageInputUnsupportedModelMessage = (
  provider: ModelProvider,
  model: string,
): string => {
  if (provider === "unconfigured") {
    return "Image attachments require a configured model provider with image input support.";
  }

  return `Model \`${model}\` on provider \`${provider}\` does not support reading image attachments. Select a vision-capable model or remove the attached images.`;
};
