import type {
  ConversationMemoryEntry,
  ConversationMemoryScope,
} from "./types.js";

export const MAX_SESSION_MEMORY_ENTRIES = 24;
export const MAX_GLOBAL_MEMORY_ENTRIES = 40;
const MAX_MEMORY_CONTENT_LENGTH = 280;

const normalizeOptionalString = (
  value: string | undefined,
): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
};

const createMemoryKey = (content: string): string => {
  return content.replace(/\s+/g, " ").trim().toLowerCase();
};

export const normalizeMemoryContent = (
  value: string | undefined,
): string | undefined => {
  const normalized = normalizeOptionalString(value)?.replace(/\s+/g, " ");

  if (!normalized) {
    return undefined;
  }

  if (normalized.length <= MAX_MEMORY_CONTENT_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_MEMORY_CONTENT_LENGTH - 1)}…`;
};

export const createConversationMemoryEntry = (
  scope: ConversationMemoryScope,
  content: string,
  timestamp = Date.now(),
): ConversationMemoryEntry => {
  return {
    id: crypto.randomUUID(),
    scope,
    content,
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
      typeof candidate.createdAt === "number"
        ? candidate.createdAt
        : Date.now();
    const updatedAt =
      typeof candidate.updatedAt === "number" ? candidate.updatedAt : createdAt;

    return [
      {
        id:
          typeof candidate.id === "string" && candidate.id.trim().length > 0
            ? candidate.id
            : crypto.randomUUID(),
        scope,
        content,
        createdAt,
        updatedAt,
      },
    ];
  });

  return mergeConversationMemoryEntries(
    [],
    normalizedEntries,
    scope === "global" ? MAX_GLOBAL_MEMORY_ENTRIES : MAX_SESSION_MEMORY_ENTRIES,
  );
};

export const mergeConversationMemoryEntries = (
  existingEntries: ConversationMemoryEntry[],
  incomingEntries: ConversationMemoryEntry[],
  maxEntries: number,
): ConversationMemoryEntry[] => {
  const merged = new Map<string, ConversationMemoryEntry>();

  for (const entry of [...existingEntries, ...incomingEntries]) {
    const content = normalizeMemoryContent(entry.content);

    if (!content) {
      continue;
    }

    const key = createMemoryKey(content);
    const normalizedEntry: ConversationMemoryEntry = {
      ...entry,
      content,
    };
    const existingEntry = merged.get(key);

    if (!existingEntry || existingEntry.updatedAt < normalizedEntry.updatedAt) {
      merged.set(key, normalizedEntry);
    }
  }

  return Array.from(merged.values())
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, Math.max(1, maxEntries));
};

export const rememberConversationMemoryEntry = (
  existingEntries: ConversationMemoryEntry[],
  scope: ConversationMemoryScope,
  content: string,
  maxEntries = scope === "global"
    ? MAX_GLOBAL_MEMORY_ENTRIES
    : MAX_SESSION_MEMORY_ENTRIES,
  timestamp = Date.now(),
): {
  entry: ConversationMemoryEntry;
  entries: ConversationMemoryEntry[];
  added: boolean;
} => {
  const normalizedContent = normalizeMemoryContent(content);

  if (!normalizedContent) {
    throw new Error("Expected non-empty memory content.");
  }

  const key = createMemoryKey(normalizedContent);
  const existingEntry = existingEntries.find(
    (entry) => createMemoryKey(entry.content) === key,
  );

  if (existingEntry) {
    const refreshedEntry: ConversationMemoryEntry = {
      ...existingEntry,
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
    };
  }

  const nextEntry = createConversationMemoryEntry(
    scope,
    normalizedContent,
    timestamp,
  );

  return {
    entry: nextEntry,
    entries: mergeConversationMemoryEntries(
      existingEntries,
      [nextEntry],
      maxEntries,
    ),
    added: true,
  };
};
