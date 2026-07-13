import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  TaskExecutionChangedLineRange,
  TaskExecutionFileChange,
  TaskExecutionFileChangeKind,
  TaskExecutionFileChanges,
} from "../types.js";
import {
  fingerprintUntrackedFiles,
  inspectNewUntrackedFiles,
} from "./task-file-change-inspection.js";

const GIT_COMMAND_TIMEOUT_MS = 10_000;
const GIT_METADATA_MAX_BYTES = 2 * 1024 * 1024;
const GIT_PATCH_MAX_BYTES = 8 * 1024 * 1024;
const MAX_RECORDED_FILES = 500;
const MAX_RECORDED_RANGES = 2_000;
const MAX_WARNINGS = 5;

interface TaskFileChangeCaptureState {
  baseline: string;
  gitRoot: string;
  workspaceRoot: string;
  pathspec: string;
  initialUntracked?: Set<string>;
  initialUntrackedFingerprints?: Map<string, string>;
  warnings: string[];
}

interface ParsedPatchRanges {
  ranges: Map<string, TaskExecutionChangedLineRange[]>;
  complete: boolean;
}

export interface TaskFileChangeCapture {
  finish(): Promise<TaskExecutionFileChanges | undefined>;
}

const runGitCommand = async (
  args: readonly string[],
  cwd: string,
  maxBuffer = GIT_METADATA_MAX_BYTES,
  input?: string,
): Promise<string> => {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      "git",
      ["--no-optional-locks", "-c", "core.quotePath=false", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(Object.assign(error, { stdout, stderr }));
          return;
        }

        resolvePromise(stdout);
      },
    );

    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
};

const getGitCommandStdout = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "stdout" in error &&
    typeof error.stdout === "string"
  ) {
    return error.stdout;
  }

  return "";
};

const hasGitMarker = (workspaceRoot: string): boolean => {
  let current = resolve(workspaceRoot);

  while (true) {
    if (existsSync(join(current, ".git"))) {
      return true;
    }

    const parent = dirname(current);

    if (parent === current) {
      return false;
    }

    current = parent;
  }
};

const addWarning = (warnings: string[], warning: string): void => {
  if (warnings.length < MAX_WARNINGS && !warnings.includes(warning)) {
    warnings.push(warning);
  }
};

const splitNulOutput = (value: string): string[] => {
  return value.split("\0").filter((entry) => entry.length > 0);
};

const isPathWithin = (parentPath: string, candidatePath: string): boolean => {
  const pathFromParent = relative(parentPath, candidatePath);

  return (
    pathFromParent === "" ||
    (!isAbsolute(pathFromParent) &&
      pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`))
  );
};

const normalizeWorkspacePath = (
  gitPath: string,
  gitRoot: string,
  workspaceRoot: string,
): string | undefined => {
  const absolutePath = resolve(gitRoot, gitPath);
  const workspacePath = relative(workspaceRoot, absolutePath);

  if (
    workspacePath.length === 0 ||
    !isPathWithin(workspaceRoot, absolutePath)
  ) {
    return undefined;
  }

  return workspacePath.replace(/\\/gu, "/");
};

const parseUntrackedPaths = (
  output: string,
  gitRoot: string,
  workspaceRoot: string,
): Set<string> => {
  const paths = new Set<string>();

  for (const gitPath of splitNulOutput(output)) {
    const path = normalizeWorkspacePath(gitPath, gitRoot, workspaceRoot);

    if (path) {
      paths.add(path);
    }
  }

  return paths;
};

const mapGitStatusToChangeKind = (
  status: string,
): TaskExecutionFileChangeKind => {
  if (status.startsWith("A")) {
    return "added";
  }

  if (status.startsWith("D")) {
    return "deleted";
  }

  return "modified";
};

const parseNameStatus = (
  output: string,
  state: TaskFileChangeCaptureState,
): { changes: Map<string, TaskExecutionFileChange>; order: string[] } => {
  const tokens = splitNulOutput(output);
  const changes = new Map<string, TaskExecutionFileChange>();
  const order: string[] = [];

  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const status = tokens[index];
    const gitPath = tokens[index + 1];

    if (!status || !gitPath) {
      continue;
    }

    const path = normalizeWorkspacePath(
      gitPath,
      state.gitRoot,
      state.workspaceRoot,
    );

    if (!path) {
      continue;
    }

    changes.set(path, {
      path,
      kind: mapGitStatusToChangeKind(status),
    });
    order.push(path);
  }

  return { changes, order };
};

const parseNumstat = (
  output: string,
  state: TaskFileChangeCaptureState,
): { stats: Map<string, Pick<TaskExecutionFileChange, "additions" | "deletions" | "binary">>; order: string[] } => {
  const stats = new Map<
    string,
    Pick<TaskExecutionFileChange, "additions" | "deletions" | "binary">
  >();
  const order: string[] = [];

  for (const record of splitNulOutput(output)) {
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);

    if (firstTab <= 0 || secondTab <= firstTab) {
      continue;
    }

    const additionsText = record.slice(0, firstTab);
    const deletionsText = record.slice(firstTab + 1, secondTab);
    const gitPath = record.slice(secondTab + 1);
    const path = normalizeWorkspacePath(
      gitPath,
      state.gitRoot,
      state.workspaceRoot,
    );

    if (!path) {
      continue;
    }

    if (additionsText === "-" || deletionsText === "-") {
      stats.set(path, { binary: true });
    } else {
      const additions = Number.parseInt(additionsText, 10);
      const deletions = Number.parseInt(deletionsText, 10);

      if (Number.isFinite(additions) && Number.isFinite(deletions)) {
        stats.set(path, { additions, deletions });
      }
    }

    order.push(path);
  }

  return { stats, order };
};

const parsePatchRanges = (
  patch: string,
  orderedPaths: readonly string[],
): ParsedPatchRanges => {
  const sectionStarts = Array.from(patch.matchAll(/^diff --git /gmu), (match) =>
    match.index,
  ).filter((index): index is number => index !== undefined);

  if (sectionStarts.length !== orderedPaths.length) {
    return { ranges: new Map(), complete: false };
  }

  const ranges = new Map<string, TaskExecutionChangedLineRange[]>();

  for (let index = 0; index < sectionStarts.length; index += 1) {
    const start = sectionStarts[index];
    const path = orderedPaths[index];

    if (start === undefined || !path) {
      continue;
    }

    const end = sectionStarts[index + 1] ?? patch.length;
    const section = patch.slice(start, end);
    const fileRanges = Array.from(
      section.matchAll(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu,
      ),
      (match): TaskExecutionChangedLineRange => ({
        oldStart: Number.parseInt(match[1] ?? "0", 10),
        oldLines: Number.parseInt(match[2] ?? "1", 10),
        newStart: Number.parseInt(match[3] ?? "0", 10),
        newLines: Number.parseInt(match[4] ?? "1", 10),
      }),
    );

    if (fileRanges.length > 0) {
      ranges.set(path, fileRanges);
    }
  }

  return { ranges, complete: true };
};

const reconcileInitialUntrackedFiles = async (
  state: TaskFileChangeCaptureState,
  finalUntracked: ReadonlySet<string>,
  changes: Map<string, TaskExecutionFileChange>,
  warnings: string[],
): Promise<void> => {
  if (!state.initialUntracked || !state.initialUntrackedFingerprints) {
    return;
  }

  const monitoredPaths = Array.from(state.initialUntrackedFingerprints.keys());
  const existingMonitoredPaths = monitoredPaths.filter((path) =>
    existsSync(resolve(state.workspaceRoot, path)),
  );
  const existingMonitoredPathSet = new Set(existingMonitoredPaths);
  const finalFingerprints = await fingerprintUntrackedFiles(
    existingMonitoredPaths,
    state.workspaceRoot,
  );

  if (!finalFingerprints.complete) {
    addWarning(
      warnings,
      "Some files that were already untracked could not be rechecked.",
    );
  }

  for (const path of monitoredPaths) {
    if (!existingMonitoredPathSet.has(path)) {
      changes.set(path, { path, kind: "deleted" });
      continue;
    }

    const initialFingerprint = state.initialUntrackedFingerprints.get(path);
    const finalFingerprint = finalFingerprints.fingerprints.get(path);

    if (!initialFingerprint || !finalFingerprint) {
      continue;
    }

    if (initialFingerprint === finalFingerprint) {
      if (changes.get(path)?.kind === "added") {
        changes.delete(path);
      }
      continue;
    }

    changes.set(path, { path, kind: "modified" });
  }

  for (const path of state.initialUntracked) {
    if (
      !state.initialUntrackedFingerprints.has(path) &&
      !finalUntracked.has(path) &&
      !changes.has(path)
    ) {
      changes.set(path, { path, kind: "deleted" });
    }
  }
};

const createDiffArguments = (
  state: TaskFileChangeCaptureState,
  formatArguments: readonly string[],
): string[] => {
  return [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    ...formatArguments,
    state.baseline,
    "--",
    state.pathspec,
  ];
};

const mergeTrackedChanges = (
  nameStatusOutput: string | undefined,
  numstatOutput: string | undefined,
  state: TaskFileChangeCaptureState,
): { changes: Map<string, TaskExecutionFileChange>; order: string[] } => {
  const parsedNames = nameStatusOutput
    ? parseNameStatus(nameStatusOutput, state)
    : { changes: new Map<string, TaskExecutionFileChange>(), order: [] };
  const parsedStats = numstatOutput
    ? parseNumstat(numstatOutput, state)
    : { stats: new Map(), order: [] };

  for (const [path, stats] of parsedStats.stats) {
    const existing = parsedNames.changes.get(path) ?? {
      path,
      kind: "modified" as const,
    };
    parsedNames.changes.set(path, { ...existing, ...stats });
  }

  return {
    changes: parsedNames.changes,
    order: parsedNames.order.length > 0 ? parsedNames.order : parsedStats.order,
  };
};

const createFileChangeResult = (
  changes: Map<string, TaskExecutionFileChange>,
  warnings: string[],
): TaskExecutionFileChanges | undefined => {
  const allFiles = Array.from(changes.values()).sort((left, right) =>
    left.path.localeCompare(right.path),
  );

  if (allFiles.length === 0) {
    return undefined;
  }

  const additions = allFiles.reduce(
    (total, file) => total + (file.additions ?? 0),
    0,
  );
  const deletions = allFiles.reduce(
    (total, file) => total + (file.deletions ?? 0),
    0,
  );
  const binaryFiles = allFiles.filter((file) => file.binary === true).length;
  let remainingRanges = MAX_RECORDED_RANGES;
  let rangesTruncated = false;
  const files = allFiles.slice(0, MAX_RECORDED_FILES).map((file) => {
    if (!file.ranges || file.ranges.length === 0) {
      return file;
    }

    const ranges = file.ranges.slice(0, remainingRanges);
    remainingRanges -= ranges.length;

    if (ranges.length < file.ranges.length) {
      rangesTruncated = true;
    }

    if (ranges.length === 0) {
      return {
        path: file.path,
        kind: file.kind,
        ...(file.additions !== undefined ? { additions: file.additions } : {}),
        ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
        ...(file.binary ? { binary: true as const } : {}),
      };
    }

    return {
      ...file,
      ranges,
    };
  });
  const filesTruncated = allFiles.length > files.length;

  return {
    files,
    totalFiles: allFiles.length,
    additions,
    deletions,
    binaryFiles,
    lineCountsComplete: allFiles.every(
      (file) => file.additions !== undefined && file.deletions !== undefined,
    ),
    coverage: warnings.length > 0 ? "partial" : "complete",
    truncated: filesTruncated || rangesTruncated,
    attribution: "workspace-observed",
    ...(warnings.length > 0 ? { warnings: warnings.slice(0, MAX_WARNINGS) } : {}),
  };
};

const finishTaskFileChangeCapture = async (
  state: TaskFileChangeCaptureState,
): Promise<TaskExecutionFileChanges | undefined> => {
  const [nameStatusResult, numstatResult, patchResult, untrackedResult] =
    await Promise.allSettled([
      runGitCommand(
        createDiffArguments(state, ["--name-status", "-z"]),
        state.gitRoot,
      ),
      runGitCommand(
        createDiffArguments(state, ["--numstat", "-z"]),
        state.gitRoot,
      ),
      runGitCommand(
        createDiffArguments(state, [
          "--unified=0",
          "--diff-algorithm=histogram",
          "--no-color",
        ]),
        state.gitRoot,
        GIT_PATCH_MAX_BYTES,
      ),
      runGitCommand(
        ["ls-files", "--others", "--exclude-standard", "-z", "--", state.pathspec],
        state.gitRoot,
      ),
    ]);
  const warnings = [...state.warnings];

  if (nameStatusResult.status === "rejected") {
    addWarning(warnings, "Some file status details could not be captured.");
  }

  if (numstatResult.status === "rejected") {
    addWarning(warnings, "Some changed-line counts could not be captured.");
  }

  const tracked = mergeTrackedChanges(
    nameStatusResult.status === "fulfilled" ? nameStatusResult.value : undefined,
    numstatResult.status === "fulfilled" ? numstatResult.value : undefined,
    state,
  );

  if (patchResult.status === "fulfilled") {
    const parsedPatch = parsePatchRanges(patchResult.value, tracked.order);

    if (!parsedPatch.complete) {
      addWarning(warnings, "Some changed-line ranges could not be captured.");
    } else {
      for (const [path, ranges] of parsedPatch.ranges) {
        const existing = tracked.changes.get(path);

        if (existing) {
          tracked.changes.set(path, { ...existing, ranges });
        }
      }
    }
  } else {
    addWarning(warnings, "Some changed-line ranges could not be captured.");
  }

  if (state.initialUntracked && untrackedResult.status === "fulfilled") {
    const finalUntracked = parseUntrackedPaths(
      untrackedResult.value,
      state.gitRoot,
      state.workspaceRoot,
    );
    const newUntracked = Array.from(finalUntracked)
      .filter((path) => !state.initialUntracked?.has(path))
      .sort((left, right) => left.localeCompare(right));

    for (const path of newUntracked) {
      if (!tracked.changes.has(path)) {
        tracked.changes.set(path, { path, kind: "added" });
      }
    }

    await reconcileInitialUntrackedFiles(
      state,
      finalUntracked,
      tracked.changes,
      warnings,
    );

    await inspectNewUntrackedFiles(
      newUntracked,
      tracked.changes,
      state.workspaceRoot,
    );
  } else {
    addWarning(warnings, "Untracked file changes could not be fully captured.");
  }

  return createFileChangeResult(tracked.changes, warnings);
};

export const startTaskFileChangeCapture = async (
  workspaceRoot: string,
): Promise<TaskFileChangeCapture | undefined> => {
  if (!hasGitMarker(workspaceRoot)) {
    return undefined;
  }

  try {
    let repositoryInfoOutput: string;
    let hasHead = true;

    try {
      repositoryInfoOutput = await runGitCommand(
        ["rev-parse", "--show-toplevel", "--verify", "HEAD"],
        workspaceRoot,
      );
    } catch (error) {
      repositoryInfoOutput = getGitCommandStdout(error);
      hasHead = false;
    }

    const repositoryInfo = repositoryInfoOutput.trimEnd().split(/\r?\n/u);
    const headBaseline = hasHead ? (repositoryInfo.pop()?.trim() ?? "") : "";
    const rawGitRoot = repositoryInfo.join("\n").trim();

    if (!rawGitRoot) {
      return undefined;
    }

    const [gitRoot, normalizedWorkspaceRoot] = await Promise.all([
      realpath(rawGitRoot).catch(() => resolve(rawGitRoot)),
      realpath(workspaceRoot).catch(() => resolve(workspaceRoot)),
    ]);
    const workspaceFromRoot = relative(gitRoot, normalizedWorkspaceRoot);

    if (!isPathWithin(gitRoot, normalizedWorkspaceRoot)) {
      return undefined;
    }

    const pathspec = workspaceFromRoot
      ? `:(top,literal)${workspaceFromRoot.replace(/\\/gu, "/")}`
      : ".";
    const [stashResult, untrackedResult] = await Promise.allSettled([
      runGitCommand(["stash", "create"], gitRoot),
      runGitCommand(
        [
          "ls-files",
          ...(hasHead ? [] : ["--cached"]),
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          pathspec,
        ],
        gitRoot,
      ),
    ]);
    const stashBaseline =
      stashResult.status === "fulfilled" ? stashResult.value.trim() : "";
    const baseline =
      stashBaseline ||
      headBaseline ||
      (
        await runGitCommand(
          ["hash-object", "-t", "tree", "-w", "--stdin"],
          gitRoot,
          GIT_METADATA_MAX_BYTES,
          "",
        )
      ).trim();

    const warnings: string[] = [];
    const initialUntracked =
      untrackedResult.status === "fulfilled"
        ? parseUntrackedPaths(
            untrackedResult.value,
            gitRoot,
            normalizedWorkspaceRoot,
          )
        : undefined;

    if (!initialUntracked) {
      addWarning(warnings, "The initial untracked file set could not be captured.");
    }

    const initialUntrackedFingerprintResult = initialUntracked
      ? await fingerprintUntrackedFiles(
          Array.from(initialUntracked).sort((left, right) =>
            left.localeCompare(right),
          ),
          normalizedWorkspaceRoot,
        )
      : undefined;

    if (
      initialUntrackedFingerprintResult &&
      !initialUntrackedFingerprintResult.complete
    ) {
      addWarning(
        warnings,
        "Some files that were already untracked could not be monitored.",
      );
    }

    const state: TaskFileChangeCaptureState = {
      baseline,
      gitRoot,
      workspaceRoot: normalizedWorkspaceRoot,
      pathspec,
      ...(initialUntracked ? { initialUntracked } : {}),
      ...(initialUntrackedFingerprintResult
        ? {
            initialUntrackedFingerprints:
              initialUntrackedFingerprintResult.fingerprints,
          }
        : {}),
      warnings,
    };

    let finishPromise: Promise<TaskExecutionFileChanges | undefined> | undefined;

    return {
      finish: () => {
        finishPromise ??= finishTaskFileChangeCapture(state).catch(
          () => undefined,
        );
        return finishPromise;
      },
    };
  } catch {
    return undefined;
  }
};
