import type {
  MediaAssetRecord,
  MediaFlow,
  MediaNodeType,
  MediaRuntimeStatus,
} from "../../../core/media/contracts.js";
import { compileMediaFlow } from "../../../core/media/compiler.js";
import { resolveMediaFlowVariables } from "../../../core/media/variables.js";
import {
  hasMediaImageMaskContent,
  normalizeMediaImageMask,
} from "../../../core/media/image-mask.js";
interface RemoteEditExecutionAssessment {
  supported: boolean;
  reason: string;
  maskIncluded: boolean;
  manifest: Array<{
    assetId: string;
    digest: string;
    byteSize: number;
    role: string;
    influence: number;
  }>;
}

export const assessRemoteEditExecution = ({
  plan,
  flow,
  assets,
  runtimeMode,
  directReferenceImageModelIds,
}: {
  plan: ReturnType<typeof compileMediaFlow>;
  flow: MediaFlow;
  assets: readonly MediaAssetRecord[];
  runtimeMode: MediaRuntimeStatus["mode"] | null;
  directReferenceImageModelIds: readonly string[] | null;
}): RemoteEditExecutionAssessment => {
  const unavailable = (reason: string): RemoteEditExecutionAssessment => ({
    supported: false,
    reason,
    maskIncluded: false,
    manifest: [],
  });
  const resolvedFlow = resolveMediaFlowVariables(flow).flow;
  if (!resolvedFlow.nodes.some((node) => node.type === "task.edit-image")) {
    return unavailable("This flow does not contain a remote image-edit task.");
  }
  if (plan.status !== "ready") {
    return unavailable(
      "Resolve preflight diagnostics before using image references.",
    );
  }
  if (directReferenceImageModelIds === null) {
    return unavailable(
      "Checking whether the selected model can use image references.",
    );
  }
  if (!plan.model || !directReferenceImageModelIds.includes(plan.model.id)) {
    return unavailable(
      "The selected model runtime does not support image references yet.",
    );
  }
  if (plan.model.target !== "remote" || !plan.preflight.requiresRemoteRequest) {
    return unavailable(
      "The selected reference-image runtime is not available in this build.",
    );
  }
  const supportedNodeTypes = new Set<MediaNodeType>([
    "source.prompt",
    "source.image",
    "task.edit-image",
    "operation.subject-cutout",
    "output.asset",
  ]);
  const unsupported = resolvedFlow.nodes.find(
    (node) => !supportedNodeTypes.has(node.type),
  );
  if (unsupported) {
    return unavailable(
      `${unsupported.label} requires a separate executor; reference generation currently supports a one-shot edit followed directly by Save assets.`,
    );
  }
  const editNodes = resolvedFlow.nodes.filter(
    (node) => node.type === "task.edit-image",
  );
  const promptNodes = resolvedFlow.nodes.filter(
    (node) => node.type === "source.prompt",
  );
  const outputNodes = resolvedFlow.nodes.filter(
    (node) => node.type === "output.asset",
  );
  const sourceNodes = resolvedFlow.nodes.filter(
    (node) => node.type === "source.image",
  );
  if (
    editNodes.length !== 1 ||
    promptNodes.length !== 1 ||
    outputNodes.length !== 1 ||
    sourceNodes.length < 1 ||
    sourceNodes.length > 8
  ) {
    return unavailable(
      "Reference generation requires one prompt, one edit task, one output, and one to eight images.",
    );
  }
  const availableAssets = new Map(assets.map((asset) => [asset.id, asset]));
  const manifest = sourceNodes.map((node) => {
    const assetId = String(node.config.assetId ?? "");
    const asset = availableAssets.get(assetId);
    return asset
      ? {
          assetId,
          digest: asset.digest,
          byteSize: asset.byteSize,
          role: String(node.config.referenceRole ?? "base"),
          influence:
            typeof node.config.influence === "number"
              ? node.config.influence
              : 1,
        }
      : null;
  });
  if (manifest.some((item) => item === null)) {
    return unavailable(
      "Every reference must point to an available Library image.",
    );
  }
  const exactManifest = manifest.filter(
    (item): item is NonNullable<typeof item> => item !== null,
  );
  if (
    new Set(exactManifest.map((item) => item.assetId)).size !==
    exactManifest.length
  ) {
    return unavailable("Remove duplicate reference images before generation.");
  }
  if (exactManifest.filter((item) => item.role === "base").length > 1) {
    return unavailable("Choose one base image.");
  }
  exactManifest.sort((left, right) =>
    left.role === "base" ? -1 : right.role === "base" ? 1 : 0,
  );
  const maskIncluded = hasMediaImageMaskContent(
    normalizeMediaImageMask(editNodes[0]?.config.editMask),
  );
  return {
    supported: true,
    reason:
      runtimeMode === "browser-preview"
        ? "Runs a deterministic browser fixture with no upload or charge."
        : `Submits one paid ${plan.model.displayName} edit request with ${exactManifest.length} image${exactManifest.length === 1 ? "" : "s"}${maskIncluded ? " and a mask" : ""}.`,
    maskIncluded,
    manifest: exactManifest,
  };
};
