import type { ConfiguredModelProvider } from "../runtime-contract.generated.js";
import type { McpInitializationInstructionSnapshot } from "../mcp/initialization-instructions.js";

export const INSTRUCTION_LIBRARY_SCHEMA_VERSION = 1 as const;
export const INSTRUCTION_RESOLUTION_SCHEMA_VERSION = 1 as const;
export const INSTRUCTION_DELIVERY_SCHEMA_VERSION = 1 as const;

export type ProfileId = string;
export type WorkspaceId = string;

export type InstructionTagRule =
  | {
      op: "tag";
      tag: string;
    }
  | {
      op: "and" | "or";
      rules: InstructionTagRule[];
    };

export interface InstructionProfile {
  id: ProfileId;
  name: string;
  description?: string;
  body: string;
  /** Defaults to true when loading libraries written before this field existed. */
  enabled?: boolean;
  /** Mirrors membership in defaults.profiles and is persisted for portable metadata. */
  global?: boolean;
  tags?: string[];
  match?: InstructionTagRule;
  createdAt: string;
  updatedAt: string;
}

export interface InstructionScopeAssignment {
  path: string;
  profiles: ProfileId[];
}

export interface InstructionWorkspaceBinding {
  id: WorkspaceId;
  root: string;
  displayName?: string;
  identityHints?: {
    gitRemote?: string;
    repositoryId?: string;
  };
  tags?: string[];
  scopes: InstructionScopeAssignment[];
}

export interface InstructionLibrary {
  schemaVersion: typeof INSTRUCTION_LIBRARY_SCHEMA_VERSION;
  revision: number;
  profiles: InstructionProfile[];
  defaults: {
    profiles: ProfileId[];
  };
  workspaces: InstructionWorkspaceBinding[];
}

export type InstructionDiagnosticSeverity =
  | "info"
  | "advisory"
  | "warning"
  | "error";

export interface InstructionDiagnostic {
  code: string;
  severity: InstructionDiagnosticSeverity;
  message: string;
  sourceId?: string;
  relativePath?: string;
  details?: Record<string, unknown>;
}

export type InstructionSourceKind =
  | "profile-default"
  | "profile-auto"
  | "profile-workspace"
  | "project-local"
  | "flow-guidance";

export interface ResolvedInstructionSource {
  id: string;
  kind: InstructionSourceKind;
  name: string;
  body: string;
  digest: string;
  byteLength: number;
  lineCount: number;
  scopePath: string;
  precedence: number;
  trusted: boolean;
  profileId?: ProfileId;
  workspaceId?: WorkspaceId;
  relativePath?: string;
  assignmentPath?: string;
  inheritedFrom?: string;
  status: "selected" | "skipped";
  reason?:
    | "NO_APPLICABLE_ASSIGNMENT"
    | "DUPLICATE_INHERITED_ASSIGNMENT"
    | "PROFILE_DISABLED"
    | "TAG_RULE_NOT_MATCHED";
  otherAssignments?: Array<{
    workspaceId: WorkspaceId;
    scopePath: string;
  }>;
}

export interface InstructionBodyAttribution {
  sourceId: string;
  scopePath: string;
  precedence: number;
}

export interface InstructionBodyGroup {
  digest: string;
  body: string;
  byteLength: number;
  lineCount: number;
  attributions: InstructionBodyAttribution[];
  renderedAtPrecedence: number;
}

export interface LocalInstructionRecord {
  id: string;
  relativePath: string;
  scopePath: string;
  body: string;
  digest: string;
  byteLength: number;
  lineCount: number;
  identity: string;
}

export type NativeInstructionStatus =
  | "canonical"
  | "native-extra"
  | "suppressed"
  | "inactive"
  | "unknown"
  | "unreadable";

export interface NativeInstructionRecord {
  path: string;
  location: "workspace" | "user";
  convention: string;
  recognizingConventions?: string[];
  status: NativeInstructionStatus;
  digest?: string;
  byteLength?: number;
  note?: string;
}

export interface InstructionBudgetReport {
  bodyBytes: number;
  envelopeBytes: number;
  runtimeSupplementBytes?: number;
  lineCount: number;
  estimatedTokens?: number;
  estimatedRuntimeSupplementTokens?: number;
  estimatedTotalInstructionTokens?: number;
  providerLimitTokens?: number;
  providerReserveTokens?: number;
  availableInstructionTokens?: number;
  advisories: string[];
  blockingErrors: string[];
}

export interface InstructionInvocationBudgetReport {
  phase: InstructionDeliveryReceipt["phase"];
  assembledRequestBytes: number;
  estimatedEnvelopeTokens: number;
  estimatedRuntimeSupplementTokens: number;
  estimatedNonInstructionTokens: number;
  minimumReservedNonInstructionTokens: number;
  estimatedRequiredInputTokens: number;
  providerLimitTokens?: number;
}

export interface InstructionFlowInput {
  id: string;
  guidance?: string;
}

export interface InstructionResolutionInput {
  workspaceRoot: string;
  providerId: ConfiguredModelProvider;
  surface: "api" | "cli";
  model?: string;
  flow?: InstructionFlowInput;
}

export interface FrozenInstructionSet {
  schemaVersion: typeof INSTRUCTION_RESOLUTION_SCHEMA_VERSION;
  resolutionId: string;
  resolvedAt: string;
  providerId: ConfiguredModelProvider;
  surface: "api" | "cli";
  model?: string;
  workspaceRegistered: boolean;
  workspaceId?: WorkspaceId;
  libraryRevision: number;
  selectedSources: readonly ResolvedInstructionSource[];
  allProfiles: readonly ResolvedInstructionSource[];
  bodyGroups: readonly InstructionBodyGroup[];
  nativeInventory: readonly NativeInstructionRecord[];
  mcpInitializationInstructions: readonly McpInitializationInstructionSnapshot[];
  diagnostics: readonly InstructionDiagnostic[];
  budget: Readonly<InstructionBudgetReport>;
  canonicalDigest: string;
  environmentDigest: string;
  envelopeBoundary: string;
  renderedEnvelope: string;
}

export interface InstructionExplanationSource {
  id: string;
  name: string;
  kind: InstructionSourceKind;
  status: ResolvedInstructionSource["status"];
  reason?: ResolvedInstructionSource["reason"];
  scopePath: string;
  precedence: number;
  digest: string;
  byteLength: number;
  lineCount: number;
  trusted: boolean;
  profileId?: string;
  workspaceId?: string;
  relativePath?: string;
  assignmentPath?: string;
  inheritedFrom?: string;
  otherAssignments?: Array<{
    workspaceId: string;
    scopePath: string;
  }>;
  body?: string;
}

export interface InstructionResolutionExplanation {
  schemaVersion: typeof INSTRUCTION_RESOLUTION_SCHEMA_VERSION;
  resolutionId: string;
  canonicalDigest: string;
  environmentDigest: string;
  providerId: ConfiguredModelProvider;
  surface: "api" | "cli";
  model?: string;
  libraryRevision: number;
  workspaceRegistered: boolean;
  workspaceId?: string;
  sources: InstructionExplanationSource[];
  bodyGroups: Array<Omit<InstructionBodyGroup, "body"> & { body?: string }>;
  nativeInventory: NativeInstructionRecord[];
  mcpInitializationInstructions: Array<
    Omit<McpInitializationInstructionSnapshot, "body">
  >;
  diagnostics: InstructionDiagnostic[];
  budget: InstructionBudgetReport;
  pathPreview?: {
    path: string;
    applicableSourceIds: string[];
    effectiveOrder: string[];
  };
}

export type InstructionAuthority =
  | "system"
  | "developer"
  | "native"
  | "user"
  | "none";
export type InstructionScopeFidelity =
  | "native-structural"
  | "declarative-envelope"
  | "none";
export type InstructionContentFidelity =
  | "exact"
  | "rewritten"
  | "partial"
  | "none";
export type InstructionNativeDiscovery =
  | "isolated"
  | "suppressed"
  | "accounted-extra"
  | "uncontrolled"
  | "unknown";
export type InstructionConformanceStatus =
  | "protocol-tested"
  | "provisional"
  | "unknown";
export type InstructionLifecycleSupport =
  | "reattached"
  | "session"
  | "unknown"
  | "unsupported";
export type InstructionDeliveryGrade = "full" | "compatible" | "unsupported";

export interface InstructionCapabilityDescriptor {
  adapterVersion: string;
  providerId: ConfiguredModelProvider;
  surface: "api" | "cli";
  authority: InstructionAuthority;
  contentFidelity: InstructionContentFidelity;
  scopeFidelity: InstructionScopeFidelity;
  acceptsArbitraryContent: boolean;
  nativeDiscovery: InstructionNativeDiscovery;
  acceptsTemporaryInstructionFile: boolean;
  conformance: InstructionConformanceStatus;
  receiptDigestVerification: boolean;
  lifecycle: {
    initial: InstructionLifecycleSupport;
    continuation: InstructionLifecycleSupport;
    retry: InstructionLifecycleSupport;
    roles: InstructionLifecycleSupport;
    subagents: InstructionLifecycleSupport;
  };
  mechanism: string;
  evidence: string[];
  version?: string;
  versionEvidence?: string;
  maxInstructionBytes?: number;
  maxInputTokens?: number;
}

export interface InstructionDeliveryDimension {
  name:
    | "content"
    | "scope"
    | "authority"
    | "native-isolation"
    | "initial"
    | "continuation"
    | "retry"
    | "roles"
    | "subagents"
    | "budget"
    | "conformance"
    | "receipt";
  status: "satisfied" | "compatible" | "unsupported";
  detail: string;
}

export interface InstructionDeliveryPlan {
  schemaVersion: typeof INSTRUCTION_DELIVERY_SCHEMA_VERSION;
  planId: string;
  resolutionId: string;
  canonicalDigest: string;
  environmentDigest: string;
  providerId: ConfiguredModelProvider;
  surface: "api" | "cli";
  grade: InstructionDeliveryGrade;
  route: string;
  blockingReasons: string[];
  dimensions: InstructionDeliveryDimension[];
  capability: InstructionCapabilityDescriptor;
  createdAt: string;
}

export interface InstructionDeliveryReceipt {
  schemaVersion: typeof INSTRUCTION_DELIVERY_SCHEMA_VERSION;
  receiptId: string;
  planId: string;
  resolutionId: string;
  canonicalDigest: string;
  providerId: ConfiguredModelProvider;
  surface: "api" | "cli";
  phase: "initial" | "continuation" | "retry" | "validator" | "generator";
  route: string;
  deliveredAt: string;
  status: "delivered" | "indeterminate";
  observedCanonicalDigest: string;
  assembledRequestDigest: string;
  deliveredBytes: number;
  estimatedTokens?: number;
  truncation: "none";
  requestId?: string;
  error?: string;
  evidence: Array<{
    kind: "request-field" | "argument" | "environment" | "temporary-file";
    detail: string;
    digest?: string;
  }>;
  bodyStored: false;
}

export interface InstructionResolveOptions {
  libraryPath?: string;
  now?: Date;
}

export interface InstructionStoreMutationResult {
  library: InstructionLibrary;
  previousRevision: number;
}

export interface InstructionLibraryExport {
  schemaVersion: typeof INSTRUCTION_LIBRARY_SCHEMA_VERSION;
  exportedAt: string;
  profiles: InstructionProfile[];
  defaults: { profiles: ProfileId[] };
  workspaces?: Array<
    Omit<InstructionWorkspaceBinding, "root"> & {
      root?: never;
    }
  >;
}

export type InstructionImportConflictChoice =
  | "keep-existing"
  | "replace-existing"
  | "duplicate-imported";

export interface InstructionLibraryImportChoices {
  conflicts?: Record<ProfileId, InstructionImportConflictChoice>;
  renamedProfiles?: Record<ProfileId, string>;
  defaults?: "merge" | "replace" | "keep-existing";
}

export interface InstructionLibraryRecoveryStatus {
  libraryPath: string;
  backupPath: string;
  primaryValid: boolean;
  primaryDigest?: string;
  backupValid: boolean;
  backupDigest?: string;
  backupRevision?: number;
  errorCode?: string;
  errorMessage?: string;
}

export class InstructionSystemError extends Error {
  readonly code: string;
  readonly diagnostics: readonly InstructionDiagnostic[];

  constructor(
    code: string,
    message: string,
    diagnostics: readonly InstructionDiagnostic[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InstructionSystemError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}
