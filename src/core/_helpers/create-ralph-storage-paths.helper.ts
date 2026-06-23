import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { getUserConfigPath } from "../env.js";
import {
  FLOW_FILE_EXTENSION,
  normalizeFlowFileName,
  normalizeFlowId,
  normalizeRevisionId,
  normalizeRunId,
} from "./ralph-flow-ids.helper.js";

const RALPH_WORKSPACE_DIRECTORY = ".machdoch/ralph";
const RALPH_USER_DIRECTORY = "ralph";
const RALPH_FLOW_SUBDIRECTORY = "flows";
const RALPH_RUN_SUBDIRECTORY = "runs";
const RALPH_REVISION_SUBDIRECTORY = "revisions";
const RALPH_ARTIFACT_SUBDIRECTORY = "artifacts";
const RALPH_INSTRUCTION_SUBDIRECTORY = "instructions";

export type RalphFlowScope = "workspace" | "user";

export interface RalphRunLogPaths {
  id: string;
  directory: string;
  recordPath: string;
  simpleJsonlPath: string;
  simpleMarkdownPath: string;
  traceJsonlPath: string;
}

export const getRalphFlowDirectory = (workspaceRoot: string): string => {
  return getRalphFlowStorageDirectory(workspaceRoot, "workspace");
};

export const getUserRalphDirectory = (): string => {
  return join(dirname(getUserConfigPath()), RALPH_USER_DIRECTORY);
};

export const getRalphStorageDirectory = (
  workspaceRoot: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return scope === "user"
    ? getUserRalphDirectory()
    : join(workspaceRoot, RALPH_WORKSPACE_DIRECTORY);
};

export const getRalphFlowStorageDirectory = (
  workspaceRoot: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(getRalphStorageDirectory(workspaceRoot, scope), RALPH_FLOW_SUBDIRECTORY);
};

export const getRalphFlowInstructionDirectory = (
  workspaceRoot: string,
  flowId: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(
    getRalphStorageDirectory(workspaceRoot, scope),
    RALPH_INSTRUCTION_SUBDIRECTORY,
    normalizeFlowId(flowId),
  );
};

export const getRalphFlowAlwaysOnInstructionPath = (
  workspaceRoot: string,
  flowId: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(
    getRalphFlowInstructionDirectory(workspaceRoot, flowId, scope),
    "instructions.md",
  );
};

export const getRalphFlowConditionalInstructionDirectory = (
  workspaceRoot: string,
  flowId: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(
    getRalphFlowInstructionDirectory(workspaceRoot, flowId, scope),
    RALPH_INSTRUCTION_SUBDIRECTORY,
  );
};

export const getRalphRunDirectory = (
  workspaceRoot: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(getRalphStorageDirectory(workspaceRoot, scope), RALPH_RUN_SUBDIRECTORY);
};

export const getRalphArtifactDirectory = (workspaceRoot: string): string => {
  return join(getRalphStorageDirectory(workspaceRoot, "workspace"), RALPH_ARTIFACT_SUBDIRECTORY);
};

export const getRalphRevisionDirectory = (
  workspaceRoot: string,
  flowId: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(
    getRalphStorageDirectory(workspaceRoot, scope),
    RALPH_REVISION_SUBDIRECTORY,
    normalizeFlowId(flowId),
  );
};

export const getRalphRevisionPath = (
  workspaceRoot: string,
  flowId: string,
  revisionId: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(
    getRalphRevisionDirectory(workspaceRoot, flowId, scope),
    `${normalizeRevisionId(revisionId)}${FLOW_FILE_EXTENSION}`,
  );
};

export const getRalphFlowPath = (
  workspaceRoot: string,
  id: string,
  scope: RalphFlowScope = "workspace",
): string => {
  return join(getRalphFlowStorageDirectory(workspaceRoot, scope), normalizeFlowFileName(id));
};

export const createRalphRevisionFilePath = (
  revisionDirectory: string,
  timestamp: string,
): string => {
  const baseName = timestamp.replace(/[:.]/gu, "-");
  let candidatePath = join(revisionDirectory, `${baseName}.json`);
  let suffix = 1;

  while (existsSync(candidatePath)) {
    candidatePath = join(revisionDirectory, `${baseName}-${suffix}.json`);
    suffix += 1;
  }

  return candidatePath;
};

export const createRalphRunArtifactPaths = (
  runDirectory: string,
  timestamp: string,
  preferredId?: string,
): RalphRunLogPaths => {
  const baseName = preferredId
    ? normalizeRunId(preferredId)
    : timestamp.replace(/[:.]/gu, "-");
  let id = baseName;
  let candidateDirectory = join(runDirectory, id);
  let suffix = 1;

  while (existsSync(candidateDirectory)) {
    id = `${baseName}-${suffix}`;
    candidateDirectory = join(runDirectory, id);
    suffix += 1;
  }

  return {
    id,
    directory: candidateDirectory,
    recordPath: join(candidateDirectory, "run.json"),
    simpleJsonlPath: join(candidateDirectory, "simple.jsonl"),
    simpleMarkdownPath: join(candidateDirectory, "simple.md"),
    traceJsonlPath: join(candidateDirectory, "trace.jsonl"),
  };
};
