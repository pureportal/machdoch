import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { getUserConfigPath } from "../../core/env.js";
import { writeJsonAtomically } from "../../core/_helpers/write-file-atomically.helper.js";
import { withCooperativeFileLock } from "../../core/_helpers/with-cooperative-file-lock.helper.js";
import { normalizeConversationMemoryEntries } from "../../core/memory.js";
import {
  REASONING_MODES,
  VALID_MODEL_PROVIDERS,
  type ReasoningMode,
  type RuntimeAgentLimitOverrides,
  type RunMode,
} from "../../core/runtime-contract.generated.js";
import type { ConfiguredModelProvider } from "../../core/provider-model-registry.js";
import type { TaskConversationContext } from "../../core/types.js";
import { CliUsageError } from "./cli-error.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseConversationContext = (
  value: unknown,
): TaskConversationContext => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.history) ||
    !value.history.every(
      (entry: unknown) =>
        isRecord(entry) &&
        ["user", "assistant"].includes(String(entry.role)) &&
        typeof entry.content === "string" &&
        (entry.createdAt === undefined ||
          (typeof entry.createdAt === "number" &&
            Number.isFinite(entry.createdAt))),
    )
  )
    throw new CliUsageError(
      "Invalid conversation context: expected a history array of user and assistant messages.",
    );
  for (const key of [
    "sessionMemoryEnabled",
    "workspaceMemoryEnabled",
    "globalMemoryEnabled",
    "uiControlEnabled",
  ]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new CliUsageError(
        `Invalid conversation context: ${key} must be a boolean.`,
      );
  }
  if (value.sessionId !== undefined && typeof value.sessionId !== "string")
    throw new CliUsageError("Invalid conversation session id.");
  if (
    value.workspace !== undefined &&
    (!isRecord(value.workspace) ||
      !["selected", "not-set"].includes(String(value.workspace.selection)) ||
      (value.workspace.selection === "selected" &&
        typeof value.workspace.root !== "string"))
  )
    throw new CliUsageError("Invalid conversation workspace.");
  for (const key of ["uiControl", "workspaceRun"]) {
    if (value[key] !== undefined && !isRecord(value[key]))
      throw new CliUsageError(
        `Invalid conversation context: ${key} must be an object.`,
      );
  }
  for (const key of ["sessionMemory", "globalMemory"]) {
    if (value[key] !== undefined && !Array.isArray(value[key]))
      throw new CliUsageError(
        `Invalid conversation context: ${key} must be an array.`,
      );
  }
  return {
    ...(value as unknown as TaskConversationContext),
    ...(value.sessionMemory
      ? {
          sessionMemory: normalizeConversationMemoryEntries(
            value.sessionMemory,
            "session",
          ),
        }
      : {}),
    ...(value.globalMemory
      ? {
          globalMemory: normalizeConversationMemoryEntries(
            value.globalMemory,
            "global",
          ),
        }
      : {}),
  };
};

export interface CliChatSession {
  id: string;
  revision: number;
  workspaceRoot: string;
  updatedAt: number;
  context: TaskConversationContext;
  mode?: RunMode;
  provider?: ConfiguredModelProvider;
  model?: string;
  reasoning?: ReasoningMode;
  agentLimits?: RuntimeAgentLimitOverrides;
}

const sessionPath = (id: string): string => {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id))
    throw new CliUsageError(
      "Invalid CLI session id. Use /sessions to choose a conversation.",
    );
  return join(dirname(getUserConfigPath()), "cli-sessions", `${id}.json`);
};

export const createChatSession = (
  workspaceRoot: string,
  context: TaskConversationContext = { history: [] },
): CliChatSession => {
  const id = randomUUID();
  return {
    id,
    revision: 0,
    workspaceRoot,
    updatedAt: Date.now(),
    context: {
      ...context,
      history: [...context.history],
      sessionMemory: context.sessionMemory ?? [],
      sessionMemoryEnabled: context.sessionMemoryEnabled ?? true,
      sessionId: id,
      workspace: { selection: "selected", root: workspaceRoot },
    },
  };
};

export const saveChatSession = async (
  session: CliChatSession,
): Promise<void> => {
  const path = sessionPath(session.id);
  await withCooperativeFileLock(path, async () => {
    let revision = 0;
    try {
      const stored: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isRecord(stored) || !Number.isSafeInteger(stored.revision))
        throw new Error("The saved conversation is invalid.");
      revision = stored.revision as number;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (revision !== session.revision)
      throw new Error("The conversation changed in another terminal");
    const saved = { ...session, revision: revision + 1 };
    await writeJsonAtomically(path, saved, { mode: 0o600 });
    session.revision = saved.revision;
  });
};

export const loadChatSession = async (id: string): Promise<CliChatSession> => {
  const value: unknown = JSON.parse(await readFile(sessionPath(id), "utf8"));
  if (
    !isRecord(value) ||
    value.id !== id ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 1 ||
    typeof value.workspaceRoot !== "string" ||
    !isAbsolute(value.workspaceRoot) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    (value.mode !== undefined &&
      !["ask", "machdoch"].includes(String(value.mode))) ||
    (value.provider !== undefined &&
      !VALID_MODEL_PROVIDERS.includes(
        value.provider as ConfiguredModelProvider,
      )) ||
    (value.model !== undefined && typeof value.model !== "string") ||
    (value.reasoning !== undefined &&
      !REASONING_MODES.includes(value.reasoning as ReasoningMode))
  )
    throw new CliUsageError(`Invalid saved CLI session: ${id}.`);
  if (value.agentLimits !== undefined) {
    const limits = value.agentLimits;
    if (
      !isRecord(limits) ||
      (limits.infinite !== undefined && typeof limits.infinite !== "boolean") ||
      ["executorTurns", "autopilotExecutorIterations"].some(
        (key) =>
          limits[key] !== undefined &&
          (!Number.isSafeInteger(limits[key]) || (limits[key] as number) <= 0),
      ) ||
      (limits.infinite === true &&
        (limits.executorTurns !== undefined ||
          limits.autopilotExecutorIterations !== undefined))
    ) {
      throw new CliUsageError(`Invalid saved execution limits: ${id}.`);
    }
  }
  return {
    ...(value as unknown as CliChatSession),
    context: parseConversationContext(value.context),
  };
};

export const listChatSessions = async (): Promise<{
  sessions: CliChatSession[];
  errors: string[];
}> => {
  const directory = join(dirname(getUserConfigPath()), "cli-sessions");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { sessions: [], errors: [] };
    throw error;
  }
  const sessions: CliChatSession[] = [];
  const errors: string[] = [];
  for (const file of files.filter((file) => file.endsWith(".json"))) {
    try {
      sessions.push(await loadChatSession(file.slice(0, -5)));
    } catch (error) {
      errors.push(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    sessions: sessions.sort((left, right) => right.updatedAt - left.updatedAt),
    errors,
  };
};

export const exportChatContext = async (
  filePath: string,
  context: TaskConversationContext,
): Promise<void> => {
  try {
    await writeFile(filePath, `${JSON.stringify(context, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliUsageError(
        `File already exists: ${filePath}. Choose another filename.`,
      );
    throw error;
  }
};
