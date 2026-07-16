import type { MediaFlow } from "./contracts.js";

export const LOCAL_BIREFNET_MODEL_ID = "local:birefnet-matting";
export const LOCAL_BORDER_MATTE_MODEL_ID = "local:border-matte-v1";

export const DEFAULT_SUBJECT_CUTOUT_MODEL_PRIORITY = [
  LOCAL_BIREFNET_MODEL_ID,
  LOCAL_BORDER_MATTE_MODEL_ID,
] as const;

export const LEGACY_SUBJECT_CUTOUT_MODEL_PRIORITY = [
  LOCAL_BIREFNET_MODEL_ID,
] as const;

const MODEL_LABELS: Readonly<Record<string, string>> = {
  [LOCAL_BIREFNET_MODEL_ID]: "BiRefNet Matting",
  [LOCAL_BORDER_MATTE_MODEL_ID]: "Local Border Matte",
};

export const subjectCutoutModelLabel = (modelId: string): string =>
  MODEL_LABELS[modelId] ?? modelId;

export const readSubjectCutoutModelPriority = (
  config: Readonly<Record<string, unknown>>,
): string[] => {
  const configured = config.modelPriority;
  if (!Array.isArray(configured)) {
    return [...LEGACY_SUBJECT_CUTOUT_MODEL_PRIORITY];
  }
  return configured.filter(
    (modelId): modelId is string =>
      typeof modelId === "string" && modelId.trim().length > 0,
  );
};

export const readFlowSubjectCutoutModelPriority = (flow: MediaFlow): string[] => {
  const node = flow.nodes.find((candidate) => candidate.type === "operation.subject-cutout");
  return node ? readSubjectCutoutModelPriority(node.config) : [];
};
