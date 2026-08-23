import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";
import { writeJsonAtomically } from "./_helpers/write-file-atomically.helper.js";
import {
  MAX_WORKSPACE_MEMORY_ENTRIES,
  forgetConversationMemoryEntry,
  normalizeConversationMemoryEntries,
  rememberConversationMemoryEntry,
  type ConversationMemoryMetadata,
} from "./memory.js";
import type { ConversationMemoryEntry } from "./types.js";

const WORKSPACE_MEMORY_VERSION = 1;
const WORKSPACE_MEMORY_DIRECTORY = ".machdoch";
const WORKSPACE_MEMORY_FILE = "memory.json";

interface WorkspaceMemoryDocument {
  version: typeof WORKSPACE_MEMORY_VERSION;
  entries: ConversationMemoryEntry[];
}

export const getWorkspaceMemoryPath = (workspaceRoot: string): string => {
  return join(
    resolve(workspaceRoot),
    WORKSPACE_MEMORY_DIRECTORY,
    WORKSPACE_MEMORY_FILE,
  );
};

const loadWorkspaceMemoryDocument = async (
  workspaceRoot: string,
): Promise<WorkspaceMemoryDocument> => {
  const path = getWorkspaceMemoryPath(workspaceRoot);
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
      return { version: WORKSPACE_MEMORY_VERSION, entries: [] };
    }

    throw error;
  }

  const value = JSON.parse(raw) as Partial<WorkspaceMemoryDocument>;

  if (value.version !== WORKSPACE_MEMORY_VERSION) {
    throw new Error(`Unsupported workspace memory version in ${path}.`);
  }

  return {
    version: WORKSPACE_MEMORY_VERSION,
    entries: normalizeConversationMemoryEntries(value.entries, "workspace"),
  };
};

export const loadWorkspaceMemory = async (
  workspaceRoot: string,
): Promise<ConversationMemoryEntry[]> => {
  return (await loadWorkspaceMemoryDocument(workspaceRoot)).entries;
};

export const rememberWorkspaceMemory = async (
  workspaceRoot: string,
  content: string,
  metadata: ConversationMemoryMetadata = {},
): Promise<ConversationMemoryEntry> => {
  const path = getWorkspaceMemoryPath(workspaceRoot);
  let rememberedEntry: ConversationMemoryEntry | undefined;

  await withCooperativeFileLock(path, async () => {
    const document = await loadWorkspaceMemoryDocument(workspaceRoot);
    const remembered = rememberConversationMemoryEntry(
      document.entries,
      "workspace",
      content,
      MAX_WORKSPACE_MEMORY_ENTRIES,
      Date.now(),
      metadata,
    );
    rememberedEntry = remembered.entry;
    await writeJsonAtomically(path, {
      version: WORKSPACE_MEMORY_VERSION,
      entries: remembered.entries,
    } satisfies WorkspaceMemoryDocument);
  });

  if (!rememberedEntry) {
    throw new Error("The workspace memory entry could not be persisted.");
  }

  return rememberedEntry;
};

export const forgetWorkspaceMemory = async (
  workspaceRoot: string,
  id: string,
): Promise<boolean> => {
  const path = getWorkspaceMemoryPath(workspaceRoot);
  let removed = false;

  await withCooperativeFileLock(path, async () => {
    const document = await loadWorkspaceMemoryDocument(workspaceRoot);
    const entries = forgetConversationMemoryEntry(document.entries, id);
    removed = entries.length !== document.entries.length;

    if (removed) {
      await writeJsonAtomically(path, {
        version: WORKSPACE_MEMORY_VERSION,
        entries,
      } satisfies WorkspaceMemoryDocument);
    }
  });

  return removed;
};
