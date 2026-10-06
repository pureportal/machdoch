import type {
  TaskExecutionChangedLineRange,
  TaskExecutionFileChange,
  TaskExecutionFileChangeCompleteness,
  TaskExecutionFileChangeIssue,
  TaskExecutionFileChangeOperation,
  TaskExecutionFileEntryType,
  TaskExecutionFileLineAnalysis,
  TaskExecutionFileChanges,
} from "@machdoch/fleet-protocol/task-file-changes";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const normalizeString = (value: unknown, defaultValue = ""): string =>
  typeof value === "string" ? value : defaultValue;
const normalizeOptionalFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const normalizeNonNegativeInteger = (value: unknown): number | undefined => {
  const normalized = normalizeOptionalFiniteNumber(value);

  return normalized === undefined
    ? undefined
    : Math.max(0, Math.round(normalized));
};

const isTaskExecutionFileChangeOperation = (
  value: unknown,
): value is TaskExecutionFileChangeOperation => {
  return (
    value === "added" ||
    value === "modified" ||
    value === "deleted" ||
    value === "renamed" ||
    value === "type-changed"
  );
};

const isTaskExecutionFileEntryType = (
  value: unknown,
): value is TaskExecutionFileEntryType => {
  return (
    value === "text" ||
    value === "binary" ||
    value === "gitlink" ||
    value === "symlink" ||
    value === "mode"
  );
};

export const normalizeTaskExecutionChangedLineRange = (
  value: unknown,
): TaskExecutionChangedLineRange | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const oldStart = normalizeNonNegativeInteger(value.oldStart);
  const oldLines = normalizeNonNegativeInteger(value.oldLines);
  const newStart = normalizeNonNegativeInteger(value.newStart);
  const newLines = normalizeNonNegativeInteger(value.newLines);

  if (
    oldStart === undefined ||
    oldLines === undefined ||
    newStart === undefined ||
    newLines === undefined
  ) {
    return undefined;
  }

  return { oldStart, oldLines, newStart, newLines };
};

const normalizeTaskExecutionFileLineAnalysis = (
  value: unknown,
): TaskExecutionFileLineAnalysis | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.state === "complete") {
    const additions = normalizeNonNegativeInteger(value.additions);
    const deletions = normalizeNonNegativeInteger(value.deletions);

    return additions === undefined || deletions === undefined
      ? undefined
      : { state: "complete", additions, deletions };
  }

  if (
    value.state === "not-applicable" &&
    (value.reason === "binary" ||
      value.reason === "gitlink" ||
      value.reason === "symlink" ||
      value.reason === "mode-only")
  ) {
    return { state: "not-applicable", reason: value.reason };
  }

  if (value.state === "failed" && value.code === "git-failed") {
    return {
      state: "failed",
      code: value.code,
      message: normalizeString(value.message, "Line analysis failed.").slice(
        0,
        4_000,
      ),
    };
  }

  return undefined;
};

const normalizeFileChangeStage = (
  value: unknown,
): TaskExecutionFileChangeCompleteness["discovery"] | undefined => {
  if (isRecord(value) && value.state === "complete") {
    return { state: "complete" };
  }

  if (isRecord(value) && value.state === "failed") {
    return {
      state: "failed",
      code: normalizeString(value.code, "unknown").slice(0, 100),
      message: normalizeString(
        value.message,
        "File-change stage failed.",
      ).slice(0, 4_000),
    };
  }

  return undefined;
};

export const normalizeTaskExecutionFileChange = (
  value: unknown,
): TaskExecutionFileChange | undefined => {
  if (
    !isRecord(value) ||
    !isTaskExecutionFileChangeOperation(value.operation) ||
    !isTaskExecutionFileEntryType(value.entryType)
  ) {
    return undefined;
  }

  const path = normalizeString(value.path).trim().slice(0, 4_000);
  const oldPath = normalizeString(value.oldPath).trim().slice(0, 4_000);
  const repositoryPath = normalizeString(value.repositoryPath)
    .trim()
    .replace(/\\/gu, "/")
    .slice(0, 4_000);
  const oldMode = normalizeString(value.oldMode).trim().slice(0, 12);
  const newMode = normalizeString(value.newMode).trim().slice(0, 12);
  const lineAnalysis = normalizeTaskExecutionFileLineAnalysis(
    value.lineAnalysis,
  );
  const ranges: TaskExecutionChangedLineRange[] = [];

  if (Array.isArray(value.ranges)) {
    for (const range of value.ranges) {
      const normalizedRange = normalizeTaskExecutionChangedLineRange(range);

      if (normalizedRange) {
        ranges.push(normalizedRange);
      }
    }
  }

  if (!path || !oldMode || !newMode || !lineAnalysis) {
    return undefined;
  }

  const oldObjectId = normalizeString(value.oldObjectId).trim().slice(0, 128);
  const newObjectId = normalizeString(value.newObjectId).trim().slice(0, 128);
  const oldCommit = normalizeString(value.oldCommit).trim().slice(0, 128);
  const newCommit = normalizeString(value.newCommit).trim().slice(0, 128);
  const hunkCount = normalizeNonNegativeInteger(value.hunkCount);
  const storedId = normalizeNonNegativeInteger(value.storedId);

  return {
    path,
    ...(oldPath && oldPath !== path ? { oldPath } : {}),
    operation: value.operation,
    entryType: value.entryType,
    ...(repositoryPath ? { repositoryPath } : {}),
    oldMode,
    newMode,
    ...(oldObjectId ? { oldObjectId } : {}),
    ...(newObjectId ? { newObjectId } : {}),
    ...(oldCommit ? { oldCommit } : {}),
    ...(newCommit ? { newCommit } : {}),
    lineAnalysis,
    ...(ranges.length > 0 ? { ranges } : {}),
    ...(hunkCount !== undefined ? { hunkCount } : {}),
    ...(storedId !== undefined ? { storedId } : {}),
  };
};

export const normalizeTaskExecutionFileChanges = (
  value: unknown,
): TaskExecutionFileChanges | undefined => {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    return undefined;
  }

  const normalizedFiles = new Map<string, TaskExecutionFileChange>();

  for (const entry of value.files) {
    const file = normalizeTaskExecutionFileChange(entry);

    if (!file) {
      continue;
    }
    normalizedFiles.set(
      `${file.repositoryPath ?? "."}\0${file.oldPath ?? ""}\0${file.path}`,
      file,
    );
  }

  const files = Array.from(normalizedFiles.values());
  const totalFiles = normalizeNonNegativeInteger(value.totalFiles);
  const additions = normalizeNonNegativeInteger(value.additions);
  const deletions = normalizeNonNegativeInteger(value.deletions);
  const binaryFiles = normalizeNonNegativeInteger(value.binaryFiles);
  const gitlinkFiles = normalizeNonNegativeInteger(value.gitlinkFiles);
  const symlinkFiles = normalizeNonNegativeInteger(value.symlinkFiles);
  const modeOnlyFiles = normalizeNonNegativeInteger(value.modeOnlyFiles);
  const failedFiles = normalizeNonNegativeInteger(value.failedFiles);
  const repositoryCount = normalizeNonNegativeInteger(value.repositoryCount);

  if (
    totalFiles === undefined ||
    additions === undefined ||
    deletions === undefined ||
    binaryFiles === undefined ||
    gitlinkFiles === undefined ||
    symlinkFiles === undefined ||
    modeOnlyFiles === undefined ||
    failedFiles === undefined ||
    repositoryCount === undefined ||
    totalFiles < files.length ||
    (totalFiles > 0 && repositoryCount === 0) ||
    (value.status !== "complete" &&
      value.status !== "partial" &&
      value.status !== "failed") ||
    value.attribution !== "workspace-observed"
  ) {
    return undefined;
  }

  const normalizedIssues: TaskExecutionFileChangeIssue[] = [];

  if (Array.isArray(value.issues)) {
    for (const entry of value.issues) {
      if (!isRecord(entry)) {
        continue;
      }

      const stage = entry.stage;
      if (
        stage !== "discovery" &&
        stage !== "startSnapshots" &&
        stage !== "finishSnapshots" &&
        stage !== "renameAnalysis" &&
        stage !== "lineAnalysis" &&
        stage !== "persistence"
      ) {
        continue;
      }

      const repositoryPath = normalizeString(entry.repositoryPath)
        .trim()
        .slice(0, 4_000);
      normalizedIssues.push({
        stage,
        code: normalizeString(entry.code, "unknown").slice(0, 100),
        message: normalizeString(
          entry.message,
          "File-change tracking failed.",
        ).slice(0, 4_000),
        ...(repositoryPath ? { repositoryPath } : {}),
      });
    }
  }

  if (totalFiles === 0 && normalizedIssues.length === 0) {
    return undefined;
  }

  if (!isRecord(value.completeness)) {
    return undefined;
  }

  const rawCompleteness = value.completeness;
  const discovery = normalizeFileChangeStage(rawCompleteness.discovery);
  const startSnapshots = normalizeFileChangeStage(
    rawCompleteness.startSnapshots,
  );
  const finishSnapshots = normalizeFileChangeStage(
    rawCompleteness.finishSnapshots,
  );
  const renameAnalysis = normalizeFileChangeStage(
    rawCompleteness.renameAnalysis,
  );
  const lineAnalysis = normalizeFileChangeStage(rawCompleteness.lineAnalysis);
  const persistence = normalizeFileChangeStage(rawCompleteness.persistence);

  if (
    !discovery ||
    !startSnapshots ||
    !finishSnapshots ||
    !renameAnalysis ||
    !lineAnalysis ||
    !persistence
  ) {
    return undefined;
  }

  const completeness: TaskExecutionFileChangeCompleteness = {
    discovery,
    startSnapshots,
    finishSnapshots,
    renameAnalysis,
    lineAnalysis,
    persistence,
  };
  const changeSetId = normalizeString(value.changeSetId).trim().slice(0, 128);

  return {
    files,
    ...(changeSetId ? { changeSetId } : {}),
    totalFiles,
    additions,
    deletions,
    binaryFiles,
    gitlinkFiles,
    symlinkFiles,
    modeOnlyFiles,
    failedFiles,
    status: value.status,
    completeness,
    attribution: "workspace-observed",
    repositoryCount,
    issues: normalizedIssues,
  };
};
