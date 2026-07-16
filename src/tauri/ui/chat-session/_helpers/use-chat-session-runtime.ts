import { isTauri } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { getProviderLabel, type RuntimeProvider } from "../../model-catalog";
import {
  loadGlobalProviderAvailability,
  authorizeMcpOAuth,
  discoverMcpServer,
  finishMcpOAuth,
  listMcpCachedCapabilities,
  loadMcpConfigDocument,
  loadUserProviderApiKeys,
  loadUserAgentLimitsSettings,
  loadUserReviewModelSettings,
  loadUserDesktopSettings,
  loadUserSpeechToTextSettings,
  loadUserMemorySettings,
  loadUserVoiceSettings,
  loadUserWebSearchSettings,
  loadWorkspaceRuntimeSnapshot,
  openUserProviderApiKeyPortal,
  saveUserSpeechToTextActiveProvider,
  saveUserSpeechToTextInputDevice,
  saveUserDesktopSettings,
  saveUserAgentLimitsSettings,
  saveUserReviewModelSettings,
  saveUserGlobalMemoryEnabled,
  saveMcpConfigDocument,
  refreshMcpDiscoveryCache,
  refreshProviderSync,
  saveUserVoiceActiveProvider,
  saveUserProviderApiKey,
  saveWorkspaceDefaultMode,
  saveWorkspaceReasoningMode,
  subscribeToDesktopSettingsChanged,
  subscribeToUserSettingsChanged,
  createFallbackMcpConfigDocument,
  createMcpConfigRawWithPreset,
  getUserApiKeyProviderLabel,
  MCP_PRESET_SUMMARIES,
  USER_API_KEY_PROVIDER_ORDER,
  saveUserWebSearchActiveProvider,
  saveUserWebSearchApiKey,
  USER_WEB_SEARCH_PROVIDER_ORDER,
  type McpConfigDocument,
  type McpConfigScope,
  type McpPresetSummary,
  type RuntimeProviderAvailability,
  type RuntimeSnapshot,
  type UserSpeechToTextSettings,
  type UserAgentLimitsSettings,
  type UserReviewModelSettings,
  type UserDesktopSettings,
  type SpeechToTextProvider,
  type UserApiKeyProvider,
  type UserMemorySettings,
  type UserProviderApiKeys,
  type UserVoiceSettings,
  type VoiceAiProvider,
  type UserWebSearchApiKeyProvider,
  type UserWebSearchApiKeys,
  type UserWebSearchSettings,
  type WebSearchProvider,
} from "../../runtime";
import type { SettingsStatusMessage } from "../components/settings-dialog-panels/types";
import {
  createEmptyUserMemorySettings,
  getWebSearchProviderLabel,
} from "./session-shell";

const MCP_CONFIG_CONFLICT_PREFIX = "MACHDOCH_MCP_CONFIG_CONFLICT:";

const isMcpConfigConflict = (error: unknown): boolean => {
  return String(error).includes(MCP_CONFIG_CONFLICT_PREFIX);
};

export interface UseChatSessionRuntimeOptions {
  catalogOpen: boolean;
  activeSessionProvider: RuntimeProvider;
  activeSessionWorkspace: string | null;
}

export interface ChatSessionRuntimeController {
  globalProviders: RuntimeProviderAvailability[] | null;
  runtimeSnapshot: RuntimeSnapshot | null;
  runtimeLoading: boolean;
  runtimeError: string | null;
  providerSetupProvider: UserApiKeyProvider;
  providerSetupKey: string;
  providerSetupSaving: boolean;
  providerSetupMessage: SettingsStatusMessage | null;
  userVoiceSettings: UserVoiceSettings;
  voiceSetupSaving: boolean;
  voiceSetupMessage: SettingsStatusMessage | null;
  userSpeechToTextSettings: UserSpeechToTextSettings;
  userSpeechToTextSettingsLoaded: boolean;
  speechToTextSetupSaving: boolean;
  speechInputDeviceSaving: boolean;
  speechToTextSetupMessage: SettingsStatusMessage | null;
  webSearchActiveProvider: WebSearchProvider;
  webSearchSetupProvider: UserWebSearchApiKeyProvider;
  webSearchSetupKey: string;
  webSearchSetupSaving: boolean;
  webSearchSetupMessage: SettingsStatusMessage | null;
  userDesktopSettings: UserDesktopSettings;
  userDesktopSettingsLoaded: boolean;
  desktopSetupSaving: boolean;
  desktopSetupMessage: SettingsStatusMessage | null;
  userAgentLimitsSettings: UserAgentLimitsSettings;
  userReviewModelSettings: UserReviewModelSettings;
  agentLimitsSetupSaving: boolean;
  agentLimitsSetupMessage: SettingsStatusMessage | null;
  workspaceSetupSaving: boolean;
  workspaceSetupMessage: SettingsStatusMessage | null;
  mcpConfigScope: McpConfigScope;
  mcpConfigDocument: McpConfigDocument;
  mcpConfigDraft: string;
  mcpConfigPresets: readonly McpPresetSummary[];
  mcpConfigWorkspaceAvailable: boolean;
  mcpConfigLoading: boolean;
  mcpConfigSaving: boolean;
  mcpDiscoveryServerId: string;
  mcpDiscoveryBusy: boolean;
  mcpDiscoveryOutput: string | null;
  mcpOAuthServerId: string;
  mcpOAuthCallback: string;
  mcpOAuthBusy: boolean;
  mcpConfigMessage: SettingsStatusMessage | null;
  userMemorySettings: UserMemorySettings;
  memorySetupSaving: boolean;
  memorySetupMessage: SettingsStatusMessage | null;
  setGlobalProviders: Dispatch<
    SetStateAction<RuntimeProviderAvailability[] | null>
  >;
  refreshWorkspaceRuntimeSnapshot: (
    workspaceRoot: string | null,
  ) => Promise<RuntimeSnapshot | null>;
  handleProviderSetupProviderChange: (provider: UserApiKeyProvider) => void;
  handleProviderSetupPortalOpen: (provider: UserApiKeyProvider) => Promise<void>;
  handleProviderSetupKeyChange: (value: string) => void;
  handleProviderSetupSave: (keyValue?: string) => Promise<boolean>;
  handleVoiceActiveProviderSave: (provider: VoiceAiProvider) => Promise<void>;
  handleSpeechToTextActiveProviderSave: (
    provider: SpeechToTextProvider,
  ) => Promise<void>;
  handleSpeechToTextInputDeviceSave: (
    inputDeviceId: string | null,
  ) => Promise<void>;
  handleWebSearchActiveProviderSave: (
    provider: WebSearchProvider,
  ) => Promise<void>;
  handleWebSearchSetupProviderChange: (
    provider: UserWebSearchApiKeyProvider,
  ) => void;
  handleWebSearchSetupKeyChange: (value: string) => void;
  handleWebSearchSetupSave: (keyValue?: string) => Promise<boolean>;
  handleDesktopSettingsSave: (settings: UserDesktopSettings) => Promise<void>;
  handleAgentLimitsSettingsSave: (
    settings: UserAgentLimitsSettings,
  ) => Promise<void>;
  handleReviewModelSettingsSave: (
    settings: UserReviewModelSettings,
  ) => Promise<void>;
  handleWorkspaceDefaultModeSave: (
    mode: RuntimeSnapshot["mode"],
  ) => Promise<void>;
  handleWorkspaceReasoningModeSave: (
    reasoning: RuntimeSnapshot["reasoning"],
  ) => Promise<void>;
  handleMcpConfigScopeChange: (scope: McpConfigScope) => void;
  handleMcpConfigDraftChange: (value: string) => void;
  handleMcpConfigSave: () => Promise<void>;
  handleMcpPresetInsert: (presetId: string) => void;
  handleMcpDiscoveryServerIdChange: (serverId: string) => void;
  handleMcpDiscoverServer: (serverId?: string) => Promise<void>;
  handleMcpRefreshDiscoveryCache: (serverId?: string) => Promise<void>;
  handleMcpListDiscoveryCache: () => Promise<void>;
  handleMcpOAuthServerIdChange: (serverId: string) => void;
  handleMcpOAuthCallbackChange: (value: string) => void;
  handleMcpOAuthStart: (serverId?: string) => Promise<void>;
  handleMcpOAuthFinish: (
    serverId?: string,
    authorizationResponse?: string,
  ) => Promise<void>;
  handleGlobalMemoryEnabledSave: (enabled: boolean) => Promise<void>;
  applyLoadedUserDesktopSettings: (settings: UserDesktopSettings) => void;
  applyLoadedUserAgentLimitsSettings: (
    settings: UserAgentLimitsSettings,
  ) => void;
  applyLoadedUserReviewModelSettings: (
    settings: UserReviewModelSettings,
  ) => void;
  applyLoadedUserMemorySettings: (settings: UserMemorySettings) => void;
}

const isUserApiKeyProvider = (
  provider: RuntimeProvider,
): provider is Extract<RuntimeProvider, UserApiKeyProvider> => {
  return USER_API_KEY_PROVIDER_ORDER.includes(provider as UserApiKeyProvider);
};

const getInitialProviderSetupProvider = (
  provider: RuntimeProvider,
): UserApiKeyProvider => {
  return isUserApiKeyProvider(provider) ? provider : "openai";
};

const createEmptyUserDesktopSettings = (): UserDesktopSettings => {
  return {
    autostartEnabled: false,
    autostartMinimized: false,
    autostartToTray: false,
    alwaysRunAsAdministrator: false,
    assistantBubbleEnabled: true,
    assistantBubbleHideWhenFullscreen: true,
    assistantBubbleTemporarilyHideSeconds: 6,
    aiContextMaxMessages: 60,
    inactiveSessionArchiveDays: 7,
    archivedSessionRetentionDays: 7,
    quickVoiceEnabled: true,
    quickVoiceShortcut: "CommandOrControl+Alt+V",
    quickVoiceSilenceSeconds: 1.8,
    quickVoiceMaxMessages: 50,
  };
};

const createEmptyUserAgentLimitsSettings = (): UserAgentLimitsSettings => {
  return {
    infinite: false,
    executorTurns: 64,
    autopilotExecutorIterations: 16,
  };
};

const createEmptyUserReviewModelSettings = (): UserReviewModelSettings => {
  return {
    mode: "base",
  };
};

const getDesktopSettingsSavedMessage = (
  settings: UserDesktopSettings,
): string => {
  const administratorDescription = settings.alwaysRunAsAdministrator
    ? " Packaged Windows launches will request administrator permissions."
    : "";
  const surfacesDescription = [
    settings.assistantBubbleEnabled ? "bubble" : null,
    settings.quickVoiceEnabled ? "quick voice" : null,
  ]
    .filter((entry): entry is string => entry !== null)
    .join(" + ");

  if (!settings.autostartEnabled) {
    return surfacesDescription.length > 0
      ? `Desktop assistant settings saved. Autostart is currently off, and ${surfacesDescription} is ready while the app is running.${administratorDescription}`
      : `Desktop startup settings saved. Autostart is currently off.${administratorDescription}`;
  }

  if (settings.autostartToTray) {
    return `Desktop assistant settings saved. Login launches will start in the tray${
      surfacesDescription.length > 0 ? ` with ${surfacesDescription}.` : "."
    }${administratorDescription}`;
  }

  if (settings.autostartMinimized) {
    return `Desktop assistant settings saved. Login launches will start minimized${
      surfacesDescription.length > 0 ? ` with ${surfacesDescription}.` : "."
    }${administratorDescription}`;
  }

  return `Desktop assistant settings saved. Login launches will open normally${
    surfacesDescription.length > 0 ? ` with ${surfacesDescription}.` : "."
  }${administratorDescription}`;
};

const getAgentLimitsSettingsSavedMessage = (
  settings: UserAgentLimitsSettings,
): string => {
  if (settings.infinite) {
    return "Agent loop limits saved. Executor and Machdoch continuation counts are unlimited; the safety timeout still applies.";
  }

  return `Agent loop limits saved. Executor turns: ${settings.executorTurns}; Machdoch continuations: ${settings.autopilotExecutorIterations}.`;
};

const getReviewModelSettingsSavedMessage = (
  settings: UserReviewModelSettings,
): string => {
  if (settings.mode !== "dedicated" || !settings.provider || !settings.model) {
    return "Review model saved. Validator and memory passes will use the base request model.";
  }

  return `Review model saved. Validator and memory passes will use ${getProviderLabel(settings.provider)} / ${settings.model}.`;
};

const getRunModeLabel = (mode: RuntimeSnapshot["mode"]): string => {
  return mode === "ask" ? "Ask mode" : "Machdoch";
};

const getReasoningModeLabel = (
  reasoning: RuntimeSnapshot["reasoning"],
): string => {
  return reasoning === "default" ? "Provider default" : reasoning;
};

const createRuntimeSnapshotRequestKey = (
  workspaceRoot: string | null,
): string => {
  const normalizedWorkspace = workspaceRoot
    ? workspaceRoot.trim().replace(/\\/gu, "/").toLowerCase()
    : "";

  return normalizedWorkspace;
};

interface McpWorkspaceEditorState {
  document: McpConfigDocument;
  draft: string;
  draftRevision: number;
}

const MCP_WORKSPACE_EDITOR_CACHE_LIMIT = 8;

const rememberMcpWorkspaceEditor = (
  editors: Map<string, McpWorkspaceEditorState>,
  workspaceKey: string,
  state: McpWorkspaceEditorState,
): void => {
  if (state.draft === state.document.raw) {
    editors.delete(workspaceKey);
    return;
  }

  editors.delete(workspaceKey);
  editors.set(workspaceKey, state);

  while (editors.size > MCP_WORKSPACE_EDITOR_CACHE_LIMIT) {
    const oldestWorkspaceKey = editors.keys().next().value;

    if (typeof oldestWorkspaceKey !== "string") {
      break;
    }

    editors.delete(oldestWorkspaceKey);
  }
};

const getFirstMcpServerIdFromRawConfig = (raw: string): string | null => {
  try {
    const parsed = JSON.parse(raw) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const servers = (parsed as { servers?: unknown }).servers;

    if (Array.isArray(servers)) {
      for (const server of servers) {
        if (
          server &&
          typeof server === "object" &&
          !Array.isArray(server) &&
          typeof (server as { id?: unknown }).id === "string"
        ) {
          return (server as { id: string }).id;
        }
      }

      return null;
    }

    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      const firstId = Object.keys(servers)[0];
      return firstId?.trim() || null;
    }

    return null;
  } catch {
    return null;
  }
};

export const useChatSessionRuntime = (
  options: UseChatSessionRuntimeOptions,
): ChatSessionRuntimeController => {
  const activeWorkspaceKey = createRuntimeSnapshotRequestKey(
    options.activeSessionWorkspace,
  );
  const [runtimeSnapshot, setRuntimeSnapshot] =
    useState<RuntimeSnapshot | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [providerSetupProvider, setProviderSetupProvider] =
    useState<UserApiKeyProvider>("openai");
  const [providerSetupKeys, setProviderSetupKeys] =
    useState<UserProviderApiKeys>({});
  const [providerSetupKey, setProviderSetupKey] = useState("");
  const [providerSetupSaving, setProviderSetupSaving] = useState(false);
  const [providerSetupMessage, setProviderSetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [userVoiceSettings, setUserVoiceSettings] =
    useState<UserVoiceSettings>({
      activeProvider: "none",
      providerAvailability: [],
    });
  const [voiceSetupSaving, setVoiceSetupSaving] = useState(false);
  const [voiceSetupMessage, setVoiceSetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [userSpeechToTextSettings, setUserSpeechToTextSettings] = useState<
    UserSpeechToTextSettings
  >({
    activeProvider: "none",
    inputDeviceId: null,
    providerAvailability: [],
  });
  const [speechToTextSetupSaving, setSpeechToTextSetupSaving] = useState(false);
  const [speechInputDeviceSaving, setSpeechInputDeviceSaving] = useState(false);
  const [speechToTextSetupMessage, setSpeechToTextSetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [webSearchActiveProvider, setWebSearchActiveProvider] =
    useState<WebSearchProvider>("none");
  const [webSearchSetupProvider, setWebSearchSetupProvider] =
    useState<UserWebSearchApiKeyProvider>("perplexity");
  const [webSearchSetupKeys, setWebSearchSetupKeys] =
    useState<UserWebSearchApiKeys>({});
  const [webSearchSetupKey, setWebSearchSetupKey] = useState("");
  const [webSearchSetupSaving, setWebSearchSetupSaving] = useState(false);
  const [webSearchSetupMessage, setWebSearchSetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [userDesktopSettings, setUserDesktopSettings] =
    useState<UserDesktopSettings>(createEmptyUserDesktopSettings());
  const [userDesktopSettingsLoaded, setUserDesktopSettingsLoaded] =
    useState(false);
  const [desktopSetupSaving, setDesktopSetupSaving] = useState(false);
  const [desktopSetupMessage, setDesktopSetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [userAgentLimitsSettings, setUserAgentLimitsSettings] =
    useState<UserAgentLimitsSettings>(createEmptyUserAgentLimitsSettings());
  const [userReviewModelSettings, setUserReviewModelSettings] =
    useState<UserReviewModelSettings>(createEmptyUserReviewModelSettings());
  const [agentLimitsSetupSaving, setAgentLimitsSetupSaving] = useState(false);
  const [agentLimitsSetupMessage, setAgentLimitsSetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [workspaceSetupSaving, setWorkspaceSetupSaving] = useState(false);
  const [workspaceSetupMessage, setWorkspaceSetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [mcpConfigScope, setMcpConfigScope] =
    useState<McpConfigScope>("user");
  const [mcpConfigDocuments, setMcpConfigDocuments] = useState<
    Record<McpConfigScope, McpConfigDocument>
  >({
    user: createFallbackMcpConfigDocument("user"),
    workspace: createFallbackMcpConfigDocument(
      "workspace",
      options.activeSessionWorkspace,
    ),
  });
  const [mcpConfigDrafts, setMcpConfigDrafts] = useState<
    Record<McpConfigScope, string>
  >({
    user: createFallbackMcpConfigDocument("user").raw,
    workspace: createFallbackMcpConfigDocument(
      "workspace",
      options.activeSessionWorkspace,
    ).raw,
  });
  const [mcpConfigLoading, setMcpConfigLoading] = useState(false);
  const [mcpConfigSaving, setMcpConfigSaving] = useState(false);
  const [mcpDiscoveryServerId, setMcpDiscoveryServerId] = useState("");
  const [mcpDiscoveryBusy, setMcpDiscoveryBusy] = useState(false);
  const [mcpDiscoveryOutput, setMcpDiscoveryOutput] = useState<string | null>(
    null,
  );
  const [mcpOAuthServerId, setMcpOAuthServerId] = useState("");
  const [mcpOAuthCallback, setMcpOAuthCallback] = useState("");
  const [mcpOAuthBusy, setMcpOAuthBusy] = useState(false);
  const [mcpConfigMessage, setMcpConfigMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [userMemorySettings, setUserMemorySettings] =
    useState<UserMemorySettings>(createEmptyUserMemorySettings());
  const [memorySetupSaving, setMemorySetupSaving] = useState(false);
  const [memorySetupMessage, setMemorySetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [globalProviders, setGlobalProviders] = useState<
    RuntimeProviderAvailability[] | null
  >(null);
  const runtimeSnapshotRequestIdRef = useRef(0);
  const runtimeSnapshotRequestKeyRef = useRef<string | null>(null);
  const workspaceSaveRequestIdRef = useRef(0);
  const mcpConfigLoadRequestIdRef = useRef(0);
  const mcpConfigSaveRequestIdRef = useRef(0);
  const mcpDiscoveryRequestIdRef = useRef(0);
  const mcpOAuthRequestIdRef = useRef(0);
  const mcpConfigDraftRevisionRef = useRef<Record<McpConfigScope, number>>({
    user: 0,
    workspace: 0,
  });
  const [userSpeechToTextSettingsLoaded, setUserSpeechToTextSettingsLoaded] =
    useState(false);
  const providerSetupOpenRef = useRef(false);
  const activeSessionProviderRef = useRef(options.activeSessionProvider);
  const providerSetupProviderRef = useRef(providerSetupProvider);
  const providerSetupKeyRef = useRef(providerSetupKey);
  const providerSetupEditRevisionRef = useRef(0);
  const providerSetupSaveRequestIdRef = useRef(0);
  const webSearchSetupOpenRef = useRef(false);
  const webSearchSetupProviderRef = useRef(webSearchSetupProvider);
  const webSearchSetupKeyRef = useRef(webSearchSetupKey);
  const webSearchSetupEditRevisionRef = useRef(0);
  const webSearchSetupSaveRequestIdRef = useRef(0);
  const mcpConfigDocumentsRef = useRef(mcpConfigDocuments);
  const mcpConfigDraftsRef = useRef(mcpConfigDrafts);
  const activeWorkspaceKeyRef = useRef(activeWorkspaceKey);
  const representedMcpWorkspaceKeyRef = useRef(activeWorkspaceKey);
  const mcpWorkspaceEditorsRef = useRef(
    new Map<string, McpWorkspaceEditorState>(),
  );
  const voiceMutationRevisionRef = useRef(0);
  const speechMutationRevisionRef = useRef(0);
  const settingsEventSequenceRef = useRef(new Map<string, number>());
  const mcpConfigDocument = mcpConfigDocuments[mcpConfigScope];
  const mcpConfigDraft = mcpConfigDrafts[mcpConfigScope];
  const mcpConfigWorkspaceAvailable = Boolean(
    options.activeSessionWorkspace?.trim(),
  );
  activeSessionProviderRef.current = options.activeSessionProvider;
  providerSetupProviderRef.current = providerSetupProvider;
  providerSetupKeyRef.current = providerSetupKey;
  webSearchSetupProviderRef.current = webSearchSetupProvider;
  webSearchSetupKeyRef.current = webSearchSetupKey;
  mcpConfigDocumentsRef.current = mcpConfigDocuments;
  mcpConfigDraftsRef.current = mcpConfigDrafts;
  activeWorkspaceKeyRef.current = activeWorkspaceKey;

  useEffect(() => {
    const previousWorkspaceKey = representedMcpWorkspaceKeyRef.current;

    if (previousWorkspaceKey === activeWorkspaceKey) {
      return;
    }

    if (previousWorkspaceKey) {
      rememberMcpWorkspaceEditor(mcpWorkspaceEditorsRef.current, previousWorkspaceKey, {
        document: mcpConfigDocumentsRef.current.workspace,
        draft: mcpConfigDraftsRef.current.workspace,
        draftRevision: mcpConfigDraftRevisionRef.current.workspace,
      });
    }

    representedMcpWorkspaceKeyRef.current = activeWorkspaceKey;
    mcpConfigLoadRequestIdRef.current += 1;
    mcpConfigSaveRequestIdRef.current += 1;
    mcpDiscoveryRequestIdRef.current += 1;
    mcpOAuthRequestIdRef.current += 1;

    const cached = activeWorkspaceKey
      ? mcpWorkspaceEditorsRef.current.get(activeWorkspaceKey)
      : undefined;

    if (activeWorkspaceKey && cached) {
      mcpWorkspaceEditorsRef.current.delete(activeWorkspaceKey);
      mcpWorkspaceEditorsRef.current.set(activeWorkspaceKey, cached);
    }
    const document =
      cached?.document ??
      createFallbackMcpConfigDocument(
        "workspace",
        options.activeSessionWorkspace,
      );
    const draft = cached?.draft ?? document.raw;

    mcpConfigDocumentsRef.current = {
      ...mcpConfigDocumentsRef.current,
      workspace: document,
    };
    mcpConfigDraftsRef.current = {
      ...mcpConfigDraftsRef.current,
      workspace: draft,
    };
    mcpConfigDraftRevisionRef.current.workspace =
      cached?.draftRevision ?? 0;
    setMcpConfigDocuments((current) => ({ ...current, workspace: document }));
    setMcpConfigDrafts((current) => ({ ...current, workspace: draft }));
    setMcpDiscoveryServerId("");
    setMcpDiscoveryOutput(null);
    setMcpOAuthServerId("");
    setMcpOAuthCallback("");
    setMcpConfigMessage(null);

    if (!activeWorkspaceKey) {
      setMcpConfigScope("user");
    }
  }, [activeWorkspaceKey, options.activeSessionWorkspace]);

  const applyLoadedWebSearchSettings = useCallback(
    (settings: UserWebSearchSettings): void => {
      const nextKeyProvider =
        settings.activeProvider === "none"
          ? USER_WEB_SEARCH_PROVIDER_ORDER[0]
          : settings.activeProvider;

      setWebSearchActiveProvider(settings.activeProvider);
      setWebSearchSetupProvider(nextKeyProvider);
      setWebSearchSetupKeys(settings.apiKeys);
    },
    [],
  );

  const applyLoadedUserMemorySettings = useCallback(
    (settings: UserMemorySettings): void => {
      setUserMemorySettings(settings);
    },
    [],
  );

  const applyLoadedUserDesktopSettings = useCallback(
    (settings: UserDesktopSettings): void => {
      setUserDesktopSettings({
        ...createEmptyUserDesktopSettings(),
        ...settings,
      });
      setUserDesktopSettingsLoaded(true);
    },
    [],
  );

  const applyLoadedUserAgentLimitsSettings = useCallback(
    (settings: UserAgentLimitsSettings): void => {
      setUserAgentLimitsSettings({
        ...createEmptyUserAgentLimitsSettings(),
        ...settings,
      });
    },
    [],
  );

  const applyLoadedUserReviewModelSettings = useCallback(
    (settings: UserReviewModelSettings): void => {
      setUserReviewModelSettings({
        ...createEmptyUserReviewModelSettings(),
        ...settings,
      });
    },
    [],
  );

  const applyLoadedUserVoiceSettings = useCallback(
    (settings: UserVoiceSettings): void => {
      setUserVoiceSettings(settings);
    },
    [],
  );

  const applyLoadedUserSpeechToTextSettings = useCallback(
    (settings: UserSpeechToTextSettings): void => {
      setUserSpeechToTextSettings({
        ...settings,
        inputDeviceId: settings.inputDeviceId?.trim() || null,
      });
    },
    [],
  );

  const refreshWorkspaceRuntimeSnapshot = useCallback(
    async (
      workspaceRoot: string | null,
    ): Promise<RuntimeSnapshot | null> => {
      const requestId = runtimeSnapshotRequestIdRef.current + 1;
      const requestKey = createRuntimeSnapshotRequestKey(workspaceRoot);
      runtimeSnapshotRequestIdRef.current = requestId;
      const isCurrentRequest = (): boolean => {
        return (
          runtimeSnapshotRequestIdRef.current === requestId &&
          activeWorkspaceKeyRef.current === requestKey
        );
      };
      const keepCurrentSnapshotForRequest = (): void => {
        setRuntimeSnapshot((currentSnapshot) =>
          currentSnapshot && runtimeSnapshotRequestKeyRef.current === requestKey
            ? currentSnapshot
            : null,
        );
      };

      setRuntimeLoading(true);
      setRuntimeError(null);

      try {
        const snapshot = await loadWorkspaceRuntimeSnapshot(workspaceRoot);

        if (!isCurrentRequest()) {
          return snapshot;
        }

        if (snapshot) {
          runtimeSnapshotRequestKeyRef.current = requestKey;
          setRuntimeSnapshot(snapshot);
        } else {
          keepCurrentSnapshotForRequest();
        }

        if (!snapshot && isTauri()) {
          setRuntimeError(
            "Runtime metadata is unavailable for this workspace right now.",
          );
        }

        return snapshot;
      } catch (error) {
        if (isCurrentRequest()) {
          console.error("Failed to resolve runtime snapshot", error);
          keepCurrentSnapshotForRequest();
          setRuntimeError(
            "Runtime metadata could not be loaded for this workspace.",
          );
        }

        return null;
      } finally {
        if (isCurrentRequest()) {
          setRuntimeLoading(false);
        }
      }
    },
    [],
  );

  const refreshMcpConfigDocuments = useCallback(async (): Promise<void> => {
    const requestId = mcpConfigLoadRequestIdRef.current + 1;
    const workspaceRoot = options.activeSessionWorkspace;
    const workspaceKey = createRuntimeSnapshotRequestKey(workspaceRoot);
    const draftRevisions = { ...mcpConfigDraftRevisionRef.current };
    const cleanDrafts = {
      user:
        mcpConfigDraftsRef.current.user ===
        mcpConfigDocumentsRef.current.user.raw,
      workspace:
        mcpConfigDraftsRef.current.workspace ===
        mcpConfigDocumentsRef.current.workspace.raw,
    };
    mcpConfigLoadRequestIdRef.current = requestId;
    setMcpConfigLoading(true);
    setMcpConfigMessage(null);

    try {
      const [userDocument, workspaceDocument] = await Promise.all([
        loadMcpConfigDocument("user"),
        loadMcpConfigDocument("workspace", workspaceRoot),
      ]);

      if (
        mcpConfigLoadRequestIdRef.current !== requestId ||
        activeWorkspaceKeyRef.current !== workspaceKey ||
        representedMcpWorkspaceKeyRef.current !== workspaceKey
      ) {
        return;
      }

      const canReplaceUser =
        cleanDrafts.user &&
        mcpConfigDraftRevisionRef.current.user === draftRevisions.user;
      const canReplaceWorkspace =
        cleanDrafts.workspace &&
        mcpConfigDraftRevisionRef.current.workspace ===
          draftRevisions.workspace;
      const nextDocuments = {
        user: canReplaceUser
          ? userDocument
          : mcpConfigDocumentsRef.current.user,
        workspace: canReplaceWorkspace
          ? workspaceDocument
          : mcpConfigDocumentsRef.current.workspace,
      };
      const nextDrafts = {
        user: canReplaceUser
          ? userDocument.raw
          : mcpConfigDraftsRef.current.user,
        workspace: canReplaceWorkspace
          ? workspaceDocument.raw
          : mcpConfigDraftsRef.current.workspace,
      };

      mcpConfigDocumentsRef.current = nextDocuments;
      mcpConfigDraftsRef.current = nextDrafts;
      setMcpConfigDocuments(nextDocuments);
      setMcpConfigDrafts(nextDrafts);
      setMcpDiscoveryServerId((current) => {
        if (current.trim()) {
          return current;
        }

        return (
          getFirstMcpServerIdFromRawConfig(workspaceDocument.raw) ??
          getFirstMcpServerIdFromRawConfig(userDocument.raw) ??
          ""
        );
      });

      if (!workspaceRoot?.trim()) {
        setMcpConfigScope("user");
      }
    } catch (error) {
      if (mcpConfigLoadRequestIdRef.current !== requestId) {
        return;
      }

      console.error("Failed to load MCP config documents", error);
      setMcpConfigMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "MCP configuration could not be loaded.",
      });
    } finally {
      if (mcpConfigLoadRequestIdRef.current === requestId) {
        setMcpConfigLoading(false);
      }
    }
  }, [options.activeSessionWorkspace]);

  useEffect(() => {
    let cancelled = false;

    void loadGlobalProviderAvailability().then((data) => {
      if (!cancelled) {
        setGlobalProviders(data);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const workspaceRoot = options.activeSessionWorkspace?.trim();
    if (!workspaceRoot || !isTauri()) return;
    void refreshProviderSync(workspaceRoot).catch((error) => {
      console.error("Failed to reconcile automatic provider enrollment", error);
    });
  }, [options.activeSessionWorkspace]);

  useEffect(() => {
    let cancelled = false;

    void loadUserVoiceSettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserVoiceSettings(settings);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load user voice settings", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedUserVoiceSettings]);

  useEffect(() => {
    let cancelled = false;

    void loadUserSpeechToTextSettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserSpeechToTextSettings(settings);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load user speech-to-text settings", error);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setUserSpeechToTextSettingsLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedUserSpeechToTextSettings]);

  useEffect(() => {
    if (!options.catalogOpen) {
      return;
    }

    let cancelled = false;

    setVoiceSetupMessage(null);

    void loadUserVoiceSettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserVoiceSettings(settings);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error("Failed to load user voice settings", error);
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedUserVoiceSettings, options.catalogOpen]);

  useEffect(() => {
    if (!options.catalogOpen) {
      return;
    }

    let cancelled = false;

    setSpeechToTextSetupMessage(null);

    void loadUserSpeechToTextSettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserSpeechToTextSettings(settings);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error("Failed to load user speech-to-text settings", error);
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedUserSpeechToTextSettings, options.catalogOpen]);

  useEffect(() => {
    let cancelled = false;

    void loadUserDesktopSettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserDesktopSettings(settings);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load user desktop settings", error);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setUserDesktopSettingsLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedUserDesktopSettings]);

  useEffect(() => {
    let cancelled = false;

    void loadUserAgentLimitsSettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserAgentLimitsSettings(settings);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load user agent limit settings", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedUserAgentLimitsSettings]);

  useEffect(() => {
    let cancelled = false;

    void loadUserReviewModelSettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserReviewModelSettings(settings);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load user review-model settings", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedUserReviewModelSettings]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToDesktopSettingsChanged((settings) => {
      applyLoadedUserDesktopSettings(settings);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }

      unsubscribe = unlisten;
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [applyLoadedUserDesktopSettings]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToUserSettingsChanged((kind) => {
      const sequence = (settingsEventSequenceRef.current.get(kind) ?? 0) + 1;
      settingsEventSequenceRef.current.set(kind, sequence);

      void (async () => {
        try {
          if (kind === "provider-keys") {
            const keys = await loadUserProviderApiKeys();
            if (disposed || settingsEventSequenceRef.current.get(kind) !== sequence) {
              return;
            }
            const editedProvider = providerSetupProviderRef.current;
            setProviderSetupKeys({
              ...keys,
              ...(providerSetupOpenRef.current
                ? { [editedProvider]: providerSetupKeyRef.current }
                : {}),
            });
          } else if (kind === "web-search") {
            const settings = await loadUserWebSearchSettings();
            if (disposed || settingsEventSequenceRef.current.get(kind) !== sequence) {
              return;
            }
            setWebSearchActiveProvider(settings.activeProvider);
            const editedProvider = webSearchSetupProviderRef.current;
            setWebSearchSetupKeys({
              ...settings.apiKeys,
              ...(webSearchSetupOpenRef.current
                ? { [editedProvider]: webSearchSetupKeyRef.current }
                : {}),
            });
          } else if (kind === "voice") {
            const settings = await loadUserVoiceSettings();
            if (!disposed && settingsEventSequenceRef.current.get(kind) === sequence) {
              applyLoadedUserVoiceSettings(settings);
            }
          } else if (kind === "speech-to-text") {
            const settings = await loadUserSpeechToTextSettings();
            if (!disposed && settingsEventSequenceRef.current.get(kind) === sequence) {
              applyLoadedUserSpeechToTextSettings(settings);
            }
          } else if (kind === "memory") {
            const settings = await loadUserMemorySettings();
            if (!disposed && settingsEventSequenceRef.current.get(kind) === sequence) {
              applyLoadedUserMemorySettings(settings);
            }
          } else if (kind === "agent-limits") {
            const settings = await loadUserAgentLimitsSettings();
            if (!disposed && settingsEventSequenceRef.current.get(kind) === sequence) {
              applyLoadedUserAgentLimitsSettings(settings);
            }
          } else if (kind === "review-model") {
            const settings = await loadUserReviewModelSettings();
            if (!disposed && settingsEventSequenceRef.current.get(kind) === sequence) {
              applyLoadedUserReviewModelSettings(settings);
            }
          } else if (kind === "mcp") {
            await refreshMcpConfigDocuments();
          }
        } catch (error) {
          if (!disposed) {
            console.error(`Failed to apply ${kind} settings update`, error);
          }
        }
      })();
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unsubscribe = unlisten;
      }
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [
    applyLoadedUserAgentLimitsSettings,
    applyLoadedUserMemorySettings,
    applyLoadedUserReviewModelSettings,
    applyLoadedUserSpeechToTextSettings,
    applyLoadedUserVoiceSettings,
    refreshMcpConfigDocuments,
  ]);

  useEffect(() => {
    if (!options.catalogOpen) {
      return;
    }

    void refreshMcpConfigDocuments();
  }, [options.catalogOpen, refreshMcpConfigDocuments]);

  useEffect(() => {
    if (!options.catalogOpen) {
      return;
    }

    let cancelled = false;

    setDesktopSetupMessage(null);

    void loadUserDesktopSettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserDesktopSettings(settings);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error("Failed to load user desktop settings", error);
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedUserDesktopSettings, options.catalogOpen]);

  useEffect(() => {
    if (!options.catalogOpen) {
      return;
    }

    let cancelled = false;

    setAgentLimitsSetupMessage(null);

    void loadUserAgentLimitsSettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserAgentLimitsSettings(settings);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error("Failed to load user agent limit settings", error);
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedUserAgentLimitsSettings, options.catalogOpen]);

  useEffect(() => {
    if (!options.catalogOpen) {
      return;
    }

    let cancelled = false;

    setAgentLimitsSetupMessage(null);

    void loadUserReviewModelSettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserReviewModelSettings(settings);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error("Failed to load user review-model settings", error);
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedUserReviewModelSettings, options.catalogOpen]);

  useEffect(() => {
    let cancelled = false;

    void loadUserMemorySettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserMemorySettings(settings);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load user memory settings", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedUserMemorySettings]);

  useEffect(() => {
    if (!options.catalogOpen) {
      return;
    }

    let cancelled = false;

    void loadGlobalProviderAvailability()
      .then((data) => {
        if (!cancelled) {
          setGlobalProviders(data);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load global provider availability", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [options.catalogOpen]);

  useEffect(() => {
    if (!options.catalogOpen) {
      providerSetupOpenRef.current = false;
      return;
    }

    if (providerSetupOpenRef.current) {
      return;
    }

    providerSetupOpenRef.current = true;

    let cancelled = false;
    const editRevision = providerSetupEditRevisionRef.current;

    setProviderSetupProvider(
      getInitialProviderSetupProvider(activeSessionProviderRef.current),
    );
    setProviderSetupKeys({});
    setProviderSetupKey("");
    setProviderSetupMessage(null);

    void loadUserProviderApiKeys()
      .then((apiKeys) => {
        if (
          !cancelled &&
          providerSetupEditRevisionRef.current === editRevision
        ) {
          setProviderSetupKeys(apiKeys);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load user provider API keys", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [options.catalogOpen]);

  useEffect(() => {
    if (!options.catalogOpen) {
      return;
    }

    setProviderSetupKey(providerSetupKeys[providerSetupProvider] ?? "");
  }, [options.catalogOpen, providerSetupKeys, providerSetupProvider]);

  useEffect(() => {
    if (!options.catalogOpen) {
      webSearchSetupOpenRef.current = false;
      return;
    }

    if (webSearchSetupOpenRef.current) {
      return;
    }

    webSearchSetupOpenRef.current = true;

    let cancelled = false;
    const editRevision = webSearchSetupEditRevisionRef.current;

    setWebSearchSetupKeys({});
    setWebSearchSetupKey("");
    setWebSearchSetupMessage(null);

    void loadUserWebSearchSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }

        if (webSearchSetupEditRevisionRef.current === editRevision) {
          applyLoadedWebSearchSettings(settings);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error("Failed to load web-search settings", error);
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedWebSearchSettings, options.catalogOpen]);

  useEffect(() => {
    if (!options.catalogOpen) {
      return;
    }

    let cancelled = false;

    setMemorySetupMessage(null);

    void loadUserMemorySettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserMemorySettings(settings);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error("Failed to load user memory settings", error);
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedUserMemorySettings, options.catalogOpen]);

  useEffect(() => {
    if (!options.catalogOpen) {
      return;
    }

    setWebSearchSetupKey(webSearchSetupKeys[webSearchSetupProvider] ?? "");
  }, [options.catalogOpen, webSearchSetupKeys, webSearchSetupProvider]);

  useEffect(() => {
    let cancelled = false;

    void refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace).catch(
      (error) => {
        if (!cancelled) {
          console.error("Failed to refresh runtime snapshot", error);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [
    options.activeSessionWorkspace,
    refreshWorkspaceRuntimeSnapshot,
  ]);

  const handleProviderSetupProviderChange = useCallback(
    (provider: UserApiKeyProvider): void => {
      providerSetupProviderRef.current = provider;
      setProviderSetupProvider(provider);
      setProviderSetupMessage(null);
    },
    [],
  );

  const handleProviderSetupKeyChange = useCallback(
    (value: string): void => {
      providerSetupEditRevisionRef.current += 1;
      setProviderSetupKey(value);
      setProviderSetupKeys((prev) => ({
        ...prev,
        [providerSetupProvider]: value,
      }));

      if (providerSetupMessage) {
        setProviderSetupMessage(null);
      }
    },
    [providerSetupMessage, providerSetupProvider],
  );

  const handleProviderSetupPortalOpen = useCallback(
    async (provider: UserApiKeyProvider): Promise<void> => {
      try {
        await openUserProviderApiKeyPortal(provider);
      } catch (error) {
        console.error("Failed to open provider API key settings", error);
        setProviderSetupMessage({
          tone: "error",
          text: `Could not open ${getUserApiKeyProviderLabel(provider)} API key settings.`,
        });
      }
    },
    [],
  );

  const handleWebSearchSetupProviderChange = useCallback(
    (provider: UserWebSearchApiKeyProvider): void => {
      webSearchSetupProviderRef.current = provider;
      setWebSearchSetupProvider(provider);
      setWebSearchSetupMessage(null);
    },
    [],
  );

  const handleWebSearchSetupKeyChange = useCallback(
    (value: string): void => {
      webSearchSetupEditRevisionRef.current += 1;
      setWebSearchSetupKey(value);
      setWebSearchSetupKeys((prev) => ({
        ...prev,
        [webSearchSetupProvider]: value,
      }));

      if (webSearchSetupMessage) {
        setWebSearchSetupMessage(null);
      }
    },
    [webSearchSetupMessage, webSearchSetupProvider],
  );

  const handleProviderSetupSave = useCallback(async (
    keyValue?: string,
  ): Promise<boolean> => {
    const normalizedKey = (keyValue ?? providerSetupKey).trim();
    const provider = providerSetupProvider;
    const editRevision = providerSetupEditRevisionRef.current;
    const requestId = providerSetupSaveRequestIdRef.current + 1;

    if (!normalizedKey || !isTauri()) {
      return false;
    }

    providerSetupSaveRequestIdRef.current = requestId;
    setProviderSetupSaving(true);
    setProviderSetupMessage(null);

    try {
      const nextProviders = await saveUserProviderApiKey(
        provider,
        normalizedKey,
      );

      if (providerSetupSaveRequestIdRef.current !== requestId) {
        return false;
      }

      setGlobalProviders(nextProviders);
      setProviderSetupKeys((prev) => ({
        ...prev,
        [provider]:
          providerSetupEditRevisionRef.current === editRevision
            ? normalizedKey
            : prev[provider],
      }));
      if (
        providerSetupEditRevisionRef.current === editRevision &&
        providerSetupProviderRef.current === provider
      ) {
        setProviderSetupKey(normalizedKey);
      }
      setProviderSetupMessage({
        tone: "success",
        text: `${getUserApiKeyProviderLabel(provider)} API key saved.`,
      });

      const submittedWorkspaceKey = createRuntimeSnapshotRequestKey(
        options.activeSessionWorkspace,
      );
      if (activeWorkspaceKeyRef.current === submittedWorkspaceKey) {
        await refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace);
      }
      const voiceRevision = voiceMutationRevisionRef.current;
      const speechRevision = speechMutationRevisionRef.current;
      const [voiceSettings, speechToTextSettings] = await Promise.all([
        loadUserVoiceSettings(),
        loadUserSpeechToTextSettings(),
      ]);
      if (voiceMutationRevisionRef.current === voiceRevision) {
        applyLoadedUserVoiceSettings(voiceSettings);
      }
      if (speechMutationRevisionRef.current === speechRevision) {
        applyLoadedUserSpeechToTextSettings(speechToTextSettings);
      }

      return true;
    } catch (error) {
      if (providerSetupSaveRequestIdRef.current !== requestId) {
        return false;
      }

      setProviderSetupMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The API key could not be saved.",
      });

      return false;
    } finally {
      if (providerSetupSaveRequestIdRef.current === requestId) {
        setProviderSetupSaving(false);
      }
    }
  }, [
    applyLoadedUserVoiceSettings,
    applyLoadedUserSpeechToTextSettings,
    options.activeSessionWorkspace,
    providerSetupKey,
    providerSetupProvider,
    refreshWorkspaceRuntimeSnapshot,
  ]);

  const handleVoiceActiveProviderSave = useCallback(
    async (provider: VoiceAiProvider): Promise<void> => {
      const mutationRevision = voiceMutationRevisionRef.current + 1;
      voiceMutationRevisionRef.current = mutationRevision;
      setVoiceSetupSaving(true);
      setVoiceSetupMessage(null);

      try {
        const settings = await saveUserVoiceActiveProvider(provider);
        const providerLabel =
          provider === "none" ? "System voice fallback" : getProviderLabel(provider);

        if (voiceMutationRevisionRef.current !== mutationRevision) {
          return;
        }
        applyLoadedUserVoiceSettings(settings);
        setVoiceSetupMessage({
          tone: "success",
          text:
            provider === "none"
              ? "AI voice playback is disabled. System voices remain available when supported."
              : settings.providerAvailability.some(
                    (entry) => entry.provider === provider && entry.configured,
                  )
                ? `${providerLabel} will handle new spoken replies.`
                : `${providerLabel} was selected, but replies will keep falling back until its API key is configured.`,
        });
      } catch (error) {
        setVoiceSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "The voice provider could not be saved.",
        });
      } finally {
        setVoiceSetupSaving(false);
      }
    },
    [applyLoadedUserVoiceSettings],
  );

  const handleSpeechToTextActiveProviderSave = useCallback(
    async (provider: SpeechToTextProvider): Promise<void> => {
      const mutationRevision = speechMutationRevisionRef.current + 1;
      speechMutationRevisionRef.current = mutationRevision;
      setSpeechToTextSetupSaving(true);
      setSpeechToTextSetupMessage(null);

      try {
        const settings = await saveUserSpeechToTextActiveProvider(provider);
        const providerLabel =
          provider === "none" ? "Speak to text" : getProviderLabel(provider);

        if (speechMutationRevisionRef.current !== mutationRevision) {
          return;
        }
        applyLoadedUserSpeechToTextSettings(settings);
        setSpeechToTextSetupMessage({
          tone: "success",
          text:
            provider === "none"
              ? "Speak to text is turned off."
              : settings.providerAvailability.some(
                    (entry) => entry.provider === provider && entry.configured,
                  )
                ? `${providerLabel} will handle new spoken prompts.`
                : `${providerLabel} was selected, but speech input will stay unavailable until its API key is configured.`,
        });
      } catch (error) {
        setSpeechToTextSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "The speech-to-text provider could not be saved.",
        });
      } finally {
        setSpeechToTextSetupSaving(false);
      }
    },
    [applyLoadedUserSpeechToTextSettings],
  );

  const handleSpeechToTextInputDeviceSave = useCallback(
    async (inputDeviceId: string | null): Promise<void> => {
      const normalizedInputDeviceId = inputDeviceId?.trim() || null;
      const mutationRevision = speechMutationRevisionRef.current + 1;
      speechMutationRevisionRef.current = mutationRevision;

      if (!isTauri()) {
        applyLoadedUserSpeechToTextSettings({
          ...userSpeechToTextSettings,
          inputDeviceId: normalizedInputDeviceId,
        });
        setSpeechToTextSetupMessage({
          tone: "success",
          text: normalizedInputDeviceId
            ? "Voice input device saved."
            : "Voice input will use the system default microphone.",
        });
        return;
      }

      setSpeechInputDeviceSaving(true);
      setSpeechToTextSetupMessage(null);

      try {
        const settings = await saveUserSpeechToTextInputDevice(
          normalizedInputDeviceId,
        );

        if (speechMutationRevisionRef.current !== mutationRevision) {
          return;
        }
        applyLoadedUserSpeechToTextSettings(settings);
        setSpeechToTextSetupMessage({
          tone: "success",
          text: normalizedInputDeviceId
            ? "Voice input device saved."
            : "Voice input will use the system default microphone.",
        });
      } catch (error) {
        setSpeechToTextSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "The voice input device could not be saved.",
        });
      } finally {
        setSpeechInputDeviceSaving(false);
      }
    },
    [applyLoadedUserSpeechToTextSettings, userSpeechToTextSettings],
  );

  const handleWebSearchActiveProviderSave = useCallback(
    async (provider: WebSearchProvider): Promise<void> => {
      const requestId = webSearchSetupSaveRequestIdRef.current + 1;
      const editRevision = webSearchSetupEditRevisionRef.current;
      webSearchSetupSaveRequestIdRef.current = requestId;
      setWebSearchSetupSaving(true);
      setWebSearchSetupMessage(null);

      try {
        const settings = await saveUserWebSearchActiveProvider(provider);

        if (webSearchSetupSaveRequestIdRef.current !== requestId) {
          return;
        }

        setWebSearchActiveProvider(settings.activeProvider);
        setWebSearchSetupKeys((currentKeys) =>
          webSearchSetupEditRevisionRef.current === editRevision
            ? settings.apiKeys
            : { ...settings.apiKeys, ...currentKeys },
        );
        setWebSearchSetupMessage({
          tone: "success",
          text:
            provider === "none"
              ? "Web search is hidden for new tasks."
              : `${getWebSearchProviderLabel(provider)} is now the active web-search provider.`,
        });

        await refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace);
      } catch (error) {
        if (webSearchSetupSaveRequestIdRef.current !== requestId) {
          return;
        }

        setWebSearchSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "The web-search provider could not be saved.",
        });
      } finally {
        if (webSearchSetupSaveRequestIdRef.current === requestId) {
          setWebSearchSetupSaving(false);
        }
      }
    },
    [
      options.activeSessionWorkspace,
      refreshWorkspaceRuntimeSnapshot,
    ],
  );

  const handleWebSearchSetupSave = useCallback(async (
    keyValue?: string,
  ): Promise<boolean> => {
    const normalizedKey = (keyValue ?? webSearchSetupKey).trim();
    const provider = webSearchSetupProvider;
    const editRevision = webSearchSetupEditRevisionRef.current;
    const requestId = webSearchSetupSaveRequestIdRef.current + 1;

    if (!normalizedKey || !isTauri()) {
      return false;
    }

    webSearchSetupSaveRequestIdRef.current = requestId;
    setWebSearchSetupSaving(true);
    setWebSearchSetupMessage(null);

    try {
      const settings = await saveUserWebSearchApiKey(
        provider,
        normalizedKey,
      );

      if (webSearchSetupSaveRequestIdRef.current !== requestId) {
        return false;
      }

      setWebSearchActiveProvider(settings.activeProvider);
      setWebSearchSetupKeys((prev) => ({
        ...settings.apiKeys,
        ...prev,
        [provider]:
          webSearchSetupEditRevisionRef.current === editRevision
            ? normalizedKey
            : prev[provider],
      }));
      if (
        webSearchSetupEditRevisionRef.current === editRevision &&
        webSearchSetupProviderRef.current === provider
      ) {
        setWebSearchSetupKey(normalizedKey);
      }
      setWebSearchSetupMessage({
        tone: "success",
        text: `${getWebSearchProviderLabel(provider)} API key saved.`,
      });

      await refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace);

      return true;
    } catch (error) {
      if (webSearchSetupSaveRequestIdRef.current !== requestId) {
        return false;
      }

      setWebSearchSetupMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The web-search API key could not be saved.",
      });

      return false;
    } finally {
      if (webSearchSetupSaveRequestIdRef.current === requestId) {
        setWebSearchSetupSaving(false);
      }
    }
  }, [
    options.activeSessionWorkspace,
    refreshWorkspaceRuntimeSnapshot,
    webSearchSetupKey,
    webSearchSetupProvider,
  ]);

  const handleDesktopSettingsSave = useCallback(
    async (settings: UserDesktopSettings): Promise<void> => {
      if (!isTauri()) {
        applyLoadedUserDesktopSettings(settings);
        setDesktopSetupMessage({
          tone: "success",
          text: getDesktopSettingsSavedMessage(settings),
        });
        return;
      }

      setDesktopSetupSaving(true);
      setDesktopSetupMessage(null);

      try {
        const nextSettings = await saveUserDesktopSettings(settings);

        applyLoadedUserDesktopSettings(nextSettings);
        setDesktopSetupMessage({
          tone: "success",
          text: getDesktopSettingsSavedMessage(nextSettings),
        });
      } catch (error) {
        setDesktopSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Desktop startup settings could not be updated.",
        });
      } finally {
        setDesktopSetupSaving(false);
      }
    },
    [applyLoadedUserDesktopSettings],
  );

  const handleAgentLimitsSettingsSave = useCallback(
    async (settings: UserAgentLimitsSettings): Promise<void> => {
      setAgentLimitsSetupSaving(true);
      setAgentLimitsSetupMessage(null);

      try {
        const nextSettings = await saveUserAgentLimitsSettings(settings);

        applyLoadedUserAgentLimitsSettings(nextSettings);
        setAgentLimitsSetupMessage({
          tone: "success",
          text: getAgentLimitsSettingsSavedMessage(nextSettings),
        });

        await refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace);
      } catch (error) {
        setAgentLimitsSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Agent loop limits could not be updated.",
        });
      } finally {
        setAgentLimitsSetupSaving(false);
      }
    },
    [
      applyLoadedUserAgentLimitsSettings,
        options.activeSessionWorkspace,
      refreshWorkspaceRuntimeSnapshot,
    ],
  );

  const handleReviewModelSettingsSave = useCallback(
    async (settings: UserReviewModelSettings): Promise<void> => {
      setAgentLimitsSetupSaving(true);
      setAgentLimitsSetupMessage(null);

      try {
        const nextSettings = await saveUserReviewModelSettings(settings);

        applyLoadedUserReviewModelSettings(nextSettings);
        setAgentLimitsSetupMessage({
          tone: "success",
          text: getReviewModelSettingsSavedMessage(nextSettings),
        });

        await refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace);
      } catch (error) {
        setAgentLimitsSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Review model settings could not be updated.",
        });
      } finally {
        setAgentLimitsSetupSaving(false);
      }
    },
    [
      applyLoadedUserReviewModelSettings,
        options.activeSessionWorkspace,
      refreshWorkspaceRuntimeSnapshot,
    ],
  );

  const handleWorkspaceDefaultModeSave = useCallback(
    async (mode: RuntimeSnapshot["mode"]): Promise<void> => {
      const workspaceRoot = options.activeSessionWorkspace;
      if (!workspaceRoot) {
        setWorkspaceSetupMessage({
          tone: "error",
          text: "Select a workspace before changing its default mode.",
        });
        return;
      }

      const workspaceKey = createRuntimeSnapshotRequestKey(workspaceRoot);
      const requestId = workspaceSaveRequestIdRef.current + 1;
      workspaceSaveRequestIdRef.current = requestId;

      setWorkspaceSetupSaving(true);
      setWorkspaceSetupMessage(null);

      try {
        await saveWorkspaceDefaultMode(workspaceRoot, mode);

        if (
          workspaceSaveRequestIdRef.current !== requestId ||
          activeWorkspaceKeyRef.current !== workspaceKey
        ) {
          return;
        }

        if (!isTauri()) {
          setRuntimeSnapshot((currentSnapshot) =>
            currentSnapshot
              ? {
                  ...currentSnapshot,
                  defaultMode: mode,
                  mode,
                }
              : currentSnapshot,
          );
        }

        await refreshWorkspaceRuntimeSnapshot(workspaceRoot);

        if (activeWorkspaceKeyRef.current !== workspaceKey) {
          return;
        }

        setWorkspaceSetupMessage({
          tone: "success",
          text: `Workspace default mode saved as ${getRunModeLabel(mode)}.`,
        });
      } catch (error) {
        if (
          workspaceSaveRequestIdRef.current === requestId &&
          activeWorkspaceKeyRef.current === workspaceKey
        ) {
          setWorkspaceSetupMessage({
            tone: "error",
            text:
              error instanceof Error
                ? error.message
                : "Workspace default mode could not be updated.",
          });
        }
      } finally {
        if (workspaceSaveRequestIdRef.current === requestId) {
          setWorkspaceSetupSaving(false);
        }
      }
    },
    [
      options.activeSessionWorkspace,
      refreshWorkspaceRuntimeSnapshot,
    ],
  );

  const handleWorkspaceReasoningModeSave = useCallback(
    async (reasoning: RuntimeSnapshot["reasoning"]): Promise<void> => {
      const workspaceRoot = options.activeSessionWorkspace;
      if (!workspaceRoot) {
        setWorkspaceSetupMessage({
          tone: "error",
          text: "Select a workspace before changing its reasoning mode.",
        });
        return;
      }

      const workspaceKey = createRuntimeSnapshotRequestKey(workspaceRoot);
      const requestId = workspaceSaveRequestIdRef.current + 1;
      workspaceSaveRequestIdRef.current = requestId;

      setWorkspaceSetupSaving(true);
      setWorkspaceSetupMessage(null);

      try {
        await saveWorkspaceReasoningMode(
          workspaceRoot,
          reasoning,
        );

        if (
          workspaceSaveRequestIdRef.current !== requestId ||
          activeWorkspaceKeyRef.current !== workspaceKey
        ) {
          return;
        }

        if (!isTauri()) {
          setRuntimeSnapshot((currentSnapshot) =>
            currentSnapshot
              ? {
                  ...currentSnapshot,
                  reasoning,
                }
              : currentSnapshot,
          );
        }

        await refreshWorkspaceRuntimeSnapshot(workspaceRoot);

        if (activeWorkspaceKeyRef.current !== workspaceKey) {
          return;
        }

        setWorkspaceSetupMessage({
          tone: "success",
          text: `Workspace reasoning saved as ${getReasoningModeLabel(reasoning)}.`,
        });
      } catch (error) {
        if (
          workspaceSaveRequestIdRef.current === requestId &&
          activeWorkspaceKeyRef.current === workspaceKey
        ) {
          setWorkspaceSetupMessage({
            tone: "error",
            text:
              error instanceof Error
                ? error.message
                : "Workspace reasoning mode could not be updated.",
          });
        }
      } finally {
        if (workspaceSaveRequestIdRef.current === requestId) {
          setWorkspaceSetupSaving(false);
        }
      }
    },
    [
      options.activeSessionWorkspace,
      refreshWorkspaceRuntimeSnapshot,
    ],
  );

  const handleMcpConfigScopeChange = useCallback(
    (scope: McpConfigScope): void => {
      if (scope === "workspace" && !options.activeSessionWorkspace?.trim()) {
        setMcpConfigMessage({
          tone: "error",
          text: "Select a workspace before editing workspace MCP config.",
        });
        return;
      }

      setMcpConfigScope(scope);
      setMcpConfigMessage(null);
    },
    [options.activeSessionWorkspace],
  );

  const handleMcpConfigDraftChange = useCallback(
    (value: string): void => {
      mcpConfigDraftRevisionRef.current[mcpConfigScope] += 1;
      mcpConfigDraftsRef.current = {
        ...mcpConfigDraftsRef.current,
        [mcpConfigScope]: value,
      };
      setMcpConfigDrafts((prev) => ({
        ...prev,
        [mcpConfigScope]: value,
      }));

      if (mcpConfigMessage) {
        setMcpConfigMessage(null);
      }
    },
    [mcpConfigMessage, mcpConfigScope],
  );

  const handleMcpConfigSave = useCallback(async (): Promise<void> => {
    const requestId = mcpConfigSaveRequestIdRef.current + 1;
    const scope = mcpConfigScope;
    const submittedDraft = mcpConfigDraft;
    const draftRevision = mcpConfigDraftRevisionRef.current[scope];
    const workspaceRoot = options.activeSessionWorkspace;
    const workspaceKey = createRuntimeSnapshotRequestKey(workspaceRoot);
    const expectedRaw = mcpConfigDocumentsRef.current[scope].raw;

    if (
      scope === "workspace" &&
      (!workspaceKey ||
        representedMcpWorkspaceKeyRef.current !== workspaceKey)
    ) {
      setMcpConfigMessage({
        tone: "error",
        text: "The workspace changed. Reload its MCP configuration before saving.",
      });
      return;
    }

    mcpConfigSaveRequestIdRef.current = requestId;
    mcpConfigLoadRequestIdRef.current += 1;
    setMcpConfigLoading(false);
    setMcpConfigSaving(true);
    setMcpConfigMessage(null);

    try {
      const document = await saveMcpConfigDocument(
        scope,
        submittedDraft,
        workspaceRoot,
        expectedRaw,
      );

      if (
        mcpConfigSaveRequestIdRef.current !== requestId ||
        (scope === "workspace" &&
          (activeWorkspaceKeyRef.current !== workspaceKey ||
            representedMcpWorkspaceKeyRef.current !== workspaceKey))
      ) {
        return;
      }

      setMcpConfigDocuments((prev) => ({
        ...prev,
        [scope]: document,
      }));
      mcpConfigDocumentsRef.current = {
        ...mcpConfigDocumentsRef.current,
        [scope]: document,
      };
      const nextDraft =
        mcpConfigDraftRevisionRef.current[scope] === draftRevision &&
        mcpConfigDraftsRef.current[scope] === submittedDraft
          ? document.raw
          : mcpConfigDraftsRef.current[scope];
      mcpConfigDraftsRef.current = {
        ...mcpConfigDraftsRef.current,
        [scope]: nextDraft,
      };
      setMcpConfigDrafts((prev) => ({ ...prev, [scope]: nextDraft }));

      if (scope === "workspace" && workspaceKey) {
        rememberMcpWorkspaceEditor(mcpWorkspaceEditorsRef.current, workspaceKey, {
          document,
          draft: nextDraft,
          draftRevision: mcpConfigDraftRevisionRef.current.workspace,
        });
      }
      setMcpConfigMessage({
        tone: "success",
        text:
          scope === "workspace"
            ? "Workspace MCP config saved."
            : "Global MCP config saved.",
      });
    } catch (error) {
      if (mcpConfigSaveRequestIdRef.current !== requestId) {
        return;
      }

      if (isMcpConfigConflict(error)) {
        try {
          const latestDocument = await loadMcpConfigDocument(
            scope,
            workspaceRoot,
          );

          if (
            mcpConfigSaveRequestIdRef.current !== requestId ||
            (scope === "workspace" &&
              (activeWorkspaceKeyRef.current !== workspaceKey ||
                representedMcpWorkspaceKeyRef.current !== workspaceKey))
          ) {
            return;
          }

          mcpConfigDocumentsRef.current = {
            ...mcpConfigDocumentsRef.current,
            [scope]: latestDocument,
          };
          setMcpConfigDocuments((prev) => ({
            ...prev,
            [scope]: latestDocument,
          }));
          setMcpConfigMessage({
            tone: "error",
            text: "MCP configuration changed elsewhere. The latest version is now the comparison base and your draft was kept; review it before saving again.",
          });
          return;
        } catch (reloadError) {
          console.error("Failed to reload conflicting MCP config", reloadError);
        }
      }

      setMcpConfigMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "MCP configuration could not be saved.",
      });
    } finally {
      if (mcpConfigSaveRequestIdRef.current === requestId) {
        setMcpConfigSaving(false);
      }
    }
  }, [mcpConfigDraft, mcpConfigScope, options.activeSessionWorkspace]);

  const handleMcpPresetInsert = useCallback(
    (presetId: string): void => {
      try {
        const nextDraft = createMcpConfigRawWithPreset(
          mcpConfigDraft,
          presetId,
        );
        const preset = MCP_PRESET_SUMMARIES.find(
          (candidate) => candidate.id === presetId,
        );

        mcpConfigDraftRevisionRef.current[mcpConfigScope] += 1;
        mcpConfigDraftsRef.current = {
          ...mcpConfigDraftsRef.current,
          [mcpConfigScope]: nextDraft,
        };
        setMcpConfigDrafts((prev) => ({
          ...prev,
          [mcpConfigScope]: nextDraft,
        }));
        setMcpConfigMessage({
          tone: "success",
          text: `${preset?.title ?? "MCP preset"} added to the draft. Save to write the config.`,
        });
      } catch (error) {
        setMcpConfigMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "MCP preset could not be inserted.",
        });
      }
    },
    [mcpConfigDraft, mcpConfigScope],
  );

  const handleMcpDiscoveryServerIdChange = useCallback((serverId: string): void => {
    setMcpDiscoveryServerId(serverId);
    setMcpConfigMessage(null);
  }, []);

  const runMcpDiscoveryAction = useCallback(
    async (
      action: "discover" | "refresh" | "cache",
      requestedServerId?: string,
    ): Promise<void> => {
      const workspaceRoot = options.activeSessionWorkspace;
      if (!workspaceRoot?.trim()) {
        setMcpConfigMessage({
          tone: "error",
          text: "Select a workspace before using MCP discovery.",
        });
        return;
      }

      const workspaceKey = createRuntimeSnapshotRequestKey(workspaceRoot);
      const requestId = mcpDiscoveryRequestIdRef.current + 1;
      mcpDiscoveryRequestIdRef.current = requestId;

      const serverId = (requestedServerId ?? mcpDiscoveryServerId).trim();

      if (action !== "cache" && !serverId) {
        setMcpConfigMessage({
          tone: "error",
          text: "Enter an MCP server id before discovery.",
        });
        return;
      }

      setMcpDiscoveryBusy(true);
      setMcpConfigMessage(null);

      try {
        const result =
          action === "cache"
            ? await listMcpCachedCapabilities(workspaceRoot)
            : action === "refresh"
              ? await refreshMcpDiscoveryCache(
                  workspaceRoot,
                  serverId,
                )
              : await discoverMcpServer(workspaceRoot, serverId);

        if (
          mcpDiscoveryRequestIdRef.current !== requestId ||
          activeWorkspaceKeyRef.current !== workspaceKey
        ) {
          return;
        }

        setMcpDiscoveryOutput(JSON.stringify(result, null, 2));
        setMcpConfigMessage({
          tone: "success",
          text:
            action === "cache"
              ? "MCP discovery cache loaded."
              : action === "refresh"
                ? "MCP discovery cache refreshed."
                : "MCP server discovery completed.",
        });
      } catch (error) {
        if (
          mcpDiscoveryRequestIdRef.current === requestId &&
          activeWorkspaceKeyRef.current === workspaceKey
        ) {
          setMcpConfigMessage({
            tone: "error",
            text:
              error instanceof Error
                ? error.message
                : "MCP discovery could not be completed.",
          });
        }
      } finally {
        if (mcpDiscoveryRequestIdRef.current === requestId) {
          setMcpDiscoveryBusy(false);
        }
      }
    },
    [mcpDiscoveryServerId, options.activeSessionWorkspace],
  );

  const handleMcpDiscoverServer = useCallback(async (serverId?: string): Promise<void> => {
    await runMcpDiscoveryAction("discover", serverId);
  }, [runMcpDiscoveryAction]);

  const handleMcpRefreshDiscoveryCache = useCallback(async (serverId?: string): Promise<void> => {
    await runMcpDiscoveryAction("refresh", serverId);
  }, [runMcpDiscoveryAction]);

  const handleMcpListDiscoveryCache = useCallback(async (): Promise<void> => {
    await runMcpDiscoveryAction("cache");
  }, [runMcpDiscoveryAction]);

  const refreshUserMcpConfigDocument = useCallback(async (): Promise<void> => {
    const requestId = mcpConfigLoadRequestIdRef.current + 1;
    const draftRevision = mcpConfigDraftRevisionRef.current.user;
    const draftWasClean =
      mcpConfigDraftsRef.current.user ===
      mcpConfigDocumentsRef.current.user.raw;
    mcpConfigLoadRequestIdRef.current = requestId;
    let document: McpConfigDocument;

    try {
      document = await loadMcpConfigDocument(
        "user",
        options.activeSessionWorkspace,
      );
    } finally {
      if (mcpConfigLoadRequestIdRef.current === requestId) {
        setMcpConfigLoading(false);
      }
    }

    if (mcpConfigLoadRequestIdRef.current !== requestId) {
      return;
    }

    const canReplaceDraft =
      draftWasClean &&
      mcpConfigDraftRevisionRef.current.user === draftRevision;

    if (!canReplaceDraft) {
      setMcpConfigMessage({
        tone: "error",
        text: "The global MCP configuration changed while this draft was open. Your draft and its original comparison base were kept; saving will require conflict review.",
      });
      return;
    }

    setMcpConfigDocuments((prev) => ({
      ...prev,
      user: document,
    }));
    mcpConfigDocumentsRef.current = {
      ...mcpConfigDocumentsRef.current,
      user: document,
    };
    setMcpConfigDrafts((prev) => ({
      ...prev,
      user: document.raw,
    }));
    mcpConfigDraftsRef.current = {
      ...mcpConfigDraftsRef.current,
      user: document.raw,
    };
  }, [options.activeSessionWorkspace]);

  const handleMcpOAuthServerIdChange = useCallback((serverId: string): void => {
    setMcpOAuthServerId(serverId);
    setMcpConfigMessage(null);
  }, []);

  const handleMcpOAuthCallbackChange = useCallback((value: string): void => {
    setMcpOAuthCallback(value);
    setMcpConfigMessage(null);
  }, []);

  const handleMcpOAuthStart = useCallback(async (requestedServerId?: string): Promise<void> => {
    const workspaceRoot = options.activeSessionWorkspace;
    if (!workspaceRoot?.trim()) {
      setMcpConfigMessage({
        tone: "error",
        text: "Select a workspace before starting MCP OAuth.",
      });
      return;
    }

    const workspaceKey = createRuntimeSnapshotRequestKey(workspaceRoot);
    const requestId = mcpOAuthRequestIdRef.current + 1;
    mcpOAuthRequestIdRef.current = requestId;

    const serverId = (requestedServerId ?? mcpOAuthServerId).trim();

    if (!serverId) {
      setMcpConfigMessage({
        tone: "error",
        text: "Enter an MCP server id before starting OAuth.",
      });
      return;
    }

    setMcpOAuthBusy(true);
    setMcpConfigMessage(null);

    try {
      const result = await authorizeMcpOAuth(
        workspaceRoot,
        serverId,
      );

      if (
        mcpOAuthRequestIdRef.current !== requestId ||
        activeWorkspaceKeyRef.current !== workspaceKey
      ) {
        return;
      }

      setMcpDiscoveryOutput(JSON.stringify(result, null, 2));
      await refreshUserMcpConfigDocument();

      if (activeWorkspaceKeyRef.current !== workspaceKey) {
        return;
      }

      setMcpConfigMessage({
        tone: "success",
        text:
          result.result.status === "authorization-required"
            ? "MCP OAuth needs manual completion. Paste the callback URL or code here and finish OAuth."
            : result.result.stateVerified === false
              ? "MCP OAuth authorized. Callback state was not available to verify."
              : "MCP OAuth authorized.",
      });
    } catch (error) {
      if (
        mcpOAuthRequestIdRef.current === requestId &&
        activeWorkspaceKeyRef.current === workspaceKey
      ) {
        setMcpConfigMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "MCP OAuth could not be started.",
        });
      }
    } finally {
      if (mcpOAuthRequestIdRef.current === requestId) {
        setMcpOAuthBusy(false);
      }
    }
  }, [
    mcpOAuthServerId,
    options.activeSessionWorkspace,
    refreshUserMcpConfigDocument,
  ]);

  const handleMcpOAuthFinish = useCallback(async (
    requestedServerId?: string,
    requestedAuthorizationResponse?: string,
  ): Promise<void> => {
    const workspaceRoot = options.activeSessionWorkspace;
    if (!workspaceRoot?.trim()) {
      setMcpConfigMessage({
        tone: "error",
        text: "Select a workspace before finishing MCP OAuth.",
      });
      return;
    }

    const workspaceKey = createRuntimeSnapshotRequestKey(workspaceRoot);
    const requestId = mcpOAuthRequestIdRef.current + 1;
    mcpOAuthRequestIdRef.current = requestId;

    const serverId = (requestedServerId ?? mcpOAuthServerId).trim();
    const authorizationResponse = (
      requestedAuthorizationResponse ?? mcpOAuthCallback
    ).trim();

    if (!serverId) {
      setMcpConfigMessage({
        tone: "error",
        text: "Enter an MCP server id before finishing OAuth.",
      });
      return;
    }

    if (!authorizationResponse) {
      setMcpConfigMessage({
        tone: "error",
        text: "Paste the OAuth callback URL or code before finishing OAuth.",
      });
      return;
    }

    setMcpOAuthBusy(true);
    setMcpConfigMessage(null);

    try {
      const result = await finishMcpOAuth(
        workspaceRoot,
        serverId,
        authorizationResponse,
      );

      if (
        mcpOAuthRequestIdRef.current !== requestId ||
        activeWorkspaceKeyRef.current !== workspaceKey
      ) {
        return;
      }

      setMcpDiscoveryOutput(JSON.stringify(result, null, 2));
      setMcpOAuthCallback("");
      await refreshUserMcpConfigDocument();
      if (activeWorkspaceKeyRef.current !== workspaceKey) {
        return;
      }
      setMcpConfigMessage({
        tone: "success",
        text:
          result.result.stateVerified === false
            ? "MCP OAuth finished. Callback state was not available to verify."
            : "MCP OAuth finished.",
      });
    } catch (error) {
      if (
        mcpOAuthRequestIdRef.current === requestId &&
        activeWorkspaceKeyRef.current === workspaceKey
      ) {
        setMcpConfigMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "MCP OAuth could not be finished.",
        });
      }
    } finally {
      if (mcpOAuthRequestIdRef.current === requestId) {
        setMcpOAuthBusy(false);
      }
    }
  }, [
    mcpOAuthCallback,
    mcpOAuthServerId,
    options.activeSessionWorkspace,
    refreshUserMcpConfigDocument,
  ]);

  const handleGlobalMemoryEnabledSave = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!isTauri()) {
        applyLoadedUserMemorySettings({
          ...userMemorySettings,
          globalEnabled: enabled,
        });
        return;
      }

      setMemorySetupSaving(true);
      setMemorySetupMessage(null);

      try {
        const settings = await saveUserGlobalMemoryEnabled(enabled);

        applyLoadedUserMemorySettings(settings);
        setMemorySetupMessage({
          tone: "success",
          text: enabled
            ? "Global memory is now enabled for future sessions."
            : "Global memory is now disabled by default.",
        });
      } catch (error) {
        setMemorySetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Global memory could not be updated.",
        });
      } finally {
        setMemorySetupSaving(false);
      }
    },
    [applyLoadedUserMemorySettings, userMemorySettings],
  );

  return {
    globalProviders,
    runtimeSnapshot,
    runtimeLoading,
    runtimeError,
    providerSetupProvider,
    providerSetupKey,
    providerSetupSaving,
    providerSetupMessage,
    userVoiceSettings,
    voiceSetupSaving,
    voiceSetupMessage,
    userSpeechToTextSettings,
    userSpeechToTextSettingsLoaded,
    speechToTextSetupSaving,
    speechInputDeviceSaving,
    speechToTextSetupMessage,
    webSearchActiveProvider,
    webSearchSetupProvider,
    webSearchSetupKey,
    webSearchSetupSaving,
    webSearchSetupMessage,
    userDesktopSettings,
    userDesktopSettingsLoaded,
    desktopSetupSaving,
    desktopSetupMessage,
    userAgentLimitsSettings,
    userReviewModelSettings,
    agentLimitsSetupSaving,
    agentLimitsSetupMessage,
    workspaceSetupSaving,
    workspaceSetupMessage,
    mcpConfigScope,
    mcpConfigDocument,
    mcpConfigDraft,
    mcpConfigPresets: MCP_PRESET_SUMMARIES,
    mcpConfigWorkspaceAvailable,
    mcpConfigLoading,
    mcpConfigSaving,
    mcpDiscoveryServerId,
    mcpDiscoveryBusy,
    mcpDiscoveryOutput,
    mcpOAuthServerId,
    mcpOAuthCallback,
    mcpOAuthBusy,
    mcpConfigMessage,
    userMemorySettings,
    memorySetupSaving,
    memorySetupMessage,
    setGlobalProviders,
    refreshWorkspaceRuntimeSnapshot,
    handleProviderSetupProviderChange,
    handleProviderSetupPortalOpen,
    handleProviderSetupKeyChange,
    handleProviderSetupSave,
    handleVoiceActiveProviderSave,
    handleSpeechToTextActiveProviderSave,
    handleSpeechToTextInputDeviceSave,
    handleWebSearchActiveProviderSave,
    handleWebSearchSetupProviderChange,
    handleWebSearchSetupKeyChange,
    handleWebSearchSetupSave,
    handleDesktopSettingsSave,
    handleAgentLimitsSettingsSave,
    handleReviewModelSettingsSave,
    handleWorkspaceDefaultModeSave,
    handleWorkspaceReasoningModeSave,
    handleMcpConfigScopeChange,
    handleMcpConfigDraftChange,
    handleMcpConfigSave,
    handleMcpPresetInsert,
    handleMcpDiscoveryServerIdChange,
    handleMcpDiscoverServer,
    handleMcpRefreshDiscoveryCache,
    handleMcpListDiscoveryCache,
    handleMcpOAuthServerIdChange,
    handleMcpOAuthCallbackChange,
    handleMcpOAuthStart,
    handleMcpOAuthFinish,
    handleGlobalMemoryEnabledSave,
    applyLoadedUserDesktopSettings,
    applyLoadedUserAgentLimitsSettings,
    applyLoadedUserReviewModelSettings,
    applyLoadedUserMemorySettings,
  };
};
