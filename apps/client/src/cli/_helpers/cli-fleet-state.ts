import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getUserConfigPath } from "../../core/env.js";
import { withCooperativeFileLock } from "../../core/_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "../../core/_helpers/write-file-atomically.helper.js";
import type {
  ModelProvider,
  ReasoningMode,
  RunMode,
} from "../../core/runtime-contract.generated.js";
import {
  REASONING_MODES,
  RUN_MODES,
  isModelProvider,
} from "../../core/runtime-contract.generated.js";

export const FLEET_CLI_STATE_SCHEMA_VERSION = 1;

export interface FleetCliMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  createdAt: number;
  taskId?: string;
}

export interface FleetCliPendingTask {
  taskId: string;
  prompt: string;
  startedAt: number;
}

export interface FleetCliSession {
  id: string;
  title: string;
  workspace: string;
  provider: ModelProvider;
  model: string;
  mode: RunMode;
  reasoning: ReasoningMode;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  pinnedAt?: number;
  tags: string[];
  draft: string;
  promptHistory: string[];
  sessionMemoryEnabled: boolean;
  globalMemoryEnabled: boolean;
  messages: FleetCliMessage[];
  pendingTask?: FleetCliPendingTask;
}

export interface FleetCliCommandRecord {
  commandId: string;
  digest: string;
  kind: string;
  createdAt: number;
  taskId?: string;
  sessionId?: string;
  promptPreview?: string;
  title?: string;
  targetPreview?: string;
}

export interface FleetCliState {
  schemaVersion: typeof FLEET_CLI_STATE_SCHEMA_VERSION;
  workspaceRoot: string;
  activeSessionId: string;
  sessions: FleetCliSession[];
  commands: FleetCliCommandRecord[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
};

const finiteTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const boundedString = (
  value: unknown,
  maximum: number,
  allowEmpty = false,
): value is string =>
  typeof value === "string" &&
  value.length <= maximum &&
  (allowEmpty || value.trim().length > 0) &&
  !value.includes("\0");

const parseMessage = (value: unknown): FleetCliMessage => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "role", "content", "createdAt"], ["taskId"]) ||
    !boundedString(value.id, 240) ||
    (value.role !== "user" && value.role !== "agent") ||
    !boundedString(value.content, 12_000, true) ||
    !finiteTimestamp(value.createdAt) ||
    (value.taskId !== undefined && !boundedString(value.taskId, 240))
  ) {
    throw new Error("Fleet CLI session message is invalid.");
  }
  return {
    id: value.id,
    role: value.role,
    content: value.content,
    createdAt: value.createdAt,
    ...(value.taskId ? { taskId: value.taskId } : {}),
  };
};

const parsePendingTask = (value: unknown): FleetCliPendingTask => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["taskId", "prompt", "startedAt"]) ||
    !boundedString(value.taskId, 240) ||
    !boundedString(value.prompt, 8_000) ||
    !finiteTimestamp(value.startedAt)
  ) {
    throw new Error("Fleet CLI pending task is invalid.");
  }
  return {
    taskId: value.taskId,
    prompt: value.prompt,
    startedAt: value.startedAt,
  };
};

const modes = new Set<unknown>(RUN_MODES);
const reasoningModes = new Set<unknown>(REASONING_MODES);

const parseStringArray = (
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): string[] => {
  if (
    !Array.isArray(value) ||
    value.length > maximumItems ||
    !value.every((entry) => boundedString(entry, maximumLength))
  ) {
    throw new Error("Fleet CLI session list is invalid.");
  }
  return [...value] as string[];
};

const parseSession = (value: unknown): FleetCliSession => {
  const required = [
    "id",
    "title",
    "workspace",
    "provider",
    "model",
    "mode",
    "reasoning",
    "createdAt",
    "updatedAt",
    "tags",
    "draft",
    "promptHistory",
    "sessionMemoryEnabled",
    "globalMemoryEnabled",
    "messages",
  ] as const;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, required, ["archivedAt", "pinnedAt", "pendingTask"]) ||
    !boundedString(value.id, 240) ||
    !boundedString(value.title, 12_000) ||
    !boundedString(value.workspace, 12_000) ||
    !boundedString(value.provider, 240) ||
    !isModelProvider(value.provider) ||
    !boundedString(value.model, 240) ||
    !modes.has(value.mode) ||
    !reasoningModes.has(value.reasoning) ||
    !finiteTimestamp(value.createdAt) ||
    !finiteTimestamp(value.updatedAt) ||
    (value.archivedAt !== undefined && !finiteTimestamp(value.archivedAt)) ||
    (value.pinnedAt !== undefined && !finiteTimestamp(value.pinnedAt)) ||
    typeof value.sessionMemoryEnabled !== "boolean" ||
    typeof value.globalMemoryEnabled !== "boolean" ||
    !boundedString(value.draft, 8_000, true) ||
    !Array.isArray(value.messages) ||
    value.messages.length > 200
  ) {
    throw new Error("Fleet CLI session is invalid.");
  }
  const pendingTask =
    value.pendingTask === undefined
      ? undefined
      : parsePendingTask(value.pendingTask);
  return {
    id: value.id,
    title: value.title,
    workspace: value.workspace,
    provider: value.provider,
    model: value.model,
    mode: value.mode as RunMode,
    reasoning: value.reasoning as ReasoningMode,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.archivedAt !== undefined ? { archivedAt: value.archivedAt } : {}),
    ...(value.pinnedAt !== undefined ? { pinnedAt: value.pinnedAt } : {}),
    tags: parseStringArray(value.tags, 24, 64),
    draft: value.draft,
    promptHistory: parseStringArray(value.promptHistory, 30, 8_000),
    sessionMemoryEnabled: value.sessionMemoryEnabled,
    globalMemoryEnabled: value.globalMemoryEnabled,
    messages: value.messages.map(parseMessage),
    ...(pendingTask ? { pendingTask } : {}),
  };
};

const parseCommand = (value: unknown): FleetCliCommandRecord => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(
      value,
      ["commandId", "digest", "kind", "createdAt"],
      ["taskId", "sessionId", "promptPreview", "title", "targetPreview"],
    ) ||
    !boundedString(value.commandId, 240) ||
    !/^[a-f0-9]{64}$/u.test(
      typeof value.digest === "string" ? value.digest : "",
    ) ||
    !boundedString(value.kind, 64) ||
    !finiteTimestamp(value.createdAt)
  ) {
    throw new Error("Fleet CLI command record is invalid.");
  }
  for (const key of [
    "taskId",
    "sessionId",
    "promptPreview",
    "title",
    "targetPreview",
  ] as const) {
    if (value[key] !== undefined && !boundedString(value[key], 240, true)) {
      throw new Error("Fleet CLI command record is invalid.");
    }
  }
  return {
    commandId: value.commandId,
    digest: value.digest as string,
    kind: value.kind,
    createdAt: value.createdAt,
    ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
    ...(typeof value.sessionId === "string"
      ? { sessionId: value.sessionId }
      : {}),
    ...(typeof value.promptPreview === "string"
      ? { promptPreview: value.promptPreview }
      : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.targetPreview === "string"
      ? { targetPreview: value.targetPreview }
      : {}),
  };
};

const parseState = (value: unknown, workspaceRoot: string): FleetCliState => {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "schemaVersion",
      "workspaceRoot",
      "activeSessionId",
      "sessions",
      "commands",
    ]) ||
    value.schemaVersion !== FLEET_CLI_STATE_SCHEMA_VERSION ||
    value.workspaceRoot !== workspaceRoot ||
    !boundedString(value.activeSessionId, 240) ||
    !Array.isArray(value.sessions) ||
    value.sessions.length === 0 ||
    value.sessions.length > 80 ||
    !Array.isArray(value.commands) ||
    value.commands.length > 100
  ) {
    throw new Error("Fleet CLI state is invalid.");
  }
  const sessions = value.sessions.map(parseSession);
  if (
    new Set(sessions.map((session) => session.id)).size !== sessions.length ||
    !sessions.some((session) => session.id === value.activeSessionId) ||
    sessions.some((session) => session.workspace !== workspaceRoot)
  ) {
    throw new Error("Fleet CLI state is invalid.");
  }
  const commands = value.commands.map(parseCommand);
  if (
    new Set(commands.map((command) => command.commandId)).size !==
    commands.length
  ) {
    throw new Error("Fleet CLI state is invalid.");
  }
  return {
    schemaVersion: FLEET_CLI_STATE_SCHEMA_VERSION,
    workspaceRoot,
    activeSessionId: value.activeSessionId,
    sessions,
    commands,
  };
};

export const getFleetCliStatePath = (workspaceRoot: string): string => {
  const workspaceId = createHash("sha256")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 24);
  return join(
    dirname(getUserConfigPath()),
    `fleet-cli-state-${workspaceId}.json`,
  );
};

export const loadFleetCliState = async (
  workspaceRoot: string,
): Promise<FleetCliState | null> => {
  const path = getFleetCliStatePath(workspaceRoot);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
  try {
    return parseState(JSON.parse(raw), workspaceRoot);
  } catch (error) {
    throw new Error(
      `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
};

export const saveFleetCliState = async (
  state: FleetCliState,
): Promise<string> => {
  const path = getFleetCliStatePath(state.workspaceRoot);
  const validated = parseState(state, state.workspaceRoot);
  await withCooperativeFileLock(
    path,
    async () => {
      await mkdir(dirname(path), { recursive: true });
      if (process.platform !== "win32") await chmod(dirname(path), 0o700);
      await writeJsonAtomically(path, validated, { mode: 0o600 });
    },
    { ownerDescription: "Fleet CLI session state" },
  );
  return path;
};
