import { normalizeOptionalString } from "../helpers/normalize-optional-string.helper.js";
import {
  RUNTIME_MEMORY_KINDS,
  type RuntimeMemoryKind,
} from "./runtime-contract.generated.js";
import type {
  ConversationMemoryEntry,
  ConversationMemoryKind,
  ConversationMemoryScope,
} from "./types.js";

export const MAX_SESSION_MEMORY_ENTRIES = 24;
export const MAX_WORKSPACE_MEMORY_ENTRIES = 64;
export const MAX_GLOBAL_MEMORY_ENTRIES = 40;
const MAX_MEMORY_CONTENT_LENGTH = 280;
const MAX_MEMORY_KEY_LENGTH = 96;
const DEFAULT_MEMORY_IMPORTANCE = 3;
const DEFAULT_MEMORY_CONFIDENCE = 1;

export interface ConversationMemoryMetadata {
  key?: string;
  kind?: ConversationMemoryKind;
  importance?: number;
  confidence?: number;
}

const createContentKey = (content: string): string => {
  return content.replace(/\s+/gu, " ").trim().toLowerCase();
};

export const normalizeMemoryContent = (
  value: string | undefined,
): string | undefined => {
  const normalized = normalizeOptionalString(value)?.replace(/\s+/gu, " ");

  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= MAX_MEMORY_CONTENT_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_MEMORY_CONTENT_LENGTH - 1)}…`;
};

export const normalizeMemoryKey = (
  value: string | undefined,
  content: string,
): string => {
  const source = normalizeOptionalString(value) ?? content;
  const normalized = source
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return (normalized || createContentKey(content)).slice(
    0,
    MAX_MEMORY_KEY_LENGTH,
  );
};

const normalizeMemoryKind = (value: unknown): ConversationMemoryKind => {
  return typeof value === "string" &&
    (RUNTIME_MEMORY_KINDS as readonly string[]).includes(value)
    ? (value as RuntimeMemoryKind)
    : "fact";
};

const normalizeMemoryImportance = (value: unknown): number => {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(5, Math.max(1, Math.round(value)))
    : DEFAULT_MEMORY_IMPORTANCE;
};

const normalizeMemoryConfidence = (value: unknown): number => {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : DEFAULT_MEMORY_CONFIDENCE;
};

const getMaxEntriesForScope = (scope: ConversationMemoryScope): number => {
  switch (scope) {
    case "session":
      return MAX_SESSION_MEMORY_ENTRIES;
    case "workspace":
      return MAX_WORKSPACE_MEMORY_ENTRIES;
    case "global":
      return MAX_GLOBAL_MEMORY_ENTRIES;
  }
};

export const createConversationMemoryEntry = (
  scope: ConversationMemoryScope,
  content: string,
  timestamp = Date.now(),
  metadata: ConversationMemoryMetadata = {},
): ConversationMemoryEntry => {
  return {
    id: crypto.randomUUID(),
    scope,
    key: normalizeMemoryKey(metadata.key, content),
    kind: normalizeMemoryKind(metadata.kind),
    content,
    importance: normalizeMemoryImportance(metadata.importance),
    confidence: normalizeMemoryConfidence(metadata.confidence),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

export const normalizeConversationMemoryEntries = (
  entries: unknown,
  scope: ConversationMemoryScope,
): ConversationMemoryEntry[] => {
  if (!Array.isArray(entries)) {
    return [];
  }

  const normalizedEntries = entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const candidate = entry as Partial<ConversationMemoryEntry>;
    const content = normalizeMemoryContent(candidate.content);

    if (!content) {
      return [];
    }

    const createdAt =
      typeof candidate.createdAt === "number" &&
      Number.isFinite(candidate.createdAt)
        ? candidate.createdAt
        : Date.now();
    const updatedAt =
      typeof candidate.updatedAt === "number" &&
      Number.isFinite(candidate.updatedAt)
        ? candidate.updatedAt
        : createdAt;

    return [
      {
        id:
          typeof candidate.id === "string" && candidate.id.trim().length > 0
            ? candidate.id
            : crypto.randomUUID(),
        scope,
        key: normalizeMemoryKey(candidate.key, content),
        kind: normalizeMemoryKind(candidate.kind),
        content,
        importance: normalizeMemoryImportance(candidate.importance),
        confidence: normalizeMemoryConfidence(candidate.confidence),
        createdAt,
        updatedAt,
      },
    ];
  });

  return mergeConversationMemoryEntries(
    [],
    normalizedEntries,
    getMaxEntriesForScope(scope),
  );
};

export const mergeConversationMemoryEntries = (
  existingEntries: ConversationMemoryEntry[],
  incomingEntries: ConversationMemoryEntry[],
  maxEntries: number,
): ConversationMemoryEntry[] => {
  const seenKeys = new Set<string>();
  const seenContent = new Set<string>();

  return [...incomingEntries, ...existingEntries]
    .flatMap((entry) => {
      const content = normalizeMemoryContent(entry.content);

      if (!content) {
        return [];
      }

      return [
        {
          ...entry,
          key: normalizeMemoryKey(entry.key, content),
          kind: normalizeMemoryKind(entry.kind),
          content,
          importance: normalizeMemoryImportance(entry.importance),
          confidence: normalizeMemoryConfidence(entry.confidence),
        },
      ];
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .filter((entry) => {
      const scopedKey = `${entry.scope}:${entry.key}`;
      const scopedContent = `${entry.scope}:${createContentKey(entry.content)}`;

      if (seenKeys.has(scopedKey) || seenContent.has(scopedContent)) {
        return false;
      }

      seenKeys.add(scopedKey);
      seenContent.add(scopedContent);
      return true;
    })
    .slice(0, Math.max(1, maxEntries));
};

export const rememberConversationMemoryEntry = (
  existingEntries: ConversationMemoryEntry[],
  scope: ConversationMemoryScope,
  content: string,
  maxEntries = getMaxEntriesForScope(scope),
  timestamp = Date.now(),
  metadata: ConversationMemoryMetadata = {},
): {
  entry: ConversationMemoryEntry;
  entries: ConversationMemoryEntry[];
  added: boolean;
  replaced: boolean;
} => {
  const normalizedContent = normalizeMemoryContent(content);

  if (!normalizedContent) {
    throw new Error("Expected non-empty memory content.");
  }

  const memoryKey = normalizeMemoryKey(metadata.key, normalizedContent);
  const contentKey = createContentKey(normalizedContent);
  const existingEntry = existingEntries.find(
    (entry) =>
      entry.scope === scope &&
      (normalizeMemoryKey(entry.key, entry.content) === memoryKey ||
        createContentKey(entry.content) === contentKey),
  );

  if (existingEntry) {
    const refreshedEntry: ConversationMemoryEntry = {
      ...existingEntry,
      key: memoryKey,
      kind: normalizeMemoryKind(metadata.kind ?? existingEntry.kind),
      content: normalizedContent,
      importance: normalizeMemoryImportance(
        metadata.importance ?? existingEntry.importance,
      ),
      confidence: normalizeMemoryConfidence(
        metadata.confidence ?? existingEntry.confidence,
      ),
      updatedAt: timestamp,
    };

    return {
      entry: refreshedEntry,
      entries: mergeConversationMemoryEntries(
        existingEntries.filter((entry) => entry.id !== existingEntry.id),
        [refreshedEntry],
        maxEntries,
      ),
      added: false,
      replaced: createContentKey(existingEntry.content) !== contentKey,
    };
  }

  const nextEntry = createConversationMemoryEntry(
    scope,
    normalizedContent,
    timestamp,
    metadata,
  );

  return {
    entry: nextEntry,
    entries: mergeConversationMemoryEntries(
      existingEntries,
      [nextEntry],
      maxEntries,
    ),
    added: true,
    replaced: false,
  };
};

export const forgetConversationMemoryEntry = (
  existingEntries: ConversationMemoryEntry[],
  id: string,
): ConversationMemoryEntry[] => {
  return existingEntries.filter((entry) => entry.id !== id);
};
