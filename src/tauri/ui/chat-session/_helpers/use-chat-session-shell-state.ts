import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  createInitialShellState,
  createVisibleConversationMessages,
  getLatestCompletedSessionResponseAt,
  getLatestRunningTaskId,
  getSessionTitle,
  isMediaAssetContextAttachment,
  markSessionRead,
  mergeRecentWorkspacesForPersistence,
  normalizeShellState,
  recoverInterruptedTasksForLaunch,
  sortSessionsByUpdatedAt,
  type ChatSessionContextAttachment,
  type ChatSessionMessage,
  type ChatSessionQueuedMessage,
  type ChatSessionRecord,
  type SmartContextPack,
  type ShellPersistedState,
} from "../../chat-session.model";
import {
  broadcastShellStateChanged,
  compareAndSwapShellStatePatch,
  getCurrentShellWindowLabel,
  loadShellStateRevision,
  loadShellStateSnapshot,
  subscribeToShellStateChanged,
  type ShellStateCompareAndSwapResult,
  type ShellStatePatch,
} from "../../lib/shell-store";
import {
  loadActiveDesktopTaskIds,
  loadDesktopLaunchId,
} from "../../runtime";
import {
  type SessionScopeFilter,
  type SessionStatusFilterSelection,
  type SettingsSection,
} from "./session-shell";
import {
  ALL_SESSION_PROJECTS_FILTER,
  createSessionHistoryIndex,
  filterSessionHistoryIndex,
  type SessionHistoryIndex,
  type SessionHistoryIndexEntryCache,
  type SessionHistoryProjectFacet,
  type SessionHistoryTagFacet,
} from "./session-history-index";
import { useNewestMessageScroll } from "./use-newest-message-scroll";
import { canUseTauriStore } from "../../lib/_helpers/shell-store-storage.helper";

const serializeShellFragment = (value: unknown): string => {
  return JSON.stringify(value);
};

const SHELL_STATE_PERSIST_DELAY_MS = 500;
const SHELL_STATE_RECONCILIATION_INTERVAL_MS = 30_000;

export const createShellStatePatch = (
  baseState: ShellPersistedState,
  nextState: ShellPersistedState,
): ShellStatePatch => {
  const { sessions: baseSessions, ...baseTopLevel } = baseState;
  const { sessions: nextSessions, ...nextTopLevel } = nextState;
  const topLevel: Record<string, unknown> = {};
  const removedTopLevel = Object.keys(baseTopLevel).filter(
    (key) => !(key in nextTopLevel),
  );

  for (const [key, value] of Object.entries(nextTopLevel)) {
    const baseValue = baseTopLevel[key as keyof typeof baseTopLevel];

    if (serializeShellFragment(value) !== serializeShellFragment(baseValue)) {
      topLevel[key] = value;
    }
  }

  const baseSessionsById = new Map(
    baseSessions.map((session) => [session.id, session]),
  );
  const changedSessions = nextSessions.filter((session) => {
    const baseSession = baseSessionsById.get(session.id);
    return (
      !baseSession ||
      serializeShellFragment(session) !== serializeShellFragment(baseSession)
    );
  });

  return {
    topLevel,
    removedTopLevel,
    sessions: changedSessions,
    sessionOrder: nextSessions.map((session) => session.id),
  };
};

const getSessionPersistenceTimestamp = (
  session: ChatSessionRecord,
): number => {
  let timestamp = Math.max(
    session.updatedAt,
    session.composerUpdatedAt ?? 0,
    session.lastReadAt ?? 0,
    session.archivedAt ?? 0,
    session.pinnedAt ?? 0,
  );

  for (const message of session.messages) {
    timestamp = Math.max(timestamp, message.createdAt ?? 0);
  }

  for (const tombstoneTimestamp of Object.values(
    session.messageTombstones ?? {},
  )) {
    timestamp = Math.max(timestamp, tombstoneTimestamp);
  }

  return timestamp;
};

const areShellFragmentsEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) {
    return true;
  }

  return serializeShellFragment(left) === serializeShellFragment(right);
};

const isMessageVersionRegression = (
  currentMessage: ChatSessionMessage,
  incomingMessage: ChatSessionMessage,
): boolean => {
  if (currentMessage.id !== incomingMessage.id) {
    return false;
  }

  const currentAttachments = currentMessage.contextAttachments ?? [];
  const incomingAttachments = incomingMessage.contextAttachments ?? [];

  if (incomingAttachments.length < currentAttachments.length) {
    return true;
  }

  if (currentMessage.content.trim() && !incomingMessage.content.trim()) {
    return true;
  }

  const currentSource = currentMessage.source;
  const incomingSource = incomingMessage.source;

  if (currentSource && !incomingSource) {
    return true;
  }

  if (!currentSource || !incomingSource) {
    return false;
  }

  if (currentSource.kind === "execution") {
    if (incomingSource.kind !== "execution") {
      return true;
    }

    const currentResponseMarkdown =
      currentSource.execution.response?.markdown.trim() ?? "";
    const incomingResponseMarkdown =
      incomingSource.execution.response?.markdown.trim() ?? "";

    return Boolean(currentResponseMarkdown && !incomingResponseMarkdown);
  }

  if (currentSource.kind === "thinking") {
    if (incomingSource.kind === "execution") {
      return false;
    }

    if (incomingSource.kind !== "thinking") {
      return true;
    }

    const currentTimelineEvents =
      currentSource.thinking.timelineEvents?.length ?? 0;
    const incomingTimelineEvents =
      incomingSource.thinking.timelineEvents?.length ?? 0;

    if (
      currentSource.thinking.status === "complete" &&
      incomingSource.thinking.status !== "complete"
    ) {
      return true;
    }

    if (
      incomingSource.thinking.entries.length <
      currentSource.thinking.entries.length
    ) {
      return true;
    }

    if (incomingTimelineEvents < currentTimelineEvents) {
      return true;
    }

    return Boolean(
      currentSource.thinking.assistantText?.trim() &&
        !incomingSource.thinking.assistantText?.trim(),
    );
  }

  return false;
};

const isMessageSafelyReplaced = (
  message: ChatSessionMessage,
  candidateMessages: readonly ChatSessionMessage[],
): boolean => {
  if (message.role !== "agent" || !message.taskId) {
    return false;
  }

  // Terminal messages are distinct records even when they belong to the same
  // task. Only transient preview/thinking placeholders may be replaced by a
  // terminal result; treating one execution as a replacement for another can
  // delete both concurrent results during a two-sided merge.
  if (
    message.source?.kind === "execution" ||
    (message.source === undefined && message.content.trim().length > 0)
  ) {
    return false;
  }

  return candidateMessages.some(
    (candidate) =>
      candidate.taskId === message.taskId &&
      candidate.role === "agent" &&
      candidate.id !== message.id &&
      (candidate.source?.kind === "execution" ||
        (candidate.source === undefined && candidate.content.trim().length > 0)),
  );
};

const isPromptEnhancementPlaceholderMessage = (
  message: ChatSessionMessage,
): boolean => {
  const taskId = message.taskId;

  if (!taskId?.startsWith("prompt-enhancement-")) {
    return false;
  }

  return message.id === `${taskId}-user` || message.id === `${taskId}-thinking`;
};

const hasMessageRegression = (
  currentMessages: readonly ChatSessionMessage[],
  incomingMessages: readonly ChatSessionMessage[],
): boolean => {
  const incomingMessagesById = new Map(
    incomingMessages.map((message) => [message.id, message]),
  );

  for (const currentMessage of currentMessages) {
    const incomingMessage = incomingMessagesById.get(currentMessage.id);

    if (!incomingMessage) {
      if (isPromptEnhancementPlaceholderMessage(currentMessage)) {
        continue;
      }

      if (!isMessageSafelyReplaced(currentMessage, incomingMessages)) {
        return true;
      }

      continue;
    }

    if (isMessageVersionRegression(currentMessage, incomingMessage)) {
      return true;
    }
  }

  return false;
};

const mergeSessionRuntimeSelection = (
  primarySession: ChatSessionRecord,
  localSession: ChatSessionRecord,
  baseSession: ChatSessionRecord,
  latestSession: ChatSessionRecord,
): ChatSessionRecord => {
  const localProviderChanged = localSession.provider !== baseSession.provider;
  const latestProviderChanged = latestSession.provider !== baseSession.provider;
  const localModelChanged = localSession.model !== baseSession.model;
  const latestModelChanged = latestSession.model !== baseSession.model;
  let mergedSession = primarySession;

  if (!localProviderChanged && latestProviderChanged) {
    mergedSession = {
      ...mergedSession,
      provider: latestSession.provider,
    };
  } else if (localProviderChanged && !latestProviderChanged) {
    mergedSession = {
      ...mergedSession,
      provider: localSession.provider,
    };
  }

  if (!localModelChanged && latestModelChanged) {
    mergedSession = {
      ...mergedSession,
      model: latestSession.model,
    };
  } else if (localModelChanged && !latestModelChanged) {
    mergedSession = {
      ...mergedSession,
      model: localSession.model,
    };
  }

  return mergedSession;
};

const getSessionComposerTimestamp = (session: ChatSessionRecord): number => {
  return Math.max(
    session.composerUpdatedAt ?? 0,
    session.draftUpdatedAt ?? 0,
    session.draftAttachmentsUpdatedAt ?? 0,
    ...Object.values(session.draftAttachmentAddedAt ?? {}),
    ...Object.values(session.draftAttachmentTombstones ?? {}),
    session.createdAt,
  );
};

const getSessionDraftTimestamp = (session: ChatSessionRecord): number => {
  return Math.max(
    session.draftUpdatedAt ?? session.composerUpdatedAt ?? 0,
    session.createdAt,
  );
};

const getSessionDraftAttachmentsTimestamp = (
  session: ChatSessionRecord,
): number => {
  return Math.max(
    session.draftAttachmentsUpdatedAt ?? session.composerUpdatedAt ?? 0,
    session.createdAt,
  );
};

const getAttachmentAddTimestamp = (
  session: ChatSessionRecord,
  attachmentId: string,
): number => {
  const storedTimestamp = session.draftAttachmentAddedAt?.[attachmentId];

  if (storedTimestamp !== undefined) {
    return storedTimestamp;
  }

  return session.draftContextAttachments.some(
    (attachment) => attachment.id === attachmentId,
  )
    ? getSessionDraftAttachmentsTimestamp(session)
    : 0;
};

const createAttachmentPersistenceIdentity = (
  attachment: ChatSessionContextAttachment,
): string => {
  if (isMediaAssetContextAttachment(attachment)) {
    return `media:${attachment.workspaceRoot.toLowerCase()}:${attachment.assetId}`;
  }
  const normalizedPath = attachment.path.trim().replace(/\\/gu, "/");
  const isCaseInsensitiveWindowsReference =
    /^[a-z]:\//iu.test(normalizedPath) ||
    /^\/\/[^/]/u.test(normalizedPath) ||
    /^file:\/{2,3}[a-z]:\//iu.test(normalizedPath);
  const caseNormalizedPath = isCaseInsensitiveWindowsReference
    ? normalizedPath.toLowerCase()
    : normalizedPath;

  return caseNormalizedPath.replace(/\/{2,}$/u, "/");
};

const mergeTimestampRecords = (
  ...records: ReadonlyArray<Readonly<Record<string, number>> | undefined>
): Record<string, number> => {
  const merged: Record<string, number> = {};

  for (const record of records) {
    for (const [id, timestamp] of Object.entries(record ?? {})) {
      if (Number.isFinite(timestamp)) {
        merged[id] = Math.max(merged[id] ?? 0, timestamp);
      }
    }
  }

  return merged;
};

const pruneTimestampRecord = (
  record: Readonly<Record<string, number>>,
  maxEntries = 2_048,
): Record<string, number> => {
  return Object.fromEntries(
    Object.entries(record)
      .sort((left, right) => right[1] - left[1])
      .slice(0, maxEntries),
  );
};

const mergeSessionMessageTombstones = (
  ...sessions: readonly ChatSessionRecord[]
): Record<string, number> => {
  return pruneTimestampRecord(
    mergeTimestampRecords(
      ...sessions.map((session) => session.messageTombstones),
    ),
  );
};

const filterMessageTombstones = (
  messages: readonly ChatSessionMessage[],
  tombstones: Readonly<Record<string, number>>,
): ChatSessionMessage[] => {
  return messages.filter((message) => tombstones[message.id] === undefined);
};

interface ComposerAttachmentBranchMetadata {
  addedAt: Record<string, number>;
  tombstones: Record<string, number>;
  updatedAt: number;
}

const hasSubmittedBaseComposer = (
  session: ChatSessionRecord,
  baseSession: ChatSessionRecord,
): boolean => {
  if (
    (!baseSession.draft.trim() &&
      baseSession.draftContextAttachments.length === 0) ||
    session.draft.trim() ||
    session.draftContextAttachments.length > 0
  ) {
    return false;
  }

  const baseMessageIds = new Set(
    baseSession.messages.map((message) => message.id),
  );

  return session.messages.some(
    (message) => message.role === "user" && !baseMessageIds.has(message.id),
  );
};

const createComposerAttachmentBranchMetadata = (
  session: ChatSessionRecord,
  baseSession: ChatSessionRecord,
  allowUpdatedAtFallback = false,
): ComposerAttachmentBranchMetadata => {
  const baseAttachmentsById = new Map(
    baseSession.draftContextAttachments.map((attachment) => [
      attachment.id,
      attachment,
    ]),
  );
  const sessionAttachmentsById = new Map(
    session.draftContextAttachments.map((attachment) => [
      attachment.id,
      attachment,
    ]),
  );
  const baseUpdatedAt = getSessionDraftAttachmentsTimestamp(baseSession);
  const storedUpdatedAt = getSessionDraftAttachmentsTimestamp(session);
  const storedClockAdvanced = storedUpdatedAt > baseUpdatedAt;
  const legacyComposerAdvanced =
    session.draftAttachmentsUpdatedAt === undefined &&
    (session.composerUpdatedAt ?? 0) > (baseSession.composerUpdatedAt ?? 0);
  const submittedBaseComposer = hasSubmittedBaseComposer(
    session,
    baseSession,
  );
  const updatedAtFallbackAdvanced =
    allowUpdatedAtFallback &&
    session.draftAttachmentsUpdatedAt === undefined &&
    !areShellFragmentsEqual(
      session.draftContextAttachments,
      baseSession.draftContextAttachments,
    ) &&
    session.updatedAt > baseSession.updatedAt;
  const fieldAdvanced =
    storedClockAdvanced ||
    legacyComposerAdvanced ||
    submittedBaseComposer ||
    updatedAtFallbackAdvanced;
  const mutationTimestamp = Math.max(
    storedClockAdvanced ? storedUpdatedAt : 0,
    legacyComposerAdvanced ? (session.composerUpdatedAt ?? 0) : 0,
    submittedBaseComposer ? session.updatedAt : 0,
    updatedAtFallbackAdvanced ? session.updatedAt : 0,
  );
  const addedAt = mergeTimestampRecords(session.draftAttachmentAddedAt);
  const tombstones = mergeTimestampRecords(
    session.draftAttachmentTombstones,
  );

  for (const attachmentId of Object.keys(addedAt)) {
    if (
      !sessionAttachmentsById.has(attachmentId) &&
      tombstones[attachmentId] === undefined &&
      (session.composerUpdatedAt ?? 0) > storedUpdatedAt
    ) {
      tombstones[attachmentId] = session.composerUpdatedAt ?? storedUpdatedAt;
    }
  }

  for (const attachment of session.draftContextAttachments) {
    const baseAttachment = baseAttachmentsById.get(attachment.id);
    const baseAddedAt = getAttachmentAddTimestamp(
      baseSession,
      attachment.id,
    );
    const storedAddedAt =
      session.draftAttachmentAddedAt?.[attachment.id];
    const attachmentChanged =
      !baseAttachment ||
      !areShellFragmentsEqual(baseAttachment, attachment);
    const shouldSynthesizeAddTimestamp =
      attachmentChanged &&
      fieldAdvanced &&
      (storedAddedAt === undefined ||
        (baseAttachment !== undefined && storedAddedAt <= baseAddedAt));

    addedAt[attachment.id] = Math.max(
      addedAt[attachment.id] ?? 0,
      baseAddedAt,
      shouldSynthesizeAddTimestamp ? mutationTimestamp : 0,
    );
  }

  if (fieldAdvanced) {
    for (const baseAttachment of baseSession.draftContextAttachments) {
      if (!sessionAttachmentsById.has(baseAttachment.id)) {
        tombstones[baseAttachment.id] = Math.max(
          tombstones[baseAttachment.id] ?? 0,
          mutationTimestamp,
        );
      }
    }
  }

  return {
    addedAt,
    tombstones,
    updatedAt: Math.max(
      storedUpdatedAt,
      ...Object.values(addedAt),
      ...Object.values(tombstones),
    ),
  };
};

interface MergedSessionComposer {
  draft: string;
  draftUpdatedAt: number;
  draftContextAttachments: ChatSessionContextAttachment[];
  draftAttachmentsUpdatedAt: number;
  draftAttachmentAddedAt: Record<string, number>;
  draftAttachmentTombstones: Record<string, number>;
  composerUpdatedAt: number;
}

const mergeSessionComposerForPersistence = (
  localSession: ChatSessionRecord,
  baseSession: ChatSessionRecord,
  latestSession: ChatSessionRecord,
): MergedSessionComposer => {
  const baseDraftUpdatedAt = getSessionDraftTimestamp(baseSession);
  const localSubmittedBaseComposer = hasSubmittedBaseComposer(
    localSession,
    baseSession,
  );
  const latestSubmittedBaseComposer = hasSubmittedBaseComposer(
    latestSession,
    baseSession,
  );
  const localDraftUpdatedAtFallback =
    localSession.draftUpdatedAt === undefined &&
    localSession.draft !== baseSession.draft &&
    localSession.updatedAt > baseSession.updatedAt
      ? localSession.updatedAt
      : 0;
  const localDraftUpdatedAt = Math.max(
    getSessionDraftTimestamp(localSession),
    localSession.draftUpdatedAt === undefined &&
    localSession.draft !== baseSession.draft &&
      (localSession.composerUpdatedAt ?? 0) >
        (baseSession.composerUpdatedAt ?? 0)
      ? (localSession.composerUpdatedAt ?? 0)
      : 0,
    localSubmittedBaseComposer ? localSession.updatedAt : 0,
    localDraftUpdatedAtFallback,
  );
  const latestDraftUpdatedAt = Math.max(
    getSessionDraftTimestamp(latestSession),
    latestSession.draftUpdatedAt === undefined &&
    latestSession.draft !== baseSession.draft &&
      (latestSession.composerUpdatedAt ?? 0) >
        (baseSession.composerUpdatedAt ?? 0)
      ? (latestSession.composerUpdatedAt ?? 0)
      : 0,
    latestSubmittedBaseComposer ? latestSession.updatedAt : 0,
  );
  const localDraftChanged =
    localSession.draft !== baseSession.draft &&
    localDraftUpdatedAt > baseDraftUpdatedAt;
  const latestDraftChanged =
    latestSession.draft !== baseSession.draft &&
    latestDraftUpdatedAt > baseDraftUpdatedAt;
  const draft = localDraftChanged
    ? latestDraftChanged
      ? localDraftUpdatedAt >= latestDraftUpdatedAt
        ? localSession.draft
        : latestSession.draft
      : localSession.draft
    : latestDraftChanged
      ? latestSession.draft
      : baseSession.draft;
  const draftUpdatedAt = Math.max(
    baseDraftUpdatedAt,
    localDraftUpdatedAt,
    latestDraftUpdatedAt,
  );
  const baseMetadata = createComposerAttachmentBranchMetadata(
    baseSession,
    baseSession,
  );
  const localMetadata = createComposerAttachmentBranchMetadata(
    localSession,
    baseSession,
    true,
  );
  const latestMetadata = createComposerAttachmentBranchMetadata(
    latestSession,
    baseSession,
  );
  let draftAttachmentTombstones = pruneTimestampRecord(
    mergeTimestampRecords(
      baseMetadata.tombstones,
      localMetadata.tombstones,
      latestMetadata.tombstones,
    ),
  );
  const attachmentsById = new Map<
    string,
    { attachment: ChatSessionContextAttachment; addedAt: number }
  >();

  for (const [session, metadata] of [
    [baseSession, baseMetadata],
    [latestSession, latestMetadata],
    [localSession, localMetadata],
  ] as const) {
    for (const attachment of session.draftContextAttachments) {
      const addedAt = metadata.addedAt[attachment.id] ?? 0;
      const existing = attachmentsById.get(attachment.id);

      if (!existing || addedAt >= existing.addedAt) {
        attachmentsById.set(attachment.id, { attachment, addedAt });
      }
    }
  }

  const survivingAttachmentEntries = [...attachmentsById.entries()].filter(
    ([attachmentId, entry]) =>
      entry.addedAt > (draftAttachmentTombstones[attachmentId] ?? 0),
  );
  const attachmentByIdentity = new Map<
    string,
    [string, { attachment: ChatSessionContextAttachment; addedAt: number }]
  >();

  for (const candidate of survivingAttachmentEntries) {
    const [candidateId, candidateEntry] = candidate;
    const identity = createAttachmentPersistenceIdentity(
      candidateEntry.attachment,
    );
    const existing = attachmentByIdentity.get(identity);

    if (!existing) {
      attachmentByIdentity.set(identity, candidate);
      continue;
    }

    const [existingId, existingEntry] = existing;
    const candidateWins =
      candidateEntry.addedAt > existingEntry.addedAt ||
      (candidateEntry.addedAt === existingEntry.addedAt &&
        candidateId.localeCompare(existingId) < 0);
    const [winnerId, winnerEntry] = candidateWins ? candidate : existing;
    const [loserId, loserEntry] = candidateWins ? existing : candidate;

    draftAttachmentTombstones[loserId] = Math.max(
      draftAttachmentTombstones[loserId] ?? 0,
      loserEntry.addedAt,
      winnerEntry.addedAt,
    );
    attachmentByIdentity.set(identity, [winnerId, winnerEntry]);
  }

  draftAttachmentTombstones = pruneTimestampRecord(
    draftAttachmentTombstones,
  );

  const baseOrderById = new Map(
    baseSession.draftContextAttachments.map((attachment, index) => [
      attachment.id,
      index,
    ]),
  );
  const draftContextAttachments = [...attachmentByIdentity.values()]
    .sort(([leftId, left], [rightId, right]) => {
      const leftBaseOrder = baseOrderById.get(leftId);
      const rightBaseOrder = baseOrderById.get(rightId);

      if (leftBaseOrder !== undefined && rightBaseOrder !== undefined) {
        return leftBaseOrder - rightBaseOrder;
      }

      if (leftBaseOrder !== undefined) {
        return -1;
      }

      if (rightBaseOrder !== undefined) {
        return 1;
      }

      return left.addedAt - right.addedAt || leftId.localeCompare(rightId);
    })
    .map(([, entry]) => entry.attachment);
  const draftAttachmentAddedAt = Object.fromEntries(
    draftContextAttachments.map((attachment) => [
      attachment.id,
      attachmentsById.get(attachment.id)?.addedAt ?? 0,
    ]),
  );
  const draftAttachmentsUpdatedAt = Math.max(
    baseMetadata.updatedAt,
    localMetadata.updatedAt,
    latestMetadata.updatedAt,
    ...Object.values(draftAttachmentAddedAt),
    ...Object.values(draftAttachmentTombstones),
  );

  return {
    draft,
    draftUpdatedAt,
    draftContextAttachments,
    draftAttachmentsUpdatedAt,
    draftAttachmentAddedAt,
    draftAttachmentTombstones,
    composerUpdatedAt: Math.max(draftUpdatedAt, draftAttachmentsUpdatedAt),
  };
};

const mergeSessionFieldForPersistence = <T,>(
  primaryValue: T,
  localValue: T,
  baseValue: T,
  latestValue: T,
): T => {
  const localChanged = !areShellFragmentsEqual(localValue, baseValue);
  const latestChanged = !areShellFragmentsEqual(latestValue, baseValue);

  if (localChanged && !latestChanged) {
    return localValue;
  }

  if (!localChanged && latestChanged) {
    return latestValue;
  }

  if (localChanged && latestChanged) {
    // Commits are serialized with compare-and-swap. If both sides changed the
    // same field, the currently committing mutation is the deterministic
    // last writer instead of an unrelated aggregate session timestamp.
    return localValue;
  }

  return primaryValue;
};

const didRemoveBaseMessages = (
  messages: readonly ChatSessionMessage[],
  baseMessages: readonly ChatSessionMessage[],
): boolean => {
  const messageIds = new Set(messages.map((message) => message.id));

  return baseMessages.some(
    (message) =>
      !isPromptEnhancementPlaceholderMessage(message) &&
      !messageIds.has(message.id) && !isMessageSafelyReplaced(message, messages),
  );
};

const getMessageCompletenessScore = (message: ChatSessionMessage): number => {
  let score = message.content.trim().length;
  score += (message.contextAttachments?.length ?? 0) * 1_000;

  const source = message.source;

  if (!source) {
    return score;
  }

  if (source.kind === "execution") {
    return score + 10_000_000 + serializeShellFragment(source).length;
  }

  if (source.kind === "thinking") {
    const thinking = source.thinking;
    score += thinking.status === "complete" ? 5_000_000 : 1_000_000;
    score += thinking.entries.length * 10_000;
    score += (thinking.timelineEvents?.length ?? 0) * 10_000;
    score += thinking.assistantText?.trim().length ?? 0;
    return score + serializeShellFragment(thinking).length;
  }

  return score + 100_000 + serializeShellFragment(source).length;
};

const MAX_SHELL_STATE_CONFLICT_RETRIES = 12;
const SHELL_STATE_RETRY_BASE_DELAY_MS = 250;
const SHELL_STATE_RETRY_MAX_DELAY_MS = 5_000;

const getShellStateRetryDelay = (attempt: number): number => {
  return Math.min(
    SHELL_STATE_RETRY_MAX_DELAY_MS,
    SHELL_STATE_RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt, 5),
  );
};

const waitForShellStateConflictRetry = async (attempt: number): Promise<void> => {
  if (typeof window === "undefined") {
    return;
  }

  const delay = Math.min(500, 20 * 2 ** Math.min(attempt, 4));
  await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
};

const mergeMessageVersionForPersistence = (
  primaryMessage: ChatSessionMessage | undefined,
  localMessage: ChatSessionMessage,
  baseMessage: ChatSessionMessage | undefined,
  latestMessage: ChatSessionMessage,
): ChatSessionMessage => {
  const localChanged =
    !baseMessage || !areShellFragmentsEqual(localMessage, baseMessage);
  const latestChanged =
    !baseMessage || !areShellFragmentsEqual(latestMessage, baseMessage);
  const localRegressed =
    baseMessage !== undefined &&
    isMessageVersionRegression(baseMessage, localMessage);
  const latestRegressed =
    baseMessage !== undefined &&
    isMessageVersionRegression(baseMessage, latestMessage);

  if (localRegressed && !latestRegressed) {
    return latestMessage;
  }

  if (!localRegressed && latestRegressed) {
    return localMessage;
  }

  if (localChanged && !latestChanged) {
    return localMessage;
  }

  if (!localChanged && latestChanged) {
    return latestMessage;
  }

  if (localChanged && latestChanged) {
    const localScore = getMessageCompletenessScore(localMessage);
    const latestScore = getMessageCompletenessScore(latestMessage);

    if (localScore !== latestScore) {
      return localScore > latestScore ? localMessage : latestMessage;
    }

    return primaryMessage ?? localMessage;
  }

  return primaryMessage ?? localMessage;
};

const mergeAppendOnlyMessages = (
  primaryMessages: readonly ChatSessionMessage[],
  localMessages: readonly ChatSessionMessage[],
  baseMessages: readonly ChatSessionMessage[],
  latestMessages: readonly ChatSessionMessage[],
): ChatSessionMessage[] => {
  const primaryMessagesById = new Map(
    primaryMessages.map((message) => [message.id, message]),
  );
  const localMessagesById = new Map(
    localMessages.map((message) => [message.id, message]),
  );
  const baseMessagesById = new Map(
    baseMessages.map((message) => [message.id, message]),
  );
  const latestMessagesById = new Map(
    latestMessages.map((message) => [message.id, message]),
  );
  const messagesById = new Map<string, ChatSessionMessage>();

  for (const messageId of new Set([
    ...localMessagesById.keys(),
    ...latestMessagesById.keys(),
  ])) {
    const localMessage = localMessagesById.get(messageId);
    const baseMessage = baseMessagesById.get(messageId);
    const latestMessage = latestMessagesById.get(messageId);

    if (!localMessage) {
      if (latestMessage) {
        if (isPromptEnhancementPlaceholderMessage(latestMessage)) {
          continue;
        }

        if (isMessageSafelyReplaced(latestMessage, localMessages)) {
          continue;
        }

        messagesById.set(messageId, latestMessage);
      }
      continue;
    }

    if (!latestMessage) {
      if (isMessageSafelyReplaced(localMessage, latestMessages)) {
        continue;
      }

      messagesById.set(messageId, localMessage);
      continue;
    }

    messagesById.set(
      messageId,
      mergeMessageVersionForPersistence(
        primaryMessagesById.get(messageId),
        localMessage,
        baseMessage,
        latestMessage,
      ),
    );
  }

  return [...messagesById.values()].sort((left, right) => {
    const leftCreatedAt = left.createdAt ?? 0;
    const rightCreatedAt = right.createdAt ?? 0;

    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }

    if (left.role !== right.role) {
      return left.role === "user" ? -1 : 1;
    }

    const getAgentSourceOrder = (message: ChatSessionMessage): number => {
      if (message.source?.kind === "preview") {
        return 0;
      }

      if (message.source?.kind === "thinking") {
        return 1;
      }

      return 2;
    };
    const sourceOrderDelta =
      getAgentSourceOrder(left) - getAgentSourceOrder(right);

    if (sourceOrderDelta !== 0) {
      return sourceOrderDelta;
    }

    return left.id.localeCompare(right.id);
  });
};

const mergeSessionMessagesForPersistence = (
  primarySession: ChatSessionRecord,
  localSession: ChatSessionRecord,
  baseSession: ChatSessionRecord,
  latestSession: ChatSessionRecord,
): ChatSessionMessage[] => {
  const localChanged = !areShellFragmentsEqual(
    localSession.messages,
    baseSession.messages,
  );
  const latestChanged = !areShellFragmentsEqual(
    latestSession.messages,
    baseSession.messages,
  );
  const localMessageRegression = hasMessageRegression(
    baseSession.messages,
    localSession.messages,
  );
  const latestMessageRegression = hasMessageRegression(
    baseSession.messages,
    latestSession.messages,
  );
  const localClearAt =
    (localSession.historyClearedAt ?? 0) > (baseSession.historyClearedAt ?? 0)
      ? (localSession.historyClearedAt ?? 0)
      : 0;
  const latestClearAt =
    (latestSession.historyClearedAt ?? 0) > (baseSession.historyClearedAt ?? 0)
      ? (latestSession.historyClearedAt ?? 0)
      : 0;
  const winningClearAt = Math.max(localClearAt, latestClearAt);

  if (winningClearAt > 0) {
    const mergedMessages = mergeAppendOnlyMessages(
      primarySession.messages,
      localSession.messages,
      baseSession.messages,
      latestSession.messages,
    );
    const baseMessageIds = new Set(
      baseSession.messages.map((message) => message.id),
    );
    const postClearMessages = mergedMessages.filter(
      (message) =>
        !baseMessageIds.has(message.id) &&
        (message.createdAt ?? winningClearAt) >= winningClearAt,
    );
    const tasksStartedAfterClear = new Set(
      postClearMessages
        .filter(
          (message) =>
            message.role === "user" &&
            (message.createdAt ?? winningClearAt) >= winningClearAt,
        )
        .flatMap((message) => (message.taskId ? [message.taskId] : [])),
    );

    return postClearMessages.filter((message) => {
      return (
        !message.taskId ||
        message.role === "user" ||
        tasksStartedAfterClear.has(message.taskId)
      );
    });
  }

  if (localChanged && !latestChanged) {
    return didRemoveBaseMessages(localSession.messages, baseSession.messages) ||
      localMessageRegression
      ? mergeAppendOnlyMessages(
          primarySession.messages,
          localSession.messages,
          baseSession.messages,
          latestSession.messages,
        )
      : localSession.messages;
  }

  if (!localChanged && latestChanged) {
    return didRemoveBaseMessages(latestSession.messages, baseSession.messages) ||
      latestMessageRegression
      ? mergeAppendOnlyMessages(
          primarySession.messages,
          localSession.messages,
          baseSession.messages,
          latestSession.messages,
        )
      : latestSession.messages;
  }

  if (localChanged && latestChanged) {
    return mergeAppendOnlyMessages(
      primarySession.messages,
      localSession.messages,
      baseSession.messages,
      latestSession.messages,
    );
  }

  return primarySession.messages;
};

const mergePromptHistoryAfterClear = (
  localSession: ChatSessionRecord,
  latestSession: ChatSessionRecord,
  clearAt: number,
): Pick<ChatSessionRecord, "promptHistory" | "promptContextHistory"> => {
  const entriesByMessageId = new Map<
    string,
    {
      createdAt: number;
      prompt: string;
      context: ChatSessionRecord["promptContextHistory"][number];
    }
  >();

  for (const session of [localSession, latestSession]) {
    const userMessages = session.messages.filter(
      (message) =>
        message.role === "user" &&
        (message.createdAt ?? clearAt) >= clearAt,
    );
    const prompts = session.promptHistory.slice(-userMessages.length);
    const contexts = session.promptContextHistory.slice(-userMessages.length);

    userMessages.forEach((message, index) => {
      entriesByMessageId.set(message.id, {
        createdAt: message.createdAt ?? 0,
        prompt: prompts[index] ?? message.content,
        context: contexts[index] ?? message.contextAttachments ?? [],
      });
    });
  }

  const entries = [...entriesByMessageId.entries()].sort(
    ([leftId, left], [rightId, right]) =>
      left.createdAt - right.createdAt || leftId.localeCompare(rightId),
  );

  return {
    promptHistory: entries.map(([, entry]) => entry.prompt),
    promptContextHistory: entries.map(([, entry]) => entry.context),
  };
};

const mergeSessionConcurrentFields = (
  primarySession: ChatSessionRecord,
  localSession: ChatSessionRecord,
  baseSession: ChatSessionRecord,
  latestSession: ChatSessionRecord,
): ChatSessionRecord => {
  const mergedComposer = mergeSessionComposerForPersistence(
    localSession,
    baseSession,
    latestSession,
  );
  const latestMessageRegression = hasMessageRegression(
    baseSession.messages,
    latestSession.messages,
  );
  const winningClearAt = Math.max(
    (localSession.historyClearedAt ?? 0) > (baseSession.historyClearedAt ?? 0)
      ? (localSession.historyClearedAt ?? 0)
      : 0,
    (latestSession.historyClearedAt ?? 0) > (baseSession.historyClearedAt ?? 0)
      ? (latestSession.historyClearedAt ?? 0)
      : 0,
  );
  const postClearHistory =
    winningClearAt > 0
      ? mergePromptHistoryAfterClear(
          localSession,
          latestSession,
          winningClearAt,
        )
      : null;
  const promptHistory = postClearHistory
    ? postClearHistory.promptHistory
    : latestMessageRegression
      ? localSession.promptHistory
      : mergeSessionFieldForPersistence(
          primarySession.promptHistory,
          localSession.promptHistory,
          baseSession.promptHistory,
          latestSession.promptHistory,
        );
  const promptContextHistory = postClearHistory
    ? postClearHistory.promptContextHistory
    : latestMessageRegression
      ? localSession.promptContextHistory
      : mergeSessionFieldForPersistence(
          primarySession.promptContextHistory,
          localSession.promptContextHistory,
          baseSession.promptContextHistory,
          latestSession.promptContextHistory,
        );
  const messageTombstones = mergeSessionMessageTombstones(
    primarySession,
    localSession,
    baseSession,
    latestSession,
  );
  const messages = filterMessageTombstones(
    mergeSessionMessagesForPersistence(
      primarySession,
      localSession,
      baseSession,
      latestSession,
    ),
    messageTombstones,
  );

  return {
    ...primarySession,
    id: baseSession.id,
    createdAt: baseSession.createdAt,
    updatedAt: Math.max(localSession.updatedAt, latestSession.updatedAt),
    historyClearedAt:
      Math.max(
        localSession.historyClearedAt ?? 0,
        latestSession.historyClearedAt ?? 0,
      ) || undefined,
    lastReadAt: Math.max(
      localSession.lastReadAt ?? 0,
      latestSession.lastReadAt ?? 0,
    ) || undefined,
    archivedAt: mergeSessionFieldForPersistence(
      primarySession.archivedAt,
      localSession.archivedAt,
      baseSession.archivedAt,
      latestSession.archivedAt,
    ),
    pinnedAt: mergeSessionFieldForPersistence(
      primarySession.pinnedAt,
      localSession.pinnedAt,
      baseSession.pinnedAt,
      latestSession.pinnedAt,
    ),
    specialSession: mergeSessionFieldForPersistence(
      primarySession.specialSession,
      localSession.specialSession,
      baseSession.specialSession,
      latestSession.specialSession,
    ),
    workspace: mergeSessionFieldForPersistence(
      primarySession.workspace,
      localSession.workspace,
      baseSession.workspace,
      latestSession.workspace,
    ),
    provider: mergeSessionFieldForPersistence(
      primarySession.provider,
      localSession.provider,
      baseSession.provider,
      latestSession.provider,
    ),
    model: mergeSessionFieldForPersistence(
      primarySession.model,
      localSession.model,
      baseSession.model,
      latestSession.model,
    ),
    mode: mergeSessionFieldForPersistence(
      primarySession.mode,
      localSession.mode,
      baseSession.mode,
      latestSession.mode,
    ),
    reasoning: mergeSessionFieldForPersistence(
      primarySession.reasoning,
      localSession.reasoning,
      baseSession.reasoning,
      latestSession.reasoning,
    ),
    manualTitle: mergeSessionFieldForPersistence(
      primarySession.manualTitle,
      localSession.manualTitle,
      baseSession.manualTitle,
      latestSession.manualTitle,
    ),
    tags: mergeSessionFieldForPersistence(
      primarySession.tags,
      localSession.tags,
      baseSession.tags,
      latestSession.tags,
    ),
    sessionMemoryEnabled: mergeSessionFieldForPersistence(
      primarySession.sessionMemoryEnabled,
      localSession.sessionMemoryEnabled,
      baseSession.sessionMemoryEnabled,
      latestSession.sessionMemoryEnabled,
    ),
    useGlobalMemory: mergeSessionFieldForPersistence(
      primarySession.useGlobalMemory,
      localSession.useGlobalMemory,
      baseSession.useGlobalMemory,
      latestSession.useGlobalMemory,
    ),
    uiControlEnabled: mergeSessionFieldForPersistence(
      primarySession.uiControlEnabled,
      localSession.uiControlEnabled,
      baseSession.uiControlEnabled,
      latestSession.uiControlEnabled,
    ),
    sessionMemory: mergeSessionFieldForPersistence(
      primarySession.sessionMemory,
      localSession.sessionMemory,
      baseSession.sessionMemory,
      latestSession.sessionMemory,
    ),
    ...mergedComposer,
    messageTombstones,
    messages,
    promptHistory,
    promptContextHistory,
  };
};

const createNewSessionConcurrentBase = (
  session: ChatSessionRecord,
): ChatSessionRecord => {
  return {
    ...session,
    draft: "",
    draftContextAttachments: [],
    composerUpdatedAt: session.createdAt,
    draftUpdatedAt: session.createdAt,
    draftAttachmentsUpdatedAt: session.createdAt,
    draftAttachmentAddedAt: {},
    draftAttachmentTombstones: {},
    messageTombstones: {},
    messages: [],
    promptHistory: [],
    promptContextHistory: [],
  };
};

const mergeNewSessionConcurrentFields = (
  primarySession: ChatSessionRecord,
  localSession: ChatSessionRecord,
  latestSession: ChatSessionRecord,
): ChatSessionRecord => {
  return mergeSessionConcurrentFields(
    primarySession,
    localSession,
    createNewSessionConcurrentBase(primarySession),
    latestSession,
  );
};

const mergeRunningSessionWithExternalSnapshot = (
  currentSession: ChatSessionRecord,
  externalSession: ChatSessionRecord,
): ChatSessionRecord => {
  const primarySession: ChatSessionRecord = {
    ...externalSession,
    updatedAt: Math.max(externalSession.updatedAt, currentSession.updatedAt),
    messages: currentSession.messages,
  };

  return mergeSessionConcurrentFields(
    primarySession,
    currentSession,
    currentSession,
    externalSession,
  );
};

const hasSessionComposerInput = (session: ChatSessionRecord): boolean => {
  return (
    session.draft.trim().length > 0 ||
    session.draftContextAttachments.length > 0
  );
};

const applyLocalMutationMetadata = (
  previousState: ShellPersistedState,
  nextState: ShellPersistedState,
): ShellPersistedState => {
  const previousSessionsById = new Map(
    previousState.sessions.map((session) => [session.id, session]),
  );
  let didDecorateSession = false;
  const sessions = nextState.sessions.map((session) => {
    const previousSession = previousSessionsById.get(session.id);

    if (!previousSession) {
      return session;
    }

    const draftChanged = session.draft !== previousSession.draft;
    const attachmentsChanged = !areShellFragmentsEqual(
      session.draftContextAttachments,
      previousSession.draftContextAttachments,
    );
    if (!draftChanged && !attachmentsChanged) {
      return session;
    }

    didDecorateSession = true;
    const mutationTimestamp = Math.max(
      Date.now(),
      session.updatedAt,
      session.composerUpdatedAt ?? 0,
      getSessionComposerTimestamp(previousSession) + 1,
    );
    const draftUpdatedAt = draftChanged
      ? mutationTimestamp
      : getSessionDraftTimestamp(session);
    let draftAttachmentsUpdatedAt =
      getSessionDraftAttachmentsTimestamp(session);
    let draftAttachmentAddedAt = mergeTimestampRecords(
      previousSession.draftAttachmentAddedAt,
      session.draftAttachmentAddedAt,
    );
    let draftAttachmentTombstones = mergeTimestampRecords(
      previousSession.draftAttachmentTombstones,
      session.draftAttachmentTombstones,
    );

    if (attachmentsChanged) {
      draftAttachmentsUpdatedAt = mutationTimestamp;
      const previousAttachmentsById = new Map(
        previousSession.draftContextAttachments.map((attachment) => [
          attachment.id,
          attachment,
        ]),
      );
      const nextAttachmentIds = new Set(
        session.draftContextAttachments.map((attachment) => attachment.id),
      );

      for (const attachment of session.draftContextAttachments) {
        const previousAttachment = previousAttachmentsById.get(attachment.id);

        if (
          !previousAttachment ||
          !areShellFragmentsEqual(previousAttachment, attachment)
        ) {
          draftAttachmentAddedAt[attachment.id] = mutationTimestamp;
        } else {
          draftAttachmentAddedAt[attachment.id] = Math.max(
            draftAttachmentAddedAt[attachment.id] ?? 0,
            getAttachmentAddTimestamp(previousSession, attachment.id),
          );
        }
      }

      for (const attachment of previousSession.draftContextAttachments) {
        if (!nextAttachmentIds.has(attachment.id)) {
          draftAttachmentTombstones[attachment.id] = Math.max(
            draftAttachmentTombstones[attachment.id] ?? 0,
            mutationTimestamp,
          );
        }
      }

      draftAttachmentAddedAt = Object.fromEntries(
        session.draftContextAttachments.map((attachment) => [
          attachment.id,
          draftAttachmentAddedAt[attachment.id] ?? mutationTimestamp,
        ]),
      );
      draftAttachmentTombstones = pruneTimestampRecord(
        draftAttachmentTombstones,
      );
    }

    return {
      ...session,
      updatedAt: Math.max(session.updatedAt, mutationTimestamp),
      composerUpdatedAt: Math.max(
        draftUpdatedAt,
        draftAttachmentsUpdatedAt,
      ),
      draftUpdatedAt,
      draftAttachmentsUpdatedAt,
      draftAttachmentAddedAt,
      draftAttachmentTombstones,
    };
  });
  const nextSessionIds = new Set(nextState.sessions.map((session) => session.id));
  const sessionTombstones = mergeTimestampRecords(
    previousState.sessionTombstones,
    nextState.sessionTombstones,
  );
  let didAddSessionTombstone = false;

  for (const previousSession of previousState.sessions) {
    if (!nextSessionIds.has(previousSession.id)) {
      didAddSessionTombstone = true;
      sessionTombstones[previousSession.id] = Math.max(
        sessionTombstones[previousSession.id] ?? 0,
        Date.now(),
        getSessionPersistenceTimestamp(previousSession) + 1,
      );
    }
  }

  if (!didDecorateSession && !didAddSessionTombstone) {
    return nextState;
  }

  return {
    ...nextState,
    sessions,
    sessionTombstones: pruneTimestampRecord(sessionTombstones),
  };
};

const isOnlySessionComposerChanged = (
  localSession: ChatSessionRecord,
  baseSession: ChatSessionRecord,
): boolean => {
  return areShellFragmentsEqual(
    {
      ...localSession,
      draft: baseSession.draft,
      draftContextAttachments: baseSession.draftContextAttachments,
      composerUpdatedAt: baseSession.composerUpdatedAt,
      draftUpdatedAt: baseSession.draftUpdatedAt,
      draftAttachmentsUpdatedAt: baseSession.draftAttachmentsUpdatedAt,
      draftAttachmentAddedAt: baseSession.draftAttachmentAddedAt,
      draftAttachmentTombstones: baseSession.draftAttachmentTombstones,
      updatedAt: baseSession.updatedAt,
    },
    baseSession,
  );
};

const rebasePreHydrationComposerInput = (
  localState: ShellPersistedState,
  baseState: ShellPersistedState,
  hydratedState: ShellPersistedState,
): ShellPersistedState => {
  const baseActiveSession = baseState.sessions.find(
    (session) => session.id === baseState.activeSessionId,
  );
  const localActiveSession = localState.sessions.find(
    (session) => session.id === baseState.activeSessionId,
  );

  if (
    !baseActiveSession ||
    !localActiveSession ||
    !hasSessionComposerInput(localActiveSession) ||
    localState.sessions.length !== baseState.sessions.length ||
    !isOnlySessionComposerChanged(localActiveSession, baseActiveSession)
  ) {
    return localState;
  }

  const hydratedActiveSessionId =
    hydratedState.sessions.find(
      (session) => session.id === hydratedState.activeSessionId,
    )?.id ?? hydratedState.sessions[0]?.id;

  if (!hydratedActiveSessionId) {
    return localState;
  }

  return {
    ...localState,
    activeSessionId: hydratedActiveSessionId,
    sessions: hydratedState.sessions.map((session) => {
      if (session.id !== hydratedActiveSessionId) {
        return session;
      }

      const composerBase: ChatSessionRecord = {
        ...session,
        id: session.id,
        createdAt: 0,
        updatedAt: 0,
        draft: baseActiveSession.draft,
        draftContextAttachments:
          baseActiveSession.draftContextAttachments,
        composerUpdatedAt: 0,
        draftUpdatedAt: 0,
        draftAttachmentsUpdatedAt: 0,
        draftAttachmentAddedAt: {},
        draftAttachmentTombstones: {},
      };
      const localComposerSession: ChatSessionRecord = {
        ...composerBase,
        updatedAt: localActiveSession.updatedAt,
        draft: localActiveSession.draft,
        draftContextAttachments:
          localActiveSession.draftContextAttachments,
        composerUpdatedAt: localActiveSession.composerUpdatedAt,
        draftUpdatedAt: localActiveSession.draftUpdatedAt,
        draftAttachmentsUpdatedAt:
          localActiveSession.draftAttachmentsUpdatedAt,
        draftAttachmentAddedAt:
          localActiveSession.draftAttachmentAddedAt,
        draftAttachmentTombstones:
          localActiveSession.draftAttachmentTombstones,
      };
      const mergedComposer = mergeSessionComposerForPersistence(
        localComposerSession,
        composerBase,
        session,
      );

      return {
        ...session,
        ...mergedComposer,
        updatedAt: Math.max(session.updatedAt, localActiveSession.updatedAt),
      };
    }),
  };
};

const preserveCurrentComposerInput = (
  externalSession: ChatSessionRecord,
  currentSession: ChatSessionRecord,
  baseSession: ChatSessionRecord,
): ChatSessionRecord => {
  const mergedSession = {
    ...externalSession,
    ...mergeSessionComposerForPersistence(
      currentSession,
      baseSession,
      externalSession,
    ),
    updatedAt: Math.max(externalSession.updatedAt, currentSession.updatedAt),
  };

  return areShellFragmentsEqual(mergedSession, externalSession)
    ? externalSession
    : mergedSession;
};

const mergeExternalSessionWithCurrentState = (
  currentSession: ChatSessionRecord,
  baseSession: ChatSessionRecord,
  externalSession: ChatSessionRecord,
): ChatSessionRecord | null => {
  if (getLatestRunningTaskId(currentSession)) {
    return mergeRunningSessionWithExternalSnapshot(currentSession, externalSession);
  }

  const externalMessageRegression = hasMessageRegression(
    currentSession.messages,
    externalSession.messages,
  );

  if (externalMessageRegression) {
    const messageTombstones = mergeSessionMessageTombstones(
      currentSession,
      externalSession,
    );

    return preserveCurrentComposerInput(
      {
        ...externalSession,
        updatedAt: Math.max(
          externalSession.updatedAt,
          currentSession.updatedAt,
        ),
        messageTombstones,
        messages: filterMessageTombstones(
          mergeAppendOnlyMessages(
            currentSession.messages,
            currentSession.messages,
            currentSession.messages,
            externalSession.messages,
          ),
          messageTombstones,
        ),
      },
      currentSession,
      baseSession,
    );
  }

  if (
    getSessionPersistenceTimestamp(currentSession) >
    getSessionPersistenceTimestamp(externalSession)
  ) {
    return currentSession;
  }

  const composerPreservedSession = preserveCurrentComposerInput(
    externalSession,
    currentSession,
    baseSession,
  );

  return composerPreservedSession === externalSession
    ? null
    : composerPreservedSession;
};

const createSessionMutationComparable = (
  session: ChatSessionRecord,
): unknown => {
  return {
    historyClearedAt: session.historyClearedAt,
    archivedAt: session.archivedAt,
    pinnedAt: session.pinnedAt,
    specialSession: session.specialSession,
    workspace: session.workspace,
    provider: session.provider,
    model: session.model,
    mode: session.mode,
    reasoning: session.reasoning,
    draft: session.draft,
    draftContextAttachments: session.draftContextAttachments,
    manualTitle: session.manualTitle,
    tags: session.tags,
    messageTombstones: session.messageTombstones,
    messages: session.messages,
    promptHistory: session.promptHistory,
    promptContextHistory: session.promptContextHistory,
    sessionMemoryEnabled: session.sessionMemoryEnabled,
    useGlobalMemory: session.useGlobalMemory,
    uiControlEnabled: session.uiControlEnabled,
    sessionMemory: session.sessionMemory,
  };
};

const hasActualSessionMutationSinceBase = (
  session: ChatSessionRecord,
  baseSession: ChatSessionRecord,
): boolean => {
  return !areShellFragmentsEqual(
    createSessionMutationComparable(session),
    createSessionMutationComparable(baseSession),
  );
};

const preserveCurrentSessionState = (
  currentState: ShellPersistedState,
  baseState: ShellPersistedState,
  externalState: ShellPersistedState,
): ShellPersistedState => {
  const baseSessionsById = new Map(
    baseState.sessions.map((session) => [session.id, session]),
  );
  const externalSessionsById = new Map(
    externalState.sessions.map((session) => [session.id, session]),
  );
  const protectedSessions = new Map<string, ChatSessionRecord>();

  for (const currentSession of currentState.sessions) {
    const externalSession = externalSessionsById.get(currentSession.id);
    const baseSession = baseSessionsById.get(currentSession.id);

    if (!externalSession) {
      const sessionTombstone =
        externalState.sessionTombstones?.[currentSession.id] ?? 0;
      const hasPostBaseMutation =
        !baseSession ||
        hasActualSessionMutationSinceBase(currentSession, baseSession);

      if (
        hasPostBaseMutation &&
        (sessionTombstone === 0 ||
          getSessionPersistenceTimestamp(currentSession) > sessionTombstone)
      ) {
        protectedSessions.set(currentSession.id, currentSession);
      }
      continue;
    }

    const protectedSession = mergeExternalSessionWithCurrentState(
      currentSession,
      baseSession ?? currentSession,
      externalSession,
    );

    if (protectedSession) {
      protectedSessions.set(currentSession.id, protectedSession);
    }
  }

  if (protectedSessions.size === 0) {
    return externalState;
  }

  const nextSessionsById = new Map(
    externalState.sessions.map((session) => [session.id, session]),
  );

  for (const [sessionId, session] of protectedSessions) {
    nextSessionsById.set(sessionId, session);
  }

  const activeSessionId = nextSessionsById.has(currentState.activeSessionId)
    ? currentState.activeSessionId
    : nextSessionsById.has(externalState.activeSessionId)
      ? externalState.activeSessionId
      : sortSessionsByUpdatedAt([...nextSessionsById.values()])[0]?.id;

  return {
    ...externalState,
    activeSessionId: activeSessionId ?? externalState.activeSessionId,
    sessions: sortSessionsByUpdatedAt([...nextSessionsById.values()]),
  };
};

const getContextPackPersistenceTimestamp = (
  pack: SmartContextPack,
): number => {
  return Math.max(pack.updatedAt, pack.lastUsedAt ?? 0, pack.createdAt);
};

const sortContextPacksForPersistence = (
  packs: SmartContextPack[],
): SmartContextPack[] => {
  return [...packs].sort(
    (left, right) =>
      getContextPackPersistenceTimestamp(right) -
      getContextPackPersistenceTimestamp(left),
  );
};

const mergeContextPacksForPersistence = (
  localPacks: SmartContextPack[],
  basePacks: SmartContextPack[],
  latestPacks: SmartContextPack[],
): SmartContextPack[] => {
  const localPacksById = new Map(localPacks.map((pack) => [pack.id, pack]));
  const basePacksById = new Map(basePacks.map((pack) => [pack.id, pack]));
  const latestPacksById = new Map(latestPacks.map((pack) => [pack.id, pack]));
  const deletedPackIds = new Set<string>();

  for (const packId of basePacksById.keys()) {
    if (!localPacksById.has(packId)) {
      deletedPackIds.add(packId);
    }
  }

  const mergedPacksById = new Map<string, SmartContextPack>();

  for (const packId of new Set([
    ...latestPacksById.keys(),
    ...localPacksById.keys(),
  ])) {
    if (deletedPackIds.has(packId)) {
      continue;
    }

    const localPack = localPacksById.get(packId);
    const basePack = basePacksById.get(packId);
    const latestPack = latestPacksById.get(packId);

    if (!localPack) {
      if (latestPack) {
        mergedPacksById.set(packId, latestPack);
      }

      continue;
    }

    const localPackChanged =
      !basePack || !areShellFragmentsEqual(localPack, basePack);

    if (!localPackChanged && latestPack) {
      mergedPacksById.set(packId, latestPack);
      continue;
    }

    if (!latestPack) {
      if (basePack && areShellFragmentsEqual(localPack, basePack)) {
        continue;
      }

      mergedPacksById.set(packId, localPack);
      continue;
    }

    const localTimestamp = getContextPackPersistenceTimestamp(localPack);
    const latestTimestamp = getContextPackPersistenceTimestamp(latestPack);

    mergedPacksById.set(
      packId,
      localTimestamp >= latestTimestamp ? localPack : latestPack,
    );
  }

  return sortContextPacksForPersistence([...mergedPacksById.values()]);
};

const mergeQueuedMessageVersionForPersistence = (
  localMessage: ChatSessionQueuedMessage,
  _baseMessage: ChatSessionQueuedMessage | undefined,
  latestMessage: ChatSessionQueuedMessage,
): ChatSessionQueuedMessage => {
  const contentMessage =
    localMessage.contentUpdatedAt >= latestMessage.contentUpdatedAt
      ? localMessage
      : latestMessage;
  const orderMessage =
    localMessage.orderUpdatedAt >= latestMessage.orderUpdatedAt
      ? localMessage
      : latestMessage;
  const blockerMessage =
    localMessage.blockerUpdatedAt >= latestMessage.blockerUpdatedAt
      ? localMessage
      : latestMessage;
  const attachmentTombstones = Object.fromEntries(
    Object.entries({
      ...latestMessage.attachmentTombstones,
      ...localMessage.attachmentTombstones,
    })
      .map(([attachmentId, deletedAt]) => [
        attachmentId,
        Math.max(
          deletedAt,
          localMessage.attachmentTombstones[attachmentId] ?? 0,
          latestMessage.attachmentTombstones[attachmentId] ?? 0,
        ),
      ] as const)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 512),
  );
  const attachmentsById = new Map(
    [...latestMessage.contextAttachments, ...localMessage.contextAttachments]
      .filter(
        (attachment) => !(attachment.id in attachmentTombstones),
      )
      .map((attachment) => [attachment.id, attachment]),
  );
  const mergedMessage: ChatSessionQueuedMessage = {
    ...contentMessage,
    contextAttachments: [...attachmentsById.values()],
    attachmentTombstones,
    attachmentsUpdatedAt: Math.max(
      localMessage.attachmentsUpdatedAt,
      latestMessage.attachmentsUpdatedAt,
    ),
    blockerUpdatedAt: blockerMessage.blockerUpdatedAt,
    orderRank: orderMessage.orderRank,
    orderUpdatedAt: orderMessage.orderUpdatedAt,
    updatedAt: Math.max(localMessage.updatedAt, latestMessage.updatedAt),
  };

  delete mergedMessage.blockedByTaskId;
  if (blockerMessage.blockedByTaskId) {
    mergedMessage.blockedByTaskId = blockerMessage.blockedByTaskId;
  }

  return mergedMessage;
};

const createQueuedMessageSubmittedContentSet = (
  message: ChatSessionQueuedMessage,
): Set<string> => {
  return new Set(
    [
      message.visibleMessageContent,
      message.promptHistoryContent,
      message.task,
    ].flatMap((content) => {
      const normalizedContent = content?.trim();

      return normalizedContent ? [normalizedContent] : [];
    }),
  );
};

const wasQueuedMessageSubmittedInSessions = (
  message: ChatSessionQueuedMessage,
  sessions: readonly ChatSessionRecord[],
): boolean => {
  const submittedContent = createQueuedMessageSubmittedContentSet(message);
  const session = sessions.find((entry) => entry.id === message.sessionId);

  if (!session || submittedContent.size === 0) {
    return false;
  }

  return session.messages.some((entry) => {
    return (
      entry.role === "user" &&
      (entry.createdAt ?? 0) >= message.createdAt &&
      submittedContent.has(entry.content.trim())
    );
  });
};

const mergeQueuedSessionMessagesForPersistence = (
  localMessages: ChatSessionQueuedMessage[],
  localSessions: ChatSessionRecord[],
  baseMessages: ChatSessionQueuedMessage[],
  latestMessages: ChatSessionQueuedMessage[],
  latestSessions: ChatSessionRecord[],
  sessionIds: ReadonlySet<string>,
): ChatSessionQueuedMessage[] => {
  const localMessagesById = new Map(
    localMessages.map((message) => [message.id, message]),
  );
  const baseMessagesById = new Map(
    baseMessages.map((message) => [message.id, message]),
  );
  const latestMessagesById = new Map(
    latestMessages.map((message) => [message.id, message]),
  );
  const deletedMessageIds = new Set<string>();

  for (const [messageId, baseMessage] of baseMessagesById.entries()) {
    if (
      !localMessagesById.has(messageId) ||
      (!latestMessagesById.has(messageId) &&
        wasQueuedMessageSubmittedInSessions(baseMessage, latestSessions))
    ) {
      deletedMessageIds.add(messageId);
    }
  }

  const mergedMessagesById = new Map<string, ChatSessionQueuedMessage>();

  for (const messageId of new Set([
    ...latestMessagesById.keys(),
    ...localMessagesById.keys(),
  ])) {
    if (deletedMessageIds.has(messageId)) {
      continue;
    }

    const localMessage = localMessagesById.get(messageId);
    const latestMessage = latestMessagesById.get(messageId);

    if (!localMessage) {
      if (latestMessage && sessionIds.has(latestMessage.sessionId)) {
        mergedMessagesById.set(messageId, latestMessage);
      }
      continue;
    }

    if (!latestMessage) {
      const baseMessage = baseMessagesById.get(messageId);

      if (
        baseMessage &&
        areShellFragmentsEqual(localMessage, baseMessage)
      ) {
        continue;
      }

      if (sessionIds.has(localMessage.sessionId)) {
        mergedMessagesById.set(messageId, localMessage);
      }
      continue;
    }

    const mergedMessage = mergeQueuedMessageVersionForPersistence(
      localMessage,
      baseMessagesById.get(messageId),
      latestMessage,
    );

    if (sessionIds.has(mergedMessage.sessionId)) {
      mergedMessagesById.set(messageId, mergedMessage);
    }
  }

  return [...mergedMessagesById.values()].sort((left, right) => {
    return (
      left.sessionId.localeCompare(right.sessionId) ||
      left.orderRank - right.orderRank ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id)
    );
  });
};

export const mergeShellStateForPersistence = (
  localState: ShellPersistedState,
  baseState: ShellPersistedState,
  latestState: ShellPersistedState,
): ShellPersistedState => {
  const localSessionsById = new Map(
    localState.sessions.map((session) => [session.id, session]),
  );
  const baseSessionsById = new Map(
    baseState.sessions.map((session) => [session.id, session]),
  );
  const latestSessionsById = new Map(
    latestState.sessions.map((session) => [session.id, session]),
  );
  const sessionTombstones = mergeTimestampRecords(
    baseState.sessionTombstones,
    latestState.sessionTombstones,
    localState.sessionTombstones,
  );
  const explicitLocalDeletionIds = new Set<string>();
  const explicitLatestDeletionIds = new Set<string>();

  for (const [sessionId, baseSession] of baseSessionsById) {
    if (!localSessionsById.has(sessionId)) {
      if (localState.sessionTombstones?.[sessionId] !== undefined) {
        explicitLocalDeletionIds.add(sessionId);
      }

      sessionTombstones[sessionId] = Math.max(
        sessionTombstones[sessionId] ?? 0,
        localState.sessionTombstones?.[sessionId] ?? 0,
        getSessionPersistenceTimestamp(baseSession) + 1,
      );
    }

    if (!latestSessionsById.has(sessionId)) {
      if (latestState.sessionTombstones?.[sessionId] !== undefined) {
        explicitLatestDeletionIds.add(sessionId);
      }

      sessionTombstones[sessionId] = Math.max(
        sessionTombstones[sessionId] ?? 0,
        latestState.sessionTombstones?.[sessionId] ?? 0,
        getSessionPersistenceTimestamp(baseSession) + 1,
      );
    }
  }

  const mergedSessionsById = new Map<string, ChatSessionRecord>();

  for (const sessionId of new Set([
    ...latestSessionsById.keys(),
    ...localSessionsById.keys(),
  ])) {
    const localSession = localSessionsById.get(sessionId);
    const baseSession = baseSessionsById.get(sessionId);
    const latestSession = latestSessionsById.get(sessionId);

    if (!localSession) {
      if (latestSession) {
        const latestHasPostBaseMutation =
          !baseSession ||
          hasActualSessionMutationSinceBase(latestSession, baseSession);
        const deletionTimestamp = sessionTombstones[sessionId] ?? 0;

        if (
          !baseSession ||
          (latestHasPostBaseMutation &&
            (!explicitLocalDeletionIds.has(sessionId) ||
              getSessionPersistenceTimestamp(latestSession) >
                deletionTimestamp))
        ) {
          mergedSessionsById.set(sessionId, latestSession);
        }
      }

      continue;
    }

    if (!latestSession) {
      const localHasPostBaseMutation =
        !baseSession ||
        hasActualSessionMutationSinceBase(localSession, baseSession);
      const deletionTimestamp = sessionTombstones[sessionId] ?? 0;

      if (
        !baseSession ||
        (localHasPostBaseMutation &&
          (!explicitLatestDeletionIds.has(sessionId) ||
            getSessionPersistenceTimestamp(localSession) > deletionTimestamp))
      ) {
        mergedSessionsById.set(sessionId, localSession);
      }
      continue;
    }

    const localTimestamp = getSessionPersistenceTimestamp(localSession);
    const latestTimestamp = getSessionPersistenceTimestamp(latestSession);

    const primarySession =
      localTimestamp >= latestTimestamp ? localSession : latestSession;

    if (!baseSession) {
      mergedSessionsById.set(
        sessionId,
        mergeNewSessionConcurrentFields(
          primarySession,
          localSession,
          latestSession,
        ),
      );
      continue;
    }

    const runtimeMergedSession = mergeSessionRuntimeSelection(
      primarySession,
      localSession,
      baseSession,
      latestSession,
    );

    mergedSessionsById.set(
      sessionId,
      mergeSessionConcurrentFields(
        runtimeMergedSession,
        localSession,
        baseSession,
        latestSession,
      ),
    );
  }

  const sessions = sortSessionsByUpdatedAt([...mergedSessionsById.values()]);
  const sessionIds = new Set(sessions.map((session) => session.id));
  const localActiveSessionUpdatedAt = localState.activeSessionUpdatedAt ?? 0;
  const latestActiveSessionUpdatedAt = latestState.activeSessionUpdatedAt ?? 0;
  const preferLocalActiveSession =
    localActiveSessionUpdatedAt >= latestActiveSessionUpdatedAt;
  const preferredActiveSessionId = preferLocalActiveSession
    ? localState.activeSessionId
    : latestState.activeSessionId;
  const activeSessionId = sessionIds.has(preferredActiveSessionId)
    ? preferredActiveSessionId
    : sessionIds.has(latestState.activeSessionId)
      ? latestState.activeSessionId
      : sessions[0]?.id;
  const activeSessionUpdatedAt =
    activeSessionId === preferredActiveSessionId
      ? preferLocalActiveSession
        ? localActiveSessionUpdatedAt
        : latestActiveSessionUpdatedAt
      : Math.max(
          Date.now(),
          localActiveSessionUpdatedAt,
          latestActiveSessionUpdatedAt,
        );
  const localRecentWorkspacesChanged = !areShellFragmentsEqual(
    localState.recentWorkspaces,
    baseState.recentWorkspaces,
  );
  const latestRecentWorkspacesChanged = !areShellFragmentsEqual(
    latestState.recentWorkspaces,
    baseState.recentWorkspaces,
  );
  const queuedMessageTombstones = Object.fromEntries(
    Object.entries({
      ...latestState.queuedMessageTombstones,
      ...localState.queuedMessageTombstones,
    })
      .map(([messageId, deletedAt]) => [
        messageId,
        Math.max(
          deletedAt,
          latestState.queuedMessageTombstones[messageId] ?? 0,
          localState.queuedMessageTombstones[messageId] ?? 0,
        ),
      ] as const)
      .sort((left, right) => right[1] - left[1])
      .slice(0, 2_048),
  );
  const mergedState: ShellPersistedState = {
    ...latestState,
    version: 2,
    activeSessionId: activeSessionId ?? latestState.activeSessionId,
    activeSessionUpdatedAt,
    sessions,
    sessionTombstones: pruneTimestampRecord(sessionTombstones),
    queuedSessionMessages: mergeQueuedSessionMessagesForPersistence(
      localState.queuedSessionMessages,
      localState.sessions,
      baseState.queuedSessionMessages,
      latestState.queuedSessionMessages,
      latestState.sessions,
      sessionIds,
    ).filter((message) => !(message.id in queuedMessageTombstones)),
    queuedMessageTombstones,
    handledRemoteCommandIds: [
      ...new Set([
        ...latestState.handledRemoteCommandIds,
        ...localState.handledRemoteCommandIds,
      ]),
    ].slice(-512),
    contextPacks: mergeContextPacksForPersistence(
      localState.contextPacks,
      baseState.contextPacks,
      latestState.contextPacks,
    ),
    recentWorkspaces:
      localRecentWorkspacesChanged && latestRecentWorkspacesChanged
        ? mergeRecentWorkspacesForPersistence(
            localState.recentWorkspaces,
            baseState.recentWorkspaces,
            latestState.recentWorkspaces,
          )
        : localRecentWorkspacesChanged
          ? localState.recentWorkspaces
          : latestState.recentWorkspaces,
    voice: areShellFragmentsEqual(localState.voice, baseState.voice)
      ? latestState.voice
      : localState.voice,
    lastSelectedProvider:
      localState.lastSelectedProvider === baseState.lastSelectedProvider
        ? latestState.lastSelectedProvider
        : localState.lastSelectedProvider,
    lastSelectedModelByProvider: areShellFragmentsEqual(
      localState.lastSelectedModelByProvider,
      baseState.lastSelectedModelByProvider,
    )
      ? latestState.lastSelectedModelByProvider
      : localState.lastSelectedModelByProvider,
    lastSelectedSessionMemoryEnabled:
      localState.lastSelectedSessionMemoryEnabled ===
      baseState.lastSelectedSessionMemoryEnabled
        ? latestState.lastSelectedSessionMemoryEnabled
        : localState.lastSelectedSessionMemoryEnabled,
    lastSelectedUseGlobalMemory:
      localState.lastSelectedUseGlobalMemory ===
      baseState.lastSelectedUseGlobalMemory
        ? latestState.lastSelectedUseGlobalMemory
        : localState.lastSelectedUseGlobalMemory,
    lastSelectedUiControlEnabled:
      localState.lastSelectedUiControlEnabled ===
      baseState.lastSelectedUiControlEnabled
        ? latestState.lastSelectedUiControlEnabled
        : localState.lastSelectedUiControlEnabled,
  };

  if (localState.lastSelectedMode !== baseState.lastSelectedMode) {
    if (localState.lastSelectedMode) {
      mergedState.lastSelectedMode = localState.lastSelectedMode;
    } else {
      delete mergedState.lastSelectedMode;
    }
  } else if (latestState.lastSelectedMode) {
    mergedState.lastSelectedMode = latestState.lastSelectedMode;
  } else {
    delete mergedState.lastSelectedMode;
  }

  if (localState.lastSelectedReasoning !== baseState.lastSelectedReasoning) {
    if (localState.lastSelectedReasoning) {
      mergedState.lastSelectedReasoning = localState.lastSelectedReasoning;
    } else {
      delete mergedState.lastSelectedReasoning;
    }
  } else if (latestState.lastSelectedReasoning) {
    mergedState.lastSelectedReasoning = latestState.lastSelectedReasoning;
  } else {
    delete mergedState.lastSelectedReasoning;
  }

  if (localState.lastRecoveredLaunchId !== baseState.lastRecoveredLaunchId) {
    if (localState.lastRecoveredLaunchId) {
      mergedState.lastRecoveredLaunchId = localState.lastRecoveredLaunchId;
    } else {
      delete mergedState.lastRecoveredLaunchId;
    }
  } else if (latestState.lastRecoveredLaunchId) {
    mergedState.lastRecoveredLaunchId = latestState.lastRecoveredLaunchId;
  } else {
    delete mergedState.lastRecoveredLaunchId;
  }

  return mergedState;
};

export const mergeShellStateFromExternalUpdate = (
  currentState: ShellPersistedState,
  baseState: ShellPersistedState,
  externalState: ShellPersistedState,
  hasUnpersistedLocalChanges: boolean,
): ShellPersistedState => {
  if (hasUnpersistedLocalChanges) {
    return mergeShellStateForPersistence(currentState, baseState, externalState);
  }

  return preserveCurrentSessionState(currentState, baseState, externalState);
};

export interface ChatSessionShellStateController {
  shellState: ShellPersistedState;
  activeSessionId: string;
  activeSession: ChatSessionRecord;
  visibleMessages: ChatSessionMessage[];
  filteredSessions: ChatSessionRecord[];
  hasHydrated: boolean;
  sessionScopeFilter: SessionScopeFilter;
  sessionStatusFilters: SessionStatusFilterSelection;
  sessionSearchQuery: string;
  sessionProjectFilter: string;
  sessionTagFilters: string[];
  sessionHistoryIndex: SessionHistoryIndex;
  sessionProjectFacets: SessionHistoryProjectFacet[];
  sessionTagFacets: SessionHistoryTagFacet[];
  catalogOpen: boolean;
  settingsSection: SettingsSection;
  isRenamingSession: boolean;
  renameValue: string;
  promptHistoryIndex: number | null;
  draftBeforeHistory: string;
  bottomRef: RefObject<HTMLDivElement | null>;
  showScrollToNewestButton: boolean;
  scrollToNewest: () => void;
  setCatalogOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsSection: Dispatch<SetStateAction<SettingsSection>>;
  setActiveSessionId: (sessionId: string) => void;
  setSessionScopeFilter: Dispatch<SetStateAction<SessionScopeFilter>>;
  setSessionStatusFilters: Dispatch<
    SetStateAction<SessionStatusFilterSelection>
  >;
  setSessionSearchQuery: Dispatch<SetStateAction<string>>;
  setSessionProjectFilter: Dispatch<SetStateAction<string>>;
  setSessionTagFilters: Dispatch<SetStateAction<string[]>>;
  setIsRenamingSession: Dispatch<SetStateAction<boolean>>;
  setRenameValue: Dispatch<SetStateAction<string>>;
  setPromptHistoryIndex: Dispatch<SetStateAction<number | null>>;
  setDraftBeforeHistory: Dispatch<SetStateAction<string>>;
  applyShellState: (updater: SetStateAction<ShellPersistedState>) => void;
  flushPersistence: () => Promise<void>;
  updateActiveSession: (
    updater: (session: ChatSessionRecord) => ChatSessionRecord,
  ) => void;
  updateSessionById: (
    sessionId: string,
    updater: (session: ChatSessionRecord) => ChatSessionRecord,
  ) => void;
  updateSessionByIdTransient: (
    sessionId: string,
    updater: (session: ChatSessionRecord) => ChatSessionRecord,
  ) => void;
  setDraftValue: Dispatch<SetStateAction<string>>;
}

export interface UseChatSessionShellStateOptions {
  includeHistoryContent?: boolean;
  isolateActiveSession?: boolean;
  persistActiveSession?: boolean;
  trackSessionReads?: boolean;
}

export const useChatSessionShellState = (
  options: UseChatSessionShellStateOptions = {},
): ChatSessionShellStateController => {
  const isolateActiveSession = options.isolateActiveSession !== false;
  const includeHistoryContent = options.includeHistoryContent !== false;
  const persistActiveSession = options.persistActiveSession !== false;
  const trackSessionReads = options.trackSessionReads !== false;
  const initialShellStateRef = useRef<ShellPersistedState>(
    createInitialShellState(),
  );
  const [shellState, setShellState] = useState<ShellPersistedState>(
    initialShellStateRef.current,
  );
  const [activeSessionId, setActiveSessionIdState] = useState<string>(
    initialShellStateRef.current.activeSessionId,
  );
  const [hasHydrated, setHasHydrated] = useState(false);
  const [hydrationRetrySequence, setHydrationRetrySequence] = useState(0);
  const [persistenceSignal, setPersistenceSignal] = useState(0);
  const [sessionScopeFilter, setSessionScopeFilter] =
    useState<SessionScopeFilter>("open");
  const [sessionStatusFilters, setSessionStatusFilters] =
    useState<SessionStatusFilterSelection>(["any"]);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [sessionProjectFilter, setSessionProjectFilter] = useState(
    ALL_SESSION_PROJECTS_FILTER,
  );
  const [sessionTagFilters, setSessionTagFilters] = useState<string[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("providers");
  const [isRenamingSession, setIsRenamingSession] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const renameSessionIdRef = useRef(initialShellStateRef.current.activeSessionId);
  const [promptHistoryIndex, setPromptHistoryIndex] = useState<number | null>(
    null,
  );
  const [draftBeforeHistory, setDraftBeforeHistory] = useState("");
  const [readAttentionSequence, setReadAttentionSequence] = useState(0);
  const didMutateBeforeHydrationRef = useRef(false);
  const shellStateRef = useRef(shellState);
  const durableShellStateRef = useRef(initialShellStateRef.current);
  const lastPersistedShellStateRef = useRef(initialShellStateRef.current);
  const lastPersistedStoreRevisionRef = useRef(0);
  const localMutationRevisionRef = useRef(0);
  const transientMutationRevisionRef = useRef(0);
  const persistedMutationRevisionRef = useRef(0);
  const persistInFlightRef = useRef(false);
  const persistQueuedRef = useRef(false);
  const persistTimerRef = useRef<number | null>(null);
  const persistRetryTimerRef = useRef<number | null>(null);
  const persistRetryAttemptRef = useRef(0);
  const persistenceWaitersRef = useRef<
    Array<{
      targetRevision: number;
      resolve: () => void;
      reject: (error: Error) => void;
    }>
  >([]);
  const externalLoadSequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const sessionHistoryIndexEntryCacheRef =
    useRef<SessionHistoryIndexEntryCache>(new Map());

  const resolvedActiveSessionId = useMemo(() => {
    if (!isolateActiveSession) {
      if (
        shellState.sessions.some(
          (session) => session.id === shellState.activeSessionId,
        )
      ) {
        return shellState.activeSessionId;
      }

      return shellState.sessions[0]?.id ?? activeSessionId;
    }

    if (shellState.sessions.some((session) => session.id === activeSessionId)) {
      return activeSessionId;
    }

    if (
      shellState.sessions.some(
        (session) => session.id === shellState.activeSessionId,
      )
    ) {
      return shellState.activeSessionId;
    }

    return shellState.sessions[0]?.id ?? activeSessionId;
  }, [
    activeSessionId,
    isolateActiveSession,
    shellState.activeSessionId,
    shellState.sessions,
  ]);

  const rawActiveSession =
    shellState.sessions.find((session) => session.id === resolvedActiveSessionId) ??
    shellState.sessions[0];
  const activeSession = rawActiveSession;

  const visibleMessages = useMemo(() => {
    return createVisibleConversationMessages(activeSession.messages);
  }, [activeSession.messages]);
  const newestMessageScroll = useNewestMessageScroll({
    resetKey: activeSession.id,
    contentKey: visibleMessages,
  });

  const sortedSessions = useMemo(() => {
    return sortSessionsByUpdatedAt(shellState.sessions);
  }, [shellState.sessions]);

  const sessionHistoryIndex = useMemo(() => {
    return createSessionHistoryIndex(
      sortedSessions,
      sessionHistoryIndexEntryCacheRef.current,
      {
        includeContent:
          includeHistoryContent && sessionSearchQuery.trim().length > 0,
      },
    );
  }, [includeHistoryContent, sessionSearchQuery, sortedSessions]);

  const filteredSessions = useMemo(() => {
    return filterSessionHistoryIndex(sessionHistoryIndex, {
      scope: sessionScopeFilter,
      status: sessionStatusFilters,
      searchQuery: sessionSearchQuery,
      projectFilter: sessionProjectFilter,
      tagFilters: sessionTagFilters,
    }).sessions;
  }, [
    sessionHistoryIndex,
    sessionProjectFilter,
    sessionScopeFilter,
    sessionSearchQuery,
    sessionStatusFilters,
    sessionTagFilters,
  ]);

  const applyShellState = useCallback(
    (updater: SetStateAction<ShellPersistedState>): void => {
      const previousState = shellStateRef.current;
      let nextState =
        typeof updater === "function" ? updater(previousState) : updater;

      if (nextState === previousState) {
        return;
      }

      if (nextState.activeSessionId !== previousState.activeSessionId) {
        nextState = persistActiveSession
          ? {
              ...nextState,
              activeSessionUpdatedAt: Date.now(),
            }
          : {
              ...nextState,
              activeSessionId: previousState.activeSessionId,
              activeSessionUpdatedAt: previousState.activeSessionUpdatedAt,
            };
      }

      nextState = applyLocalMutationMetadata(previousState, nextState);

      if (!hasHydrated) {
        didMutateBeforeHydrationRef.current = true;
      }

      localMutationRevisionRef.current += 1;
      shellStateRef.current = nextState;
      durableShellStateRef.current = nextState;
      setShellState(nextState);
    },
    [hasHydrated, persistActiveSession],
  );

  const applyTransientShellState = useCallback(
    (updater: SetStateAction<ShellPersistedState>): void => {
      const previousState = shellStateRef.current;
      let nextState =
        typeof updater === "function" ? updater(previousState) : updater;

      if (nextState === previousState) {
        return;
      }

      if (nextState.activeSessionId !== previousState.activeSessionId) {
        nextState = {
          ...nextState,
          activeSessionId: previousState.activeSessionId,
          activeSessionUpdatedAt: previousState.activeSessionUpdatedAt,
        };
      }

      transientMutationRevisionRef.current += 1;
      shellStateRef.current = nextState;
      setShellState(nextState);
    },
    [],
  );

  const clearScheduledShellStatePersistence = useCallback((): void => {
    if (typeof window !== "undefined") {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
      }

      if (persistRetryTimerRef.current !== null) {
        window.clearTimeout(persistRetryTimerRef.current);
      }
    }

    persistTimerRef.current = null;
    persistRetryTimerRef.current = null;
  }, []);

  const settlePersistenceWaiters = useCallback((error?: unknown): void => {
    const remainingWaiters: typeof persistenceWaitersRef.current = [];
    const normalizedError = error
      ? error instanceof Error
        ? error
        : new Error(String(error))
      : null;

    for (const waiter of persistenceWaitersRef.current) {
      if (normalizedError) {
        waiter.reject(normalizedError);
      } else if (
        persistedMutationRevisionRef.current >= waiter.targetRevision
      ) {
        waiter.resolve();
      } else {
        remainingWaiters.push(waiter);
      }
    }

    persistenceWaitersRef.current = remainingWaiters;
  }, []);

  const persistShellState = useCallback(async (): Promise<void> => {
    if (persistInFlightRef.current) {
      persistQueuedRef.current = true;
      return;
    }

    persistInFlightRef.current = true;

    try {
      let conflictAttempts = 0;

      do {
        persistQueuedRef.current = false;

        const targetRevision = localMutationRevisionRef.current;
        const targetTransientRevision = transientMutationRevisionRef.current;

        if (persistedMutationRevisionRef.current >= targetRevision) {
          continue;
        }

        let latestPersistedState = lastPersistedShellStateRef.current;
        let latestStoreRevision = lastPersistedStoreRevisionRef.current;

        if (!canUseTauriStore()) {
          const latestSnapshot = await loadShellStateSnapshot(
            latestPersistedState,
          );
          latestPersistedState = normalizeShellState(latestSnapshot.state);
          latestStoreRevision = latestSnapshot.revision;
        }

        let mergedShellState = durableShellStateRef.current;
        let commit: ShellStateCompareAndSwapResult<ShellPersistedState>;

        if (canUseTauriStore()) {
          const observedRevision = await loadShellStateRevision();
          if (observedRevision !== latestStoreRevision) {
            const latestSnapshot = await loadShellStateSnapshot(
              lastPersistedShellStateRef.current,
            );
            latestPersistedState = normalizeShellState(latestSnapshot.state);
            latestStoreRevision = latestSnapshot.revision;
          }
        }

        while (true) {
          mergedShellState = normalizeShellState(
            mergeShellStateForPersistence(
              durableShellStateRef.current,
              lastPersistedShellStateRef.current,
              latestPersistedState,
            ),
          );
          commit = await compareAndSwapShellStatePatch(
            latestStoreRevision,
            createShellStatePatch(latestPersistedState, mergedShellState),
            mergedShellState,
          );

          if (commit.committed) {
            break;
          }

          conflictAttempts += 1;

          if (conflictAttempts >= MAX_SHELL_STATE_CONFLICT_RETRIES) {
            throw new Error(
              "Shell state kept changing in another window and could not be committed.",
            );
          }

          if (commit.state === undefined) {
            throw new Error(
              "Shell-state conflict response omitted the latest state.",
            );
          }

          latestPersistedState = normalizeShellState(commit.state);
          latestStoreRevision = commit.revision;
          await waitForShellStateConflictRetry(conflictAttempts);
        }

        conflictAttempts = 0;
        persistRetryAttemptRef.current = 0;

        const committedShellState = mergedShellState;
        lastPersistedShellStateRef.current = committedShellState;
        lastPersistedStoreRevisionRef.current = commit.revision;
        persistedMutationRevisionRef.current = targetRevision;
        settlePersistenceWaiters();

        if (localMutationRevisionRef.current === targetRevision) {
          durableShellStateRef.current = committedShellState;
        }

        if (
          mountedRef.current &&
          localMutationRevisionRef.current === targetRevision &&
          transientMutationRevisionRef.current === targetTransientRevision &&
          shellStateRef.current !== committedShellState
        ) {
          shellStateRef.current = committedShellState;
          setShellState(committedShellState);
        }

        void broadcastShellStateChanged(commit.revision);
      } while (
        persistQueuedRef.current ||
        persistedMutationRevisionRef.current < localMutationRevisionRef.current
      );
    } catch (error) {
      if (!mountedRef.current) {
        persistQueuedRef.current = false;
        return;
      }

      persistQueuedRef.current = true;
      persistRetryAttemptRef.current += 1;
      console.error("Failed to persist shell state", error);
      settlePersistenceWaiters(error);

      if (
        typeof window !== "undefined" &&
        persistRetryTimerRef.current === null
      ) {
        const retryDelay = getShellStateRetryDelay(
          persistRetryAttemptRef.current - 1,
        );
        persistRetryTimerRef.current = window.setTimeout(() => {
          persistRetryTimerRef.current = null;
          if (mountedRef.current) {
            setPersistenceSignal((revision) => revision + 1);
          }
        }, retryDelay);
      }
    } finally {
      persistInFlightRef.current = false;
    }
  }, [settlePersistenceWaiters]);

  const scheduleShellStatePersistence = useCallback((): void => {
    if (persistTimerRef.current !== null) {
      return;
    }

    if (typeof window === "undefined") {
      void persistShellState();
      return;
    }

    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      void persistShellState();
    }, SHELL_STATE_PERSIST_DELAY_MS);
  }, [persistShellState]);

  const flushShellStatePersistence = useCallback(async (): Promise<void> => {
    clearScheduledShellStatePersistence();

    const targetRevision = localMutationRevisionRef.current;

    if (persistedMutationRevisionRef.current >= targetRevision) {
      return;
    }

    const persistencePromise = new Promise<void>((resolve, reject) => {
      persistenceWaitersRef.current.push({
        targetRevision,
        resolve,
        reject,
      });
    });

    void persistShellState();
    await persistencePromise;
  }, [clearScheduledShellStatePersistence, persistShellState]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      settlePersistenceWaiters(
        new Error("Shell state persistence stopped before the write completed."),
      );
    };
  }, [settlePersistenceWaiters]);

  useEffect(() => {
    shellStateRef.current = shellState;
  }, [shellState]);

  useEffect(() => {
    document.documentElement.classList.add("dark");

    return () => {
      document.documentElement.classList.remove("dark");
    };
  }, []);

  useEffect(() => {
    if (!activeSession || resolvedActiveSessionId === activeSessionId) {
      return;
    }

    setActiveSessionIdState(resolvedActiveSessionId);
  }, [activeSession, activeSessionId, resolvedActiveSessionId]);

  useEffect(() => {
    if (sessionTagFilters.length === 0) {
      return;
    }

    const availableTags = new Set(
      sessionHistoryIndex.tags.map((tag) => tag.label.toLowerCase()),
    );
    const nextTagFilters = sessionTagFilters.filter((tag) =>
      availableTags.has(tag.toLowerCase()),
    );

    if (nextTagFilters.length !== sessionTagFilters.length) {
      setSessionTagFilters(nextTagFilters);
    }
  }, [sessionHistoryIndex.tags, sessionTagFilters]);

  useEffect(() => {
    if (sessionProjectFilter === ALL_SESSION_PROJECTS_FILTER) {
      return;
    }

    const availableProjects = new Set(
      sessionHistoryIndex.projects.map((project) => project.id),
    );

    if (!availableProjects.has(sessionProjectFilter)) {
      setSessionProjectFilter(ALL_SESSION_PROJECTS_FILTER);
    }
  }, [sessionHistoryIndex.projects, sessionProjectFilter]);

  useEffect(() => {
    let cancelled = false;
    let didHydrate = false;
    let retryTimer: number | null = null;

    void Promise.all([
      loadShellStateSnapshot(initialShellStateRef.current),
      loadDesktopLaunchId(),
      loadActiveDesktopTaskIds(),
    ])
      .then(([snapshot, launchId, activeDesktopTaskIds]) => {
        if (cancelled) {
          return;
        }

        didHydrate = true;

        const value = snapshot.state;
        const normalizedShellState = normalizeShellState(value);
        const recoveredShellState = recoverInterruptedTasksForLaunch(
          normalizedShellState,
          launchId,
          Date.now(),
          activeDesktopTaskIds ?? undefined,
        );
        lastPersistedShellStateRef.current = normalizedShellState;
        lastPersistedStoreRevisionRef.current = snapshot.revision;

        if (!areShellFragmentsEqual(value, normalizedShellState)) {
          localMutationRevisionRef.current += 1;
        }

        if (didMutateBeforeHydrationRef.current) {
          const preHydrationShellState = rebasePreHydrationComposerInput(
            shellStateRef.current,
            initialShellStateRef.current,
            recoveredShellState,
          );
          const mergedShellState = mergeShellStateForPersistence(
            preHydrationShellState,
            initialShellStateRef.current,
            recoveredShellState,
          );

          if (!areShellFragmentsEqual(mergedShellState, normalizedShellState)) {
            localMutationRevisionRef.current += 1;
          }

          shellStateRef.current = mergedShellState;
          durableShellStateRef.current = mergedShellState;
          setShellState(mergedShellState);
          return;
        }

        if (
          value === initialShellStateRef.current &&
          areShellFragmentsEqual(
            recoveredShellState,
            initialShellStateRef.current,
          )
        ) {
          return;
        }

        if (!areShellFragmentsEqual(recoveredShellState, normalizedShellState)) {
          localMutationRevisionRef.current += 1;
        }

        shellStateRef.current = recoveredShellState;
        durableShellStateRef.current = recoveredShellState;
        setShellState(recoveredShellState);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error("Failed to hydrate shell state", error);
        retryTimer = window.setTimeout(() => {
          setHydrationRetrySequence((sequence) => sequence + 1);
        }, getShellStateRetryDelay(hydrationRetrySequence));
      })
      .finally(() => {
        if (!cancelled && didHydrate) {
          setHasHydrated(true);
        }
      });

    return () => {
      cancelled = true;

      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [hydrationRetrySequence]);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    if (
      localMutationRevisionRef.current <=
      persistedMutationRevisionRef.current
    ) {
      return;
    }

    scheduleShellStatePersistence();
  }, [
    hasHydrated,
    persistenceSignal,
    scheduleShellStatePersistence,
    shellState,
  ]);

  useEffect(() => {
    return () => {
      clearScheduledShellStatePersistence();
      void persistShellState();
    };
  }, [clearScheduledShellStatePersistence, persistShellState]);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    const flushWhenHidden = (): void => {
      if (document.visibilityState === "hidden") {
        void flushShellStatePersistence().catch((error) => {
          console.error("Failed to flush shell state while hidden", error);
        });
      }
    };
    const flushOnPageHide = (): void => {
      void flushShellStatePersistence().catch((error) => {
        console.error("Failed to flush shell state while closing", error);
      });
    };

    window.addEventListener("pagehide", flushOnPageHide);
    document.addEventListener("visibilitychange", flushWhenHidden);

    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [flushShellStatePersistence, hasHydrated]);

  useEffect(() => {
    if (!hasHydrated) {
      return;
    }

    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    const reconcileLatestShellState = async (
      revisionHint?: number,
    ): Promise<void> => {
      if (document.visibilityState === "hidden") {
        return;
      }

      const loadSequence = externalLoadSequenceRef.current + 1;
      externalLoadSequenceRef.current = loadSequence;

      try {
        const latestRevision =
          revisionHint ?? (await loadShellStateRevision());
        if (
          disposed ||
          loadSequence !== externalLoadSequenceRef.current ||
          latestRevision <= lastPersistedStoreRevisionRef.current
        ) {
          return;
        }

        const snapshot = await loadShellStateSnapshot(
          initialShellStateRef.current,
        );
        if (disposed || loadSequence !== externalLoadSequenceRef.current) {
          return;
        }
        if (snapshot.revision <= lastPersistedStoreRevisionRef.current) {
          return;
        }

        const normalizedShellState = normalizeShellState(snapshot.state);
        const previousPersistedShellState =
          lastPersistedShellStateRef.current;
        const hasUnpersistedLocalChanges =
          localMutationRevisionRef.current >
          persistedMutationRevisionRef.current;
        const nextShellState = mergeShellStateFromExternalUpdate(
          shellStateRef.current,
          previousPersistedShellState,
          normalizedShellState,
          hasUnpersistedLocalChanges,
        );

        const nextStateNeedsPersistence = !areShellFragmentsEqual(
          nextShellState,
          normalizedShellState,
        );

        lastPersistedShellStateRef.current = normalizedShellState;
        lastPersistedStoreRevisionRef.current = snapshot.revision;

        if (nextStateNeedsPersistence) {
          localMutationRevisionRef.current += 1;
        }

        if (!areShellFragmentsEqual(shellStateRef.current, nextShellState)) {
          shellStateRef.current = nextShellState;
          durableShellStateRef.current = nextShellState;
          setShellState(nextShellState);
        } else if (nextStateNeedsPersistence) {
          setPersistenceSignal((revision) => revision + 1);
        }
      } catch (error) {
        if (!disposed) {
          console.error("Failed to load an external shell-state update", error);
        }
      }
    };

    void subscribeToShellStateChanged((payload) => {
      if (payload.originWindowLabel !== getCurrentShellWindowLabel()) {
        void reconcileLatestShellState(payload.revision);
      }
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
          return;
        }

        unsubscribe = unlisten;
      })
      .catch((error) => {
        if (!disposed) {
          console.error("Failed to subscribe to shell-state updates", error);
        }
      });
    const reconciliationInterval = window.setInterval(() => {
      void reconcileLatestShellState();
    }, SHELL_STATE_RECONCILIATION_INTERVAL_MS);
    const reconcileWhenVisible = (): void => {
      if (document.visibilityState === "visible") {
        void reconcileLatestShellState();
      }
    };
    document.addEventListener("visibilitychange", reconcileWhenVisible);

    return () => {
      disposed = true;
      unsubscribe?.();
      window.clearInterval(reconciliationInterval);
      document.removeEventListener("visibilitychange", reconcileWhenVisible);
    };
  }, [hasHydrated]);

  useEffect(() => {
    setPromptHistoryIndex(null);
    setDraftBeforeHistory("");
  }, [activeSession.id]);

  useEffect(() => {
    const sessionChanged = renameSessionIdRef.current !== activeSession.id;
    renameSessionIdRef.current = activeSession.id;

    if (sessionChanged) {
      setIsRenamingSession(false);
      setRenameValue(getSessionTitle(activeSession));
      return;
    }

    if (!isRenamingSession) {
      setRenameValue(getSessionTitle(activeSession));
    }
  }, [activeSession.id, activeSession.manualTitle, isRenamingSession]);

  useEffect(() => {
    if (!trackSessionReads) {
      return;
    }

    const refreshReadAttention = (): void => {
      setReadAttentionSequence((sequence) => sequence + 1);
    };

    window.addEventListener("focus", refreshReadAttention);
    document.addEventListener("visibilitychange", refreshReadAttention);

    return () => {
      window.removeEventListener("focus", refreshReadAttention);
      document.removeEventListener("visibilitychange", refreshReadAttention);
    };
  }, [trackSessionReads]);

  useEffect(() => {
    if (!hasHydrated || !trackSessionReads) {
      return;
    }

    if (
      document.visibilityState === "hidden" ||
      (canUseTauriStore() && !document.hasFocus())
    ) {
      return;
    }

    const latestCompletedResponseAt =
      getLatestCompletedSessionResponseAt(activeSession);

    if (
      latestCompletedResponseAt === null ||
      (activeSession.lastReadAt ?? 0) >= latestCompletedResponseAt
    ) {
      return;
    }

    applyShellState((prev) => ({
      ...prev,
      sessions: prev.sessions.map((session) =>
        session.id === activeSession.id
          ? markSessionRead(session, latestCompletedResponseAt)
          : session,
      ),
    }));
  }, [
    activeSession,
    activeSession.id,
    activeSession.lastReadAt,
    applyShellState,
    hasHydrated,
    readAttentionSequence,
    trackSessionReads,
  ]);

  const updateActiveSession = useCallback(
    (updater: (session: ChatSessionRecord) => ChatSessionRecord): void => {
      const targetSessionId = activeSession.id;
      const allowHydrationFallback = !hasHydrated;

      applyShellState((prev) => {
        const targetSessionExists = prev.sessions.some(
          (session) => session.id === targetSessionId,
        );
        const fallbackSessionId = allowHydrationFallback
          ? prev.activeSessionId
          : null;
        const resolvedSessionId = targetSessionExists
          ? targetSessionId
          : fallbackSessionId &&
              prev.sessions.some((session) => session.id === fallbackSessionId)
            ? fallbackSessionId
            : null;

        if (!resolvedSessionId) {
          return prev;
        }

        let didUpdateSession = false;
        const sessions = prev.sessions.map((session) => {
          if (session.id !== resolvedSessionId) {
            return session;
          }

          const nextSession = updater(session);

          if (nextSession !== session) {
            didUpdateSession = true;
          }

          return nextSession;
        });

        if (!didUpdateSession) {
          return prev;
        }

        return {
          ...prev,
          sessions,
        };
      });
    },
    [activeSession.id, applyShellState, hasHydrated],
  );

  const updateSessionById = useCallback(
    (
      sessionId: string,
      updater: (session: ChatSessionRecord) => ChatSessionRecord,
    ): void => {
      applyShellState((prev) => {
        let didFindSession = false;
        let didUpdateSession = false;
        const sessions = prev.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          didFindSession = true;
          const nextSession = updater(session);

          if (nextSession !== session) {
            didUpdateSession = true;
          }

          return nextSession;
        });

        if (!didFindSession || !didUpdateSession) {
          return prev;
        }

        return {
          ...prev,
          sessions,
        };
      });
    },
    [applyShellState],
  );

  const updateSessionByIdTransient = useCallback(
    (
      sessionId: string,
      updater: (session: ChatSessionRecord) => ChatSessionRecord,
    ): void => {
      applyTransientShellState((prev) => {
        let didUpdateSession = false;
        const sessions = prev.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          const nextSession = updater(session);
          didUpdateSession ||= nextSession !== session;
          return nextSession;
        });

        return didUpdateSession
          ? {
              ...prev,
              sessions,
            }
          : prev;
      });
    },
    [applyTransientShellState],
  );

  const setDraftValue = useCallback(
    (value: SetStateAction<string>): void => {
      const sessionId = activeSession.id;

      applyShellState((prev) => {
        let didFindSession = false;
        let didUpdateSession = false;
        const updatedAt = Date.now();
        const sessions = prev.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          didFindSession = true;
          const nextDraft =
            typeof value === "function" ? value(session.draft) : value;

          if (session.draft === nextDraft) {
            return session;
          }

          didUpdateSession = true;
          return {
            ...session,
            draft: nextDraft,
            updatedAt,
            composerUpdatedAt: updatedAt,
          };
        });

        if (!didFindSession || !didUpdateSession) {
          return prev;
        }

        return {
          ...prev,
          sessions,
        };
      });
    },
    [activeSession.id, applyShellState],
  );

  const setActiveSessionId = useCallback(
    (sessionId: string): void => {
      setActiveSessionIdState(sessionId);
      if (!persistActiveSession && !trackSessionReads) {
        return;
      }

      applyShellState((prev) => {
        const readAt = Date.now();
        let didUpdateReadState = false;
        const sessions = prev.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          const nextSession = trackSessionReads
            ? markSessionRead(session, readAt)
            : session;

          if (nextSession !== session) {
            didUpdateReadState = true;
          }

          return nextSession;
        });

        if (
          (!persistActiveSession || prev.activeSessionId === sessionId) &&
          !didUpdateReadState
        ) {
          return prev;
        }

        return {
          ...prev,
          activeSessionId: persistActiveSession
            ? sessionId
            : prev.activeSessionId,
          sessions,
        };
      });
    },
    [applyShellState, persistActiveSession, trackSessionReads],
  );

  return {
    shellState,
    activeSessionId: activeSession.id,
    activeSession,
    visibleMessages,
    filteredSessions,
    hasHydrated,
    sessionScopeFilter,
    sessionStatusFilters,
    sessionSearchQuery,
    sessionProjectFilter,
    sessionTagFilters,
    sessionHistoryIndex,
    sessionProjectFacets: sessionHistoryIndex.projects,
    sessionTagFacets: sessionHistoryIndex.tags,
    catalogOpen,
    settingsSection,
    isRenamingSession,
    renameValue,
    promptHistoryIndex,
    draftBeforeHistory,
    bottomRef: newestMessageScroll.bottomRef,
    showScrollToNewestButton: newestMessageScroll.showScrollToNewestButton,
    scrollToNewest: newestMessageScroll.scrollToNewest,
    setCatalogOpen,
    setSettingsSection,
    setActiveSessionId,
    setSessionScopeFilter,
    setSessionStatusFilters,
    setSessionSearchQuery,
    setSessionProjectFilter,
    setSessionTagFilters,
    setIsRenamingSession,
    setRenameValue,
    setPromptHistoryIndex,
    setDraftBeforeHistory,
    applyShellState,
    flushPersistence: flushShellStatePersistence,
    updateActiveSession,
    updateSessionById,
    updateSessionByIdTransient,
    setDraftValue,
  };
};
