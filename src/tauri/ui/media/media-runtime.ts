import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import { hash as sha256 } from "fast-sha256";
import { createMediaModelCatalogSnapshot } from "../../../core/media/catalog.js";
import {
  canonicalizeMediaValue,
  createMediaFlowDocumentDigest,
  createMediaFlowFingerprint,
  createMediaFlowLayoutDigest,
} from "../../../core/media/canonicalize.js";
import {
  createLocalBiRefNetInstallPlan,
  createLocalFluxInstallPlan,
  LOCAL_BIREFNET_INSTALL_FILES,
  LOCAL_BIREFNET_MODEL_ID,
  LOCAL_FLUX_INSTALL_FILES,
  LOCAL_FLUX_MODEL_ID,
} from "../../../core/media/model-install.js";
import { resolveMediaFlowVariables } from "../../../core/media/variables.js";
import type {
  ExecuteLocalImageFlowRequest,
  ExecuteRemoteImageEditFlowRequest,
  EnqueueFixtureRunRequest,
  EnqueueMockRemoteRunRequest,
  GenerateMediaImagesRequest,
  GenerateMediaSvgRequest,
  ExportMediaFlowRevisionRequest,
  ImportMediaFlowRequest,
  ImportMediaFlowResult,
  ImportMediaLocalModelRequest,
  ImportMediaModelAddonRequest,
  RemoveMediaModelAddonRequest,
  DownloadMediaCivitaiModelAddonRequest,
  InspectMediaFlowImportRequest,
  MediaAssetExportRecord,
  MediaAssetExportRequest,
  MediaAssetDeletionImpact,
  MediaAssetDeletionRequest,
  MediaAssetDeletionResult,
  MediaAssetRecord,
  MediaAssetTag,
  MediaAssetTagUpdate,
  MediaErrorAction,
  MediaErrorCode,
  MediaErrorDetail,
  MediaFlow,
  MediaFlowHead,
  MediaFlowHistory,
  MediaFlowExportResult,
  MediaFlowImportInspection,
  MediaHardwareInspection,
  MediaHumanReviewDecisionRequest,
  MediaHumanReviewRecord,
  MediaImageImportResult,
  MediaImageOutputFormat,
  MediaImageTransformRequest,
  MediaModelCatalogSnapshot,
  MediaLocalModelImportInspection,
  MediaLocalModelImportResult,
  MediaLocalModelRuntimeProbeResult,
  MediaModelAddonImportInspection,
  MediaModelAddonImportResult,
  MediaModelAddonRemovalPlan,
  MediaModelAddonRemovalResult,
  MediaCivitaiModelAddonInspection,
  MediaModelInstallJob,
  MediaModelInstallPlan,
  MediaModelRemovalPlan,
  MediaModelRemovalResult,
  MediaNodeExecutionRecord,
  MediaNodeExecutionStatus,
  MediaQualityAnalysisResult,
  MediaQualityObservation,
  MediaQualityReport,
  MediaProviderJobRecord,
  MediaProviderReviewAction,
  MediaRunDetail,
  MediaRunEvent,
  MediaRunPlanSnapshot,
  MediaRuntimeRunRecord,
  MediaRuntimeStatus,
  RemoveMediaModelRequest,
  SaveMediaFlowRevisionRequest,
  SaveMediaFlowRevisionResult,
  StartMediaModelInstallRequest,
} from "../../../core/media/contracts.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isMediaErrorAction = (value: unknown): value is MediaErrorAction =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.label === "string" &&
  typeof value.description === "string";

export const isMediaErrorDetail = (
  value: unknown,
): value is MediaErrorDetail =>
  isRecord(value) &&
  value.schemaVersion === 1 &&
  typeof value.code === "string" &&
  typeof value.category === "string" &&
  typeof value.message === "string" &&
  typeof value.technicalDiagnostic === "string" &&
  isRecord(value.context) &&
  typeof value.retryability === "string" &&
  typeof value.partialOutputsExist === "boolean" &&
  Array.isArray(value.suggestedActions) &&
  value.suggestedActions.every(isMediaErrorAction);

const sanitizeBrowserDiagnostic = (diagnostic: string): string => {
  const normalized = diagnostic
    .replaceAll(/https?:\/\/[^\s]+/gu, (url) => url.split(/[?#]/u, 1)[0] ?? "[redacted-url]")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return [...normalized].slice(0, 2_000).join("");
};

const fallbackCode = (diagnostic: string): MediaErrorCode => {
  const lower = diagnostic.toLowerCase();
  if (lower.includes("flow revision conflict")) {
    return "FLOW_REVISION_CONFLICT";
  }
  if (lower.includes("license") && lower.includes("accept")) {
    return "MODEL_LICENSE_REQUIRED";
  }
  if (lower.includes("not found")) {
    return "RESOURCE_NOT_FOUND";
  }
  if (lower.includes("expired") && lower.includes("result")) {
    return "REMOTE_OUTPUT_EXPIRED";
  }
  if (
    lower.includes("provider") &&
    (lower.includes("rejected") || lower.includes("failed"))
  ) {
    return "PROVIDER_REQUEST_FAILED";
  }
  if (lower.includes("native desktop app only")) {
    return "UNSUPPORTED_CAPABILITY";
  }
  if (lower.includes("outside") && lower.includes("path")) {
    return "PATH_NOT_ALLOWED";
  }
  if (lower.includes("format")) {
    return "UNSUPPORTED_FORMAT";
  }
  if (lower.includes("dimension") || lower.includes("pixel")) {
    return "UNSUPPORTED_DIMENSIONS";
  }
  if (
    lower.includes("invalid") ||
    lower.includes("must be") ||
    lower.includes("limited to") ||
    lower.includes("requires")
  ) {
    return "INVALID_REQUEST";
  }
  return "INTERNAL_ERROR";
};

const fallbackPresentation = (
  code: MediaErrorCode,
): Pick<
  MediaErrorDetail,
  "category" | "message" | "retryability" | "suggestedActions"
> => {
  switch (code) {
    case "FLOW_REVISION_CONFLICT":
      return {
        category: "integrity",
        message: "This flow changed since its revision history was loaded.",
        retryability: "reconcile-first",
        suggestedActions: [
          {
            id: "refresh",
            label: "Refresh",
            description: "Reload the current flow head before saving again.",
          },
        ],
      };
    case "MODEL_LICENSE_REQUIRED":
      return {
        category: "configuration",
        message: "Model access requires review before this operation can continue.",
        retryability: "after-user-action",
        suggestedActions: [
          {
            id: "open-models",
            label: "Review model",
            description: "Review the model license and access requirements.",
          },
        ],
      };
    case "RESOURCE_NOT_FOUND":
      return {
        category: "storage",
        message: "The requested media item is no longer available.",
        retryability: "after-user-action",
        suggestedActions: [
          {
            id: "refresh",
            label: "Refresh",
            description: "Reload the durable Media Studio state before trying again.",
          },
        ],
      };
    case "PATH_NOT_ALLOWED":
      return {
        category: "storage",
        message: "Media Studio cannot use that file location.",
        retryability: "after-user-action",
        suggestedActions: [
          {
            id: "choose-location",
            label: "Choose another location",
            description: "Select a user-approved file or export destination.",
          },
        ],
      };
    case "REMOTE_OUTPUT_EXPIRED":
      return {
        category: "provider",
        message: "The remote result expired before it could be ingested.",
        retryability: "user-approval-required",
        suggestedActions: [
          {
            id: "review-run",
            label: "Review rerun",
            description: "Review cost and inputs before creating a replacement provider request.",
          },
        ],
      };
    case "PROVIDER_REQUEST_FAILED":
      return {
        category: "provider",
        message: "The remote provider did not complete the media request.",
        retryability: "user-approval-required",
        suggestedActions: [
          {
            id: "review-run",
            label: "Review provider job",
            description: "Inspect the terminal provider state and cost record before creating a new attempt.",
          },
        ],
      };
    case "UNSUPPORTED_CAPABILITY":
    case "UNSUPPORTED_DIMENSIONS":
    case "UNSUPPORTED_FORMAT":
      return {
        category: "capability",
        message: "This media operation is not supported in the current runtime.",
        retryability: "after-user-action",
        suggestedActions: [
          {
            id: "review-input",
            label: "Review compatibility",
            description: "Choose a compatible runtime, dimensions, format, or preset.",
          },
        ],
      };
    case "INVALID_REQUEST":
      return {
        category: "validation",
        message: "Some media settings are invalid.",
        retryability: "after-user-action",
        suggestedActions: [
          {
            id: "review-input",
            label: "Review settings",
            description: "Correct the input or choose a compatible preset.",
          },
        ],
      };
    default:
      return {
        category: "internal",
        message: "Media Studio could not complete the operation.",
        retryability: "retry-safe",
        suggestedActions: [
          {
            id: "refresh",
            label: "Refresh",
            description: "Reload the durable Media Studio state before trying again.",
          },
        ],
      };
  }
};

export const normalizeMediaError = (
  error: unknown,
  operation: string,
): MediaErrorDetail => {
  if (error instanceof MediaRuntimeError) {
    return error.detail;
  }
  if (isMediaErrorDetail(error)) {
    return structuredClone(error);
  }
  const diagnostic =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unknown Media Studio failure";
  const code = fallbackCode(diagnostic);
  return {
    schemaVersion: 1,
    code,
    ...fallbackPresentation(code),
    technicalDiagnostic: sanitizeBrowserDiagnostic(diagnostic),
    context: {
      nodeId: null,
      providerId: null,
      modelId: null,
      runtimeId: null,
      runId: null,
      assetId: null,
      operation,
    },
    partialOutputsExist: false,
  };
};

export class MediaRuntimeError extends Error {
  readonly detail: MediaErrorDetail;

  constructor(detail: MediaErrorDetail, cause?: unknown) {
    super(detail.message, { cause });
    this.name = "MediaRuntimeError";
    this.detail = detail;
  }
}

const invoke = async <T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> => {
  try {
    return await tauriInvoke<T>(command, args);
  } catch (error: unknown) {
    throw new MediaRuntimeError(normalizeMediaError(error, command), error);
  }
};

const browserRuns = new Map<string, MediaRunDetail>();
const browserFlowHistories = new Map<string, MediaFlowHistory>();
const browserFlowSaveRequests = new Map<
  string,
  { requestDigest: string; revisionId: string }
>();
const browserRequests = new Map<string, EnqueueFixtureRunRequest>();
const browserProviderRequests = new Map<string, EnqueueMockRemoteRunRequest>();
const browserProviderCancellations = new Set<string>();
const browserEditSourceAssets = new Map<string, string[]>();
const browserAttempts = new Map<string, number>();
const browserQualityReports = new Map<string, MediaQualityReport>();
const browserModelInstallJobs = new Map<string, MediaModelInstallJob>();
let browserLocalFluxInstalled = false;
let browserLocalBiRefNetInstalled = false;
let nextBrowserModelInstallId = 1;
let nextBrowserEventId = 1;

const createBrowserDigest = (value: unknown): string => {
  const bytes = sha256(
    new TextEncoder().encode(JSON.stringify(canonicalizeMediaValue(value))),
  );
  return `sha256:${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
};

const browserFlowHistory = (flowId: string): MediaFlowHistory => {
  const existing = browserFlowHistories.get(flowId);
  if (existing) {
    return existing;
  }
  const history: MediaFlowHistory = {
    schemaVersion: 1,
    flowId,
    head: null,
    revisions: [],
  };
  browserFlowHistories.set(flowId, history);
  return history;
};

const browserFlowConflict = (diagnostic: string): MediaRuntimeError =>
  new MediaRuntimeError(
    normalizeMediaError(`flow revision conflict: ${diagnostic}`, "media_save_flow_revision"),
  );

const validateBrowserRunFlowRevision = (
  request: EnqueueFixtureRunRequest,
): void => {
  if (!request.flowRevisionId) {
    return;
  }
  const revision = browserFlowHistories
    .get(request.flowId)
    ?.revisions.find(
      (candidate) => candidate.revisionId === request.flowRevisionId,
    );
  if (!revision) {
    throw new Error(`Flow revision ${request.flowRevisionId} was not found.`);
  }
  if (
    !request.planSnapshot ||
    request.planSnapshot.flowId !== request.flowId ||
    request.planSnapshot.flowFingerprint !== revision.executionDigest
  ) {
    throw new Error(
      "Run flow revision execution digest does not match the compiled plan.",
    );
  }
};

const validateExistingBrowserRunIdentity = (
  existing: MediaRunDetail,
  request: EnqueueFixtureRunRequest,
  executor: MediaRunDetail["executor"],
): void => {
  if (
    existing.flowId !== request.flowId ||
    existing.flowRevisionId !== request.flowRevisionId ||
    existing.planId !== request.planId ||
    existing.executor !== executor
  ) {
    throw new Error(
      "Run idempotency conflict: runId was reused with different immutable inputs.",
    );
  }
};

const canInvokeNativeRuntime = (): boolean => {
  return (
    typeof window !== "undefined" &&
    isTauri() &&
    "__TAURI_INTERNALS__" in window
  );
};

export const supportsNativeMediaImport = (): boolean =>
  canInvokeNativeRuntime();

export const supportsNativeMediaExport = (): boolean =>
  canInvokeNativeRuntime();

export const supportsNativeMediaFlowPortability = (): boolean =>
  canInvokeNativeRuntime();

export const supportsNativeMediaModelImport = (): boolean =>
  canInvokeNativeRuntime();

export const supportsNativeMediaModelAddonImport = (): boolean =>
  canInvokeNativeRuntime();

export const supportsNativeMediaModelProbe = (): boolean =>
  canInvokeNativeRuntime();

const clone = <T>(value: T): T => structuredClone(value);

const now = (): string => new Date().toISOString();

const digestFixtureMetadata = (
  request: EnqueueFixtureRunRequest,
  outputIndex: number,
): string => {
  const bytes = sha256(
    new TextEncoder().encode(
      `machdoch-browser-fixture-v1\0${outputIndex}\0${request.prompt}`,
    ),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
};

const dimensions = (
  aspectRatio: EnqueueFixtureRunRequest["aspectRatio"],
): readonly [number, number] => {
  switch (aspectRatio) {
    case "4:5":
      return [384, 480];
    case "16:9":
      return [512, 288];
    case "9:16":
      return [288, 512];
    default:
      return [384, 384];
  }
};

const mimeTypeForFormat = (
  format: MediaImageTransformRequest["outputFormat"],
): MediaAssetRecord["mimeType"] => {
  switch (format) {
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
};

const isMediaImageOutputFormat = (
  value: string,
): value is MediaImageOutputFormat =>
  value === "png" || value === "jpeg" || value === "webp";

const appendBrowserEvent = (
  detail: MediaRunDetail,
  event: Omit<
    MediaRunEvent,
    "id" | "runId" | "sequence" | "createdAt" | "nodeId"
  > & { nodeId?: string | null },
): void => {
  const { nodeId = null, ...eventData } = event;
  detail.events.push({
    id: nextBrowserEventId++,
    runId: detail.id,
    sequence: detail.events.length + 1,
    createdAt: now(),
    nodeId,
    ...eventData,
  });
};

const seedBrowserNodeExecutions = (
  runId: string,
  snapshot: MediaRunPlanSnapshot | null,
  status: MediaNodeExecutionStatus = "pending",
): MediaNodeExecutionRecord[] => {
  if (!snapshot) return [];
  const timestamp = now();
  return snapshot.nodes.map((node, ordinal) => {
    const steps = snapshot.steps.filter((step) => step.sourceNodeId === node.id);
    const terminal = ["completed", "cached", "skipped", "failed", "canceled"].includes(status);
    return {
      runId,
      nodeId: node.id,
      nodeType: node.type,
      nodeLabel: node.label,
      ordinal,
      status,
      activeStepId: terminal ? steps.at(-1)?.id ?? null : null,
      runtimePhase: null,
      attempt: status === "running" ? 1 : 0,
      progress: status === "completed" ? 1 : null,
      message: null,
      startedAt: terminal ? timestamp : null,
      updatedAt: timestamp,
      finishedAt: terminal ? timestamp : null,
      stateSequence: 0,
    };
  });
};

const transitionBrowserNode = (
  detail: MediaRunDetail,
  nodeId: string,
  status: MediaNodeExecutionStatus,
  runtimePhase: string,
  message: string,
  progress: number | null,
): void => {
  const execution = detail.nodeExecutions.find((candidate) => candidate.nodeId === nodeId);
  if (!execution) return;
  const timestamp = now();
  const terminal = ["completed", "cached", "skipped", "failed", "canceled"].includes(status);
  const steps = detail.planSnapshot?.steps.filter((step) => step.sourceNodeId === nodeId) ?? [];
  if (status === "running" && execution.status !== "running") execution.attempt += 1;
  execution.status = status;
  execution.activeStepId = terminal
    ? steps.at(-1)?.id ?? null
    : steps.at(0)?.id ?? null;
  execution.runtimePhase = runtimePhase;
  execution.progress = progress;
  execution.message = message;
  execution.startedAt ??= timestamp;
  execution.updatedAt = timestamp;
  execution.finishedAt = terminal ? timestamp : null;
  execution.stateSequence += 1;
  detail.currentStep = message;
  detail.updatedAt = timestamp;
  if (progress !== null) detail.progress = progress;
  appendBrowserEvent(detail, {
    kind: "node_state_changed",
    message,
    progress,
    stepId: execution.activeStepId,
    nodeId,
  });
};

const transitionBrowserNodesByType = (
  detail: MediaRunDetail,
  nodeTypes: readonly string[],
  status: MediaNodeExecutionStatus,
  runtimePhase: string,
  message: string,
  progress: number | null,
): void => {
  const wanted = new Set(nodeTypes);
  detail.nodeExecutions
    .filter((execution) => wanted.has(execution.nodeType))
    .forEach((execution) =>
      transitionBrowserNode(
        detail,
        execution.nodeId,
        status,
        runtimePhase,
        message,
        progress,
      ),
    );
};

const finalizeBrowserNodes = (
  detail: MediaRunDetail,
  status: Extract<MediaNodeExecutionStatus, "completed" | "failed" | "canceled">,
): void => {
  detail.nodeExecutions.forEach((execution) => {
    const shouldTransition = status === "completed"
      ? !["completed", "cached", "skipped", "failed", "canceled"].includes(execution.status)
      : ["queued", "running", "retrying", "waiting-for-review", "blocked"].includes(execution.status);
    if (shouldTransition) {
      transitionBrowserNode(
        detail,
        execution.nodeId,
        status,
        "run.finalize",
        status === "completed" ? `Completed ${execution.nodeLabel}` : `${status} ${execution.nodeLabel}`,
        status === "completed" ? 1 : null,
      );
    }
  });
};

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));
};

const hasRunStatus = (
  detail: MediaRunDetail,
  status: MediaRunDetail["status"],
): boolean => detail.status === status;

const browserRunFailure = (
  detail: MediaRunDetail,
  diagnostic: string,
  operation: string,
  providerId: string | null = null,
): MediaErrorDetail => {
  const failure = normalizeMediaError(diagnostic, operation);
  return {
    ...failure,
    context: {
      ...failure.context,
      providerId,
      runId: detail.id,
    },
    partialOutputsExist: detail.assets.length > 0,
  };
};

const finalizeBrowserCancellation = (detail: MediaRunDetail): void => {
  finalizeBrowserNodes(detail, "canceled");
  detail.status = "canceled";
  detail.currentStep = "Canceled";
  detail.updatedAt = now();
  appendBrowserEvent(detail, {
    kind: "run_canceled",
    message: "Browser fixture preview stopped at a safe checkpoint.",
    progress: detail.progress,
    stepId: "cancel",
  });
};

const beginBrowserHumanReview = (detail: MediaRunDetail): boolean => {
  const reviewSteps =
    detail.planSnapshot?.steps.filter(
      (step) => step.kind === "wait-for-review" && step.review,
    ) ?? [];
  if (reviewSteps.length === 0) {
    return false;
  }
  const timestamp = now();
  const candidateAssetIds = detail.assets.map((asset) => asset.id);
  detail.humanReviews = reviewSteps.map((step, index) => {
    const review = step.review;
    if (!review) {
      throw new Error(`Review contract is missing from ${step.id}.`);
    }
    return {
      id: `human-review:${detail.id}:${step.id}`,
      runId: detail.id,
      nodeId: step.sourceNodeId,
      sequence: index + 1,
      status: index === 0 ? "pending" : "queued",
      ...review,
      candidateAssetIds: index === 0 ? candidateAssetIds : [],
      selectedAssetIds: [],
      decisionId: null,
      decisionAction: null,
      comment: null,
      actor: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      decidedAt: null,
    } satisfies MediaHumanReviewRecord;
  });
  const firstReview = detail.humanReviews[0];
  if (!firstReview) {
    return false;
  }
  detail.status = "waiting-for-review";
  detail.progress = 0.96;
  detail.currentStep = "Waiting for human review";
  detail.updatedAt = timestamp;
  transitionBrowserNode(
    detail,
    firstReview.nodeId,
    "waiting-for-review",
    "human.review",
    "Waiting for human review",
    0.96,
  );
  appendBrowserEvent(detail, {
    kind: "human_review_requested",
    message: `${candidateAssetIds.length} candidates are ready; approve up to ${firstReview.maxSelections}. Compute leases were released while the run waits.`,
    progress: 0.96,
    stepId: firstReview.nodeId,
  });
  return true;
};

const executeBrowserFixture = async (
  request: EnqueueFixtureRunRequest,
): Promise<void> => {
  await wait(140);
  const detail = browserRuns.get(request.runId);
  if (!detail) {
    return;
  }
  if (hasRunStatus(detail, "canceling")) {
    finalizeBrowserCancellation(detail);
    return;
  }
  if (detail.status !== "queued") {
    return;
  }

  browserAttempts.set(
    request.runId,
    (browserAttempts.get(request.runId) ?? 0) + 1,
  );
  detail.status = "running";
  detail.progress = 0.02;
  detail.currentStep = "Preparing browser fixture preview";
  detail.updatedAt = now();
  appendBrowserEvent(detail, {
    kind: "run_started",
    message: "Browser preview executor claimed the fixture job.",
    progress: 0.02,
    stepId: "fixture.prepare",
  });
  transitionBrowserNodesByType(
    detail,
    ["source.prompt", "source.image"],
    "completed",
    "fixture.resolve-inputs",
    "Fixture inputs resolved",
    0.05,
  );
  transitionBrowserNodesByType(
    detail,
    ["task.generate-image", "task.edit-image"],
    "running",
    "fixture.generate",
    "Generating browser fixture output",
    0.08,
  );

  const [width, height] = dimensions(request.aspectRatio);
  for (let outputIndex = 0; outputIndex < request.outputCount; outputIndex += 1) {
    await wait(280);
    if (hasRunStatus(detail, "canceling")) {
      finalizeBrowserCancellation(detail);
      return;
    }

    if (detail.assets.some((asset) => asset.outputIndex === outputIndex)) {
      continue;
    }

    const asset: MediaAssetRecord = {
      id: `asset:${request.runId}:${outputIndex}`,
      runId: request.runId,
      digest: digestFixtureMetadata(request, outputIndex),
      kind: "image",
      mimeType: "image/png",
      byteSize: width * height * 2 + outputIndex * 97,
      width,
      height,
      createdAt: now(),
      outputIndex,
      fixture: true,
      operation: null,
      sourceAssetIds: browserEditSourceAssets.get(request.runId) ?? [],
      tags: [],
    };
    detail.assets.push(asset);
    detail.progress =
      0.05 + ((outputIndex + 1) / request.outputCount) * 0.9;
    detail.currentStep = `Published preview output ${outputIndex + 1} of ${request.outputCount}`;
    detail.updatedAt = now();
    appendBrowserEvent(detail, {
      kind: "asset_published",
      message: `Preview output ${outputIndex + 1} was registered with deterministic metadata.`,
      progress: detail.progress,
      stepId: "fixture.ingest",
    });
  }

  await wait(120);
  transitionBrowserNodesByType(
    detail,
    ["task.generate-image", "task.edit-image"],
    "completed",
    "fixture.generate",
    "Fixture outputs generated",
    0.94,
  );
  if (beginBrowserHumanReview(detail)) {
    return;
  }
  finalizeBrowserNodes(detail, "completed");
  detail.status = "completed";
  detail.progress = 1;
  detail.currentStep = "Completed";
  detail.updatedAt = now();
  appendBrowserEvent(detail, {
    kind: "run_completed",
    message: "Browser fixture preview completed. Native mode additionally writes PNG bytes to CAS.",
    progress: 1,
    stepId: "finalize",
  });
};

const enqueueBrowserFixture = (
  request: EnqueueFixtureRunRequest,
): MediaRunDetail => {
  const existing = browserRuns.get(request.runId);
  if (existing) {
    validateExistingBrowserRunIdentity(
      existing,
      request,
      "deterministic-fixture",
    );
    return clone(existing);
  }

  const createdAt = now();
  const detail: MediaRunDetail = {
    id: request.runId,
    flowId: request.flowId,
    flowRevisionId: request.flowRevisionId,
    flowName: request.flowName,
    planId: request.planId,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    prompt: request.prompt,
    modelLabel: request.modelLabel,
    target: request.target,
    outputCount: request.outputCount,
    diagnosticCount: request.diagnosticCount,
    progress: 0,
    currentStep: "Waiting for browser fixture preview",
    executor: "deterministic-fixture",
    error: null,
    failure: null,
    events: [],
    assets: [],
    providerJobs: [],
    humanReviews: [],
    nodeExecutions: seedBrowserNodeExecutions(
      request.runId,
      request.planSnapshot ? clone(request.planSnapshot) : null,
    ),
    planSnapshot: request.planSnapshot ? clone(request.planSnapshot) : null,
  };
  appendBrowserEvent(detail, {
    kind: "run_queued",
    message: "Deterministic fixture preview was added to the in-memory browser queue.",
    progress: 0,
    stepId: "queue",
  });
  browserRuns.set(request.runId, detail);
  browserRequests.set(request.runId, clone(request));
  browserAttempts.set(request.runId, 0);
  void executeBrowserFixture(request);
  return clone(detail);
};

const browserProviderPolicy = (
  request: EnqueueMockRemoteRunRequest,
): MediaProviderJobRecord["policy"] => ({
  adapterId: "mock.remote-image",
  adapterVersion: "1.0.0",
  endpointVersion: "fixture-2026-07-14",
  region: "fixture-local",
  idempotencyMode: "provider-key",
  retryPolicy:
    "No resubmission after possible acceptance; reconcile by idempotency key first.",
  cancellationSemantics:
    "Best effort. Late success is still ingested and visibly flagged.",
  inputRetentionSeconds: 0,
  outputRetentionSeconds: 3_600,
  outputVisibility: "private-signed-url",
  publicLinks: false,
  noStoreRequested: true,
  uploadAssetCount: 0,
  uploadBytes: 0,
  containsPersonalData: false,
  remoteUploadAllowed: request.allowRemoteUpload,
});

const continueBrowserRemoteAfterAcceptance = async (
  detail: MediaRunDetail,
  request: EnqueueMockRemoteRunRequest,
  providerJob: MediaProviderJobRecord,
): Promise<void> => {
  const cancellationRequested = (): boolean =>
    browserProviderCancellations.has(detail.id);
  await wait(180);
  providerJob.status = cancellationRequested() ? "cancel-requested" : "queued";
  providerJob.rawState = "queued";
  providerJob.pollAttempts += 1;
  providerJob.nextPollAt = new Date(Date.now() + 180).toISOString();
  providerJob.updatedAt = now();
  detail.progress = 0.28;
  detail.currentStep = "Provider queued request";
  detail.updatedAt = now();
  appendBrowserEvent(detail, {
    kind: "provider_reconciled",
    message: "Provider state reconciled as queued; the next poll time is durable in native mode.",
    progress: 0.28,
    stepId: "provider.poll",
  });

  await wait(220);
  providerJob.status = cancellationRequested() ? "cancel-requested" : "running";
  providerJob.rawState = "processing";
  providerJob.pollAttempts += 1;
  providerJob.nextPollAt = new Date(Date.now() + 180).toISOString();
  providerJob.updatedAt = now();
  detail.progress = 0.56;
  detail.currentStep = "Provider is processing";
  detail.updatedAt = now();
  appendBrowserEvent(detail, {
    kind: "provider_reconciled",
    message: "Provider state reconciled as running with a bounded deadline.",
    progress: 0.56,
    stepId: "provider.poll",
  });

  await wait(240);
  if (cancellationRequested() && request.scenario !== "cancel-race-success") {
    providerJob.status = "cancelled";
    providerJob.rawState = "cancelled";
    providerJob.nextPollAt = null;
    providerJob.completedAt = now();
    providerJob.updatedAt = providerJob.completedAt;
    finalizeBrowserCancellation(detail);
    return;
  }
  if (request.scenario === "provider-failure") {
    providerJob.status = "failed";
    providerJob.rawState = "rejected";
    providerJob.error = "Mock provider rejected the prepared request.";
    providerJob.failure = browserRunFailure(
      detail,
      providerJob.error,
      "provider_job",
      "mock-remote",
    );
    providerJob.completedAt = now();
    providerJob.updatedAt = providerJob.completedAt;
    detail.status = "failed";
    detail.error = providerJob.error;
    detail.failure = providerJob.failure;
    detail.currentStep = "Provider failed";
    detail.updatedAt = now();
    finalizeBrowserNodes(detail, "failed");
    appendBrowserEvent(detail, {
      kind: "provider_failed",
      message: "The normalized refusal was preserved without exposing a provider response body.",
      progress: detail.progress,
      stepId: "provider.finalize",
    });
    return;
  }
  if (request.scenario === "result-expired") {
    providerJob.status = "expired";
    providerJob.rawState = "expired";
    providerJob.error = "Provider result retention window expired.";
    providerJob.failure = browserRunFailure(
      detail,
      providerJob.error,
      "provider_job",
      "mock-remote",
    );
    providerJob.completedAt = now();
    providerJob.updatedAt = providerJob.completedAt;
    detail.status = "failed";
    detail.error = providerJob.error;
    detail.failure = providerJob.failure;
    detail.currentStep = "Provider result expired";
    detail.updatedAt = now();
    finalizeBrowserNodes(detail, "failed");
    appendBrowserEvent(detail, {
      kind: "provider_failed",
      message: "The result expired; automatic resubmission remains blocked because the original request may have been charged.",
      progress: detail.progress,
      stepId: "provider.finalize",
    });
    return;
  }

  const lateSuccess = cancellationRequested();
  providerJob.status = "succeeded-download-pending";
  providerJob.rawState = "succeeded";
  providerJob.lateSuccess = lateSuccess;
  providerJob.nextPollAt = now();
  providerJob.updatedAt = now();
  detail.status = "running";
  detail.progress = 0.72;
  detail.currentStep = "Downloading provider output";
  detail.updatedAt = now();
  transitionBrowserNodesByType(
    detail,
    ["task.generate-image", "task.edit-image"],
    "completed",
    "provider.output",
    "Provider output is ready",
    0.72,
  );
  appendBrowserEvent(detail, {
    kind: lateSuccess ? "provider_late_success" : "provider_output_pending",
    message: lateSuccess
      ? "The provider completed after cancellation was requested. The paid result will still be ingested."
      : "Provider success was observed and queued for immediate bounded ingestion.",
    progress: 0.72,
    stepId: "provider.output",
  });

  await wait(180);
  providerJob.status = "downloading";
  providerJob.rawState = "downloading-signed-result";
  providerJob.updatedAt = now();
  detail.progress = 0.8;
  detail.currentStep = "Verifying provider output";
  detail.updatedAt = now();
  appendBrowserEvent(detail, {
    kind: "provider_download_started",
    message: "A bounded download began; provider URLs remain outside renderer state.",
    progress: 0.8,
    stepId: "provider.download",
  });

  const [width, height] = dimensions(request.aspectRatio);
  for (let outputIndex = 0; outputIndex < request.outputCount; outputIndex += 1) {
    const asset: MediaAssetRecord = {
      id: `asset:${request.runId}:${outputIndex}`,
      runId: request.runId,
      digest: digestFixtureMetadata(request, outputIndex),
      kind: "image",
      mimeType: "image/png",
      byteSize: width * height * 2 + outputIndex * 97,
      width,
      height,
      createdAt: now(),
      outputIndex,
      fixture: true,
      operation: null,
      sourceAssetIds: [],
      tags: [],
    };
    detail.assets.push(asset);
    detail.progress = 0.8 + ((outputIndex + 1) / request.outputCount) * 0.15;
    appendBrowserEvent(detail, {
      kind: "asset_published",
      message: `Provider output ${outputIndex + 1} passed bounded decode, hashing, and CAS simulation.`,
      progress: detail.progress,
      stepId: "provider.ingest",
    });
  }
  providerJob.status = "completed";
  providerJob.rawState = "completed";
  providerJob.nextPollAt = null;
  providerJob.completedAt = now();
  providerJob.updatedAt = providerJob.completedAt;
  if (beginBrowserHumanReview(detail)) {
    return;
  }
  finalizeBrowserNodes(detail, "completed");
  detail.status = "completed";
  detail.progress = 1;
  detail.currentStep = lateSuccess ? "Completed after cancellation race" : "Completed";
  detail.updatedAt = now();
  appendBrowserEvent(detail, {
    kind: "run_completed",
    message: "Provider outputs were ingested before expiry; playback no longer depends on provider URLs.",
    progress: 1,
    stepId: "provider.finalize",
  });
};

const executeBrowserRemote = async (
  detail: MediaRunDetail,
  request: EnqueueMockRemoteRunRequest,
): Promise<void> => {
  const providerJob = detail.providerJobs.at(-1);
  if (!providerJob) return;
  await wait(140);
  if (
    browserProviderCancellations.has(detail.id) &&
    request.scenario !== "cancel-race-success"
  ) {
    providerJob.status = "cancelled";
    providerJob.rawState = "cancelled-before-submit";
    providerJob.completedAt = now();
    providerJob.updatedAt = providerJob.completedAt;
    finalizeBrowserCancellation(detail);
    return;
  }
  providerJob.status = "submitting";
  providerJob.rawState = "submitting";
  providerJob.updatedAt = now();
  detail.status = browserProviderCancellations.has(detail.id)
    ? "canceling"
    : "running";
  detail.progress = 0.08;
  detail.currentStep = "Submitting prepared provider request";
  detail.updatedAt = now();
  appendBrowserEvent(detail, {
    kind: "provider_submission_started",
    message: "The prepared request was sent exactly once with its persisted idempotency key.",
    progress: 0.08,
    stepId: "provider.submit",
  });
  transitionBrowserNodesByType(
    detail,
    ["source.prompt", "source.image"],
    "completed",
    "provider.resolve-inputs",
    "Provider inputs resolved",
    0.05,
  );
  transitionBrowserNodesByType(
    detail,
    ["task.generate-image", "task.edit-image"],
    "running",
    "provider.submit",
    "Submitting prepared provider request",
    0.08,
  );

  await wait(180);
  if (request.scenario === "acceptance-unknown") {
    providerJob.status = "acceptance-unknown";
    providerJob.rawState = "transport-disconnected";
    providerJob.reviewRequired = true;
    providerJob.reviewReason =
      "The transport disconnected after the provider may have accepted and charged the request.";
    providerJob.updatedAt = now();
    detail.status = "needs-review";
    detail.progress = 0.12;
    detail.currentStep = "Provider acceptance requires review";
    detail.updatedAt = now();
    transitionBrowserNodesByType(
      detail,
      ["task.generate-image", "task.edit-image"],
      "blocked",
      "provider.acceptance-unknown",
      "Provider acceptance requires review",
      0.12,
    );
    appendBrowserEvent(detail, {
      kind: "provider_acceptance_unknown",
      message: "Possible paid acceptance is unresolved. Automatic resubmission is blocked.",
      progress: 0.12,
      stepId: "provider.acceptance",
    });
    return;
  }

  const acceptedAt = now();
  providerJob.status = "accepted";
  providerJob.rawState = "accepted";
  providerJob.providerJobId = `mock-job-${detail.id}`;
  providerJob.providerRequestId = `mock-request-${detail.id}`;
  providerJob.acceptedAt = acceptedAt;
  providerJob.retentionExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
  providerJob.nextPollAt = acceptedAt;
  providerJob.updatedAt = acceptedAt;
  detail.status = browserProviderCancellations.has(detail.id)
    ? "canceling"
    : "running";
  detail.progress = 0.18;
  detail.currentStep = "Provider accepted request";
  detail.updatedAt = acceptedAt;
  appendBrowserEvent(detail, {
    kind: "provider_accepted",
    message: "Acceptance, identifiers, cost exposure, and result retention were persisted immediately.",
    progress: 0.18,
    stepId: "provider.acceptance",
  });
  await continueBrowserRemoteAfterAcceptance(detail, request, providerJob);
};

const enqueueBrowserRemote = (
  request: EnqueueMockRemoteRunRequest,
): MediaRunDetail => {
  const existing = browserRuns.get(request.runId);
  if (existing) {
    validateExistingBrowserRunIdentity(existing, request, "mock-remote-provider");
    return clone(existing);
  }
  const createdAt = now();
  const digest = digestFixtureMetadata(request, 0);
  const providerJob: MediaProviderJobRecord = {
    id: `provider:${request.runId}:1`,
    runId: request.runId,
    attempt: 1,
    status: "prepared",
    rawState: null,
    scenario: request.scenario,
    requestDigest: digest,
    idempotencyKey: `media-${digest.slice(0, 24)}-1`,
    providerJobId: null,
    providerRequestId: null,
    estimatedCostMin: 0.02,
    estimatedCostMax: 0.04,
    currency: "USD",
    pollAttempts: 0,
    nextPollAt: null,
    reconciliationDeadline: new Date(Date.now() + 600_000).toISOString(),
    acceptedAt: null,
    retentionExpiresAt: null,
    lateSuccess: false,
    reviewRequired: false,
    reviewReason: null,
    error: null,
    failure: null,
    policy: browserProviderPolicy(request),
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  };
  const detail: MediaRunDetail = {
    id: request.runId,
    flowId: request.flowId,
    flowRevisionId: request.flowRevisionId,
    flowName: request.flowName,
    planId: request.planId,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    prompt: request.prompt,
    modelLabel: "Mock Remote Image v1",
    target: "remote",
    outputCount: request.outputCount,
    diagnosticCount: request.diagnosticCount,
    progress: 0.01,
    currentStep: "Provider request prepared",
    executor: "mock-remote-provider",
    error: null,
    failure: null,
    events: [],
    assets: [],
    providerJobs: [providerJob],
    humanReviews: [],
    nodeExecutions: seedBrowserNodeExecutions(
      request.runId,
      request.planSnapshot ? clone(request.planSnapshot) : null,
    ),
    planSnapshot: request.planSnapshot ? clone(request.planSnapshot) : null,
  };
  appendBrowserEvent(detail, {
    kind: "provider_prepared",
    message: "A redacted request, cost range, policy snapshot, and idempotency decision were recorded before submission.",
    progress: 0.01,
    stepId: "provider.prepare",
  });
  browserRuns.set(request.runId, detail);
  browserProviderRequests.set(request.runId, clone(request));
  void executeBrowserRemote(detail, request);
  return clone(detail);
};

export const initializeMediaRuntime = async (): Promise<MediaRuntimeStatus> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRuntimeStatus>("media_initialize_runtime");
  }
  const runs = [...browserRuns.values()];
  return {
    schemaVersion: 21,
    recoveredRuns: 0,
    queuedRuns: runs.filter((run) => run.status === "queued").length,
    activeRuns: runs.filter((run) =>
      ["queued", "running", "canceling"].includes(run.status),
    ).length,
    storageReady: true,
    mode: "browser-preview",
    directGenerationModelIds: ["openai:gpt-image-2"],
    directReferenceImageModelIds: ["openai:gpt-image-2"],
    localDiffusers: {
      status: "unavailable",
      ready: false,
      workerVersion: null,
      pythonVersion: null,
      packages: {},
      device: null,
      deviceLabel: null,
      deviceMemoryBytes: null,
      architectures: [],
      capabilities: [],
      diagnostic: "Local Diffusers execution is available in the native desktop app only.",
    },
  };
};

export const getMediaModelCatalog = async (
  configuredProviderIds: readonly string[],
): Promise<MediaModelCatalogSnapshot> => {
  const normalizedProviderIds = [
    ...new Set(
      configuredProviderIds
        .map((providerId) => providerId.trim())
        .filter((providerId) => providerId.length > 0),
    ),
  ];
  if (
    normalizedProviderIds.length > 32 ||
    normalizedProviderIds.some((providerId) => providerId.length > 64)
  ) {
    throw new Error("Configured media provider identifiers are invalid.");
  }
  if (canInvokeNativeRuntime()) {
    return invoke<MediaModelCatalogSnapshot>("media_get_model_catalog", {
      configuredProviderIds: normalizedProviderIds,
    });
  }
  return clone(
    createMediaModelCatalogSnapshot({
      isOpenAiConfigured: normalizedProviderIds.includes("openai"),
      isLocalFluxInstalled: browserLocalFluxInstalled,
      isLocalBiRefNetInstalled: browserLocalBiRefNetInstalled,
    }),
  );
};

const advanceBrowserModelInstall = (
  job: MediaModelInstallJob,
): MediaModelInstallJob => {
  if (["installed", "failed", "canceled"].includes(job.status)) {
    return job;
  }
  const elapsed = Date.now() - Date.parse(job.createdAt);
  if (elapsed < 250) {
    job.status = "queued";
    job.currentFile = null;
  } else if (elapsed < 3_000) {
    const downloadProgress = Math.min(1, (elapsed - 250) / 2_750);
    job.status = "downloading";
    job.progress = 0.02 + downloadProgress * 0.88;
    job.bytesDownloaded = Math.floor(job.bytesTotal * job.progress);
    job.filesCompleted = Math.min(
      job.filesTotal - 1,
      Math.floor(downloadProgress * job.filesTotal),
    );
    const files = job.modelId === LOCAL_BIREFNET_MODEL_ID
      ? LOCAL_BIREFNET_INSTALL_FILES
      : LOCAL_FLUX_INSTALL_FILES;
    job.currentFile =
      files[
        Math.min(
          files.length - 1,
          Math.floor(downloadProgress * files.length),
        )
      ]?.path ?? null;
  } else if (elapsed < 3_600) {
    job.status = "verifying";
    job.progress = 0.96;
    job.bytesDownloaded = job.bytesTotal;
    job.filesCompleted = job.filesTotal;
    job.currentFile = "Verifying the reviewed SHA-256 allowlist";
  } else if (elapsed < 4_000) {
    job.status = "activating";
    job.progress = 0.99;
    job.bytesDownloaded = job.bytesTotal;
    job.filesCompleted = job.filesTotal;
    job.currentFile = null;
  } else {
    job.status = "installed";
    job.progress = 1;
    job.bytesDownloaded = job.bytesTotal;
    job.filesCompleted = job.filesTotal;
    job.currentFile = null;
    job.completedAt = now();
    if (job.modelId === LOCAL_BIREFNET_MODEL_ID) {
      browserLocalBiRefNetInstalled = true;
    } else {
      browserLocalFluxInstalled = true;
    }
  }
  job.updatedAt = now();
  return job;
};

export const planMediaModelInstall = async (
  modelId: string,
): Promise<MediaModelInstallPlan> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaModelInstallPlan>("media_plan_model_install", {
      modelId,
    });
  }
  if (modelId === LOCAL_FLUX_MODEL_ID) {
    return createLocalFluxInstallPlan({
      alreadyInstalled: browserLocalFluxInstalled,
    });
  }
  if (modelId === LOCAL_BIREFNET_MODEL_ID) {
    return createLocalBiRefNetInstallPlan({
      alreadyInstalled: browserLocalBiRefNetInstalled,
    });
  }
  throw new Error("This model does not have a managed installation manifest.");
};

export const inspectMediaLocalModel = async (
  sourcePath: string,
): Promise<MediaLocalModelImportInspection> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error(
      "Local model import is available in the native desktop app only.",
    );
  }
  return invoke<MediaLocalModelImportInspection>("media_inspect_local_model", {
    sourcePath,
  });
};

export const importMediaLocalModel = async (
  request: ImportMediaLocalModelRequest,
): Promise<MediaLocalModelImportResult> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error(
      "Local model import is available in the native desktop app only.",
    );
  }
  return invoke<MediaLocalModelImportResult>("media_import_local_model", {
    request,
  });
};

export const probeMediaLocalModel = async (
  modelId: string,
): Promise<MediaLocalModelRuntimeProbeResult> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error(
      "Local model verification is available in the native desktop app only.",
    );
  }
  return invoke<MediaLocalModelRuntimeProbeResult>("media_probe_local_model", {
    modelId,
  });
};

export const inspectMediaModelAddon = async (
  sourcePath: string,
): Promise<MediaModelAddonImportInspection> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error(
      "LoRA and embedding import is available in the native desktop app only.",
    );
  }
  return invoke<MediaModelAddonImportInspection>("media_inspect_model_addon", {
    sourcePath,
  });
};

export const inspectMediaCivitaiModelAddon = async (
  source: string,
): Promise<MediaCivitaiModelAddonInspection> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error(
      "Civitai add-on import is available in the native desktop app only.",
    );
  }
  return invoke<MediaCivitaiModelAddonInspection>(
    "media_inspect_civitai_model_addon",
    { source },
  );
};

export const downloadMediaCivitaiModelAddon = async (
  request: DownloadMediaCivitaiModelAddonRequest,
): Promise<MediaModelAddonImportInspection> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error(
      "Civitai add-on import is available in the native desktop app only.",
    );
  }
  return invoke<MediaModelAddonImportInspection>(
    "media_download_civitai_model_addon",
    { request },
  );
};

export const importMediaModelAddon = async (
  request: ImportMediaModelAddonRequest,
): Promise<MediaModelAddonImportResult> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error(
      "LoRA and embedding import is available in the native desktop app only.",
    );
  }
  return invoke<MediaModelAddonImportResult>("media_import_model_addon", {
    request,
  });
};

export const planMediaModelAddonRemoval = async (
  addonId: string,
): Promise<MediaModelAddonRemovalPlan> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error(
      "Model add-on removal is available in the native desktop app only.",
    );
  }
  return invoke<MediaModelAddonRemovalPlan>(
    "media_plan_model_addon_removal",
    { addonId },
  );
};

export const removeMediaModelAddon = async (
  request: RemoveMediaModelAddonRequest,
): Promise<MediaModelAddonRemovalResult> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error(
      "Model add-on removal is available in the native desktop app only.",
    );
  }
  return invoke<MediaModelAddonRemovalResult>("media_remove_model_addon", {
    request,
  });
};

export const startMediaModelInstall = async (
  request: StartMediaModelInstallRequest,
): Promise<MediaModelInstallJob> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaModelInstallJob>("media_start_model_install", {
      request,
    });
  }
  const plan = await planMediaModelInstall(request.modelId);
  if (
    request.modelId !== plan.modelId ||
    request.reviewToken !== plan.reviewToken ||
    request.manifestDigest !== plan.manifestDigest ||
    request.licenseDigest !== plan.licenseDigest
  ) {
    throw new Error(
      "The reviewed model installation plan is stale; review it again.",
    );
  }
  if (!request.acceptLicense) {
    throw new Error(
      "Explicit license acceptance is required before installation.",
    );
  }
  if (plan.alreadyInstalled) {
    throw new Error("This exact model revision is already installed.");
  }
  const active = [...browserModelInstallJobs.values()]
    .map(advanceBrowserModelInstall)
    .find((job) =>
      [
        "queued",
        "downloading",
        "verifying",
        "activating",
        "canceling",
      ].includes(job.status),
    );
  if (active) {
    return clone(active);
  }
  const createdAt = now();
  const job: MediaModelInstallJob = {
    id: `browser-model-install-${nextBrowserModelInstallId++}`,
    modelId: plan.modelId,
    revision: plan.revision,
    status: "queued",
    manifestDigest: plan.manifestDigest,
    filesTotal: plan.files.length,
    filesCompleted: 0,
    bytesTotal: plan.totalBytes,
    bytesDownloaded: 0,
    progress: 0,
    currentFile: null,
    error: null,
    failure: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
  };
  browserModelInstallJobs.set(job.id, job);
  return clone(job);
};

export const getMediaModelInstallJob = async (
  jobId: string,
): Promise<MediaModelInstallJob> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaModelInstallJob>("media_get_model_install_job", {
      jobId,
    });
  }
  const job = browserModelInstallJobs.get(jobId);
  if (!job) {
    throw new Error(`Model installation ${jobId} was not found.`);
  }
  return clone(advanceBrowserModelInstall(job));
};

export const cancelMediaModelInstall = async (
  jobId: string,
): Promise<MediaModelInstallJob> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaModelInstallJob>("media_cancel_model_install", {
      jobId,
    });
  }
  const job = browserModelInstallJobs.get(jobId);
  if (!job) {
    throw new Error(`Model installation ${jobId} was not found.`);
  }
  advanceBrowserModelInstall(job);
  if (["installed", "failed", "canceled"].includes(job.status)) {
    return clone(job);
  }
  if (job.status === "activating") {
    throw new Error(
      "Model activation has reached its atomic commit and can no longer be canceled safely.",
    );
  }
  job.status = "canceled";
  job.currentFile = null;
  job.completedAt = now();
  job.updatedAt = job.completedAt;
  return clone(job);
};

const browserRemovalToken = (
  modelId: string,
  revision: string,
  totalBytes: number,
): string =>
  Array.from(
    sha256(
      new TextEncoder().encode(
        `machdoch-browser-model-removal-v1\0${modelId}\0${revision}\0${totalBytes}`,
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

export const planMediaModelRemoval = async (
  modelId: string,
): Promise<MediaModelRemovalPlan> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaModelRemovalPlan>("media_plan_model_removal", {
      modelId,
    });
  }
  const plan = modelId === LOCAL_FLUX_MODEL_ID
    ? createLocalFluxInstallPlan({ alreadyInstalled: browserLocalFluxInstalled })
    : modelId === LOCAL_BIREFNET_MODEL_ID
      ? createLocalBiRefNetInstallPlan({
          alreadyInstalled: browserLocalBiRefNetInstalled,
        })
      : null;
  if (!plan?.alreadyInstalled) {
    throw new Error("The model is not currently installed.");
  }
  const active = [...browserModelInstallJobs.values()]
    .map(advanceBrowserModelInstall)
    .find((job) =>
      [
        "queued",
        "downloading",
        "verifying",
        "activating",
        "canceling",
      ].includes(job.status),
    );
  return {
    schemaVersion: 1,
    modelId,
    displayName: plan.displayName,
    revision: plan.revision,
    installedBytes: plan.totalBytes,
    targetLabel: plan.targetLabel,
    confirmationToken: browserRemovalToken(
      plan.modelId,
      plan.revision,
      plan.totalBytes,
    ),
    canRemove: active === undefined,
    blockingJobId: active?.id ?? null,
    warnings: [
      "Saved flows remain intact but return to model-not-installed preflight until this revision is installed again.",
      "The desktop app journals removal and atomically detaches the active revision before cleanup.",
    ],
  };
};

export const removeMediaModel = async (
  request: RemoveMediaModelRequest,
): Promise<MediaModelRemovalResult> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaModelRemovalResult>("media_remove_model", { request });
  }
  const plan = await planMediaModelRemoval(request.modelId);
  if (
    request.confirmationToken !== plan.confirmationToken ||
    !request.confirmRemoval
  ) {
    throw new Error("Explicit confirmation of the reviewed removal is required.");
  }
  if (!plan.canRemove) {
    throw new Error("The model has an active installation job.");
  }
  if (request.modelId === LOCAL_BIREFNET_MODEL_ID) {
    browserLocalBiRefNetInstalled = false;
  } else {
    browserLocalFluxInstalled = false;
  }
  return {
    modelId: plan.modelId,
    revision: plan.revision,
    removedAt: now(),
    reclaimedBytes: plan.installedBytes,
    cleanupPending: false,
  };
};

export const listMediaFlows = async (): Promise<MediaFlowHead[]> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaFlowHead[]>("media_list_flows");
  }
  return [...browserFlowHistories.values()]
    .flatMap((history) => (history.head ? [history.head] : []))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map(clone);
};

export const getMediaFlow = async (
  flowId: string,
): Promise<MediaFlowHistory> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaFlowHistory>("media_get_flow", { flowId });
  }
  return clone(browserFlowHistory(flowId));
};

export const saveMediaFlowRevision = async (
  request: SaveMediaFlowRevisionRequest,
): Promise<SaveMediaFlowRevisionResult> => {
  if (canInvokeNativeRuntime()) {
    return invoke<SaveMediaFlowRevisionResult>("media_save_flow_revision", {
      request,
    });
  }

  const history = browserFlowHistory(request.flow.id);
  const requestKey = `${request.flow.id}\u0000${request.idempotencyKey}`;
  const requestDigest = createBrowserDigest({
    schemaVersion: request.schemaVersion,
    expectedHeadRevisionId: request.expectedHeadRevisionId,
    changeSummary: request.changeSummary,
    flow: request.flow,
    layout: request.layout,
  });
  const existingRequest = browserFlowSaveRequests.get(requestKey);
  if (existingRequest) {
    if (existingRequest.requestDigest !== requestDigest) {
      throw browserFlowConflict(
        "idempotency key was reused with a different request",
      );
    }
    const revision = history.revisions.find(
      (candidate) => candidate.revisionId === existingRequest.revisionId,
    );
    if (!history.head || !revision) {
      throw new Error("Browser flow revision history is inconsistent.");
    }
    return {
      schemaVersion: 1,
      created: false,
      head: clone(history.head),
      revision: clone(revision),
    };
  }

  if (request.schemaVersion !== 1 || request.layout.flowId !== request.flow.id) {
    throw new Error("Flow revision identity is invalid.");
  }
  if (
    request.expectedHeadRevisionId !==
    (history.head?.headRevisionId ?? null)
  ) {
    throw browserFlowConflict("the expected head is stale");
  }

  const documentDigest = createMediaFlowDocumentDigest(request.flow);
  const executionDigest = createMediaFlowFingerprint(request.flow);
  const layoutDigest = createMediaFlowLayoutDigest(request.layout);
  const unchanged =
    history.head?.documentDigest === documentDigest &&
    history.head.executionDigest === executionDigest &&
    history.head.layoutDigest === layoutDigest;
  if (unchanged && history.head) {
    const revision = history.revisions.find(
      (candidate) => candidate.revisionId === history.head?.headRevisionId,
    );
    if (!revision) {
      throw new Error("Browser flow revision head is inconsistent.");
    }
    browserFlowSaveRequests.set(requestKey, {
      requestDigest,
      revisionId: revision.revisionId,
    });
    return {
      schemaVersion: 1,
      created: false,
      head: clone(history.head),
      revision: clone(revision),
    };
  }

  const createdAt = now();
  const revisionNumber = (history.head?.headRevisionNumber ?? 0) + 1;
  const revisionId = `mfr-${createBrowserDigest({
    flowId: request.flow.id,
    idempotencyKey: request.idempotencyKey,
    requestDigest,
  }).slice("sha256:".length, "sha256:".length + 32)}`;
  const revision = {
    schemaVersion: 1,
    revisionId,
    flowId: request.flow.id,
    revisionNumber,
    parentRevisionId: history.head?.headRevisionId ?? null,
    createdAt,
    changeSummary: request.changeSummary,
    documentDigest,
    executionDigest,
    layoutDigest,
    nodeCount: request.flow.nodes.length,
    edgeCount: request.flow.edges.length,
    isHead: true,
    flow: clone(request.flow),
    layout: clone(request.layout),
  } as const;
  history.revisions.forEach((candidate) => {
    candidate.isHead = false;
  });
  history.revisions.unshift(revision);
  history.head = {
    schemaVersion: 1,
    flowId: request.flow.id,
    name: request.flow.name,
    description: request.flow.description,
    headRevisionId: revisionId,
    headRevisionNumber: revisionNumber,
    createdAt: history.head?.createdAt ?? request.flow.createdAt,
    updatedAt: createdAt,
    documentDigest,
    executionDigest,
    layoutDigest,
  };
  browserFlowSaveRequests.set(requestKey, { requestDigest, revisionId });
  return {
    schemaVersion: 1,
    created: true,
    head: clone(history.head),
    revision: clone(revision),
  };
};

export const exportMediaFlowRevision = async (
  request: ExportMediaFlowRevisionRequest,
): Promise<MediaFlowExportResult> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error(
      "Portable flow export is available in the native desktop app only.",
    );
  }
  return invoke<MediaFlowExportResult>("media_export_flow_revision", {
    request,
  });
};

export const inspectMediaFlowImport = async (
  request: InspectMediaFlowImportRequest,
): Promise<MediaFlowImportInspection> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error(
      "Portable flow import is available in the native desktop app only.",
    );
  }
  return invoke<MediaFlowImportInspection>("media_inspect_flow_import", {
    request,
  });
};

export const importMediaFlow = async (
  request: ImportMediaFlowRequest,
): Promise<ImportMediaFlowResult> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error(
      "Portable flow import is available in the native desktop app only.",
    );
  }
  return invoke<ImportMediaFlowResult>("media_import_flow", { request });
};

export const enqueueMediaFixtureRun = async (
  request: EnqueueFixtureRunRequest,
): Promise<MediaRunDetail> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRunDetail>("media_enqueue_fixture_run", { request });
  }
  validateBrowserRunFlowRevision(request);
  return enqueueBrowserFixture(request);
};

export const generateMediaImages = async (
  request: GenerateMediaImagesRequest,
): Promise<MediaRunDetail> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRunDetail>("media_generate_images", { request });
  }
  const previewRequest: EnqueueFixtureRunRequest = {
    runId: request.runId,
    flowId: request.flowId,
    flowRevisionId: request.flowRevisionId,
    flowName: request.flowName,
    planId: request.planId,
    prompt: request.prompt,
    modelLabel: request.modelLabel,
    target: "remote",
    outputCount: request.outputCount,
    diagnosticCount: request.diagnosticCount,
    aspectRatio: request.aspectRatio,
    planSnapshot: request.planSnapshot,
  };
  validateBrowserRunFlowRevision(previewRequest);
  return enqueueBrowserFixture(previewRequest);
};

export const generateMediaSvg = async (
  request: GenerateMediaSvgRequest,
): Promise<MediaRunDetail> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRunDetail>("media_generate_svg", { request });
  }
  throw new Error("Native SVG generation is available in the desktop runtime only.");
};

export const enqueueMediaMockRemoteRun = async (
  request: EnqueueMockRemoteRunRequest,
): Promise<MediaRunDetail> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRunDetail>("media_enqueue_mock_remote_run", { request });
  }
  validateBrowserRunFlowRevision(request);
  return enqueueBrowserRemote(request);
};

export const listMediaRuns = async (): Promise<MediaRuntimeRunRecord[]> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRuntimeRunRecord[]>("media_list_runs", { limit: 100 });
  }
  return [...browserRuns.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(({ events, assets, providerJobs, humanReviews, ...run }) => {
      void events;
      void assets;
      void providerJobs;
      void humanReviews;
      return clone(run);
    });
};

export const getMediaRunDetail = async (
  runId: string,
): Promise<MediaRunDetail> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRunDetail>("media_get_run_detail", { runId });
  }
  const detail = browserRuns.get(runId);
  if (!detail) {
    throw new Error(`Media run ${runId} was not found.`);
  }
  return clone(detail);
};

export const cancelMediaRun = async (
  runId: string,
): Promise<MediaRunDetail> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRunDetail>("media_cancel_run", { runId });
  }
  const detail = browserRuns.get(runId);
  if (!detail) {
    throw new Error(`Media run ${runId} was not found.`);
  }
  if (["queued", "running", "waiting-for-review"].includes(detail.status)) {
    if (detail.status === "waiting-for-review") {
      finalizeBrowserCancellation(detail);
      return clone(detail);
    }
    detail.status = "canceling";
    detail.currentStep = "Cancellation requested";
    detail.updatedAt = now();
    appendBrowserEvent(detail, {
      kind: "cancel_requested",
      message: "Cancellation will occur at the next safe checkpoint.",
      progress: detail.progress,
      stepId: "cancel",
    });
    const providerJob = detail.providerJobs.at(-1);
    if (providerJob && !["completed", "failed", "expired", "cancelled"].includes(providerJob.status)) {
      browserProviderCancellations.add(runId);
      providerJob.status = "cancel-requested";
      providerJob.nextPollAt = now();
      providerJob.updatedAt = now();
      appendBrowserEvent(detail, {
        kind: "provider_cancel_requested",
        message: "Best-effort provider cancellation was requested; reconciliation continues because success can race cancellation.",
        progress: detail.progress,
        stepId: "provider.cancel",
      });
    }
  }
  return clone(detail);
};

export const resolveMediaProviderReview = async (
  providerJobId: string,
  action: MediaProviderReviewAction,
): Promise<MediaRunDetail> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRunDetail>("media_resolve_provider_review", {
      request: { providerJobId, action },
    });
  }
  const detail = [...browserRuns.values()].find((candidate) =>
    candidate.providerJobs.some((job) => job.id === providerJobId),
  );
  const providerJob = detail?.providerJobs.find((job) => job.id === providerJobId);
  if (!detail || !providerJob || providerJob.status !== "acceptance-unknown") {
    throw new Error("The provider job is not awaiting acceptance review.");
  }
  const original = browserProviderRequests.get(detail.id);
  if (!original) throw new Error("The prepared provider request is unavailable.");
  const timestamp = now();
  if (action === "reconcile-only") {
    providerJob.status = "accepted";
    providerJob.rawState = "accepted-by-idempotency-lookup";
    providerJob.providerJobId = `mock-reconciled-${detail.id}`;
    providerJob.providerRequestId = `lookup-${detail.id}`;
    providerJob.acceptedAt = timestamp;
    providerJob.retentionExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
    providerJob.reviewRequired = false;
    providerJob.reviewReason = null;
    providerJob.nextPollAt = timestamp;
    providerJob.updatedAt = timestamp;
    detail.status = "running";
    detail.progress = 0.18;
    detail.currentStep = "Acceptance reconciled without resubmission";
    detail.updatedAt = timestamp;
    appendBrowserEvent(detail, {
      kind: "provider_reconciled",
      message: "Idempotency lookup found the original paid request. No second submission was made.",
      progress: 0.18,
      stepId: "provider.review",
    });
    void continueBrowserRemoteAfterAcceptance(detail, original, providerJob);
  } else {
    providerJob.status = "failed";
    providerJob.rawState = "operator-confirmed-not-accepted";
    providerJob.reviewRequired = false;
    providerJob.reviewReason = null;
    providerJob.error = "Provider request failed because the operator confirmed it was not accepted.";
    providerJob.failure = browserRunFailure(
      detail,
      providerJob.error,
      "provider_review",
      "mock-remote",
    );
    providerJob.completedAt = timestamp;
    providerJob.updatedAt = timestamp;
    const retry: MediaProviderJobRecord = {
      ...clone(providerJob),
      id: `provider:${detail.id}:${providerJob.attempt + 1}`,
      attempt: providerJob.attempt + 1,
      status: "prepared",
      rawState: null,
      scenario: "success",
      requestDigest: `${providerJob.requestDigest.slice(0, 62)}${providerJob.attempt + 1}`,
      idempotencyKey: `${providerJob.idempotencyKey ?? "media"}-retry`,
      providerJobId: null,
      providerRequestId: null,
      pollAttempts: 0,
      nextPollAt: null,
      acceptedAt: null,
      retentionExpiresAt: null,
      lateSuccess: false,
      error: null,
      failure: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
    };
    detail.providerJobs.push(retry);
    detail.status = "queued";
    detail.progress = 0.01;
    detail.currentStep = "Explicitly approved provider retry";
    detail.error = null;
    detail.failure = null;
    detail.updatedAt = timestamp;
    appendBrowserEvent(detail, {
      kind: "retry_queued",
      message: "A new attempt was created only after explicit confirmation that the previous request was not accepted.",
      progress: 0.01,
      stepId: "provider.review",
    });
    const retryRequest = { ...original, scenario: "success" as const };
    browserProviderRequests.set(detail.id, retryRequest);
    void executeBrowserRemote(detail, retryRequest);
  }
  return clone(detail);
};

export const resolveMediaHumanReview = async (
  request: MediaHumanReviewDecisionRequest,
): Promise<MediaRunDetail> => {
  const normalizedRequest = {
    ...request,
    comment: request.comment.trim(),
  };
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRunDetail>("media_resolve_human_review", {
      request: normalizedRequest,
    });
  }
  const reviews = [...browserRuns.values()].flatMap((detail) =>
    detail.humanReviews.map((review) => ({ detail, review })),
  );
  const priorDecision = reviews.find(
    ({ review }) => review.decisionId === normalizedRequest.decisionId,
  );
  if (priorDecision) {
    const matches =
      priorDecision.review.id === normalizedRequest.reviewId &&
      priorDecision.review.decisionAction === normalizedRequest.action &&
      priorDecision.review.comment === normalizedRequest.comment &&
      JSON.stringify(priorDecision.review.selectedAssetIds) ===
        JSON.stringify(normalizedRequest.selectedAssetIds);
    if (!matches) {
      throw new Error(
        "Human review decision idempotency conflict: decisionId was reused with different inputs.",
      );
    }
    return clone(priorDecision.detail);
  }
  const entry = reviews.find(
    ({ review }) => review.id === normalizedRequest.reviewId,
  );
  if (!entry || entry.review.status !== "pending") {
    throw new Error("The human review is not awaiting a decision.");
  }
  const { detail, review } = entry;
  if (detail.status !== "waiting-for-review") {
    throw new Error("The media run is not waiting for human review.");
  }
  if (review.requireComment && normalizedRequest.comment.length === 0) {
    throw new Error("This human review requires a comment.");
  }
  const selectedIds = normalizedRequest.selectedAssetIds;
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error("Selected assets must be unique.");
  }
  if (normalizedRequest.action === "approve") {
    if (selectedIds.length === 0 || selectedIds.length > review.maxSelections) {
      throw new Error(
        `Select between 1 and ${review.maxSelections} candidates to approve.`,
      );
    }
    const candidates = new Set(review.candidateAssetIds);
    if (selectedIds.some((assetId) => !candidates.has(assetId))) {
      throw new Error("Selected assets must be candidates from this review.");
    }
  } else if (selectedIds.length > 0) {
    throw new Error("Reject decisions cannot contain selected assets.");
  }

  const timestamp = now();
  review.status =
    normalizedRequest.action === "approve" ? "approved" : "rejected";
  review.selectedAssetIds = [...selectedIds];
  review.decisionId = normalizedRequest.decisionId;
  review.decisionAction = normalizedRequest.action;
  review.comment = normalizedRequest.comment;
  review.actor = "local-user";
  review.updatedAt = timestamp;
  review.decidedAt = timestamp;

  if (normalizedRequest.action === "approve") {
    transitionBrowserNode(
      detail,
      review.nodeId,
      "completed",
      "human.review.approved",
      "Human review approved",
      0.98,
    );
    appendBrowserEvent(detail, {
      kind: "human_review_approved",
      message: `Reviewer approved ${selectedIds.length} of ${review.candidateAssetIds.length} candidates.`,
      progress: 0.98,
      stepId: review.nodeId,
    });
    const nextReview = detail.humanReviews.find(
      (candidate) =>
        candidate.sequence > review.sequence && candidate.status === "queued",
    );
    if (nextReview) {
      nextReview.status = "pending";
      nextReview.candidateAssetIds = [...selectedIds];
      nextReview.updatedAt = timestamp;
      detail.progress = 0.98;
      detail.currentStep = "Waiting for the next human review";
      transitionBrowserNode(
        detail,
        nextReview.nodeId,
        "waiting-for-review",
        "human.review",
        "Waiting for the next human review",
        0.98,
      );
      appendBrowserEvent(detail, {
        kind: "human_review_requested",
        message: `${selectedIds.length} approved candidates entered the next review; approve up to ${nextReview.maxSelections}.`,
        progress: 0.98,
        stepId: nextReview.nodeId,
      });
    } else {
      finalizeBrowserNodes(detail, "completed");
      detail.status = "completed";
      detail.progress = 1;
      detail.currentStep = `Completed · ${selectedIds.length} approved`;
      appendBrowserEvent(detail, {
        kind: "run_completed",
        message: "Human-approved outputs completed the durable review contract.",
        progress: 1,
        stepId: "finalize",
      });
    }
  } else {
    transitionBrowserNode(
      detail,
      review.nodeId,
      "canceled",
      "human.review.rejected",
      "Rejected in human review",
      null,
    );
    finalizeBrowserNodes(detail, "canceled");
    detail.status = "canceled";
    detail.progress = Math.min(detail.progress, 0.99);
    detail.currentStep = "Rejected in human review";
    appendBrowserEvent(detail, {
      kind: "human_review_rejected",
      message: `Reviewer rejected all ${review.candidateAssetIds.length} candidates.`,
      progress: null,
      stepId: review.nodeId,
    });
    appendBrowserEvent(detail, {
      kind: "run_canceled",
      message:
        "The run ended without approved outputs after explicit human rejection.",
      progress: null,
      stepId: "finalize",
    });
  }
  detail.updatedAt = timestamp;
  return clone(detail);
};

export const wakeMediaProviderReconciliation = async (
  providerJobId: string,
): Promise<MediaRunDetail> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRunDetail>("media_wake_provider_reconciliation", {
      providerJobId,
    });
  }
  const detail = [...browserRuns.values()].find((candidate) =>
    candidate.providerJobs.some((job) => job.id === providerJobId),
  );
  const providerJob = detail?.providerJobs.find((job) => job.id === providerJobId);
  if (!detail || !providerJob) {
    throw new Error(`Provider job ${providerJobId} was not found.`);
  }
  if (
    [
      "accepted",
      "queued",
      "running",
      "cancel-requested",
      "succeeded-download-pending",
    ].includes(providerJob.status)
  ) {
    providerJob.nextPollAt = now();
    providerJob.updatedAt = now();
  }
  return clone(detail);
};

export const retryMediaFixtureRun = async (
  runId: string,
): Promise<MediaRunDetail> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRunDetail>("media_retry_fixture_run", { runId });
  }
  const detail = browserRuns.get(runId);
  const request = browserRequests.get(runId);
  if (!detail || !request) {
    throw new Error(`Media run ${runId} was not found.`);
  }
  if (!["failed", "canceled"].includes(detail.status)) {
    throw new Error(`Media run ${runId} cannot be retried from ${detail.status}.`);
  }
  if (detail.humanReviews.length > 0) {
    throw new Error(
      "Human-reviewed runs are immutable; create a new run instead of retrying this outcome.",
    );
  }
  if ((browserAttempts.get(runId) ?? 0) >= 3) {
    throw new Error(`Media run ${runId} exhausted its 3 fixture attempts.`);
  }

  detail.status = "queued";
  detail.progress =
    detail.assets.length === 0
      ? 0
      : 0.05 + (detail.assets.length / detail.outputCount) * 0.9;
  detail.currentStep = "Queued for retry";
  detail.updatedAt = now();
  detail.error = null;
  detail.failure = null;
  detail.nodeExecutions
    .filter((execution) => execution.status === "failed" || execution.status === "canceled")
    .forEach((execution) => {
      execution.status = "retrying";
      execution.runtimePhase = "fixture.retry";
      execution.message = "Queued for retry";
      execution.updatedAt = now();
      execution.finishedAt = null;
      execution.stateSequence += 1;
    });
  appendBrowserEvent(detail, {
    kind: "retry_queued",
    message: "Fixture retry was queued; previously published outputs will be reused.",
    progress: detail.progress,
    stepId: "retry",
  });
  void executeBrowserFixture(request);
  return clone(detail);
};

export const listMediaAssets = async (): Promise<MediaAssetRecord[]> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaAssetRecord[]>("media_list_assets", { limit: 200 });
  }
  return [...browserRuns.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .flatMap((detail) => {
      const finalReview = detail.humanReviews.at(-1);
      const visibleAssetIds = finalReview
        ? new Set(
            detail.status === "completed" && finalReview.status === "approved"
              ? finalReview.selectedAssetIds
              : [],
          )
        : null;
      return detail.assets
        .filter((asset) => !visibleAssetIds || visibleAssetIds.has(asset.id))
        .sort(
        (left, right) => left.outputIndex - right.outputIndex,
        );
    })
    .map(clone);
};

export const inspectMediaHardware = async (): Promise<MediaHardwareInspection> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaHardwareInspection>("media_inspect_hardware");
  }

  const browserNavigator =
    typeof navigator === "undefined" ? null : navigator;
  const deviceMemoryGb = browserNavigator
    ? (browserNavigator as Navigator & { deviceMemory?: number }).deviceMemory
    : undefined;
  return {
    inspectedAt: now(),
    operatingSystem: "browser-preview",
    architecture: "unavailable",
    cpuLabel: "Browser-reported logical processors",
    logicalCpuCount: browserNavigator?.hardwareConcurrency ?? 1,
    totalMemoryBytes:
      deviceMemoryGb === undefined ? null : deviceMemoryGb * 1_024 ** 3,
    availableMemoryBytes: null,
    storageFreeBytes: null,
    ffmpeg: {
      status: "unavailable",
      version: null,
      diagnostic: "Native executable probes are unavailable in browser preview.",
    },
    ffprobe: {
      status: "unavailable",
      version: null,
      diagnostic: "Native executable probes are unavailable in browser preview.",
    },
    nvidiaSmi: {
      status: "unavailable",
      version: null,
      diagnostic: "Native GPU probes are unavailable in browser preview.",
    },
    nvidiaGpus: [],
    runtimeSupport: {
      cpuUtilities: "preview-only",
      cuda: "not-validated",
      amd: "not-validated",
      appleSilicon: "not-applicable",
      directMl: "not-applicable",
    },
    warnings: [
      "Browser preview cannot validate native CPU, GPU, disk, FFmpeg, or model-runner compatibility.",
    ],
  };
};

export const importMediaImage = async (
  path: string,
): Promise<MediaImageImportResult> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error("Image import is available in the native desktop app only.");
  }
  return invoke<MediaImageImportResult>("media_import_image", { path });
};

export const readMediaAssetPreview = async (
  asset: MediaAssetRecord,
  maxEdge = 512,
): Promise<Blob> => {
  if (asset.kind !== "image" && asset.kind !== "vector") {
    throw new Error(`Media asset ${asset.id} does not have a visual preview.`);
  }
  if (canInvokeNativeRuntime()) {
    const bytes = await invoke<ArrayBuffer>("media_read_asset_preview", {
      assetId: asset.id,
      maxEdge,
    });
    return new Blob([bytes], { type: "image/webp" });
  }

  const primary = `#${asset.digest.slice(0, 6)}`;
  const secondary = `#${asset.digest.slice(6, 12)}`;
  const label = asset.operation?.kind ?? "fixture";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${asset.width}" height="${asset.height}" viewBox="0 0 ${asset.width} ${asset.height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${primary}"/><stop offset="1" stop-color="${secondary}"/></linearGradient><pattern id="p" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M0 32 32 0M-8 8 8-8M24 40 40 24" stroke="rgba(255,255,255,.1)" stroke-width="2"/></pattern></defs><rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#p)"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="rgba(255,255,255,.88)" font-family="ui-sans-serif,system-ui" font-size="${Math.max(14, Math.round(Math.min(asset.width, asset.height) / 12))}" font-weight="700">${label.toUpperCase()}</text></svg>`;
  return new Blob([svg], { type: "image/svg+xml" });
};

export const readMediaAssetReferencePreview = async (
  assetId: string,
  maxEdge = 512,
): Promise<Blob> => {
  const normalizedAssetId = assetId.trim();
  if (!normalizedAssetId) {
    throw new Error("Expected a Media Studio asset id for preview.");
  }
  if (canInvokeNativeRuntime()) {
    const bytes = await invoke<ArrayBuffer>("media_read_asset_preview", {
      assetId: normalizedAssetId,
      maxEdge,
    });
    return new Blob([bytes], { type: "image/webp" });
  }
  return readMediaAssetPreview(findBrowserAsset(normalizedAssetId).asset, maxEdge);
};

const requirePositiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 20_000) {
    throw new Error(`${label} must be an integer between 1 and 20000.`);
  }
  return value;
};

const browserTransformDimensions = (
  source: MediaAssetRecord,
  request: MediaImageTransformRequest,
): readonly [number, number] => {
  const operation = request.operation;
  if (operation.kind === "crop") {
    const width = requirePositiveInteger(operation.width, "Crop width");
    const height = requirePositiveInteger(operation.height, "Crop height");
    if (
      !Number.isSafeInteger(operation.x) ||
      !Number.isSafeInteger(operation.y) ||
      operation.x < 0 ||
      operation.y < 0 ||
      operation.x + width > source.width ||
      operation.y + height > source.height
    ) {
      throw new Error("Crop rectangle must stay inside the source image.");
    }
    return [width, height];
  }
  if (operation.kind === "resize") {
    const width = requirePositiveInteger(operation.width, "Resize width");
    const height = requirePositiveInteger(operation.height, "Resize height");
    if (operation.fit === "contain") {
      const scale = Math.min(width / source.width, height / source.height);
      return [
        Math.max(1, Math.round(source.width * scale)),
        Math.max(1, Math.round(source.height * scale)),
      ];
    }
    return [width, height];
  }
  return [source.width, source.height];
};

const transformBrowserImage = (
  request: MediaImageTransformRequest,
): MediaRunDetail => {
  const source = [...browserRuns.values()]
    .flatMap((detail) => detail.assets)
    .find(
      (asset) => asset.id === request.sourceAssetId && asset.kind === "image",
    );
  if (!source) {
    throw new Error(`Image asset ${request.sourceAssetId} was not found.`);
  }
  if (
    request.outputFormat !== "jpeg" &&
    (request.quality !== undefined || request.jpegBackground !== undefined)
  ) {
    throw new Error("JPEG quality and background are only valid for JPEG output.");
  }
  if (
    request.quality !== undefined &&
    (!Number.isInteger(request.quality) || request.quality < 1 || request.quality > 100)
  ) {
    throw new Error("JPEG quality must be between 1 and 100.");
  }
  const [width, height] = browserTransformDimensions(source, request);
  const createdAt = now();
  const digestBytes = sha256(
    new TextEncoder().encode(
      `${source.digest}\0${JSON.stringify(request.operation)}\0${request.outputFormat}\0${request.quality ?? ""}\0${request.jpegBackground ?? ""}`,
    ),
  );
  const digest = Array.from(digestBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const runId = `browser-transform-${createdAt}-${digest.slice(0, 12)}`;
  const asset: MediaAssetRecord = {
    id: `asset:${runId}:0`,
    runId,
    digest,
    kind: "image",
    mimeType: mimeTypeForFormat(request.outputFormat),
    byteSize: Math.max(256, Math.round(width * height * 1.4)),
    width,
    height,
    createdAt,
    outputIndex: 0,
    fixture: false,
    operation: clone(request.operation),
    sourceAssetIds: [source.id],
    tags: [],
  };
  const label =
    request.operation.kind === "crop"
      ? "Crop image"
      : request.operation.kind === "resize"
        ? "Resize image"
        : "Convert image format";
  const detail: MediaRunDetail = {
    id: runId,
    flowId: "builtin:transform-image",
    flowRevisionId: null,
    flowName: label,
    planId: "transform:browser-preview-v1",
    status: "completed",
    createdAt,
    updatedAt: createdAt,
    prompt: label,
    modelLabel: "Built-in image processor",
    target: "local",
    outputCount: 1,
    diagnosticCount: 0,
    progress: 1,
    currentStep: "Completed",
    executor: "local-transform",
    error: null,
    failure: null,
    events: [],
    assets: [asset],
    providerJobs: [],
    humanReviews: [],
    nodeExecutions: [],
    planSnapshot: null,
  };
  appendBrowserEvent(detail, {
    kind: "asset_transformed",
    message: `${label} completed and published a derived preview asset.`,
    progress: 1,
    stepId: "transform.publish",
  });
  appendBrowserEvent(detail, {
    kind: "run_completed",
    message: "Browser transform preview completed without a network request.",
    progress: 1,
    stepId: "transform.finalize",
  });
  browserRuns.set(runId, detail);
  return clone(detail);
};

const executeBrowserLocalImageFlow = (
  request: ExecuteLocalImageFlowRequest,
  sourceFlow: MediaFlow,
): MediaRunDetail => {
  const flow = resolveMediaFlowVariables(sourceFlow).flow;
  if (
    flow.id !== request.flowId ||
    request.planSnapshot.flowId !== request.flowId ||
    request.planSnapshot.planId !== request.planId ||
    request.planSnapshot.flowFingerprint !== createMediaFlowFingerprint(flow)
  ) {
    throw new Error("Local flow request does not match the pinned execution plan.");
  }
  const supported = new Set([
    "source.image",
    "operation.crop",
    "operation.resize",
    "operation.format-convert",
    "operation.metadata-strip",
    "operation.auto-tag",
    "operation.subject-cutout",
    "operation.alpha-matte",
    "operation.composite",
    "operation.contact-sheet",
    "output.asset",
  ]);
  const unsupported = flow.nodes.find((node) => !supported.has(node.type));
  if (unsupported) {
    throw new Error(
      `${unsupported.label} requires a model or runtime that the local image utility executor does not provide.`,
    );
  }
  const outputs = flow.nodes.filter((node) => node.type === "output.asset");
  if (outputs.length !== 1) {
    throw new Error("Local image utility flows require exactly one Save asset output.");
  }
  const incomingCount = new Map(flow.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of flow.edges) {
    incomingCount.set(edge.toNodeId, (incomingCount.get(edge.toNodeId) ?? 0) + 1);
    outgoing.set(edge.fromNodeId, [
      ...(outgoing.get(edge.fromNodeId) ?? []),
      edge.toNodeId,
    ]);
  }
  const ready = flow.nodes
    .filter((node) => incomingCount.get(node.id) === 0)
    .map((node) => node.id);
  const nodesById = new Map(flow.nodes.map((node) => [node.id, node]));
  const ordered = [] as typeof flow.nodes;
  for (let index = 0; index < ready.length; index += 1) {
    const nodeId = ready[index];
    if (!nodeId) continue;
    const node = nodesById.get(nodeId);
    if (!node) throw new Error("Local image flow topology is inconsistent.");
    ordered.push(node);
    for (const nextNodeId of outgoing.get(nodeId) ?? []) {
      const count = (incomingCount.get(nextNodeId) ?? 0) - 1;
      incomingCount.set(nextNodeId, count);
      if (count === 0) ready.push(nextNodeId);
    }
  }
  if (ordered.length !== flow.nodes.length) {
    throw new Error("Local image utility flow must be acyclic.");
  }
  const snapshotNodeIdentity = request.planSnapshot.nodes
    .map((node) => `${node.id}\u001f${node.type}`)
    .sort();
  const flowNodeIdentity = flow.nodes
    .map((node) => `${node.id}\u001f${node.type}`)
    .sort();
  if (snapshotNodeIdentity.join("\u001e") !== flowNodeIdentity.join("\u001e")) {
    throw new Error("Compiled plan nodes do not match the pinned flow revision.");
  }
  const localStepKindByNodeType = new Map<MediaFlow["nodes"][number]["type"], string>([
    ["source.image", "resolve-asset"],
    ["operation.crop", "crop-image"],
    ["operation.resize", "resize-image"],
    ["operation.format-convert", "convert-image"],
    ["operation.metadata-strip", "strip-metadata"],
    ["operation.auto-tag", "auto-tag"],
    ["operation.subject-cutout", "cutout-subject"],
    ["operation.alpha-matte", "extract-alpha-matte"],
    ["operation.composite", "composite-image"],
    ["operation.contact-sheet", "create-contact-sheet"],
    ["output.asset", "ingest-asset"],
  ]);
  const expectedStepIdentity = ordered.map(
    (node) => `${node.id}\u001f${localStepKindByNodeType.get(node.type) ?? "unsupported"}`,
  );
  const snapshotStepIdentity = request.planSnapshot.steps.map(
    (step) => `${step.sourceNodeId}\u001f${step.kind}`,
  );
  if (expectedStepIdentity.join("\u001e") !== snapshotStepIdentity.join("\u001e")) {
    throw new Error("Compiled plan steps do not match the pinned local utility flow.");
  }
  const createdAt = now();
  const detail: MediaRunDetail = {
    id: request.runId,
    flowId: request.flowId,
    flowRevisionId: request.flowRevisionId,
    flowName: flow.name,
    planId: request.planId,
    status: "running",
    createdAt,
    updatedAt: createdAt,
    prompt: "Execute local image utility flow",
    modelLabel: "Built-in media utilities",
    target: "local",
    outputCount: 1,
    diagnosticCount: 0,
    progress: 0,
    currentStep: "Preparing local flow",
    executor: "local-image-flow",
    error: null,
    failure: null,
    events: [],
    assets: [],
    providerJobs: [],
    humanReviews: [],
    nodeExecutions: seedBrowserNodeExecutions(
      request.runId,
      clone(request.planSnapshot),
    ),
    planSnapshot: clone(request.planSnapshot),
  };
  appendBrowserEvent(detail, {
    kind: "run_started",
    message: "The pinned browser utility graph started.",
    progress: 0,
    stepId: null,
  });
  browserRuns.set(request.runId, detail);
  type BrowserValue = {
    width: number;
    height: number;
    sourceAssetIds: string[];
    outputFormat?: string;
    quality?: number;
    jpegBackground?: string;
    metadataStripped: boolean;
    alphaExtraction?: { inverted: boolean };
    autoTagProfile?: "technical-metadata-v1";
    composite?: {
      fit: "contain" | "cover" | "stretch";
      opacityPercent: number;
      foregroundSourceAssetIds: string[];
      backgroundSourceAssetIds: string[];
    };
    contactSheet?: {
      columns: number;
      cellWidth: number;
      cellHeight: number;
      gap: number;
      background: string;
      labelMode: "index" | "none";
      sourceAssetIds: string[];
    };
  };
  const values = new Map<string, BrowserValue>();
  let finalValue: BrowserValue | null = null;
  const numberConfig = (node: (typeof flow.nodes)[number], key: string): number => {
    const value = node.config[key];
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new Error(`${node.label} requires integer ${key}.`);
    }
    return value;
  };
  const stringConfig = (node: (typeof flow.nodes)[number], key: string): string => {
    const value = node.config[key];
    if (typeof value !== "string") {
      throw new Error(`${node.label} requires string ${key}.`);
    }
    return value;
  };
  const singleInput = (
    node: (typeof flow.nodes)[number],
    inputs: BrowserValue[],
  ): BrowserValue => {
    if (inputs.length !== 1 || !inputs[0]) {
      throw new Error(`${node.label} requires exactly one image input.`);
    }
    return { ...inputs[0], sourceAssetIds: [...inputs[0].sourceAssetIds] };
  };
  const namedInput = (
    node: (typeof flow.nodes)[number],
    portId: string,
  ): BrowserValue => {
    const edges = flow.edges.filter(
      (edge) => edge.toNodeId === node.id && edge.toPortId === portId,
    );
    const value = edges.length === 1 ? values.get(edges[0]?.fromNodeId ?? "") : null;
    if (!value) {
      throw new Error(`${node.label} requires exactly one ${portId} input.`);
    }
    return { ...value, sourceAssetIds: [...value.sourceAssetIds] };
  };
  try {
  for (const [nodeIndex, node] of ordered.entries()) {
    transitionBrowserNode(
      detail,
      node.id,
      "running",
      "browser.local.execute",
      `Running ${node.label}`,
      nodeIndex / Math.max(ordered.length, 1),
    );
    const inputs = flow.edges
      .filter((edge) => edge.toNodeId === node.id && edge.toPortId === "image")
      .map((edge) => values.get(edge.fromNodeId))
      .filter((value): value is BrowserValue => Boolean(value));
    let value: BrowserValue;
    if (node.type === "source.image") {
      const assetId = stringConfig(node, "assetId");
      const asset = [...browserRuns.values()]
        .flatMap((detail) => detail.assets)
        .find((candidate) => candidate.id === assetId && candidate.kind === "image");
      if (!asset) throw new Error(`Image asset ${assetId} was not found.`);
      value = {
        width: asset.width,
        height: asset.height,
        sourceAssetIds: [asset.id],
        metadataStripped: false,
        ...(asset.operation?.kind === "local-image-flow" &&
        asset.operation.assetRole === "alpha-matte"
          ? {
              alphaExtraction: {
                inverted: asset.operation.alphaExtraction?.inverted ?? false,
              },
            }
          : {}),
      };
    } else if (node.type === "operation.crop") {
      value = singleInput(node, inputs);
      const x = numberConfig(node, "x");
      const y = numberConfig(node, "y");
      const width = numberConfig(node, "width");
      const height = numberConfig(node, "height");
      if (x + width > value.width || y + height > value.height) {
        throw new Error(`${node.label} exceeds the source image bounds.`);
      }
      value.width = width;
      value.height = height;
    } else if (node.type === "operation.resize") {
      value = singleInput(node, inputs);
      const width = numberConfig(node, "width");
      const height = numberConfig(node, "height");
      if (stringConfig(node, "fit") === "contain") {
        const scale = Math.min(width / value.width, height / value.height);
        value.width = Math.max(1, Math.round(value.width * scale));
        value.height = Math.max(1, Math.round(value.height * scale));
      } else {
        value.width = width;
        value.height = height;
      }
    } else if (node.type === "operation.format-convert") {
      value = singleInput(node, inputs);
      value.outputFormat = stringConfig(node, "outputFormat");
      value.quality = numberConfig(node, "quality");
      const background = node.config.jpegBackground;
      value.jpegBackground = typeof background === "string" ? background : undefined;
    } else if (node.type === "operation.metadata-strip") {
      value = singleInput(node, inputs);
      if (node.config.applyOrientation !== true) {
        throw new Error("Metadata Strip requires Apply orientation.");
      }
      value.metadataStripped = true;
    } else if (node.type === "operation.auto-tag") {
      value = singleInput(node, inputs);
      if (stringConfig(node, "profile") !== "technical-metadata-v1") {
        throw new Error("Auto Tag requires the technical-metadata-v1 profile.");
      }
      value.autoTagProfile = "technical-metadata-v1";
    } else if (node.type === "operation.subject-cutout") {
      throw new Error(
        "Subject cutout requires the native local model runtime; browser preview cannot execute its configured priority/fallback policy.",
      );
    } else if (node.type === "operation.alpha-matte") {
      value = singleInput(node, inputs);
      value.alphaExtraction = { inverted: node.config.invert === true };
      value.metadataStripped = true;
    } else if (node.type === "operation.composite") {
      const foreground = namedInput(node, "foreground");
      const background = namedInput(node, "background");
      const fit = stringConfig(node, "fit");
      if (!(["contain", "cover", "stretch"] as const).includes(
        fit as "contain" | "cover" | "stretch",
      )) {
        throw new Error(`${node.label} has an unsupported foreground fit.`);
      }
      const opacityPercent = numberConfig(node, "opacityPercent");
      if (opacityPercent < 0 || opacityPercent > 100) {
        throw new Error(`${node.label} opacity must be between 0 and 100.`);
      }
      value = {
        width: background.width,
        height: background.height,
        sourceAssetIds: [
          ...new Set([
            ...foreground.sourceAssetIds,
            ...background.sourceAssetIds,
          ]),
        ],
        metadataStripped:
          foreground.metadataStripped && background.metadataStripped,
        composite: {
          fit: fit as "contain" | "cover" | "stretch",
          opacityPercent,
          foregroundSourceAssetIds: foreground.sourceAssetIds,
          backgroundSourceAssetIds: background.sourceAssetIds,
        },
      };
    } else if (node.type === "operation.contact-sheet") {
      if (inputs.length < 1 || inputs.length > 8) {
        throw new Error(`${node.label} requires between one and eight images.`);
      }
      const columns = Math.min(numberConfig(node, "columns"), inputs.length);
      const rows = Math.ceil(inputs.length / columns);
      const gap = numberConfig(node, "gap");
      const cellWidth = numberConfig(node, "cellWidth");
      const cellHeight = numberConfig(node, "cellHeight");
      const background = stringConfig(node, "background");
      const labelMode = stringConfig(node, "labelMode");
      if (labelMode !== "index" && labelMode !== "none") {
        throw new Error(`${node.label} requires index or none labels.`);
      }
      const sourceAssetIds = [
        ...new Set(inputs.flatMap((input) => input.sourceAssetIds)),
      ];
      value = {
        width: columns * cellWidth + gap * (columns - 1),
        height: rows * cellHeight + gap * (rows - 1),
        sourceAssetIds,
        metadataStripped: inputs.every((input) => input.metadataStripped),
        contactSheet: {
          columns,
          cellWidth,
          cellHeight,
          gap,
          background,
          labelMode,
          sourceAssetIds,
        },
        ...(inputs.some((input) => input.autoTagProfile === "technical-metadata-v1")
          ? { autoTagProfile: "technical-metadata-v1" as const }
          : {}),
      };
    } else {
      value = singleInput(node, inputs);
      const outputFormat = stringConfig(node, "format");
      if (value.outputFormat && value.outputFormat !== outputFormat) {
        throw new Error(
          `Save asset format ${outputFormat} conflicts with the upstream explicit ${value.outputFormat} conversion.`,
        );
      }
      value.outputFormat = outputFormat;
      finalValue = value;
    }
    values.set(node.id, value);
    transitionBrowserNode(
      detail,
      node.id,
      "completed",
      "browser.local.execute",
      `Completed ${node.label}`,
      (nodeIndex + 1) / Math.max(ordered.length, 1),
    );
  }
  } catch (error: unknown) {
    const diagnostic = error instanceof Error ? error.message : "Browser local flow failed.";
    finalizeBrowserNodes(detail, "failed");
    detail.status = "failed";
    detail.error = diagnostic;
    detail.failure = browserRunFailure(detail, diagnostic, "local_image_flow");
    detail.currentStep = "Failed";
    detail.updatedAt = now();
    appendBrowserEvent(detail, {
      kind: "run_failed",
      message: "Browser local image utility execution failed.",
      progress: detail.progress,
      stepId: null,
    });
    throw error;
  }
  if (!finalValue?.outputFormat) {
    throw new Error("Local image utility flow did not reach its Save asset output.");
  }
  const outputFormat = finalValue.outputFormat;
  if (!isMediaImageOutputFormat(outputFormat)) {
    throw new Error(`Unsupported local image output format ${outputFormat}.`);
  }
  if (finalValue.alphaExtraction && outputFormat === "jpeg") {
    throw new Error(
      "Cutouts and exact alpha mattes must use PNG or WebP; JPEG would flatten transparency or quantize the matte.",
    );
  }
  const technicalTags: MediaAssetTag[] = finalValue.autoTagProfile
    ? [
        { value: "image", label: "Image" },
        outputFormat === "png"
          ? { value: "png", label: "PNG" }
          : outputFormat === "jpeg"
            ? { value: "jpeg", label: "JPEG" }
            : { value: "webp", label: "WebP" },
        Math.abs(finalValue.width - finalValue.height) <=
        Math.max(finalValue.width, finalValue.height) / 100
          ? { value: "square", label: "Square" }
          : finalValue.width > finalValue.height
            ? { value: "landscape", label: "Landscape" }
            : { value: "portrait", label: "Portrait" },
        Math.min(finalValue.width, finalValue.height) < 512
          ? { value: "low-resolution", label: "Low resolution" }
          : Math.max(finalValue.width, finalValue.height) >= 1_920 ||
              finalValue.width * finalValue.height >= 2_000_000
            ? { value: "high-resolution", label: "High resolution" }
            : { value: "standard-resolution", label: "Standard resolution" },
      ].map((tag) => ({
        ...tag,
        source: "technical" as const,
        confidence: 1,
        createdAt,
      }))
    : [];
  const digestBytes = sha256(
    new TextEncoder().encode(
      `${request.planSnapshot.flowFingerprint}\0${finalValue.sourceAssetIds.join("\0")}\0${finalValue.width}x${finalValue.height}\0${finalValue.outputFormat}`,
    ),
  );
  const digest = Array.from(digestBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const asset: MediaAssetRecord = {
    id: `asset:${request.runId}:0`,
    runId: request.runId,
    digest,
    kind: "image",
    mimeType: mimeTypeForFormat(outputFormat),
    byteSize: Math.max(256, Math.round(finalValue.width * finalValue.height * 1.4)),
    width: finalValue.width,
    height: finalValue.height,
    createdAt,
    outputIndex: 0,
    fixture: false,
    operation: {
      kind: "local-image-flow",
      flowRevisionId: request.flowRevisionId,
      metadataStripped: finalValue.metadataStripped,
      assetRole: finalValue.alphaExtraction
        ? "alpha-matte"
        : "primary",
      ...(finalValue.alphaExtraction ? { alphaExtraction: null } : {}),
      ...(finalValue.autoTagProfile
        ? { autoTagProfile: finalValue.autoTagProfile }
        : {}),
      ...(finalValue.composite
        ? {
            composite: {
              engine: "center-alpha-over-v1" as const,
              ...finalValue.composite,
            },
          }
        : {}),
      ...(finalValue.contactSheet
        ? {
            contactSheet: {
              engine: "grid-contact-sheet-v1" as const,
              ...finalValue.contactSheet,
            },
          }
        : {}),
      nodeIds: ordered.map((node) => node.id),
    },
    sourceAssetIds: finalValue.sourceAssetIds,
    tags: [
      ...technicalTags,
      ...(finalValue.alphaExtraction
        ? [
          {
            value: "alpha-matte",
            label: "Alpha matte",
            source: "technical" as const,
            confidence: 1,
            createdAt,
          },
          ]
        : []),
    ],
  };
  detail.status = "completed";
  detail.progress = 1;
  detail.currentStep = "Completed";
  detail.updatedAt = now();
  detail.assets = [asset];
  appendBrowserEvent(detail, {
    kind: "local_flow_executed",
    message:
      "The browser validated the pinned local utility graph and produced deterministic metadata fixtures; no source pixels, model, or network request were used.",
    progress: 1,
    stepId: "local-flow.execute",
  });
  appendBrowserEvent(detail, {
    kind: "asset_published",
    message: "The final image was published as an immutable derived preview asset.",
    progress: 1,
    stepId: "local-flow.publish",
  });
  appendBrowserEvent(detail, {
    kind: "run_completed",
    message:
      "Browser fixture preview completed. The native app performs the bounded pixel operation and writes verified bytes to CAS.",
    progress: 1,
    stepId: "local-flow.finalize",
  });
  browserRuns.set(request.runId, detail);
  return clone(detail);
};

export const executeMediaLocalImageFlow = async (
  request: ExecuteLocalImageFlowRequest,
  flow: MediaFlow,
): Promise<MediaRunDetail> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRunDetail>("media_execute_local_image_flow", { request });
  }
  return executeBrowserLocalImageFlow(request, flow);
};

export const executeMediaRemoteImageEditFlow = async (
  request: ExecuteRemoteImageEditFlowRequest,
  flow: MediaFlow,
): Promise<MediaRunDetail> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRunDetail>("media_execute_remote_image_edit_flow", {
      request,
    });
  }
  const promptNode = flow.nodes.find((node) => node.type === "source.prompt");
  const editNode = flow.nodes.find((node) => node.type === "task.edit-image");
  const sourceAssetIds = flow.nodes
    .filter((node) => node.type === "source.image")
    .map((node) => String(node.config.assetId ?? ""))
    .filter(Boolean);
  const configuredAspectRatio = String(editNode?.config.aspectRatio ?? "1:1");
  const aspectRatio =
    configuredAspectRatio === "4:5" ||
    configuredAspectRatio === "16:9" ||
    configuredAspectRatio === "9:16"
      ? configuredAspectRatio
      : "1:1";
  const previewRequest: EnqueueFixtureRunRequest = {
    runId: request.runId,
    flowId: request.flowId,
    flowRevisionId: request.flowRevisionId,
    flowName: flow.name,
    planId: request.planId,
    prompt: String(promptNode?.config.prompt ?? "Image edit preview"),
    modelLabel: "GPT Image 2 · browser fixture",
    target: "remote",
    outputCount: Number(editNode?.config.outputCount ?? 1),
    diagnosticCount: 0,
    aspectRatio,
    planSnapshot: request.planSnapshot,
  };
  validateBrowserRunFlowRevision(previewRequest);
  browserEditSourceAssets.set(request.runId, sourceAssetIds);
  enqueueBrowserFixture(previewRequest);
  const stored = browserRuns.get(request.runId);
  if (!stored) {
    throw new Error("Browser edit preview could not be registered.");
  }
  stored.currentStep = "Browser-only edit fixture — no upload or charge";
  appendBrowserEvent(stored, {
    kind: "provider_prepared",
    message: `Browser preview used ${sourceAssetIds.length} local asset reference${sourceAssetIds.length === 1 ? "" : "s"}; no provider request, upload, or charge occurred.`,
    progress: 0.01,
    stepId: "provider.preview",
  });
  return clone(stored);
};

export const transformMediaImage = async (
  request: MediaImageTransformRequest,
): Promise<MediaRunDetail> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaRunDetail>("media_transform_image", { request });
  }
  return transformBrowserImage(request);
};

export const exportMediaAsset = async (
  request: MediaAssetExportRequest,
): Promise<MediaAssetExportRecord> => {
  if (!canInvokeNativeRuntime()) {
    throw new Error("Asset export is available in the native desktop app only.");
  }
  return invoke<MediaAssetExportRecord>("media_export_asset", { request });
};

const findBrowserAsset = (
  assetId: string,
): { detail: MediaRunDetail; asset: MediaAssetRecord } => {
  for (const detail of browserRuns.values()) {
    const asset = detail.assets.find((candidate) => candidate.id === assetId);
    if (asset) {
      return { detail, asset };
    }
  }
  throw new Error(`Media asset ${assetId} was not found.`);
};

const normalizeBrowserTags = (
  tags: readonly string[],
): Array<{ value: string; label: string }> => {
  if (tags.length > 64) {
    throw new Error("Asset tag input is limited to 64 entries.");
  }
  const normalized: Array<{ value: string; label: string }> = [];
  const seen = new Set<string>();
  for (const rawTag of tags) {
    const label = rawTag.trim().split(/\s+/u).filter(Boolean).join(" ");
    if (!label) {
      continue;
    }
    if ([...label].length > 48) {
      throw new Error("Asset tags are limited to 48 characters.");
    }
    let value = "";
    let separatorPending = false;
    for (const character of label) {
      if (/^[\p{L}\p{N}]$/u.test(character)) {
        if (separatorPending && value) {
          value += "-";
        }
        separatorPending = false;
        value += character.toLowerCase();
      } else if (/^[\s_-]$/u.test(character)) {
        separatorPending = true;
      } else {
        throw new Error(
          "Asset tags may contain letters, numbers, spaces, hyphens, and underscores.",
        );
      }
    }
    if (value && !seen.has(value)) {
      seen.add(value);
      normalized.push({ value, label });
    }
  }
  if (normalized.length > 32) {
    throw new Error("An asset can have at most 32 user tags.");
  }
  return normalized;
};

const replaceBrowserAssetTags = (
  assetId: string,
  source: MediaAssetTag["source"],
  tags: Array<{ value: string; label: string }>,
  confidence: number | null,
): MediaAssetRecord => {
  const { detail, asset } = findBrowserAsset(assetId);
  const createdAt = now();
  asset.tags = [
    ...asset.tags.filter((tag) => tag.source !== source),
    ...tags.map((tag) => ({
      ...tag,
      source,
      confidence,
      createdAt,
    })),
  ].sort((left, right) => left.value.localeCompare(right.value));
  detail.updatedAt = createdAt;
  appendBrowserEvent(detail, {
    kind: "asset_tagged",
    message: `${tags.length} ${source} tag${tags.length === 1 ? "" : "s"} were saved as a metadata-only revision.`,
    progress: 1,
    stepId: "asset.tags",
  });
  return clone(asset);
};

export const setMediaAssetTags = async (
  update: MediaAssetTagUpdate,
): Promise<MediaAssetRecord> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaAssetRecord>("media_set_asset_tags", {
      assetId: update.assetId,
      tags: update.tags,
    });
  }
  return replaceBrowserAssetTags(
    update.assetId,
    "user",
    normalizeBrowserTags(update.tags),
    null,
  );
};

export const autoTagMediaAsset = async (
  assetId: string,
): Promise<MediaAssetRecord> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaAssetRecord>("media_auto_tag_asset", { assetId });
  }
  const { asset } = findBrowserAsset(assetId);
  const tags: Array<{ value: string; label: string }> = [
    { value: asset.kind, label: asset.kind },
  ];
  const formatTags: Partial<
    Record<MediaAssetRecord["mimeType"], { value: string; label: string }>
  > = {
    "image/png": { value: "png", label: "PNG" },
    "image/jpeg": { value: "jpeg", label: "JPEG" },
    "image/webp": { value: "webp", label: "WebP" },
    "application/json": { value: "json-report", label: "JSON report" },
  };
  const formatTag = formatTags[asset.mimeType];
  if (formatTag) {
    tags.push(formatTag);
  }
  if (asset.width > 0 && asset.height > 0) {
    const difference = Math.abs(asset.width - asset.height);
    tags.push(
      difference <= Math.max(asset.width, asset.height) / 100
        ? { value: "square", label: "Square" }
        : asset.width > asset.height
          ? { value: "landscape", label: "Landscape" }
          : { value: "portrait", label: "Portrait" },
    );
    tags.push(
      Math.min(asset.width, asset.height) < 512
        ? { value: "low-resolution", label: "Low resolution" }
        : Math.max(asset.width, asset.height) >= 1_920 ||
            asset.width * asset.height >= 2_000_000
          ? { value: "high-resolution", label: "High resolution" }
          : { value: "standard-resolution", label: "Standard resolution" },
    );
  }
  if (asset.fixture) {
    tags.push({ value: "fixture-output", label: "Fixture output" });
  }
  return replaceBrowserAssetTags(assetId, "technical", tags, 1);
};

const browserDeletionImpact = (
  assetId: string,
): MediaAssetDeletionImpact => {
  const { asset } = findBrowserAsset(assetId);
  const allAssets = [...browserRuns.values()].flatMap((detail) => detail.assets);
  const dependentAssetIds = allAssets
    .filter((candidate) => candidate.sourceAssetIds.includes(assetId))
    .map((candidate) => candidate.id)
    .sort();
  const sharedBlobAssetIds = allAssets
    .filter(
      (candidate) =>
        candidate.id !== assetId && candidate.digest === asset.digest,
    )
    .map((candidate) => candidate.id)
    .sort();
  const reclaimableByteSize =
    sharedBlobAssetIds.length === 0 ? asset.byteSize : 0;
  const retainedSharedByteSize =
    sharedBlobAssetIds.length > 0 ? asset.byteSize : 0;
  const warnings: string[] = [];
  if (dependentAssetIds.length > 0) {
    warnings.push(
      `${dependentAssetIds.length} active derived asset${dependentAssetIds.length === 1 ? "" : "s"} retain lineage to this asset and will show a source tombstone.`,
    );
  }
  if (sharedBlobAssetIds.length > 0) {
    warnings.push(
      "Content-addressed bytes still referenced by another active asset will be retained.",
    );
  }
  warnings.push(
    "Browser preview simulates deletion metadata; native mode performs reviewed CAS cleanup.",
  );
  const tokenPayload = JSON.stringify({
    assetId,
    digest: asset.digest,
    dependentAssetIds,
    sharedBlobAssetIds,
    exportCount: 0,
    activeExportCount: 0,
    renditionCount: 0,
    reclaimableByteSize,
    retainedSharedByteSize,
  });
  const confirmationToken = Array.from(
    sha256(new TextEncoder().encode(tokenPayload)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    assetId,
    digest: asset.digest,
    dependentAssetIds,
    sharedBlobAssetIds,
    exportCount: 0,
    activeExportCount: 0,
    renditionCount: 0,
    originalByteSize: asset.byteSize,
    renditionByteSize: 0,
    reclaimableByteSize,
    retainedSharedByteSize,
    warnings,
    confirmationToken: `sha256:${confirmationToken}`,
  };
};

export const planMediaAssetDeletion = async (
  assetId: string,
): Promise<MediaAssetDeletionImpact> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaAssetDeletionImpact>("media_plan_asset_deletion", {
      assetId,
    });
  }
  return clone(browserDeletionImpact(assetId));
};

export const deleteMediaAsset = async (
  request: MediaAssetDeletionRequest,
): Promise<MediaAssetDeletionResult> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaAssetDeletionResult>("media_delete_asset", { request });
  }
  const impact = browserDeletionImpact(request.assetId);
  if (impact.confirmationToken !== request.confirmationToken) {
    throw new Error(
      "Asset deletion impact changed; review the refreshed dependencies before confirming.",
    );
  }
  if (impact.dependentAssetIds.length > 0 && !request.confirmDependencies) {
    throw new Error("Dependent assets require explicit deletion acknowledgement.");
  }
  const { detail, asset } = findBrowserAsset(request.assetId);
  const deletedAt = now();
  appendBrowserEvent(detail, {
    kind: "asset_deleted",
    message:
      "Asset metadata was replaced by a durable preview tombstone after dependency review.",
    progress: 1,
    stepId: "asset.delete",
  });
  detail.updatedAt = deletedAt;
  detail.assets = detail.assets.filter((candidate) => candidate.id !== asset.id);
  const deleteBytes = request.mode === "metadata-and-unreferenced-bytes";
  const reclaimedBytes = deleteBytes ? impact.reclaimableByteSize : 0;
  const retainedBytes = deleteBytes
    ? impact.retainedSharedByteSize
    : impact.originalByteSize + impact.renditionByteSize;
  const result: MediaAssetDeletionResult = {
    tombstone: {
      assetId: asset.id,
      digest: asset.digest,
      kind: asset.kind,
      mimeType: asset.mimeType,
      deletedAt,
      mode: request.mode,
      bytesStatus: !deleteBytes
        ? "retained"
        : retainedBytes > 0
          ? reclaimedBytes > 0
            ? "partial"
            : "shared"
          : "deleted",
    },
    reclaimedBytes,
    retainedBytes,
    failedBlobDigests: [],
  };
  return clone(result);
};

const browserObservation = (
  sourceAssetId: string,
  metricId: string,
  status: MediaQualityObservation["status"],
  value: MediaQualityObservation["value"],
  limitations: string[],
): MediaQualityObservation => ({
  metricId,
  metricVersion: "1.0.0",
  family: "technical",
  scope: "asset",
  status,
  ...(value === undefined ? {} : { value }),
  direction: "categorical",
  inputAssetIds: [sourceAssetId],
  referenceAssetIds: [],
  preprocessingProfileId: "browser-metadata-only-v1",
  limitations,
});

const analyzeBrowserImageQuality = (
  sourceAssetId: string,
): MediaQualityAnalysisResult => {
  const source = [...browserRuns.values()]
    .flatMap((detail) => detail.assets)
    .find((asset) => asset.id === sourceAssetId && asset.kind === "image");
  if (!source) {
    throw new Error(`Image asset ${sourceAssetId} was not found.`);
  }
  const analyzedAt = now();
  const gateReasons = [
    "Browser preview cannot verify or decode native CAS bytes; pixel-dependent metrics remain unknown.",
  ];
  let verdict: MediaQualityReport["verdict"] = "warn";
  const minimumAxis = Math.min(source.width, source.height);
  if (minimumAxis < 128) {
    verdict = "fail";
    gateReasons.unshift(
      `Minimum axis ${minimumAxis}px is below the profile's 128px hard floor.`,
    );
  } else if (minimumAxis < 512) {
    gateReasons.unshift(
      `Minimum axis ${minimumAxis}px is below the profile's 512px review threshold.`,
    );
  }
  const report: MediaQualityReport = {
    schemaVersion: 1,
    sourceAssetId,
    analyzedAt,
    profile: {
      id: "technical-image-baseline",
      version: "1.0.0",
      description:
        "Browser metadata preview for the native deterministic technical image profile. Pixel-dependent metrics are explicitly unknown.",
    },
    verdict,
    gateReasons,
    observations: [
      browserObservation(
        sourceAssetId,
        "decode.valid",
        "unknown",
        undefined,
        ["Native CAS bytes are unavailable to browser preview mode."],
      ),
      browserObservation(
        sourceAssetId,
        "dimensions.exact",
        "observed",
        {
          width: source.width,
          height: source.height,
          pixels: source.width * source.height,
        },
        ["Dimensions come from deterministic fixture metadata."],
      ),
      browserObservation(
        sourceAssetId,
        "format.detected",
        "observed",
        source.mimeType,
        ["Format comes from fixture metadata rather than native byte probing."],
      ),
      browserObservation(
        sourceAssetId,
        "luma.standardDeviation",
        "unknown",
        undefined,
        ["Pixel-dependent luma metrics require native bounded decode."],
      ),
      browserObservation(
        sourceAssetId,
        "alpha.nonOpaqueRatio",
        "unknown",
        undefined,
        ["Alpha occupancy requires native bounded decode."],
      ),
    ],
  };
  const encoded = new TextEncoder().encode(JSON.stringify(report));
  const digest = Array.from(sha256(encoded), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const runId = `browser-analysis-${analyzedAt}-${digest.slice(0, 12)}`;
  const reportAsset: MediaAssetRecord = {
    id: `asset:${runId}:0`,
    runId,
    digest,
    kind: "report",
    mimeType: "application/json",
    byteSize: encoded.byteLength,
    width: 0,
    height: 0,
    createdAt: analyzedAt,
    outputIndex: 0,
    fixture: false,
    operation: {
      kind: "analyze-quality",
      profileId: report.profile.id,
      verdict,
    },
    sourceAssetIds: [sourceAssetId],
    tags: [],
  };
  const detail: MediaRunDetail = {
    id: runId,
    flowId: "builtin:analyze-image",
    flowRevisionId: null,
    flowName: "Analyze image quality",
    planId: `quality:${report.profile.id}:${report.profile.version}`,
    status: "completed",
    createdAt: analyzedAt,
    updatedAt: analyzedAt,
    prompt: "Deterministic technical image analysis",
    modelLabel: "Technical image profile",
    target: "local",
    outputCount: 1,
    diagnosticCount: 0,
    progress: 1,
    currentStep: "Completed",
    executor: "local-analysis",
    error: null,
    failure: null,
    events: [],
    assets: [reportAsset],
    providerJobs: [],
    humanReviews: [],
    nodeExecutions: [],
    planSnapshot: null,
  };
  appendBrowserEvent(detail, {
    kind: "asset_analyzed",
    message: `Technical quality profile produced a ${verdict} preview verdict and immutable report metadata.`,
    progress: 1,
    stepId: "analysis.publish",
  });
  appendBrowserEvent(detail, {
    kind: "run_completed",
    message: "Browser metadata analysis completed without a network request.",
    progress: 1,
    stepId: "analysis.finalize",
  });
  browserRuns.set(runId, detail);
  browserQualityReports.set(reportAsset.id, report);
  return { detail: clone(detail), report: clone(report) };
};

export const analyzeMediaImageQuality = async (
  sourceAssetId: string,
): Promise<MediaQualityAnalysisResult> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaQualityAnalysisResult>("media_analyze_image_quality", {
      sourceAssetId,
    });
  }
  return analyzeBrowserImageQuality(sourceAssetId);
};

export const readMediaQualityReport = async (
  reportAssetId: string,
): Promise<MediaQualityReport> => {
  if (canInvokeNativeRuntime()) {
    return invoke<MediaQualityReport>("media_read_quality_report", {
      reportAssetId,
    });
  }
  const report = browserQualityReports.get(reportAssetId);
  if (!report) {
    throw new Error(`Quality report ${reportAssetId} was not found.`);
  }
  return clone(report);
};
