import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  TaskExecutionChangedLineRange,
  TaskExecutionFileChange,
  TaskExecutionFileChangeCompleteness,
  TaskExecutionFileChangeIssue,
  TaskExecutionFileChangeOperation,
  TaskExecutionFileChanges,
} from "../types.js";
import { mapWithConcurrencyLimit } from "./task-file-change-concurrency.js";
import {
  discoverWorkspaceGitRepositories,
  type DiscoveredGitRepository,
} from "./task-file-change-repository-discovery.js";

const GIT_COMMAND_TIMEOUT_MS = 60_000;
const SNAPSHOT_STABILITY_ATTEMPTS = 3;
const REPOSITORY_START_CONCURRENCY = 4;
const REPOSITORY_FINISH_CONCURRENCY = 2;
const GITLINK_HEAD_CONCURRENCY = 8;
const MAX_GIT_ERROR_OUTPUT_BYTES = 64 * 1_024;
const MAX_DIFF_CONTROL_LINE_CHARS = 8 * 1_024;
const ZERO_OBJECT_PATTERN = /^0+$/u;

interface GitCommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: Buffer;
}

interface RepositoryCaptureState {
  repository: DiscoveredGitRepository;
  objectDirectory: string;
  realIndexPath: string;
  environment: NodeJS.ProcessEnv;
  pathspec: string;
  startTree: string;
  snapshotSequence: number;
}

interface RawDiffEntry {
  oldMode: string;
  newMode: string;
  oldObjectId: string;
  newObjectId: string;
  status: string;
  oldGitPath?: string;
  gitPath: string;
}

interface RepositoryAnalysisResult {
  files: TaskExecutionFileChange[];
  issues: TaskExecutionFileChangeIssue[];
}

interface GitPathLineAnalysis {
  oldGitPath?: string;
  gitPath: string;
  additions: number | "binary";
  deletions: number | "binary";
  ranges: TaskExecutionChangedLineRange[];
}

export interface TaskFileChangeCapture {
  dispose(): Promise<void>;
  finish(): Promise<TaskExecutionFileChanges | undefined>;
}

class GitCommandError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitCommandError";
  }
}

const parseGitInteger = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Git returned an invalid integer: ${value}`);
  }

  return parsed;
};

const runGitProcess = async (
  args: readonly string[],
  options: GitCommandOptions,
  onStdout: (chunk: Buffer) => void,
): Promise<void> => {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(
      "git",
      ["--no-optional-locks", "-c", "core.quotePath=false", ...args],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...options.env,
          GIT_OPTIONAL_LOCKS: "0",
        },
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    const reject = (error: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      child.kill();
      rejectPromise(error);
    };
    const timeout = setTimeout(() => {
      reject(
        new GitCommandError(`Git command timed out: git ${args.join(" ")}`),
      );
    }, GIT_COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }

      try {
        onStdout(chunk);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const remaining = MAX_GIT_ERROR_OUTPUT_BYTES - stderrBytes;

      if (remaining <= 0) {
        return;
      }

      const boundedChunk =
        chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderr.push(boundedChunk);
      stderrBytes += boundedChunk.length;
    });
    child.once("error", (error) => {
      reject(new GitCommandError(`Failed to start Git: ${error.message}`));
    });
    child.stdin?.once("error", (error) => {
      reject(new GitCommandError(`Failed to send Git input: ${error.message}`));
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      const stderrText = Buffer.concat(stderr).toString("utf8").trim();

      if (code !== 0) {
        rejectPromise(
          new GitCommandError(
            `Git command failed (${code ?? "unknown"}): git ${args.join(" ")}${
              stderrText ? `\n${stderrText}` : ""
            }`,
          ),
        );
        return;
      }

      resolvePromise();
    });

    if (options.input) {
      child.stdin?.end(options.input);
    }
  });
};

const runGitCommand = async (
  args: readonly string[],
  options: GitCommandOptions,
): Promise<Buffer> => {
  const stdout: Buffer[] = [];
  await runGitProcess(args, options, (chunk) => stdout.push(chunk));
  return Buffer.concat(stdout);
};

const runGitText = async (
  args: readonly string[],
  options: GitCommandOptions,
): Promise<string> => {
  return (await runGitCommand(args, options)).toString("utf8");
};

const runGitPatchRangeAnalysis = async (
  args: readonly string[],
  options: GitCommandOptions,
  analyses: GitPathLineAnalysis[],
): Promise<void> => {
  const decoder = new StringDecoder("utf8");
  let pendingLine = "";
  let discardingLine = false;
  let analysisIndex = -1;

  const processLine = (line: string): void => {
    if (line.startsWith("diff --git ")) {
      analysisIndex += 1;
      if (analysisIndex >= analyses.length) {
        throw new Error("Git returned more patch sections than changed paths.");
      }
      return;
    }

    if (!line.startsWith("@@ ")) {
      return;
    }

    if (analysisIndex < 0) {
      throw new Error("Git returned a hunk before its changed-path header.");
    }

    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (!hunk) {
      return;
    }

    analyses[analysisIndex]?.ranges.push({
      oldStart: parseGitInteger(hunk[1] ?? "0"),
      oldLines: parseGitInteger(hunk[2] ?? "1"),
      newStart: parseGitInteger(hunk[3] ?? "0"),
      newLines: parseGitInteger(hunk[4] ?? "1"),
    });
  };
  const consumeText = (value: string): void => {
    let text = value;

    while (text.length > 0) {
      if (discardingLine) {
        const newlineIndex = text.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }

        discardingLine = false;
        text = text.slice(newlineIndex + 1);
        continue;
      }

      const newlineIndex = text.indexOf("\n");
      if (newlineIndex < 0) {
        if (
          pendingLine.length + text.length >
          MAX_DIFF_CONTROL_LINE_CHARS
        ) {
          pendingLine = "";
          discardingLine = true;
        } else {
          pendingLine += text;
        }
        return;
      }

      const lineFragment = text.slice(0, newlineIndex);
      if (
        pendingLine.length + lineFragment.length <=
        MAX_DIFF_CONTROL_LINE_CHARS
      ) {
        pendingLine += lineFragment;
        processLine(
          pendingLine.endsWith("\r") ? pendingLine.slice(0, -1) : pendingLine,
        );
      }
      pendingLine = "";
      text = text.slice(newlineIndex + 1);
    }
  };

  await runGitProcess(args, options, (chunk) =>
    consumeText(decoder.write(chunk)),
  );
  consumeText(decoder.end());
  if (!discardingLine && pendingLine) {
    processLine(pendingLine);
  }

  if (analysisIndex + 1 !== analyses.length) {
    throw new Error("Git patch sections did not match the changed-path list.");
  }
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

const getPathKey = (value: string): string => {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const resolveGitPath = (repositoryRoot: string, value: string): string => {
  const trimmed = value.trim();
  return isAbsolute(trimmed) ? trimmed : resolve(repositoryRoot, trimmed);
};

const createRepositoryPathspec = (
  repository: DiscoveredGitRepository,
): string => {
  const workspaceFromRoot = relative(repository.root, repository.captureRoot);

  return workspaceFromRoot
    ? `:(top,literal)${workspaceFromRoot.replace(/\\/gu, "/")}`
    : ".";
};

const splitNulBuffer = (value: Buffer): Buffer[] => {
  const entries: Buffer[] = [];
  let start = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) {
      continue;
    }

    if (index > start) {
      entries.push(value.subarray(start, index));
    }

    start = index + 1;
  }

  if (start < value.length) {
    entries.push(value.subarray(start));
  }

  return entries;
};

const parseGitlinkPaths = (output: Buffer): string[] => {
  const paths: string[] = [];

  for (const record of splitNulBuffer(output)) {
    const text = record.toString("utf8");
    const separator = text.indexOf("\t");

    if (separator < 0 || !text.startsWith("160000 ")) {
      continue;
    }

    paths.push(text.slice(separator + 1));
  }

  return paths;
};

const refreshGitlinks = async (
  state: RepositoryCaptureState,
  gitlinkPaths: readonly string[],
): Promise<void> => {
  const updates = (
    await mapWithConcurrencyLimit(
      gitlinkPaths,
      GITLINK_HEAD_CONCURRENCY,
      async (gitPath): Promise<string | undefined> => {
        const absolutePath = resolve(state.repository.root, gitPath);

        if (
          !isPathWithin(state.repository.captureRoot, absolutePath) ||
          !existsSync(absolutePath)
        ) {
          return undefined;
        }

        try {
          const head = (
            await runGitText(["rev-parse", "--verify", "HEAD"], {
              cwd: absolutePath,
            })
          ).trim();
          return head ? `160000 ${head}\t${gitPath}\0` : undefined;
        } catch {
          return undefined;
        }
      },
    )
  ).filter((update): update is string => update !== undefined);

  if (updates.length > 0) {
    await runGitCommand(["update-index", "-z", "--index-info"], {
      cwd: state.repository.root,
      env: state.environment,
      input: Buffer.from(updates.join(""), "utf8"),
    });
  }
};

const captureTreeOnce = async (
  state: RepositoryCaptureState,
): Promise<string> => {
  state.snapshotSequence += 1;
  const indexPath = join(
    state.objectDirectory,
    `snapshot-${state.snapshotSequence}.index`,
  );
  const environment = { ...state.environment, GIT_INDEX_FILE: indexPath };

  try {
    if (existsSync(state.realIndexPath)) {
      await copyFile(state.realIndexPath, indexPath);
    } else {
      await runGitCommand(["read-tree", "--empty"], {
        cwd: state.repository.root,
        env: environment,
      });
    }

    const initialGitlinks = parseGitlinkPaths(
      await runGitCommand(["ls-files", "--stage", "-z"], {
        cwd: state.repository.root,
        env: environment,
      }),
    );
    await runGitCommand(
      ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
      {
        cwd: state.repository.root,
        env: environment,
        input: Buffer.from(`${state.pathspec}\0`, "utf8"),
      },
    );
    const finalGitlinks = parseGitlinkPaths(
      await runGitCommand(["ls-files", "--stage", "-z"], {
        cwd: state.repository.root,
        env: environment,
      }),
    );
    await refreshGitlinks(
      { ...state, environment },
      Array.from(new Set([...initialGitlinks, ...finalGitlinks])),
    );

    return (
      await runGitText(["write-tree"], {
        cwd: state.repository.root,
        env: environment,
      })
    ).trim();
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
    await rm(`${indexPath}.lock`, { force: true }).catch(() => undefined);
  }
};

const captureStableTree = async (
  state: RepositoryCaptureState,
): Promise<string> => {
  let previousTree: string | undefined;

  for (let attempt = 0; attempt < SNAPSHOT_STABILITY_ATTEMPTS; attempt += 1) {
    const tree = await captureTreeOnce(state);

    if (tree === previousTree) {
      return tree;
    }

    previousTree = tree;
  }

  throw new GitCommandError(
    "The workspace kept changing while its file snapshot was captured.",
  );
};

const createEmptyTree = async (
  state: RepositoryCaptureState,
): Promise<string> => {
  state.snapshotSequence += 1;
  const indexPath = join(state.objectDirectory, `empty-${state.snapshotSequence}.index`);
  const environment = { ...state.environment, GIT_INDEX_FILE: indexPath };

  try {
    await runGitCommand(["read-tree", "--empty"], {
      cwd: state.repository.root,
      env: environment,
    });
    return (
      await runGitText(["write-tree"], {
        cwd: state.repository.root,
        env: environment,
      })
    ).trim();
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
  }
};

const createRepositoryCaptureState = async (
  repository: DiscoveredGitRepository,
  artifactRoot: string,
  repositoryIndex: number,
  captureStart: boolean,
): Promise<RepositoryCaptureState> => {
  const objectDirectory = join(
    artifactRoot,
    `repository-${repositoryIndex}`,
    "objects",
  );
  await mkdir(objectDirectory, { recursive: true });
  const [realIndexOutput, realObjectOutput] = await Promise.all([
    runGitText(["rev-parse", "--git-path", "index"], { cwd: repository.root }),
    runGitText(["rev-parse", "--git-path", "objects"], { cwd: repository.root }),
  ]);
  const realObjectDirectory = resolveGitPath(repository.root, realObjectOutput);
  const alternateSeparator = process.platform === "win32" ? ";" : ":";
  const inheritedAlternates = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  const environment: NodeJS.ProcessEnv = {
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [realObjectDirectory, inheritedAlternates]
      .filter((entry): entry is string => Boolean(entry))
      .join(alternateSeparator),
  };
  const state: RepositoryCaptureState = {
    repository,
    objectDirectory,
    realIndexPath: resolveGitPath(repository.root, realIndexOutput),
    environment,
    pathspec: createRepositoryPathspec(repository),
    startTree: "",
    snapshotSequence: 0,
  };
  state.startTree = captureStart
    ? await captureStableTree(state)
    : await createEmptyTree(state);
  return state;
};

const createGitPathKey = (
  oldGitPath: string | undefined,
  gitPath: string,
): string => {
  return `${oldGitPath ?? ""}\0${gitPath}`;
};

const parseNumstatValue = (value: string): number | "binary" => {
  if (value === "-") {
    return "binary";
  }

  return parseGitInteger(value);
};

const parseRawDiffAndNumstat = (
  output: Buffer,
): { entries: RawDiffEntry[]; analyses: GitPathLineAnalysis[] } => {
  const tokens = splitNulBuffer(output);
  const entries: RawDiffEntry[] = [];
  const analyses: GitPathLineAnalysis[] = [];
  let index = 0;

  while (index < tokens.length) {
    const header = tokens[index]?.toString("utf8");
    if (!header?.startsWith(":")) {
      break;
    }
    index += 1;

    const match =
      /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/u.exec(
        header,
      );

    if (!match) {
      throw new Error(`Unexpected Git raw diff record: ${header}`);
    }

    const firstPath = tokens[index]?.toString("utf8");
    index += 1;

    if (!firstPath) {
      throw new Error("Git raw diff record did not contain a path.");
    }

    const status = match[5] ?? "M";
    const hasTwoPaths = status === "R" || status === "C";
    const secondPath = hasTwoPaths ? tokens[index]?.toString("utf8") : undefined;

    if (hasTwoPaths) {
      index += 1;
    }

    if (hasTwoPaths && !secondPath) {
      throw new Error("Git rename record did not contain its destination path.");
    }

    entries.push({
      oldMode: match[1] ?? "000000",
      newMode: match[2] ?? "000000",
      oldObjectId: match[3] ?? "",
      newObjectId: match[4] ?? "",
      status,
      ...(hasTwoPaths ? { oldGitPath: firstPath } : {}),
      gitPath: secondPath ?? firstPath,
    });
  }

  while (index < tokens.length) {
    const record = tokens[index]?.toString("utf8");
    index += 1;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(record ?? "");
    if (!match) {
      throw new Error(`Unexpected Git numstat record: ${record ?? ""}`);
    }

    const additions = parseNumstatValue(match[1] ?? "0");
    const deletions = parseNumstatValue(match[2] ?? "0");
    if ((additions === "binary") !== (deletions === "binary")) {
      throw new Error("Git returned inconsistent binary line statistics.");
    }
    const inlinePath = match[3] ?? "";
    const oldGitPath = inlinePath
      ? undefined
      : tokens[index]?.toString("utf8");
    const gitPath = inlinePath
      ? inlinePath
      : tokens[index + 1]?.toString("utf8");

    if (!inlinePath) {
      index += 2;
    }

    if (!gitPath || (!inlinePath && !oldGitPath)) {
      throw new Error("Git numstat rename record did not contain both paths.");
    }

    analyses.push({
      ...(oldGitPath ? { oldGitPath } : {}),
      gitPath,
      additions,
      deletions,
      ranges: [],
    });
  }

  if (entries.length !== analyses.length) {
    throw new Error("Git raw and numstat outputs contained different path counts.");
  }

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    const analysis = analyses[entryIndex];
    if (
      !entry ||
      !analysis ||
      createGitPathKey(entry.oldGitPath, entry.gitPath) !==
        createGitPathKey(analysis.oldGitPath, analysis.gitPath)
    ) {
      throw new Error("Git raw and numstat path ordering did not match.");
    }
  }

  return { entries, analyses };
};

const mapOperation = (entry: RawDiffEntry): TaskExecutionFileChangeOperation => {
  if (entry.status === "A") {
    return "added";
  }

  if (entry.status === "D") {
    return "deleted";
  }

  if (entry.status === "R") {
    return "renamed";
  }

  if (entry.status === "T") {
    return "type-changed";
  }

  return "modified";
};

const normalizeWorkspacePath = (
  gitPath: string,
  repository: DiscoveredGitRepository,
  workspaceRoot: string,
): string => {
  const absolutePath = resolve(repository.root, gitPath);
  return relative(workspaceRoot, absolutePath).replace(/\\/gu, "/");
};

const getPresentObjectId = (value: string): string | undefined => {
  return ZERO_OBJECT_PATTERN.test(value) ? undefined : value;
};

const analyzeRegularFile = (
  entry: RawDiffEntry,
  analysis: GitPathLineAnalysis | undefined,
  repositoryAnalysisFailure: string | undefined,
): Pick<
  TaskExecutionFileChange,
  "entryType" | "lineAnalysis" | "ranges" | "hunkCount"
> => {
  if (
    entry.oldObjectId === entry.newObjectId &&
    entry.oldMode !== entry.newMode
  ) {
    return {
      entryType: "mode",
      lineAnalysis: { state: "not-applicable", reason: "mode-only" },
      hunkCount: 0,
    };
  }

  if (entry.oldObjectId === entry.newObjectId) {
    return {
      entryType: "text",
      lineAnalysis: { state: "complete", additions: 0, deletions: 0 },
      hunkCount: 0,
    };
  }

  if (analysis?.additions === "binary" || analysis?.deletions === "binary") {
    return {
      entryType: "binary",
      lineAnalysis: { state: "not-applicable", reason: "binary" },
      hunkCount: 0,
    };
  }

  if (repositoryAnalysisFailure || !analysis) {
    return {
      entryType: "text",
      lineAnalysis: {
        state: "failed",
        code: "git-failed",
        message:
          repositoryAnalysisFailure ??
          "Git did not return line statistics for this path.",
      },
      hunkCount: 0,
    };
  }

  const { additions, deletions, ranges } = analysis;
  if ((additions > 0 || deletions > 0) && ranges.length === 0) {
    return {
      entryType: "text",
      lineAnalysis: {
        state: "failed",
        code: "git-failed",
        message: "Git returned line statistics without changed-line coordinates.",
      },
      hunkCount: 0,
    };
  }

  return {
    entryType: "text",
    lineAnalysis: { state: "complete", additions, deletions },
    ...(ranges.length > 0 ? { ranges } : {}),
    hunkCount: ranges.length,
  };
};

const analyzeDiffEntry = (
  state: RepositoryCaptureState,
  entry: RawDiffEntry,
  analysis: GitPathLineAnalysis | undefined,
  repositoryAnalysisFailure: string | undefined,
  workspaceRoot: string,
): TaskExecutionFileChange => {
  const path = normalizeWorkspacePath(
    entry.gitPath,
    state.repository,
    workspaceRoot,
  );
  const oldPath = entry.oldGitPath
    ? normalizeWorkspacePath(entry.oldGitPath, state.repository, workspaceRoot)
    : undefined;
  const base = {
    path,
    ...(oldPath && oldPath !== path ? { oldPath } : {}),
    operation: mapOperation(entry),
    ...(state.repository.workspacePath !== "." ||
    state.repository.source === "nested"
      ? { repositoryPath: state.repository.workspacePath }
      : {}),
    oldMode: entry.oldMode,
    newMode: entry.newMode,
    ...(getPresentObjectId(entry.oldObjectId)
      ? { oldObjectId: entry.oldObjectId }
      : {}),
    ...(getPresentObjectId(entry.newObjectId)
      ? { newObjectId: entry.newObjectId }
      : {}),
  } satisfies Omit<
    TaskExecutionFileChange,
    "entryType" | "lineAnalysis" | "ranges" | "hunkCount"
  >;

  if (entry.oldMode === "160000" || entry.newMode === "160000") {
    return {
      ...base,
      entryType: "gitlink",
      lineAnalysis: { state: "not-applicable", reason: "gitlink" },
      ...(getPresentObjectId(entry.oldObjectId)
        ? { oldCommit: entry.oldObjectId }
        : {}),
      ...(getPresentObjectId(entry.newObjectId)
        ? { newCommit: entry.newObjectId }
        : {}),
      hunkCount: 0,
    };
  }

  if (entry.oldMode === "120000" || entry.newMode === "120000") {
    return {
      ...base,
      entryType: "symlink",
      lineAnalysis: { state: "not-applicable", reason: "symlink" },
      hunkCount: 0,
    };
  }

  return {
    ...base,
    ...analyzeRegularFile(entry, analysis, repositoryAnalysisFailure),
  };
};

const createTreeDiffArguments = (
  state: RepositoryCaptureState,
  finishTree: string,
  outputArguments: readonly string[],
): string[] => {
  return [
    "diff-tree",
    "--no-commit-id",
    "-r",
    ...outputArguments,
    "--full-index",
    "-M50%",
    "-l0",
    "--diff-algorithm=histogram",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    state.startTree,
    finishTree,
    "--",
    state.pathspec,
  ];
};

const analyzeRepository = async (
  state: RepositoryCaptureState,
  finishTree: string,
  workspaceRoot: string,
): Promise<RepositoryAnalysisResult> => {
  let entries: RawDiffEntry[];
  let analyses: GitPathLineAnalysis[];

  try {
    const rawDiff = await runGitCommand(
      createTreeDiffArguments(state, finishTree, [
        "--raw",
        "--numstat",
        "-z",
      ]),
      { cwd: state.repository.root, env: state.environment },
    );
    ({ entries, analyses } = parseRawDiffAndNumstat(rawDiff));
  } catch (error) {
    return {
      files: [],
      issues: [
        {
          stage: "renameAnalysis",
          code: "git-diff-failed",
          message: error instanceof Error ? error.message : String(error),
          repositoryPath: state.repository.workspacePath,
        },
      ],
    };
  }

  if (entries.length === 0) {
    return { files: [], issues: [] };
  }

  let repositoryAnalysisFailure: string | undefined;
  try {
    await runGitPatchRangeAnalysis(
      createTreeDiffArguments(state, finishTree, ["--patch", "--unified=0"]),
      { cwd: state.repository.root, env: state.environment },
      analyses,
    );
  } catch (error) {
    repositoryAnalysisFailure =
      error instanceof Error ? error.message : String(error);
  }

  const files = entries.map((entry, index) =>
    analyzeDiffEntry(
      state,
      entry,
      analyses[index],
      repositoryAnalysisFailure,
      workspaceRoot,
    ),
  );

  return { files, issues: [] };
};

const createStage = (
  issuesByStage: ReadonlyMap<
    TaskExecutionFileChangeIssue["stage"],
    TaskExecutionFileChangeIssue
  >,
  stage: TaskExecutionFileChangeIssue["stage"],
): TaskExecutionFileChangeCompleteness[typeof stage] => {
  const issue = issuesByStage.get(stage);

  return issue
    ? { state: "failed", code: issue.code, message: issue.message }
    : { state: "complete" };
};

const createResult = (
  files: readonly TaskExecutionFileChange[],
  repositoryCount: number,
  issues: readonly TaskExecutionFileChangeIssue[],
): TaskExecutionFileChanges | undefined => {
  if (files.length === 0 && issues.length === 0) {
    return undefined;
  }

  const orderedFiles = [...files].sort(
    (left, right) =>
      (left.repositoryPath ?? ".").localeCompare(right.repositoryPath ?? ".") ||
      left.path.localeCompare(right.path),
  );
  const allIssues = [...issues];
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  let gitlinkFiles = 0;
  let symlinkFiles = 0;
  let modeOnlyFiles = 0;
  let failedFiles = 0;
  const lineIssueKeys = new Set<string>();

  for (const file of orderedFiles) {
    if (file.lineAnalysis.state === "complete") {
      additions += file.lineAnalysis.additions;
      deletions += file.lineAnalysis.deletions;
    } else if (file.lineAnalysis.state === "failed") {
      failedFiles += 1;
      const repositoryPath = file.repositoryPath ?? ".";
      const issueKey = [
        repositoryPath,
        file.lineAnalysis.code,
        file.lineAnalysis.message,
      ].join("\0");
      if (!lineIssueKeys.has(issueKey)) {
        lineIssueKeys.add(issueKey);
        allIssues.push({
          stage: "lineAnalysis",
          code: file.lineAnalysis.code,
          message: file.lineAnalysis.message,
          ...(file.repositoryPath
            ? { repositoryPath: file.repositoryPath }
            : {}),
        });
      }
    }

    if (file.entryType === "binary") {
      binaryFiles += 1;
    } else if (file.entryType === "gitlink") {
      gitlinkFiles += 1;
    } else if (file.entryType === "symlink") {
      symlinkFiles += 1;
    } else if (file.entryType === "mode") {
      modeOnlyFiles += 1;
    }
  }
  const issuesByStage = new Map<
    TaskExecutionFileChangeIssue["stage"],
    TaskExecutionFileChangeIssue
  >();

  for (const issue of allIssues) {
    if (!issuesByStage.has(issue.stage)) {
      issuesByStage.set(issue.stage, issue);
    }
  }

  const completeness: TaskExecutionFileChangeCompleteness = {
    discovery: createStage(issuesByStage, "discovery"),
    startSnapshots: createStage(issuesByStage, "startSnapshots"),
    finishSnapshots: createStage(issuesByStage, "finishSnapshots"),
    renameAnalysis: createStage(issuesByStage, "renameAnalysis"),
    lineAnalysis: createStage(issuesByStage, "lineAnalysis"),
    persistence: createStage(issuesByStage, "persistence"),
  };

  return {
    files: orderedFiles,
    totalFiles: orderedFiles.length,
    additions,
    deletions,
    binaryFiles,
    gitlinkFiles,
    symlinkFiles,
    modeOnlyFiles,
    failedFiles,
    status:
      allIssues.length === 0
        ? "complete"
        : orderedFiles.length > 0
          ? "partial"
          : "failed",
    completeness,
    attribution: "workspace-observed",
    repositoryCount,
    issues: allIssues,
  };
};

const finishCapture = async (
  workspaceRoot: string,
  artifactRoot: string,
  startStates: readonly RepositoryCaptureState[],
  startIssues: readonly TaskExecutionFileChangeIssue[],
): Promise<TaskExecutionFileChanges | undefined> => {
  const issues = [...startIssues];
  const finishDiscovery = await discoverWorkspaceGitRepositories(workspaceRoot);

  for (const issue of finishDiscovery.issues) {
    issues.push({
      stage: "discovery",
      code: "repository-discovery-failed",
      message: issue,
    });
  }

  const startRoots = new Set(
    startStates.map((state) => getPathKey(state.repository.root)),
  );
  const states = [...startStates];
  const newRepositories = finishDiscovery.repositories.filter(
    (repository) => !startRoots.has(getPathKey(repository.root)),
  );
  const newRepositoryOutcomes = await mapWithConcurrencyLimit(
    newRepositories,
    REPOSITORY_START_CONCURRENCY,
    async (repository, index) => {
      try {
        return {
          state: await createRepositoryCaptureState(
            repository,
            artifactRoot,
            startStates.length + index,
            false,
          ),
        };
      } catch (error) {
        return {
          issue: {
            stage: "finishSnapshots" as const,
            code: "new-repository-snapshot-failed",
            message: error instanceof Error ? error.message : String(error),
            repositoryPath: repository.workspacePath,
          },
        };
      }
    },
  );

  for (const outcome of newRepositoryOutcomes) {
    if (outcome.state) {
      states.push(outcome.state);
    } else if (outcome.issue) {
      issues.push(outcome.issue);
    }
  }

  const outcomes = await mapWithConcurrencyLimit(
    states,
    REPOSITORY_FINISH_CONCURRENCY,
    async (state): Promise<RepositoryAnalysisResult> => {
      try {
        const finishTree = await captureStableTree(state);
        return await analyzeRepository(state, finishTree, workspaceRoot);
      } catch (error) {
        return {
          files: [],
          issues: [
            {
              stage: "finishSnapshots",
              code:
                error instanceof GitCommandError &&
                error.message.includes("kept changing")
                  ? "snapshot-unstable"
                  : "snapshot-failed",
              message: error instanceof Error ? error.message : String(error),
              repositoryPath: state.repository.workspacePath,
            },
          ],
        };
      }
    },
  );
  const files = outcomes.flatMap((outcome) => outcome.files);

  for (const outcome of outcomes) {
    issues.push(...outcome.issues);
  }

  return createResult(files, states.length, issues);
};

const createFailedCapture = (
  issue: TaskExecutionFileChangeIssue,
): TaskFileChangeCapture => {
  const result = createResult([], 0, [issue]);
  const finishPromise = Promise.resolve(result);

  return {
    dispose: async () => undefined,
    finish: () => finishPromise,
  };
};

export const startTaskFileChangeCapture = async (
  workspaceRoot: string,
): Promise<TaskFileChangeCapture | undefined> => {
  let discovery: Awaited<ReturnType<typeof discoverWorkspaceGitRepositories>>;

  try {
    discovery = await discoverWorkspaceGitRepositories(workspaceRoot);
  } catch (error) {
    return createFailedCapture({
      stage: "discovery",
      code: "repository-discovery-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  let artifactRoot: string;

  try {
    artifactRoot = await mkdtemp(join(tmpdir(), "machdoch-file-changes-"));
  } catch (error) {
    return createFailedCapture({
      stage: "startSnapshots",
      code: "capture-initialization-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const issues: TaskExecutionFileChangeIssue[] = discovery.issues.map(
    (message) => ({
      stage: "discovery",
      code: "repository-discovery-failed",
      message,
    }),
  );
  const states = (
    await mapWithConcurrencyLimit(
      discovery.repositories,
      REPOSITORY_START_CONCURRENCY,
      async (repository, index): Promise<RepositoryCaptureState | undefined> => {
        try {
          return await createRepositoryCaptureState(
            repository,
            artifactRoot,
            index,
            true,
          );
        } catch (error) {
          issues.push({
            stage: "startSnapshots",
            code:
              error instanceof GitCommandError &&
              error.message.includes("kept changing")
                ? "snapshot-unstable"
                : "snapshot-failed",
            message: error instanceof Error ? error.message : String(error),
            repositoryPath: repository.workspacePath,
          });
          return undefined;
        }
      },
    )
  ).filter((state): state is RepositoryCaptureState => state !== undefined);
  let finishPromise: Promise<TaskExecutionFileChanges | undefined> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let disposed = false;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= rm(artifactRoot, { force: true, recursive: true }).catch(
      () => undefined,
    );
    return cleanupPromise;
  };

  return {
    dispose: async () => {
      disposed = true;
      if (finishPromise) {
        await finishPromise.catch(() => undefined);
        return;
      }

      await cleanup();
    },
    finish: () => {
      if (disposed) {
        return Promise.resolve(undefined);
      }

      finishPromise ??= finishCapture(
        discovery.workspaceRoot,
        artifactRoot,
        states,
        issues,
      )
        .catch((error) =>
          createResult([], states.length, [
            ...issues,
            {
              stage: "finishSnapshots",
              code: "capture-finalization-failed",
              message: error instanceof Error ? error.message : String(error),
            },
          ]),
        )
        .finally(cleanup);
      return finishPromise;
    },
  };
};
