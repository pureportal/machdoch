import {
  getSessionOverviewStatus,
  isSessionArchived,
  type ChatSessionRecord,
} from "../../chat-session.model";
import {
  SUPPORTED_PROVIDER_ORDER,
  type RuntimeProvider,
} from "../../model-catalog";
import type {
  RuntimeProviderAvailability,
  RuntimeSnapshot,
  UserMemorySettings,
} from "../../runtime";
import {
  formatSavedFactCount,
  getWorkspaceLabel,
  type SessionScopeFilter,
  type SessionStatusFilter,
} from "./session-shell";

export const filterSessions = (
  sessions: ChatSessionRecord[],
  sessionScopeFilter: SessionScopeFilter,
  sessionStatusFilter: SessionStatusFilter,
): ChatSessionRecord[] => {
  return sessions.filter((session) => {
    const archived = isSessionArchived(session);
    const sessionStatus = getSessionOverviewStatus(session);
    const matchesScope =
      sessionScopeFilter === "all"
        ? true
        : sessionScopeFilter === "archived"
          ? archived
          : !archived;
    const matchesStatus =
      sessionStatusFilter === "any"
        ? true
        : sessionStatus === sessionStatusFilter;

    return matchesScope && matchesStatus;
  });
};

export interface ProviderChooserState {
  activeProviderStats: RuntimeProviderAvailability[];
  runtimeProviderLookup: Map<RuntimeProvider, boolean>;
  configuredProviders: RuntimeProvider[];
  chooserProviders: RuntimeProvider[];
  hasAnyProvider: boolean;
}

export const createProviderChooserState = (options: {
  isDesktop: boolean;
  runtimeSnapshot: RuntimeSnapshot | null;
  globalProviders: RuntimeProviderAvailability[] | null;
}): ProviderChooserState => {
  const activeProviderStats = options.runtimeSnapshot
    ? options.runtimeSnapshot.providerAvailability
    : (options.globalProviders ?? []);
  const runtimeProviderLookup = new Map<RuntimeProvider, boolean>(
    activeProviderStats.map((entry) => [entry.provider, entry.configured]),
  );
  const configuredProviders = options.isDesktop
    ? SUPPORTED_PROVIDER_ORDER.filter(
        (provider) => runtimeProviderLookup.get(provider) ?? false,
      )
    : [...SUPPORTED_PROVIDER_ORDER];
  const chooserProviders =
    configuredProviders.length > 0
      ? configuredProviders
      : [...SUPPORTED_PROVIDER_ORDER];
  const hasAnyProvider =
    options.isDesktop && options.globalProviders !== null
      ? activeProviderStats.some((entry) => entry.configured)
      : true;

  return {
    activeProviderStats,
    runtimeProviderLookup,
    configuredProviders,
    chooserProviders,
    hasAnyProvider,
  };
};

export interface MemorySummaryState {
  composerWorkspaceLabel: string;
  sessionMemoryDescription: string;
  globalMemoryDescription: string;
  isGlobalMemoryAvailable: boolean;
  isGlobalMemoryActive: boolean;
}

export const createMemorySummaryState = (options: {
  session: ChatSessionRecord;
  userMemorySettings: UserMemorySettings;
}): MemorySummaryState => {
  const composerWorkspaceLabel = options.session.workspace
    ? getWorkspaceLabel(options.session.workspace)
    : "Choose workspace";
  const sessionMemoryFactCount = options.session.sessionMemory.length;
  const globalMemoryFactCount = options.userMemorySettings.entries.length;
  const isGlobalMemoryAvailable = options.userMemorySettings.globalEnabled;
  const isGlobalMemoryActive =
    isGlobalMemoryAvailable && options.session.useGlobalMemory;
  const sessionMemoryDescription = options.session.sessionMemoryEnabled
    ? `${formatSavedFactCount(sessionMemoryFactCount)} available in this session.`
    : "Session-only facts are paused for this conversation.";
  const globalMemoryDescription = !isGlobalMemoryAvailable
    ? "Unavailable right now. Enable global memory in Settings to bridge this session."
    : isGlobalMemoryActive
      ? `${formatSavedFactCount(globalMemoryFactCount)} available across sessions.`
      : `${formatSavedFactCount(globalMemoryFactCount)} available across sessions, but this session is not using them.`;

  return {
    composerWorkspaceLabel,
    sessionMemoryDescription,
    globalMemoryDescription,
    isGlobalMemoryAvailable,
    isGlobalMemoryActive,
  };
};
