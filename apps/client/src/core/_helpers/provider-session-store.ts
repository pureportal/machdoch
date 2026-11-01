import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getUserConfigPath } from "../env.js";
import type { AgentCliProvider } from "../runtime-contract.generated.js";
import type { ConversationHistoryEntry } from "../types.js";
import {
  CooperativeFileLockTimeoutError,
  withCooperativeFileLock,
} from "./with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "./write-file-atomically.helper.js";

const TRANSCRIPTS_DIRECTORY = "transcripts";
const BINDING_FILE = "binding.json";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** One finished exchange: the user message and the reply it got. */
const MAX_NEW_ENTRIES_SINCE_LAST_RUN = 2;

export interface ProviderSessionTarget {
  chatSessionId: string;
  workspaceRoot: string;
}

/** Which provider conversation holds a chat, and what it has already seen. */
export interface ProviderSessionBinding {
  provider: AgentCliProvider;
  sessionId: string;
  instructionDigest: string;
  historyLength: number;
  historyDigest: string;
  updatedAt: number;
}

export interface ProviderSessionPlan {
  storePath: string;
  /** The provider conversation to continue; a new one starts without it. */
  resumeId?: string;
  newSessionId: string;
  save(sessionId: string): Promise<void>;
  clear(): Promise<void>;
}

const getSessionsRoot = (): string =>
  join(dirname(getUserConfigPath()), "provider-sessions");

const getSessionDirectory = ({
  chatSessionId,
  workspaceRoot,
}: ProviderSessionTarget): string =>
  join(
    getSessionsRoot(),
    createHash("sha256")
      .update(JSON.stringify([resolve(workspaceRoot), chatSessionId]))
      .digest("hex"),
  );

const visibleHistory = (
  history: readonly ConversationHistoryEntry[],
): ConversationHistoryEntry[] =>
  history.filter((entry) => entry.content.trim().length > 0);

const digestHistory = (history: readonly ConversationHistoryEntry[]): string =>
  createHash("sha256")
    .update(JSON.stringify(history.map((entry) => [entry.role, entry.content])))
    .digest("hex");

const readBinding = async (
  directory: string,
): Promise<ProviderSessionBinding | undefined> => {
  try {
    const value = JSON.parse(
      await readFile(join(directory, BINDING_FILE), "utf8"),
    ) as Partial<ProviderSessionBinding>;
    return typeof value.provider === "string" &&
      typeof value.sessionId === "string" &&
      value.sessionId.length > 0 &&
      typeof value.instructionDigest === "string" &&
      typeof value.historyDigest === "string" &&
      typeof value.historyLength === "number"
      ? (value as ProviderSessionBinding)
      : undefined;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    )
      return undefined;
    throw error;
  }
};

/**
 * A stored conversation only continues a chat when it saw everything before
 * this message. Another provider's turn, an edited or retried message, or a
 * changed instruction set means it did not, so the chat starts a new one and
 * gets its history in the prompt.
 */
const isHistoryAligned = (
  binding: ProviderSessionBinding,
  history: readonly ConversationHistoryEntry[],
): boolean => {
  const newEntries = history.length - binding.historyLength;
  return (
    newEntries >= 1 &&
    newEntries <= MAX_NEW_ENTRIES_SINCE_LAST_RUN &&
    digestHistory(history.slice(0, binding.historyLength)) ===
      binding.historyDigest
  );
};

/** Whether the next run will probably not need the chat history in its prompt. */
export const hasAlignedProviderSession = async (
  target: ProviderSessionTarget,
  provider: AgentCliProvider,
  rawHistory: readonly ConversationHistoryEntry[],
): Promise<boolean> => {
  const binding = await readBinding(getSessionDirectory(target));
  return (
    binding?.provider === provider &&
    isHistoryAligned(binding, visibleHistory(rawHistory))
  );
};

export const planProviderSessionRun = async (
  target: ProviderSessionTarget,
  {
    provider,
    instructionDigest,
    history: rawHistory,
    continuing,
  }: {
    provider: AgentCliProvider;
    instructionDigest: string;
    history: readonly ConversationHistoryEntry[];
    /** A later turn of one run, whose history the session already has. */
    continuing: boolean;
  },
): Promise<ProviderSessionPlan> => {
  const directory = getSessionDirectory(target);
  const storePath = join(directory, TRANSCRIPTS_DIRECTORY);
  const history = visibleHistory(rawHistory);
  const binding = await readBinding(directory);
  const resumeId =
    binding?.provider === provider &&
    binding.instructionDigest === instructionDigest &&
    (continuing || isHistoryAligned(binding, history))
      ? binding.sessionId
      : undefined;
  if (!resumeId) await rm(storePath, { recursive: true, force: true });
  await mkdir(storePath, { recursive: true, mode: 0o700 });
  const historyLength =
    resumeId && continuing ? binding!.historyLength : history.length;
  const historyDigest =
    resumeId && continuing ? binding!.historyDigest : digestHistory(history);
  return {
    storePath,
    ...(resumeId ? { resumeId } : {}),
    newSessionId: randomUUID(),
    save: async (sessionId) => {
      await writeJsonAtomically(
        join(directory, BINDING_FILE),
        {
          provider,
          sessionId,
          instructionDigest,
          historyLength,
          historyDigest,
          updatedAt: Date.now(),
        } satisfies ProviderSessionBinding,
        { mode: 0o600 },
      );
    },
    clear: async () => {
      await rm(join(directory, BINDING_FILE), { force: true });
    },
  };
};

/**
 * Runs `operation` as the only provider session of this chat. A second run at
 * the same time would fork the conversation, so it goes without one instead.
 */
export const withProviderSessionLock = async <Result>(
  target: ProviderSessionTarget,
  operation: () => Promise<Result>,
  whenBusy: () => Promise<Result>,
  signal?: AbortSignal,
): Promise<Result> => {
  const directory = getSessionDirectory(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let started = false;
  try {
    return await withCooperativeFileLock(
      join(directory, "run"),
      () => {
        started = true;
        return operation();
      },
      {
        timeoutMs: 500,
        ownerDescription: "provider session run",
        ...(signal ? { signal } : {}),
      },
    );
  } catch (error) {
    if (started || !(error instanceof CooperativeFileLockTimeoutError))
      throw error;
    return whenBusy();
  }
};

/** Removes stored conversations of chats that have not run for a while. */
export const pruneProviderSessions = async (
  now = Date.now(),
): Promise<void> => {
  const root = getSessionsRoot();
  const names = await readdir(root).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const name of names) {
    const path = join(root, name);
    const updated = await stat(join(path, BINDING_FILE))
      .catch(() => stat(path))
      .catch(() => undefined);
    if (updated && now - updated.mtimeMs > RETENTION_MS) {
      await rm(path, { recursive: true, force: true }).catch((error: unknown) =>
        console.error(`Could not remove stored session ${name}`, error),
      );
    }
  }
};
