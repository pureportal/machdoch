import { createHash } from "node:crypto";

export interface RalphRepositoryWorkYieldTransform {
  type: "repository-work-yield";
  baselineBlockId: string;
  currentBlockId: string;
  scopeGuardBlockId?: string;
  workItemBlockId?: string;
  excludedPaths?: string[];
  trackPrevious?: boolean;
  verifyOnObservationError?: boolean;
}

export interface RalphVerificationCommandTransform {
  type: "verification-command";
  selectionBlockId: string;
  selectionPath: string;
  commandsBlockId: string;
  configuredCommandVariable: string;
}

export interface RalphCodeImprovementPlanTransform {
  type: "code-improvement-plan";
  draftBlockId: string;
  selectionBlockId: string;
  constitutionBlockId: string;
  researchBlockId: string;
}

export interface RalphVisualRuntimeTransform {
  type: "visual-runtime";
  commandsBlockId: string;
  targetUrlVariable: string;
  healthUrlVariable: string;
  serverCommandVariable: string;
  serverCwdVariable: string;
  screenshotPathVariable: string;
}

export type RalphVerificationTier = "focused" | "standard" | "broad";
export type RalphReviewTier = "validator-only" | "strict";

export interface RalphVerificationCommandSelection {
  tier: RalphVerificationTier;
  reviewTier: RalphReviewTier;
  protocolValid: boolean;
  command: string;
  source: "variable" | "detected";
  focusedCommand: string;
  standardCommand: string;
  broadCommand: string;
}

export type RalphImprovementPlanDecision = "IMPLEMENT" | "STOP" | "DEFER";

export interface RalphCodeImprovementPlan {
  planId: string;
  decision: RalphImprovementPlanDecision;
  rationale: unknown;
  stopReason: unknown;
  scope: Record<string, unknown>;
  scopeCluster: unknown;
  constitution: unknown;
  research: string;
  tasks: unknown[];
}

export type RalphVisualRuntimeStatus =
  | "managed-or-reused"
  | "existing-only"
  | "screenshot-only"
  | "degraded-unavailable";

export interface RalphVisualRuntimeSelection {
  targetUrl: string;
  healthUrl: string;
  serverCommand: string;
  serverCwd: string;
  visualStatus: RalphVisualRuntimeStatus;
  degradedReason: string;
  targetSource: "variable" | "detected" | "";
  healthSource: "variable" | "target" | "";
  commandSource: string;
}

export type RalphDeterministicJsonTransform =
  | RalphRepositoryWorkYieldTransform
  | RalphVerificationCommandTransform
  | RalphCodeImprovementPlanTransform
  | RalphVisualRuntimeTransform;

export interface RalphRepositoryObservationFile {
  path: string;
  signature: string;
}

export interface RalphRepositoryObservation {
  head: string;
  files: readonly RalphRepositoryObservationFile[];
}

export interface RalphWorkSelectionIdentity {
  path: string;
  jsonPath: string;
  taskIds: readonly string[];
}

interface RalphRepositoryChange {
  path: string;
  beforeSignature: string | null;
  afterSignature: string | null;
}

export interface RalphRepositoryWorkYield {
  evidenceKind: "ralph-repository-work-yield-v1";
  workSelection?: {
    path: string;
    jsonPath: string;
    taskIds: string[];
  };
  changedFiles: string[];
  changedFileCount: number;
  implementationFiles: string[];
  implementationFileCount: number;
  excludedChangedFiles: string[];
  onlyExcludedFilesChanged: boolean;
  headChanged: boolean;
  producedWork: boolean;
  madeProgress: boolean;
  stalled: boolean;
  scopeAccepted: boolean;
  usefulWorkProduced: boolean;
  observationFailed: boolean;
  shouldVerify: boolean;
  repositoryFingerprint: string;
  previousRepositoryFingerprint?: string;
  selectedTaskCount: number;
  baselineFileCount: number;
  currentFileCount: number;
  reason: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizePath = (value: string): string => {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const readTrimmedString = (value: unknown): string => readString(value).trim();

const parseImprovementPlanDecision = (
  value: unknown,
): RalphImprovementPlanDecision | undefined =>
  value === "IMPLEMENT" || value === "STOP" || value === "DEFER"
    ? value
    : undefined;

const parseVerificationTier = (
  value: unknown,
): RalphVerificationTier | undefined =>
  value === "focused" || value === "standard" || value === "broad"
    ? value
    : undefined;

const parseReviewTier = (value: unknown): RalphReviewTier | undefined =>
  value === "validator-only" || value === "strict" ? value : undefined;

export const resolveRalphVerificationCommand = (input: {
  selection: unknown;
  commands: unknown;
  configuredCommand?: string;
}): RalphVerificationCommandSelection => {
  const selection = isRecord(input.selection) ? input.selection : {};
  const commands = isRecord(input.commands) ? input.commands : {};
  const declaredTier = parseVerificationTier(selection.verificationTier);
  const declaredReviewTier = parseReviewTier(selection.reviewTier);
  const tier = declaredTier ?? "broad";
  const reviewTier =
    tier === "broad" ? "strict" : (declaredReviewTier ?? "strict");
  const focusedCommand = readString(commands.focusedVerificationCommand);
  const standardCommand = readString(commands.standardVerificationCommand);
  const broadCommand = readString(commands.broadVerificationCommand);
  const detectedCommand =
    tier === "focused"
      ? focusedCommand
      : tier === "standard"
        ? standardCommand
        : broadCommand;
  const configuredCommand = input.configuredCommand?.trim() ?? "";

  return {
    tier,
    reviewTier,
    protocolValid:
      declaredTier !== undefined && declaredReviewTier !== undefined,
    command:
      configuredCommand ||
      detectedCommand ||
      readString(commands.verificationCommand),
    source: configuredCommand ? "variable" : "detected",
    focusedCommand,
    standardCommand,
    broadCommand,
  };
};

export const resolveRalphCodeImprovementPlan = (input: {
  draft: unknown;
  selection: unknown;
  constitution: unknown;
  research: unknown;
  stableDigest: (value: unknown) => string;
}): RalphCodeImprovementPlan => {
  if (!isRecord(input.draft) || !isRecord(input.selection)) {
    throw new Error(
      "Improvement plan requires a valid draft and selected scope.",
    );
  }
  const scope = input.selection.scope;
  const decision = parseImprovementPlanDecision(input.draft.decision);
  if (!isRecord(scope) || !readTrimmedString(scope.id) || !decision) {
    throw new Error(
      "Improvement plan requires a valid draft and selected scope.",
    );
  }

  const tasks = Array.isArray(input.draft.tasks) ? input.draft.tasks : [];
  const taskIds = tasks.flatMap((task) => {
    if (!isRecord(task)) {
      return [];
    }
    const taskId = readTrimmedString(task.id);
    return taskId ? [taskId] : [];
  });
  const scopeId = readTrimmedString(scope.id);
  const defaultCluster = {
    rootScopeId: scopeId,
    scopeIds: [scopeId],
    paths: Array.isArray(scope.paths) ? scope.paths : [],
    risk: scope.risk,
    rationale: ["Selected scope"],
  };

  return {
    planId: `improvement-${input
      .stableDigest({ scopeId, taskIds, decision })
      .slice(0, 32)}`,
    decision,
    rationale: input.draft.rationale,
    stopReason: input.draft.stopReason,
    scope,
    scopeCluster: input.selection.scopeCluster ?? defaultCluster,
    constitution: input.constitution ?? {},
    research: readString(input.research),
    tasks,
  };
};

export const resolveRalphVisualRuntime = (input: {
  commands: unknown;
  variables: Record<string, string>;
  transform: RalphVisualRuntimeTransform;
}): RalphVisualRuntimeSelection => {
  const commands = isRecord(input.commands) ? input.commands : {};
  const configuredTargetUrl = readTrimmedString(
    input.variables[input.transform.targetUrlVariable],
  );
  const configuredHealthUrl = readTrimmedString(
    input.variables[input.transform.healthUrlVariable],
  );
  const configuredCommand = readTrimmedString(
    input.variables[input.transform.serverCommandVariable],
  );
  const targetUrl =
    configuredTargetUrl || readTrimmedString(commands.targetUrl);
  const healthUrl = configuredHealthUrl || targetUrl;
  const serverCommand =
    configuredCommand || readTrimmedString(commands.serveCommand);
  const serverCwd =
    readTrimmedString(input.variables[input.transform.serverCwdVariable]) ||
    readTrimmedString(commands.rootPath) ||
    ".";
  const screenshotPath = readTrimmedString(
    input.variables[input.transform.screenshotPathVariable],
  );
  const visualStatus: RalphVisualRuntimeStatus = targetUrl
    ? serverCommand
      ? "managed-or-reused"
      : "existing-only"
    : screenshotPath
      ? "screenshot-only"
      : "degraded-unavailable";

  return {
    targetUrl,
    healthUrl,
    serverCommand,
    serverCwd,
    visualStatus,
    degradedReason:
      visualStatus === "degraded-unavailable"
        ? "No configured or detected target URL; code verification continues and FINAL_REPORT records degraded visual coverage."
        : "",
    targetSource: targetUrl
      ? configuredTargetUrl
        ? "variable"
        : "detected"
      : "",
    healthSource: healthUrl
      ? configuredHealthUrl
        ? "variable"
        : "target"
      : "",
    commandSource: serverCommand
      ? configuredCommand
        ? "variable"
        : readTrimmedString(commands.serveCommandSource) || "detected"
      : "",
  };
};

export const parseRalphRepositoryObservation = (
  value: unknown,
): RalphRepositoryObservation | undefined => {
  if (!isRecord(value) || typeof value.head !== "string") {
    return undefined;
  }
  if (!Array.isArray(value.files)) {
    return undefined;
  }

  const files = value.files.flatMap(
    (entry): RalphRepositoryObservationFile[] =>
      isRecord(entry) &&
      typeof entry.path === "string" &&
      typeof entry.signature === "string"
        ? [{ path: entry.path, signature: entry.signature }]
        : [],
  );

  return files.length === value.files.length
    ? { head: value.head, files }
    : undefined;
};

export const parseRalphWorkSelectionIdentity = (
  value: unknown,
): RalphWorkSelectionIdentity | undefined => {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.jsonPath !== "string" ||
    !Array.isArray(value.taskIds) ||
    !value.taskIds.every((taskId) => typeof taskId === "string")
  ) {
    return undefined;
  }

  return {
    path: value.path,
    jsonPath: value.jsonPath,
    taskIds: [...value.taskIds],
  };
};

const normalizeWorkSelection = (
  selection: RalphWorkSelectionIdentity,
): RalphRepositoryWorkYield["workSelection"] => ({
  path: normalizePath(selection.path),
  jsonPath: selection.jsonPath,
  taskIds: [...selection.taskIds].sort(),
});

const isSameWorkSelection = (
  left: RalphRepositoryWorkYield["workSelection"],
  right: RalphRepositoryWorkYield["workSelection"],
): boolean => {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.path === right.path &&
    left.jsonPath === right.jsonPath &&
    left.taskIds.length === right.taskIds.length &&
    left.taskIds.every((taskId, index) => taskId === right.taskIds[index])
  );
};

const createRepositoryChanges = (
  baseline: RalphRepositoryObservation,
  current: RalphRepositoryObservation,
): RalphRepositoryChange[] => {
  const baselineFiles = new Map(
    baseline.files.map((file) => [normalizePath(file.path), file.signature]),
  );
  const currentFiles = new Map(
    current.files.map((file) => [normalizePath(file.path), file.signature]),
  );
  const paths = [
    ...new Set([...baselineFiles.keys(), ...currentFiles.keys()]),
  ].sort((left, right) => left.localeCompare(right));

  return paths.flatMap((path) => {
    const beforeSignature = baselineFiles.get(path);
    const afterSignature = currentFiles.get(path);
    return beforeSignature === afterSignature
      ? []
      : [
          {
            path,
            beforeSignature: beforeSignature ?? null,
            afterSignature: afterSignature ?? null,
          },
        ];
  });
};

const createRepositoryFingerprint = (input: {
  baselineHead: string;
  currentHead: string;
  changes: readonly RalphRepositoryChange[];
}): string => createHash("sha256").update(JSON.stringify(input)).digest("hex");

export const isRalphRepositoryWorkYield = (
  value: unknown,
): value is RalphRepositoryWorkYield =>
  isRecord(value) &&
  value.evidenceKind === "ralph-repository-work-yield-v1" &&
  Array.isArray(value.changedFiles) &&
  value.changedFiles.every((entry) => typeof entry === "string") &&
  Array.isArray(value.implementationFiles) &&
  value.implementationFiles.every((entry) => typeof entry === "string") &&
  Array.isArray(value.excludedChangedFiles) &&
  value.excludedChangedFiles.every((entry) => typeof entry === "string") &&
  typeof value.repositoryFingerprint === "string" &&
  typeof value.producedWork === "boolean" &&
  typeof value.madeProgress === "boolean" &&
  typeof value.scopeAccepted === "boolean" &&
  typeof value.observationFailed === "boolean";

export const assessRalphRepositoryWorkYield = (input: {
  baseline: RalphRepositoryObservation;
  current: RalphRepositoryObservation;
  workSelection?: RalphWorkSelectionIdentity;
  previous?: RalphRepositoryWorkYield;
  excludedPaths?: readonly string[];
  trackPrevious?: boolean;
  scopeAccepted?: boolean;
  observationFailed?: boolean;
  verifyOnObservationError?: boolean;
}): RalphRepositoryWorkYield => {
  const changes = createRepositoryChanges(input.baseline, input.current);
  const changedFiles = changes.map((change) => change.path);
  const excludedPaths = new Set(
    (input.excludedPaths ?? []).map(normalizePath).filter(Boolean),
  );
  const implementationFiles = changedFiles.filter(
    (path) => !excludedPaths.has(path),
  );
  const excludedChangedFiles = changedFiles.filter((path) =>
    excludedPaths.has(path),
  );
  const headChanged = input.baseline.head !== input.current.head;
  const producedWork = implementationFiles.length > 0 || headChanged;
  const workSelection = input.workSelection
    ? normalizeWorkSelection(input.workSelection)
    : undefined;
  const repositoryFingerprint = createRepositoryFingerprint({
    baselineHead: input.baseline.head,
    currentHead: input.current.head,
    changes,
  });
  const repeated = Boolean(
    input.trackPrevious &&
    input.previous &&
    isSameWorkSelection(input.previous.workSelection, workSelection) &&
    input.previous.repositoryFingerprint === repositoryFingerprint,
  );
  const madeProgress = producedWork && !repeated;
  const scopeAccepted = input.scopeAccepted ?? true;
  const observationFailed = input.observationFailed ?? false;
  const shouldVerify =
    producedWork ||
    (observationFailed && input.verifyOnObservationError === true);

  return {
    evidenceKind: "ralph-repository-work-yield-v1",
    ...(workSelection ? { workSelection } : {}),
    changedFiles,
    changedFileCount: changedFiles.length,
    implementationFiles,
    implementationFileCount: implementationFiles.length,
    excludedChangedFiles,
    onlyExcludedFilesChanged:
      changedFiles.length > 0 &&
      implementationFiles.length === 0 &&
      !headChanged,
    headChanged,
    producedWork,
    madeProgress,
    stalled: producedWork && !madeProgress,
    scopeAccepted,
    usefulWorkProduced: madeProgress && scopeAccepted,
    observationFailed,
    shouldVerify,
    repositoryFingerprint,
    ...(input.previous
      ? { previousRepositoryFingerprint: input.previous.repositoryFingerprint }
      : {}),
    selectedTaskCount: workSelection?.taskIds.length ?? 0,
    baselineFileCount: input.baseline.files.length,
    currentFileCount: input.current.files.length,
    reason: observationFailed
      ? "Repository observation failed; verification remains required."
      : producedWork
        ? madeProgress
          ? "Repository content changed since the prior task observation."
          : "Repository content matches the prior task observation."
        : changedFiles.length > 0
          ? "Only excluded state files changed."
          : "No repository content changed beyond the baseline.",
  };
};
