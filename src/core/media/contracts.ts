export type MediaAssetKind =
  | "prompt"
  | "image"
  | "vector"
  | "alpha-matte"
  | "report"
  | "collection";

export interface MediaAssetReference {
  source: "media-asset";
  workspaceRoot: string;
  assetId: string;
  kind: MediaAssetKind;
  displayName?: string;
  rendition?: "thumbnail" | "preview" | "original";
}

export interface MediaRunReference {
  source: "media-run";
  workspaceRoot: string;
  runId: string;
  outputAssetIds: string[];
}

export type MediaCapability =
  | "text-to-image"
  | "text-to-svg"
  | "image-to-svg"
  | "guided-svg-generation"
  | "svg-edit"
  | "svg-structure-evaluation"
  | "render-verified"
  | "image-to-image"
  | "multi-reference-edit"
  | "background-remove"
  | "image-quality-analysis"
  | "transparent-output";

export type MediaExecutionTarget = "local" | "remote";
export type MediaProviderPolicy = "auto" | "local" | "remote";
export type MediaModelPolicy = "balanced" | "fast" | "quality";
export type MediaLifecycleState =
  | "active"
  | "preview"
  | "deprecated"
  | "scheduled-shutdown"
  | "removed";

export type MediaModelInstallationStatus =
  | "remote"
  | "bundled"
  | "not-installed"
  | "queued"
  | "downloading"
  | "installed"
  | "verifying"
  | "activating"
  | "canceling"
  | "removing"
  | "quarantined"
  | "failed";

export type MediaModelPackageType =
  | "remote-endpoint"
  | "diffusers"
  | "safetensors"
  | "onnx"
  | "native-utility";

export type MediaLocalModelArchitecture =
  | "stable-diffusion-1"
  | "stable-diffusion-2"
  | "stable-diffusion-xl"
  | "stable-diffusion-3"
  | "flux-1"
  | "flux-2";

export type MediaLocalModelArchitectureConfidence =
  | "high"
  | "medium"
  | "unknown";

export type MediaModelAddonKind = "lora" | "textual-inversion";

export type MediaModelAddonTargetComponent =
  | "denoiser"
  | "text-encoder"
  | "text-encoder-2";

export interface MediaModelAddonCapability {
  kind: MediaModelAddonKind;
  targetComponents: readonly MediaModelAddonTargetComponent[];
  maxActive: number;
  supportsSeparateComponentStrengths: boolean;
  supportsDenoisingSchedules: boolean;
}

export interface MediaEmbeddingVectorProfile {
  component: Exclude<MediaModelAddonTargetComponent, "denoiser">;
  tensorKey: string;
  vectorCount: number;
  dimension: number;
}

export interface MediaLoraTensorProfile {
  algorithm: "lora" | "locon" | "dora";
  dialect: "kohya" | "diffusers-peft" | "generic";
  rankMinimum: number;
  rankMaximum: number;
  heterogeneousRanks: boolean;
  targetModuleCount: number;
  convolutionTargetCount: number;
  magnitudeVectorCount: number;
  networkAlphaCount: number;
}

export interface MediaModelLicense {
  name: string;
  spdxId: string | null;
  sourceUrl: string;
  commercialUse: "allowed" | "provider-terms" | "review-required";
  requiresAcceptance: boolean;
}

export interface MediaProviderCatalogEntry {
  id: string;
  displayName: string;
  target: MediaExecutionTarget;
  configured: boolean;
  lifecycle: MediaLifecycleState;
  capabilities: readonly MediaCapability[];
  privacySummary: string;
  checkedAt: string;
  staleAfterSeconds: number;
  sourceUrl?: string;
  catalogRevision: string;
}

export type MediaNodeLayer =
  | "source"
  | "task"
  | "operation"
  | "control"
  | "output"
  | "runtime";

export type MediaNodeType =
  | "source.prompt"
  | "source.image"
  | "task.generate-image"
  | "task.edit-image"
  | "operation.crop"
  | "operation.resize"
  | "operation.format-convert"
  | "operation.metadata-strip"
  | "operation.auto-tag"
  | "operation.contact-sheet"
  | "operation.subject-cutout"
  | "operation.alpha-matte"
  | "operation.composite"
  | "operation.quality-analyze"
  | "control.quality-gate"
  | "control.human-review"
  | "output.asset";

export type MediaPortDataType =
  | "prompt"
  | "image"
  | "report"
  | "asset-ref";

export interface MediaFlowNode {
  id: string;
  type: MediaNodeType;
  version: 1;
  label: string;
  layer: MediaNodeLayer;
  config: Record<string, unknown>;
}

export interface MediaFlowEdge {
  id: string;
  fromNodeId: string;
  fromPortId: string;
  toNodeId: string;
  toPortId: string;
}

export type MediaFlowVariableType = "text" | "number" | "boolean" | "choice";
export type MediaFlowVariableValue = string | number | boolean;

interface MediaFlowVariableBase {
  id: string;
  name: string;
  description: string;
  required: boolean;
}

export interface MediaFlowTextVariable extends MediaFlowVariableBase {
  type: "text";
  defaultValue: string | null;
  constraints: {
    maxLength: number;
  };
}

export interface MediaFlowNumberVariable extends MediaFlowVariableBase {
  type: "number";
  defaultValue: number | null;
  constraints: {
    min: number;
    max: number;
    step: number;
  };
}

export interface MediaFlowBooleanVariable extends MediaFlowVariableBase {
  type: "boolean";
  defaultValue: boolean | null;
  constraints: Record<never, never>;
}

export interface MediaFlowChoiceVariable extends MediaFlowVariableBase {
  type: "choice";
  defaultValue: string | null;
  constraints: {
    options: string[];
  };
}

export type MediaFlowVariable =
  | MediaFlowTextVariable
  | MediaFlowNumberVariable
  | MediaFlowBooleanVariable
  | MediaFlowChoiceVariable;

export interface MediaFlowPreset {
  id: string;
  name: string;
  description: string;
  values: Record<string, MediaFlowVariableValue>;
}

export interface MediaFlow {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  variables: MediaFlowVariable[];
  variableBindings: Record<string, MediaFlowVariableValue>;
  presets: MediaFlowPreset[];
  activePresetId: string | null;
  nodes: MediaFlowNode[];
  edges: MediaFlowEdge[];
}

export interface MediaFlowNodeLayout {
  nodeId: string;
  x: number;
  y: number;
}

export type MediaFlowGroupColor = "slate" | "cyan" | "violet" | "amber" | "emerald";

export interface MediaFlowLayoutGroup {
  id: string;
  label: string;
  color: MediaFlowGroupColor;
  collapsed: boolean;
  nodeIds: string[];
}

export interface MediaFlowLayoutComment {
  id: string;
  body: string;
  color: MediaFlowGroupColor;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MediaFlowLayout {
  schemaVersion: 1;
  flowId: string;
  nodes: MediaFlowNodeLayout[];
  groups: MediaFlowLayoutGroup[];
  comments: MediaFlowLayoutComment[];
}

export type MediaFlowTemplateCategory = "Generation" | "Product" | "Quality";

export interface MediaFlowTemplateDescriptor {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  category: MediaFlowTemplateCategory;
  tags: string[];
  workflowSummary: string;
  privacySummary: string;
  remoteCapable: boolean;
  flow: MediaFlow;
  layout: MediaFlowLayout;
}

export interface InstantiateMediaFlowTemplateResult {
  templateId: string;
  flow: MediaFlow;
  layout: MediaFlowLayout;
}

export interface MediaFlowHead {
  schemaVersion: 1;
  flowId: string;
  name: string;
  description: string;
  headRevisionId: string;
  headRevisionNumber: number;
  createdAt: string;
  updatedAt: string;
  documentDigest: string;
  executionDigest: string;
  layoutDigest: string;
}

export interface MediaFlowRevision {
  schemaVersion: 1;
  revisionId: string;
  flowId: string;
  revisionNumber: number;
  parentRevisionId: string | null;
  createdAt: string;
  changeSummary: string;
  documentDigest: string;
  executionDigest: string;
  layoutDigest: string;
  nodeCount: number;
  edgeCount: number;
  isHead: boolean;
  flow: MediaFlow;
  layout: MediaFlowLayout;
}

export interface MediaFlowHistory {
  schemaVersion: 1;
  flowId: string;
  head: MediaFlowHead | null;
  revisions: MediaFlowRevision[];
}

export type MediaFlowRevisionChangeKind = "added" | "removed" | "modified";

export interface MediaFlowRevisionNodeChange {
  nodeId: string;
  nodeLabel: string;
  kind: MediaFlowRevisionChangeKind;
  changedFields: string[];
  executionAffecting: boolean;
}

export interface MediaFlowRevisionEdgeChange {
  edgeId: string;
  kind: MediaFlowRevisionChangeKind;
  description: string;
}

export interface MediaFlowRevisionLayoutChange {
  nodeId: string;
  kind: MediaFlowRevisionChangeKind;
  before: { x: number; y: number } | null;
  after: { x: number; y: number } | null;
}

export interface MediaFlowRevisionVariableChange {
  variableId: string;
  variableName: string;
  kind: MediaFlowRevisionChangeKind;
  changedFields: string[];
  executionAffecting: boolean;
}

export interface MediaFlowRevisionPresetChange {
  presetId: string;
  presetName: string;
  kind: MediaFlowRevisionChangeKind;
  changedFields: string[];
}

export interface MediaFlowRevisionDiff {
  schemaVersion: 1;
  baseRevisionId: string;
  targetRevisionId: string;
  documentChanged: boolean;
  executionChanged: boolean;
  layoutChanged: boolean;
  metadataFieldsChanged: string[];
  nodeChanges: MediaFlowRevisionNodeChange[];
  edgeChanges: MediaFlowRevisionEdgeChange[];
  layoutChanges: MediaFlowRevisionLayoutChange[];
  variableChanges: MediaFlowRevisionVariableChange[];
  presetChanges: MediaFlowRevisionPresetChange[];
}

export interface SaveMediaFlowRevisionRequest {
  schemaVersion: 1;
  idempotencyKey: string;
  expectedHeadRevisionId: string | null;
  changeSummary: string;
  flow: MediaFlow;
  layout: MediaFlowLayout;
}

export interface SaveMediaFlowRevisionResult {
  schemaVersion: 1;
  created: boolean;
  head: MediaFlowHead;
  revision: MediaFlowRevision;
}

export interface ExportMediaFlowRevisionRequest {
  schemaVersion: 1;
  idempotencyKey: string;
  revisionId: string;
  destinationPath: string;
}

export interface MediaFlowExportResult {
  schemaVersion: 1;
  revisionId: string;
  fileName: string;
  byteSize: number;
  bundleDigest: string;
  exportedAt: string;
  requirementCount: number;
}

export interface InspectMediaFlowImportRequest {
  schemaVersion: 1;
  sourcePath: string;
}

export interface ImportMediaFlowRequest {
  schemaVersion: 1;
  idempotencyKey: string;
  sourcePath: string;
  reviewToken: string;
}

export type MediaFlowImportStatus = "ready" | "inspect-only" | "invalid";

export interface MediaFlowNodeRequirement {
  nodeType: string;
  version: number;
  supported: boolean;
}

export interface MediaFlowImportIssue {
  severity: "warning" | "error";
  code: string;
  message: string;
  nodeId: string | null;
}

export interface MediaFlowUnknownNodeTombstone {
  schemaVersion: 1;
  nodeId: string;
  nodeType: string;
  version: number | null;
  originalNode: unknown;
  connectedEdges: unknown[];
}

export interface MediaFlowImportInspection {
  schemaVersion: 1;
  status: MediaFlowImportStatus;
  canImport: boolean;
  reviewToken: string;
  sourceDisplayName: string;
  bundleDigest: string;
  bundleSchemaVersion: number | null;
  sourceFlowId: string | null;
  sourceFlowName: string | null;
  sourceRevisionId: string | null;
  proposedFlowId: string | null;
  nodeCount: number;
  edgeCount: number;
  documentDigest: string | null;
  executionDigest: string | null;
  layoutDigest: string | null;
  requirements: MediaFlowNodeRequirement[];
  issues: MediaFlowImportIssue[];
  unknownNodes: MediaFlowUnknownNodeTombstone[];
  importMutations: string[];
}

export interface ImportMediaFlowResult {
  schemaVersion: 1;
  created: boolean;
  bundleDigest: string;
  sourceFlowId: string;
  sourceRevisionId: string;
  targetFlowId: string;
  importMutations: string[];
  head: MediaFlowHead;
  revision: MediaFlowRevision;
}

export interface MediaModelDescriptor {
  id: string;
  providerId: string;
  displayName: string;
  family: string;
  target: MediaExecutionTarget;
  lifecycle: MediaLifecycleState;
  lifecycleCheckedAt: string;
  lifecycleStaleAfterSeconds: number;
  lifecycleSourceUrl?: string;
  catalogRevision: string;
  capabilities: readonly MediaCapability[];
  configured: boolean;
  installed: boolean;
  bundled: boolean;
  installationStatus: MediaModelInstallationStatus;
  installedRevision?: string;
  packageType: MediaModelPackageType;
  architecture: MediaLocalModelArchitecture | null;
  addonCapabilities: readonly MediaModelAddonCapability[];
  runtimeReadiness?:
    | "not-applicable"
    | "unverified"
    | "ready"
    | "failed"
    | "runtime-unavailable";
  runtimeReadinessDiagnostic?: string;
  runtimeReadinessCheckedAt?: string;
  license: MediaModelLicense;
  recommended: boolean;
  speedScore: number;
  qualityScore: number;
  minVramGb?: number;
  expectedDownloadGb?: number;
  costHint?: string;
  privacySummary: string;
  limitation?: string;
  userImported: boolean;
}

export interface MediaLocalModelRuntimeProbeResult {
  schemaVersion: 1;
  modelId: string;
  revision: string;
  status: "ready" | "failed" | "unavailable";
  diagnostic: string;
  checkedAt: string;
  workerVersion: string | null;
  pipelineClass: string | null;
  deviceLabel: string | null;
  components: string[];
  capabilities: string[];
}

export interface MediaModelAddonDescriptor {
  id: string;
  kind: MediaModelAddonKind;
  displayName: string;
  architecture: MediaLocalModelArchitecture;
  architectureConfidence: MediaLocalModelArchitectureConfidence;
  format: "safetensors";
  targetComponents: readonly MediaModelAddonTargetComponent[];
  embeddingVectors: readonly MediaEmbeddingVectorProfile[];
  loraProfile: MediaLoraTensorProfile | null;
  baseModelHint: string | null;
  triggerWords: string[];
  defaultToken: string | null;
  digest: string;
  headerDigest: string;
  byteSize: number;
  relativePath: string;
  sourceUrl: string | null;
  sourceMetadata?: MediaModelAddonSourceMetadata | null;
  license: MediaModelLicense;
  importedAt: string;
}

export interface MediaModelCatalogSnapshot {
  schemaVersion: 1;
  catalogRevision: string;
  observedAt: string;
  providers: MediaProviderCatalogEntry[];
  models: MediaModelDescriptor[];
  addons: MediaModelAddonDescriptor[];
}

export interface MediaLocalModelImportInspection {
  schemaVersion: 1;
  canImport: boolean;
  blockingReason: string | null;
  sourcePath: string;
  sourceFileName: string;
  byteSize: number;
  tensorCount: number;
  headerDigest: string;
  reviewToken: string;
  suggestedDisplayName: string;
  detectedArchitecture: MediaLocalModelArchitecture | null;
  architectureConfidence: MediaLocalModelArchitectureConfidence;
  metadataSummary: string[];
  warnings: string[];
}

export interface ImportMediaLocalModelRequest {
  sourcePath: string;
  reviewToken: string;
  displayName: string;
  architecture: MediaLocalModelArchitecture;
  sourceUrl: string | null;
  licenseName: string;
  commercialUse: "allowed" | "review-required";
  confirmRights: boolean;
}

export interface MediaLocalModelImportResult {
  schemaVersion: 1;
  modelId: string;
  displayName: string;
  family: string;
  revision: string;
  digest: string;
  byteSize: number;
  targetLabel: string;
  importedAt: string;
  alreadyInstalled: boolean;
}

export interface MediaModelAddonImportInspection {
  schemaVersion: 1;
  canImport: boolean;
  blockingReason: string | null;
  sourcePath: string;
  sourceFileName: string;
  byteSize: number;
  tensorCount: number;
  headerDigest: string;
  reviewToken: string;
  suggestedDisplayName: string;
  detectedKind: MediaModelAddonKind | null;
  detectedArchitecture: MediaLocalModelArchitecture | null;
  architectureConfidence: MediaLocalModelArchitectureConfidence;
  targetComponents: MediaModelAddonTargetComponent[];
  embeddingVectors: MediaEmbeddingVectorProfile[];
  loraProfile: MediaLoraTensorProfile | null;
  baseModelHint: string | null;
  suggestedTriggerWords: string[];
  suggestedToken: string | null;
  metadataSummary: string[];
  warnings: string[];
}

export interface ImportMediaModelAddonRequest {
  sourcePath: string;
  reviewToken: string;
  displayName: string;
  kind: MediaModelAddonKind;
  architecture: MediaLocalModelArchitecture;
  triggerWords: string[];
  token: string | null;
  sourceUrl: string | null;
  licenseName: string;
  commercialUse: "allowed" | "review-required";
  confirmRights: boolean;
}

export interface MediaModelAddonImportResult {
  schemaVersion: 1;
  addonId: string;
  kind: MediaModelAddonKind;
  displayName: string;
  architecture: MediaLocalModelArchitecture;
  digest: string;
  byteSize: number;
  targetLabel: string;
  importedAt: string;
  alreadyInstalled: boolean;
}

export interface MediaModelAddonRemovalPlan {
  schemaVersion: 1;
  addonId: string;
  displayName: string;
  kind: MediaModelAddonKind;
  digest: string;
  installedBytes: number;
  targetLabel: string;
  confirmationToken: string;
  canRemove: boolean;
  blockingRunCount: number;
  blockingRunIds: string[];
  savedFlowCount: number;
  savedFlowIds: string[];
  historicalRunCount: number;
  warnings: string[];
}

export interface RemoveMediaModelAddonRequest {
  addonId: string;
  confirmationToken: string;
  confirmRemoval: boolean;
}

export interface MediaModelAddonRemovalResult {
  schemaVersion: 1;
  addonId: string;
  digest: string;
  removedAt: string;
  reclaimedBytes: number;
  cleanupPending: boolean;
}

export interface MediaCivitaiModelAddonFileInspection {
  id: number;
  name: string;
  byteSize: number;
  sha256: string;
  pickleScanResult: string;
  virusScanResult: string;
  scannedAt: string | null;
}

export interface MediaCivitaiLicenseClaims {
  allowNoCredit: boolean | null;
  allowCommercialUse: string[] | null;
  allowDerivatives: boolean | null;
  allowDifferentLicense: boolean | null;
}

export interface MediaCivitaiModelAddonInspection {
  schemaVersion: 1;
  canDownload: boolean;
  blockingReason: string | null;
  reviewToken: string;
  observedAt: string;
  sourceUrl: string;
  air: string | null;
  modelId: number;
  versionId: number;
  modelName: string;
  versionName: string;
  kind: MediaModelAddonKind | null;
  baseModel: string | null;
  suggestedArchitecture: MediaLocalModelArchitecture | null;
  trainedWords: string[];
  creator: string | null;
  nsfw: boolean;
  poi: boolean;
  availability: string | null;
  status: string | null;
  file: MediaCivitaiModelAddonFileInspection | null;
  licenseClaims: MediaCivitaiLicenseClaims;
  warnings: string[];
}

export interface MediaModelAddonSourceMetadata {
  provider: "civitai";
  metadata: MediaCivitaiModelAddonInspection;
}

export interface DownloadMediaCivitaiModelAddonRequest {
  source: string;
  reviewToken: string;
}

export interface MediaModelInstallManifestFile {
  path: string;
  byteSize: number;
  sha256: string;
}

export interface MediaModelInstallPlan {
  schemaVersion: 1;
  modelId: string;
  displayName: string;
  revision: string;
  manifestDigest: string;
  licenseDigest: string;
  reviewToken: string;
  sourceUrl: string;
  targetLabel: string;
  files: MediaModelInstallManifestFile[];
  excludedPaths: string[];
  totalBytes: number;
  requiredWorkingBytes: number;
  availableBytes: number | null;
  hasSufficientSpace: boolean | null;
  alreadyInstalled: boolean;
  license: MediaModelLicense;
  warnings: string[];
}

export type MediaModelInstallJobStatus =
  | "queued"
  | "downloading"
  | "verifying"
  | "activating"
  | "canceling"
  | "installed"
  | "failed"
  | "canceled";

export interface MediaModelInstallJob {
  id: string;
  modelId: string;
  revision: string;
  status: MediaModelInstallJobStatus;
  manifestDigest: string;
  filesTotal: number;
  filesCompleted: number;
  bytesTotal: number;
  bytesDownloaded: number;
  progress: number;
  currentFile: string | null;
  error: string | null;
  failure: MediaErrorDetail | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface StartMediaModelInstallRequest {
  modelId: string;
  reviewToken: string;
  manifestDigest: string;
  licenseDigest: string;
  acceptLicense: boolean;
}

export interface MediaModelRemovalPlan {
  schemaVersion: 1;
  modelId: string;
  displayName: string;
  revision: string;
  installedBytes: number;
  targetLabel: string;
  confirmationToken: string;
  canRemove: boolean;
  blockingJobId: string | null;
  warnings: string[];
}

export interface RemoveMediaModelRequest {
  modelId: string;
  confirmationToken: string;
  confirmRemoval: boolean;
}

export interface MediaModelRemovalResult {
  modelId: string;
  revision: string;
  removedAt: string;
  reclaimedBytes: number;
  cleanupPending: boolean;
}

export type MediaImageReferenceRole =
  | "base"
  | "subject"
  | "style"
  | "composition"
  | "palette"
  | "detail";

export interface MediaImageReference {
  assetId: string;
  role: MediaImageReferenceRole;
  influence: number;
}

export interface MediaLoraSelection {
  kind: "lora";
  addonId: string;
  enabled: boolean;
  modelStrength: number;
  textEncoderStrength: number | null;
  denoisingSchedule: MediaLoraDenoisingSchedule | null;
}

export interface MediaLoraDenoisingSchedule {
  start: number;
  end: number;
}

export interface MediaTextualInversionSelection {
  kind: "textual-inversion";
  addonId: string;
  enabled: boolean;
  token: string;
  placement: "positive" | "negative" | "both";
}

export type MediaModelAddonSelection =
  | MediaLoraSelection
  | MediaTextualInversionSelection;

export interface ImageRecipeSettings {
  prompt: string;
  providerPolicy: MediaProviderPolicy;
  modelPolicy: MediaModelPolicy;
  modelId: string | null;
  aspectRatio: "1:1" | "4:5" | "16:9" | "9:16";
  outputCount: number;
  outputFormat: "png" | "jpeg" | "webp" | "svg";
  transparentBackground: boolean;
  qualityGateEnabled: boolean;
  referenceImages: MediaImageReference[];
  svgMode?: "generate" | "vectorize";
  svgAutoCrop?: boolean;
  svgTargetSize?: number;
  svgStyle?: "illustration" | "icon" | "logo" | "diagram" | "technical";
  svgTextPolicy?: "avoid" | "editable" | "outlines";
  svgCandidateCount?: number;
  svgCriticEnabled?: boolean;
  modelAddons: MediaModelAddonSelection[];
}

export type MediaDiagnosticSeverity = "error" | "warning" | "info";

export type MediaErrorCode =
  | "INVALID_REQUEST"
  | "FLOW_REVISION_CONFLICT"
  | "RESOURCE_NOT_FOUND"
  | "STORAGE_UNAVAILABLE"
  | "DISK_FULL"
  | "PATH_NOT_ALLOWED"
  | "INTERNAL_ERROR"
  | "MODEL_NOT_INSTALLED"
  | "MODEL_LICENSE_REQUIRED"
  | "MODEL_ACCESS_DENIED"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_MODEL_DEPRECATED"
  | "PROVIDER_MODEL_REMOVED"
  | "PROVIDER_LIFECYCLE_UNKNOWN"
  | "PROVIDER_QUOTA_EXCEEDED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_REGION_UNSUPPORTED"
  | "PROVIDER_FEATURE_UI_ONLY"
  | "PROVIDER_REQUEST_FAILED"
  | "REMOTE_UPLOAD_NOT_ALLOWED"
  | "REMOTE_OUTPUT_EXPIRED"
  | "REMOTE_RETRY_COST_RISK"
  | "UNSUPPORTED_CAPABILITY"
  | "UNSUPPORTED_HARDWARE"
  | "UNSUPPORTED_RUNTIME_VARIANT"
  | "UNSUPPORTED_DIMENSIONS"
  | "UNSUPPORTED_FORMAT"
  | "UNSUPPORTED_ADAPTER"
  | "ADAPTER_BASE_MODEL_MISMATCH"
  | "UNSUPPORTED_OPTIMIZATION"
  | "OPTIMIZATION_QUALITY_DRIFT"
  | "TRAINING_DATASET_INVALID"
  | "TRAINING_INTERRUPTED"
  | "INVALID_MASK_ALIGNMENT"
  | "INVALID_FRAME_RANGE"
  | "INVALID_KEYFRAME_SET"
  | "INVALID_CONDITION_SET"
  | "INVALID_EDIT_INTENT"
  | "CONTINUITY_CONSTRAINT_FAILED"
  | "OOM"
  | "DRIVER_RUNTIME_MISMATCH"
  | "OPTIMIZED_ENGINE_INVALID"
  | "WORKER_CRASHED"
  | "WORKER_TIMEOUT"
  | "SAFETY_REJECTED_INPUT"
  | "SAFETY_REJECTED_OUTPUT"
  | "PROVENANCE_ATTACH_FAILED"
  | "PROVENANCE_VERIFY_FAILED"
  | "WATERMARK_DETECTION_FAILED"
  | "OUTPUT_VALIDATION_FAILED"
  | "EXPORT_FAILED"
  | "CANCELLED_BY_USER";

export type MediaErrorCategory =
  | "validation"
  | "configuration"
  | "capability"
  | "resource"
  | "provider"
  | "safety"
  | "integrity"
  | "storage"
  | "lifecycle"
  | "cancellation"
  | "internal";

export type MediaErrorRetryability =
  | "never"
  | "retry-safe"
  | "after-user-action"
  | "reconcile-first"
  | "user-approval-required";

export interface MediaErrorContext {
  nodeId: string | null;
  providerId: string | null;
  modelId: string | null;
  runtimeId: string | null;
  runId: string | null;
  assetId: string | null;
  operation: string | null;
}

export interface MediaErrorAction {
  id:
    | "refresh"
    | "retry"
    | "review-input"
    | "open-models"
    | "open-provider-settings"
    | "review-run"
    | "free-space"
    | "choose-location";
  label: string;
  description: string;
}

export interface MediaErrorDetail {
  schemaVersion: 1;
  code: MediaErrorCode;
  category: MediaErrorCategory;
  message: string;
  technicalDiagnostic: string;
  context: MediaErrorContext;
  retryability: MediaErrorRetryability;
  partialOutputsExist: boolean;
  suggestedActions: MediaErrorAction[];
}

export interface MediaCompilerDiagnostic {
  code:
    | "PROMPT_REQUIRED"
    | "SOURCE_ASSET_REQUIRED"
    | "NODE_SCHEMA_INVALID"
    | "OUTPUT_COUNT_INVALID"
    | "MODEL_NOT_FOUND"
    | "MODEL_NOT_READY"
    | "MODEL_REMOVED"
    | "MODEL_CAPABILITY_UNSUPPORTED"
    | "MODEL_LIFECYCLE_REVIEW_REQUIRED"
     | "MODEL_LIFECYCLE_STALE"
    | "ADDON_NOT_FOUND"
    | "ADDON_KIND_MISMATCH"
    | "ADDON_PROVIDER_UNSUPPORTED"
    | "ADDON_ARCHITECTURE_MISMATCH"
    | "ADDON_LIMIT_EXCEEDED"
    | "ADDON_CONFIG_INVALID"
    | "ADDON_BASE_MODEL_UNVERIFIED"
    | "PROVIDER_POLICY_UNSATISFIED"
    | "VARIABLE_SCHEMA_INVALID"
    | "VARIABLE_REQUIRED"
    | "VARIABLE_REFERENCE_UNKNOWN"
    | "VARIABLE_VALUE_INVALID"
    | "TRANSPARENCY_REQUIRES_POSTPROCESS"
    | "HUMAN_REVIEW_REQUIRED"
    | "REMOTE_EXECUTION_SELECTED"
    | "REMOTE_ASSET_UPLOAD_SELECTED"
    | "SVG_CRITIC_UNAVAILABLE"
    | "SUBJECT_CUTOUT_FALLBACK_SELECTED"
    | "LOCAL_MODEL_DOWNLOAD_REQUIRED";
  severity: MediaDiagnosticSeverity;
  message: string;
  nodeId?: string;
  action?: string;
}

export interface MediaExecutionStep {
  id: string;
  sourceNodeId: string;
  kind:
    | "normalize-prompt"
    | "resolve-asset"
     | "resolve-model"
    | "resolve-model-addons"
    | "generate-image"
    | "generate-svg"
    | "vectorize-svg"
    | "validate-svg"
    | "render-svg"
    | "score-svg"
    | "repair-svg"
    | "edit-image"
    | "crop-image"
    | "resize-image"
    | "convert-image"
    | "strip-metadata"
    | "auto-tag"
    | "create-contact-sheet"
    | "cutout-subject"
    | "extract-alpha-matte"
    | "composite-image"
    | "analyze-quality"
    | "evaluate-gate"
    | "wait-for-review"
    | "ingest-asset";
  label: string;
  target: "orchestrator" | MediaExecutionTarget;
  cacheable: boolean;
  sideEffect?: "paid-request" | "model-download" | "asset-write";
  review?: MediaHumanReviewContract;
}

export interface MediaHumanReviewContract {
  instructions: string;
  maxSelections: number;
  requireComment: boolean;
}

export interface MediaPreflightSummary {
  target: MediaExecutionTarget | null;
  modelId: string | null;
  modelLabel: string;
  requiresRemoteRequest: boolean;
  requiresModelDownload: boolean;
  requiresHumanReview: boolean;
  remoteUploadAssetIds: string[];
  generatedCandidates: number;
  estimatedOutputs: number;
  estimatedVramGb: number | null;
  estimatedDownloadGb: number | null;
  costHint: string;
  privacySummary: string;
}

export interface MediaCompiledPlan {
  schemaVersion: 1;
  id: string;
  flowId: string;
  flowFingerprint: string;
  status: "ready" | "blocked";
  compiledAt: string;
  model: MediaModelDescriptor | null;
  addons: MediaResolvedModelAddon[];
  steps: MediaExecutionStep[];
  diagnostics: MediaCompilerDiagnostic[];
  preflight: MediaPreflightSummary;
}

export interface MediaResolvedModelAddon {
  descriptor: MediaModelAddonDescriptor;
  selection: MediaModelAddonSelection;
  compatibility: "compatible" | "unverified";
}

export interface MediaRunPlanNodeSnapshot {
  id: string;
  type: MediaNodeType;
  label: string;
  layer: MediaNodeLayer;
}

export interface MediaRunPlanSnapshot {
  schemaVersion: 1;
  planId: string;
  flowId: string;
  flowFingerprint: string;
  compiledAt: string;
  nodes: MediaRunPlanNodeSnapshot[];
  steps: MediaExecutionStep[];
}

export type MediaStudioSection =
  | "generate"
  | "flow"
  | "library"
  | "runs"
  | "models";

export type MediaRunStatus =
  | "draft"
  | "blocked"
  | "ready"
  | "queued"
  | "running"
  | "needs-review"
  | "waiting-for-review"
  | "canceling"
  | "completed"
  | "failed"
  | "canceled";

export interface MediaRunRecord {
  id: string;
  flowId: string;
  flowRevisionId: string | null;
  flowName: string;
  planId: string;
  status: MediaRunStatus;
  createdAt: string;
  prompt: string;
  modelLabel: string;
  target: MediaExecutionTarget | null;
  outputCount: number;
  diagnosticCount: number;
}

export type MediaRuntimeRunStatus = Extract<
  MediaRunStatus,
  | "queued"
  | "running"
  | "needs-review"
  | "waiting-for-review"
  | "canceling"
  | "completed"
  | "failed"
  | "canceled"
>;

export interface MediaRuntimeRunRecord extends MediaRunRecord {
  status: MediaRuntimeRunStatus;
  updatedAt: string;
  progress: number;
  currentStep: string;
  executor:
    | "deterministic-fixture"
    | "openai-image-api"
    | "local-import"
    | "local-transform"
    | "local-image-flow"
    | "local-analysis"
    | "mock-remote-provider"
    | "svg-ai-pipeline";
  error: string | null;
  failure: MediaErrorDetail | null;
}

export interface MediaRunEvent {
  id: number;
  runId: string;
  sequence: number;
  kind:
    | "run_queued"
    | "run_started"
    | "asset_published"
    | "cancel_requested"
    | "run_canceled"
    | "run_completed"
    | "run_failed"
    | "run_recovered"
    | "retry_queued"
    | "asset_imported"
    | "asset_transformed"
    | "local_flow_executed"
    | "asset_exported"
    | "asset_analyzed"
    | "asset_tagged"
    | "asset_deleted"
    | "provider_prepared"
    | "provider_submission_started"
    | "provider_accepted"
    | "provider_acceptance_unknown"
    | "provider_reconciled"
    | "provider_output_pending"
    | "provider_download_started"
    | "provider_cancel_requested"
    | "provider_late_success"
    | "provider_review_required"
    | "provider_review_closed"
    | "provider_failed"
    | "node_state_changed"
    | "human_review_requested"
    | "human_review_approved"
    | "human_review_rejected";
  createdAt: string;
  message: string;
  progress: number | null;
  stepId: string | null;
  nodeId: string | null;
}

export type MediaNodeExecutionStatus =
  | "pending"
  | "queued"
  | "running"
  | "waiting-for-review"
  | "retrying"
  | "completed"
  | "cached"
  | "skipped"
  | "failed"
  | "canceled"
  | "blocked";

export interface MediaNodeExecutionRecord {
  runId: string;
  nodeId: string;
  nodeType: string;
  nodeLabel: string;
  ordinal: number;
  status: MediaNodeExecutionStatus;
  activeStepId: string | null;
  runtimePhase: string | null;
  attempt: number;
  progress: number | null;
  message: string | null;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  stateSequence: number;
}

export interface MediaAssetRecord {
  id: string;
  runId: string;
  digest: string;
  kind: "image" | "vector" | "report";
  mimeType:
    | "image/png"
    | "image/jpeg"
    | "image/webp"
    | "image/svg+xml"
    | "application/json";
  byteSize: number;
  width: number;
  height: number;
  createdAt: string;
  outputIndex: number;
  fixture: boolean;
  operation: MediaAssetOperation | null;
  sourceAssetIds: string[];
  tags: MediaAssetTag[];
}

export interface MediaAssetTag {
  value: string;
  label: string;
  source: "user" | "technical";
  confidence: number | null;
  createdAt: string;
}

export interface MediaAssetTagUpdate {
  assetId: string;
  tags: string[];
}

export type MediaAssetDeletionMode =
  | "metadata-only"
  | "metadata-and-unreferenced-bytes";

export interface MediaAssetDeletionImpact {
  assetId: string;
  digest: string;
  dependentAssetIds: string[];
  sharedBlobAssetIds: string[];
  exportCount: number;
  activeExportCount: number;
  renditionCount: number;
  originalByteSize: number;
  renditionByteSize: number;
  reclaimableByteSize: number;
  retainedSharedByteSize: number;
  warnings: string[];
  confirmationToken: string;
}

export interface MediaAssetDeletionRequest {
  assetId: string;
  mode: MediaAssetDeletionMode;
  confirmationToken: string;
  confirmDependencies: boolean;
}

export interface MediaAssetTombstone {
  assetId: string;
  digest: string;
  kind: MediaAssetRecord["kind"];
  mimeType: MediaAssetRecord["mimeType"];
  deletedAt: string;
  mode: MediaAssetDeletionMode;
  bytesStatus: "retained" | "deleted" | "partial" | "shared" | "failed";
}

export interface MediaAssetDeletionResult {
  tombstone: MediaAssetTombstone;
  reclaimedBytes: number;
  retainedBytes: number;
  failedBlobDigests: string[];
}

export type MediaImageOutputFormat = "png" | "jpeg" | "webp";
export type MediaImageResizeFit = "contain" | "cover" | "stretch";

export type MediaImageTransformOperation =
  | {
      kind: "crop";
      x: number;
      y: number;
      width: number;
      height: number;
    }
  | {
      kind: "resize";
      width: number;
      height: number;
      fit: MediaImageResizeFit;
    }
  | { kind: "convert" };

export type MediaQualityVerdict = "pass" | "warn" | "fail";

export interface MediaQualityAnalysisOperation {
  kind: "analyze-quality";
  profileId: string;
  verdict: MediaQualityVerdict;
}

export interface MediaSvgRasterizeOperation {
  kind: "rasterize-svg";
  sanitizerVersion: string;
  sourceDigest: string;
  sourceByteSize: number;
  xmlNodeCount: number;
  hadText: boolean;
  resourcePolicy: "no-external-or-embedded-images";
  fontPolicy: "system-font-snapshot";
  outputColorSpace: "srgb";
}

export interface MediaLocalImageFlowOperation {
  kind: "local-image-flow";
  flowRevisionId: string;
  metadataStripped: boolean;
  assetRole?: "primary" | "cutout" | "alpha-matte";
  subjectCutout?: {
    engine: "birefnet-matting-onnx-v1" | "border-matte-v1";
    modelId: "local:birefnet-matting" | "local:border-matte-v1";
    modelRevision: string;
    attemptedModelIds: string[];
    fallbackUsed: boolean;
    transparentPixels: number;
    softPixels: number;
    opaquePixels: number;
  } | null;
  alphaExtraction?: {
    engine: "alpha-channel-v1";
    inverted: boolean;
    transparentPixels: number;
    softPixels: number;
    opaquePixels: number;
  } | null;
  autoTagProfile?: "technical-metadata-v1" | null;
  composite?: {
    engine: "center-alpha-over-v1";
    fit: "contain" | "cover" | "stretch";
    opacityPercent: number;
    foregroundSourceAssetIds: string[];
    backgroundSourceAssetIds: string[];
  } | null;
  contactSheet?: {
    engine: "grid-contact-sheet-v1";
    columns: number;
    cellWidth: number;
    cellHeight: number;
    gap: number;
    background: string;
    labelMode: "index" | "none";
    sourceAssetIds: string[];
  } | null;
  nodeIds?: string[];
  nodes?: unknown[];
}

export interface MediaRemoteImageGenerationOperation {
  kind: "remote-image-generation";
  providerId: "openai";
  modelId: string;
  providerRequestId: string | null;
  flowRevisionId: string;
  subjectCutout?: MediaSubjectCutoutSummary | null;
}

export interface MediaLocalDiffusionGenerationOperation {
  kind: "local-diffusion-generation";
  providerId: "local-diffusers";
  modelId: string;
  flowRevisionId: string;
  modelRevision: string;
  modelDigest: string;
  workerVersion: string;
  packages: Record<string, string | null>;
  device: string;
  deviceLabel: string;
  deviceMemoryBytes: number | null;
  prompt: string;
  negativePrompt: string;
  addons: unknown[];
  output: { index: number; seed: number } | null;
  subjectCutout?: MediaSubjectCutoutSummary | null;
}

export interface MediaSubjectCutoutSummary {
  engine: "birefnet-matting-onnx-v1" | "border-matte-v1";
  modelId: "local:birefnet-matting" | "local:border-matte-v1";
  modelRevision: string;
  attemptedModelIds: string[];
  fallbackUsed: boolean;
  transparentPixels: number;
  softPixels: number;
  opaquePixels: number;
}

export interface MediaRemoteImageEditSourceOperation {
  order: number;
  nodeId: string;
  assetId: string;
  role: string;
  influence: number;
  sourceDigest: string;
  uploadDigest: string;
  uploadBytes: number;
  width: number;
  height: number;
}

export interface MediaRemoteImageEditOperation {
  kind: "remote-image-edit";
  providerId: "openai";
  modelId: string;
  modelSnapshot: string;
  providerRequestId: string | null;
  flowRevisionId: string;
  taskNodeId: string;
  editStrength: number;
  metadataStrippedBeforeUpload: boolean;
  orientationAppliedBeforeUpload: boolean;
  colorProfilePreservedBeforeUpload: boolean;
  sources: MediaRemoteImageEditSourceOperation[];
  subjectCutout?: MediaSubjectCutoutSummary | null;
}

export interface MediaRemoteSvgGenerationOperation {
  kind: "remote-svg-generation";
  providerId: string;
  modelId: string;
  providerRequestId: string | null;
  flowRevisionId: string;
  mode: NonNullable<ImageRecipeSettings["svgMode"]>;
  autoCrop: boolean;
  targetSize: number;
  style: NonNullable<ImageRecipeSettings["svgStyle"]>;
  textPolicy: NonNullable<ImageRecipeSettings["svgTextPolicy"]>;
  candidateCount: number;
  providerCredits: number | null;
  rank: number;
  score: {
    score: number;
    structuralQualityScore?: number;
    sourceFidelityScore?: number | null;
    multiScaleConsistencyScore?: number;
    paintedPixelRatio: number;
    canvasFillRatio: number;
    edgeContactCount: number;
    complexityPenalty: number;
    redundancyPenalty: number;
    geometryEfficiencyScore: number;
    editabilityScore: number;
    issues: string[];
  };
  structure: {
    xmlNodeCount: number;
    elementCount: number;
    pathCount: number;
    pathCommandCount: number;
    textCount: number;
    definitionCount: number;
    useCount: number;
    idCount: number;
    drawableElementCount: number;
    groupCount: number;
    duplicateElementCount: number;
    unusedDefinitionCount: number;
    emptyGroupCount: number;
  };
  repairRounds: number;
  criticAttempted?: boolean;
  criticProviderId?: "openai" | null;
  criticModel?: string | null;
  criticRequestId?: string | null;
  criticRequestIds?: string[];
  criticVerdict?: {
    semanticFidelityBefore: number;
    semanticFidelityAfter: number;
    visualQualityBefore: number;
    visualQualityAfter: number;
    regressionDetected: boolean;
    rationale: string;
  } | null;
  criticAttemptCount?: number;
  metadataStrippedBeforeUpload: boolean;
  colorProfilePreservedBeforeUpload: boolean;
  sources: Array<{
    assetId: string;
    role: MediaImageReferenceRole;
    influence: number;
    sourceDigest: string;
    uploadDigest: string;
    uploadBytes: number;
    width: number;
    height: number;
  }>;
  sanitizerVersion: string;
  rendererVersion: string;
  scorerVersion: string;
  fontPolicy: "no-host-font-access";
}

export type MediaAssetOperation =
  | MediaImageTransformOperation
  | MediaQualityAnalysisOperation
  | MediaSvgRasterizeOperation
  | MediaLocalImageFlowOperation
  | MediaRemoteImageGenerationOperation
  | MediaLocalDiffusionGenerationOperation
  | MediaRemoteImageEditOperation
  | MediaRemoteSvgGenerationOperation;

export interface MediaQualityObservation {
  metricId: string;
  metricVersion: string;
  family: "technical" | "reference" | "learned" | "policy" | "human";
  scope:
    | "asset"
    | "frame"
    | "frame-range"
    | "region"
    | "audio"
    | "pair"
    | "collection";
  status: "observed" | "unknown" | "error";
  value?: number | boolean | string | Record<string, number>;
  unit?: string;
  direction?:
    | "higher-is-better"
    | "lower-is-better"
    | "target-range"
    | "categorical";
  inputAssetIds: string[];
  referenceAssetIds: string[];
  evaluator?: {
    id: string;
    version: string;
    digest?: string;
    license?: string;
  };
  preprocessingProfileId: string;
  samplingProfileId?: string;
  calibrationProfileId?: string;
  confidence?: number;
  limitations: string[];
}

export interface MediaQualityReport {
  schemaVersion: 1;
  sourceAssetId: string;
  analyzedAt: string;
  profile: {
    id: string;
    version: string;
    description: string;
  };
  verdict: MediaQualityVerdict;
  gateReasons: string[];
  observations: MediaQualityObservation[];
}

export interface MediaQualityAnalysisResult {
  detail: MediaRunDetail;
  report: MediaQualityReport;
}

export interface MediaImageTransformRequest {
  sourceAssetId: string;
  operation: MediaImageTransformOperation;
  outputFormat: MediaImageOutputFormat;
  quality?: number;
  jpegBackground?: string;
}

export interface ExecuteLocalImageFlowRequest {
  schemaVersion: 1;
  runId: string;
  flowId: string;
  flowRevisionId: string;
  planId: string;
  planSnapshot: MediaRunPlanSnapshot;
}

export interface ExecuteRemoteImageEditFlowRequest {
  schemaVersion: 1;
  runId: string;
  flowId: string;
  flowRevisionId: string;
  planId: string;
  planSnapshot: MediaRunPlanSnapshot;
  allowRemoteUpload: true;
}

export type MediaAssetExportMode =
  | "verified-original"
  | "metadata-stripped";

export interface MediaAssetExportRequest {
  assetId: string;
  destinationPath: string;
  mode: MediaAssetExportMode;
}

export interface MediaAssetExportRecord {
  id: string;
  assetId: string;
  destinationPath: string;
  mode: MediaAssetExportMode;
  sourceDigest: string;
  digest: string;
  byteSize: number;
  metadataStripped: boolean;
  createdAt: string;
}

export interface MediaRunDetail extends MediaRuntimeRunRecord {
  events: MediaRunEvent[];
  assets: MediaAssetRecord[];
  providerJobs: MediaProviderJobRecord[];
  humanReviews: MediaHumanReviewRecord[];
  nodeExecutions: MediaNodeExecutionRecord[];
  planSnapshot: MediaRunPlanSnapshot | null;
}

export type MediaHumanReviewStatus =
  | "queued"
  | "pending"
  | "approved"
  | "rejected";

export interface MediaHumanReviewRecord extends MediaHumanReviewContract {
  id: string;
  runId: string;
  nodeId: string;
  sequence: number;
  status: MediaHumanReviewStatus;
  candidateAssetIds: string[];
  selectedAssetIds: string[];
  decisionId: string | null;
  decisionAction: "approve" | "reject" | null;
  comment: string | null;
  actor: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
}

export interface MediaHumanReviewDecisionRequest {
  reviewId: string;
  decisionId: string;
  action: "approve" | "reject";
  selectedAssetIds: string[];
  comment: string;
}

export type MediaProviderJobStatus =
  | "prepared"
  | "submitting"
  | "acceptance-unknown"
  | "accepted"
  | "queued"
  | "running"
  | "succeeded-download-pending"
  | "downloading"
  | "cancel-requested"
  | "cancelled"
  | "failed"
  | "expired"
  | "completed";

export type MediaProviderIdempotencyMode =
  | "provider-key"
  | "lookup-only"
  | "none";

export type MediaMockProviderScenario =
  | "success"
  | "acceptance-unknown"
  | "crash-before-submit"
  | "crash-during-submit"
  | "crash-after-acceptance"
  | "crash-during-poll"
  | "crash-after-success"
  | "crash-during-download"
  | "cancel-race-success"
  | "provider-failure"
  | "result-expired";

export type MediaProviderScenario =
  | MediaMockProviderScenario
  | "openai:gpt-image-2";

export interface MediaProviderPolicySnapshot {
  adapterId: string;
  adapterVersion: string;
  endpointVersion: string;
  region: string;
  idempotencyMode: MediaProviderIdempotencyMode;
  retryPolicy: string;
  cancellationSemantics: string;
  inputRetentionSeconds: number | null;
  outputRetentionSeconds: number | null;
  outputVisibility:
    | "private-signed-url"
    | "public-link"
    | "inline-base64-response";
  publicLinks: boolean;
  noStoreRequested: boolean;
  uploadAssetCount: number;
  uploadBytes: number;
  containsPersonalData: boolean;
  remoteUploadAllowed: boolean;
}

export interface MediaProviderJobRecord {
  id: string;
  runId: string;
  attempt: number;
  status: MediaProviderJobStatus;
  rawState: string | null;
  scenario: MediaProviderScenario;
  requestDigest: string;
  idempotencyKey: string | null;
  providerJobId: string | null;
  providerRequestId: string | null;
  estimatedCostMin: number;
  estimatedCostMax: number;
  currency: "USD";
  pollAttempts: number;
  nextPollAt: string | null;
  reconciliationDeadline: string;
  acceptedAt: string | null;
  retentionExpiresAt: string | null;
  lateSuccess: boolean;
  reviewRequired: boolean;
  reviewReason: string | null;
  error: string | null;
  failure: MediaErrorDetail | null;
  policy: MediaProviderPolicySnapshot;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface MediaRuntimeStatus {
  schemaVersion: number;
  recoveredRuns: number;
  queuedRuns: number;
  activeRuns: number;
  storageReady: boolean;
  mode: "native" | "browser-preview";
  directGenerationModelIds: string[];
  directReferenceImageModelIds: string[];
  localDiffusers: MediaLocalDiffusersRuntimeStatus;
}

export interface MediaLocalDiffusersRuntimeStatus {
  status: "ready" | "unavailable";
  ready: boolean;
  workerVersion: string | null;
  pythonVersion: string | null;
  packages: Record<string, string | null>;
  device: string | null;
  deviceLabel: string | null;
  deviceMemoryBytes: number | null;
  architectures: string[];
  capabilities: string[];
  diagnostic: string;
}

export interface MediaToolProbe {
  status: "available" | "unavailable" | "timed-out";
  version: string | null;
  diagnostic: string;
}

export interface MediaNvidiaGpu {
  name: string;
  memoryTotalMb: number | null;
  driverVersion: string;
}

export interface MediaLocalRuntimeSupport {
  cpuUtilities: "available" | "preview-only";
  cuda: "driver-probe-only" | "not-validated";
  amd: "not-validated";
  appleSilicon: "hardware-visible-runtime-unvalidated" | "not-applicable";
  directMl: "not-validated" | "not-applicable";
}

export interface MediaHardwareInspection {
  inspectedAt: string;
  operatingSystem: string;
  architecture: string;
  cpuLabel: string;
  logicalCpuCount: number;
  totalMemoryBytes: number | null;
  availableMemoryBytes: number | null;
  storageFreeBytes: number | null;
  ffmpeg: MediaToolProbe;
  ffprobe: MediaToolProbe;
  nvidiaSmi: MediaToolProbe;
  nvidiaGpus: MediaNvidiaGpu[];
  runtimeSupport: MediaLocalRuntimeSupport;
  warnings: string[];
}

export interface EnqueueFixtureRunRequest {
  runId: string;
  flowId: string;
  flowRevisionId: string | null;
  flowName: string;
  planId: string;
  prompt: string;
  modelLabel: string;
  target: MediaExecutionTarget | null;
  outputCount: number;
  diagnosticCount: number;
  aspectRatio: ImageRecipeSettings["aspectRatio"];
  planSnapshot?: MediaRunPlanSnapshot;
}

export interface GenerateMediaImagesRequest {
  schemaVersion: 1;
  runId: string;
  flowId: string;
  flowRevisionId: string;
  flowName: string;
  planId: string;
  prompt: string;
  modelId: string;
  modelLabel: string;
  outputCount: number;
  diagnosticCount: number;
  aspectRatio: ImageRecipeSettings["aspectRatio"];
  outputFormat: MediaImageOutputFormat;
  modelPolicy: MediaModelPolicy;
  modelAddons: MediaModelAddonSelection[];
  transparentBackground: boolean;
  subjectCutoutModelPriority: string[];
  planSnapshot: MediaRunPlanSnapshot;
}

export interface GenerateMediaSvgRequest {
  schemaVersion: 1;
  runId: string;
  flowId: string;
  flowRevisionId: string;
  flowName: string;
  planId: string;
  prompt: string;
  modelId: string;
  modelLabel: string;
  outputCount: number;
  candidateCount: number;
  diagnosticCount: number;
  aspectRatio: ImageRecipeSettings["aspectRatio"];
  modelPolicy: MediaModelPolicy;
  transparentBackground: boolean;
  mode: NonNullable<ImageRecipeSettings["svgMode"]>;
  autoCrop: boolean;
  targetSize: number;
  style: NonNullable<ImageRecipeSettings["svgStyle"]>;
  textPolicy: NonNullable<ImageRecipeSettings["svgTextPolicy"]>;
  criticEnabled: boolean;
  referenceImages: MediaImageReference[];
  allowRemoteUpload: boolean;
  planSnapshot: MediaRunPlanSnapshot;
}

export interface MediaImageImportResult {
  detail: MediaRunDetail;
  asset: MediaAssetRecord;
  deduplicated: boolean;
}

export interface EnqueueMockRemoteRunRequest
  extends EnqueueFixtureRunRequest {
  scenario: MediaMockProviderScenario;
  allowRemoteUpload: boolean;
}

export type MediaProviderReviewAction =
  | "reconcile-only"
  | "confirm-not-accepted-and-retry"
  | "accept-duplicate-charge-risk-and-retry";

export interface MediaStudioState {
  version: 3;
  activeSection: MediaStudioSection;
  recipe: ImageRecipeSettings;
  flow: MediaFlow | null;
  flowLayout: MediaFlowLayout | null;
  runs: MediaRunRecord[];
}
