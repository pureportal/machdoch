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
  saveUserVoiceActiveProvider,
  saveUserProviderApiKey,
  saveWorkspaceDefaultMode,
  saveWorkspaceReasoningMode,
  subscribeToDesktopSettingsChanged,
  createFallbackMcpConfigDocument,
  createMcpConfigRawWithPreset,
  MCP_PRESET_SUMMARIES,
  USER_SPEECH_TO_TEXT_PROVIDER_ORDER,
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
  createEmptyWebSearchSettings,
  getWebSearchProviderLabel,
} from "./session-shell";

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
): provider is UserApiKeyProvider => {
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
  const mcpConfigDocument = mcpConfigDocuments[mcpConfigScope];
  const mcpConfigDraft = mcpConfigDrafts[mcpConfigScope];
  const mcpConfigWorkspaceAvailable = Boolean(
    options.activeSessionWorkspace?.trim(),
  );

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
        return runtimeSnapshotRequestIdRef.current === requestId;
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
    setMcpConfigLoading(true);
    setMcpConfigMessage(null);

    try {
      const [userDocument, workspaceDocument] = await Promise.all([
        loadMcpConfigDocument("user"),
        loadMcpConfigDocument("workspace", options.activeSessionWorkspace),
      ]);

      setMcpConfigDocuments({
        user: userDocument,
        workspace: workspaceDocument,
      });
      setMcpConfigDrafts({
        user: userDocument.raw,
        workspace: workspaceDocument.raw,
      });
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

      if (!options.activeSessionWorkspace?.trim()) {
        setMcpConfigScope("user");
      }
    } catch (error) {
      console.error("Failed to load MCP config documents", error);
      setMcpConfigMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "MCP configuration could not be loaded.",
      });
    } finally {
      setMcpConfigLoading(false);
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
        applyLoadedUserSpeechToTextSettings({
          activeProvider: "none",
          inputDeviceId: null,
          providerAvailability: USER_SPEECH_TO_TEXT_PROVIDER_ORDER.map(
            (provider) => ({
              provider,
              configured: false,
            }),
          ),
        });
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
          applyLoadedUserDesktopSettings(createEmptyUserDesktopSettings());
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
        applyLoadedUserDesktopSettings(createEmptyUserDesktopSettings());
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
        applyLoadedUserAgentLimitsSettings(
          createEmptyUserAgentLimitsSettings(),
        );
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
        applyLoadedUserReviewModelSettings(
          createEmptyUserReviewModelSettings(),
        );
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
      return;
    }

    let cancelled = false;

    setProviderSetupProvider(
      getInitialProviderSetupProvider(options.activeSessionProvider),
    );
    setProviderSetupKeys({});
    setProviderSetupKey("");
    setProviderSetupMessage(null);

    void loadUserProviderApiKeys()
      .then((apiKeys) => {
        if (!cancelled) {
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
  }, [options.activeSessionProvider, options.catalogOpen]);

  useEffect(() => {
    if (!options.catalogOpen) {
      return;
    }

    setProviderSetupKey(providerSetupKeys[providerSetupProvider] ?? "");
  }, [options.catalogOpen, providerSetupKeys, providerSetupProvider]);

  useEffect(() => {
    if (!options.catalogOpen) {
      return;
    }

    let cancelled = false;

    setWebSearchSetupKeys({});
    setWebSearchSetupKey("");
    setWebSearchSetupMessage(null);

    void loadUserWebSearchSettings()
      .then((settings) => {
        if (cancelled) {
          return;
        }

        applyLoadedWebSearchSettings(settings);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        console.error("Failed to load web-search settings", error);
        applyLoadedWebSearchSettings(createEmptyWebSearchSettings());
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
        applyLoadedUserMemorySettings(createEmptyUserMemorySettings());
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
      setProviderSetupProvider(provider);
      setProviderSetupMessage(null);
    },
    [],
  );

  const handleProviderSetupKeyChange = useCallback(
    (value: string): void => {
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
          text: `Could not open ${getProviderLabel(provider)} API key settings.`,
        });
      }
    },
    [],
  );

  const handleWebSearchSetupProviderChange = useCallback(
    (provider: UserWebSearchApiKeyProvider): void => {
      setWebSearchSetupProvider(provider);
      setWebSearchSetupMessage(null);
    },
    [],
  );

  const handleWebSearchSetupKeyChange = useCallback(
    (value: string): void => {
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

    if (!normalizedKey || !isTauri()) {
      return false;
    }

    setProviderSetupSaving(true);
    setProviderSetupMessage(null);

    try {
      const nextProviders = await saveUserProviderApiKey(
        providerSetupProvider,
        normalizedKey,
      );

      setGlobalProviders(nextProviders);
      setProviderSetupKeys((prev) => ({
        ...prev,
        [providerSetupProvider]: normalizedKey,
      }));
      setProviderSetupKey(normalizedKey);
      setProviderSetupMessage({
        tone: "success",
        text: `${getProviderLabel(providerSetupProvider)} API key saved.`,
      });

      await refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace);
      const [voiceSettings, speechToTextSettings] = await Promise.all([
        loadUserVoiceSettings(),
        loadUserSpeechToTextSettings(),
      ]);
      applyLoadedUserVoiceSettings(voiceSettings);
      applyLoadedUserSpeechToTextSettings(speechToTextSettings);

      return true;
    } catch (error) {
      setProviderSetupMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The API key could not be saved.",
      });

      return false;
    } finally {
      setProviderSetupSaving(false);
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
      setVoiceSetupSaving(true);
      setVoiceSetupMessage(null);

      try {
        const settings = await saveUserVoiceActiveProvider(provider);
        const providerLabel =
          provider === "none" ? "System voice fallback" : getProviderLabel(provider);

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
      setSpeechToTextSetupSaving(true);
      setSpeechToTextSetupMessage(null);

      try {
        const settings = await saveUserSpeechToTextActiveProvider(provider);
        const providerLabel =
          provider === "none" ? "Speak to text" : getProviderLabel(provider);

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
      setWebSearchSetupSaving(true);
      setWebSearchSetupMessage(null);

      try {
        const settings = await saveUserWebSearchActiveProvider(provider);

        applyLoadedWebSearchSettings(settings);
        setWebSearchSetupMessage({
          tone: "success",
          text:
            provider === "none"
              ? "Web search is hidden for new tasks."
              : `${getWebSearchProviderLabel(provider)} is now the active web-search provider.`,
        });

        await refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace);
      } catch (error) {
        setWebSearchSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "The web-search provider could not be saved.",
        });
      } finally {
        setWebSearchSetupSaving(false);
      }
    },
    [
      applyLoadedWebSearchSettings,
        options.activeSessionWorkspace,
      refreshWorkspaceRuntimeSnapshot,
    ],
  );

  const handleWebSearchSetupSave = useCallback(async (
    keyValue?: string,
  ): Promise<boolean> => {
    const normalizedKey = (keyValue ?? webSearchSetupKey).trim();

    if (!normalizedKey || !isTauri()) {
      return false;
    }

    setWebSearchSetupSaving(true);
    setWebSearchSetupMessage(null);

    try {
      const settings = await saveUserWebSearchApiKey(
        webSearchSetupProvider,
        normalizedKey,
      );

      applyLoadedWebSearchSettings(settings);
      setWebSearchSetupKeys((prev) => ({
        ...prev,
        ...settings.apiKeys,
        [webSearchSetupProvider]: normalizedKey,
      }));
      setWebSearchSetupKey(normalizedKey);
      setWebSearchSetupMessage({
        tone: "success",
        text: `${getWebSearchProviderLabel(webSearchSetupProvider)} API key saved.`,
      });

      await refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace);

      return true;
    } catch (error) {
      setWebSearchSetupMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The web-search API key could not be saved.",
      });

      return false;
    } finally {
      setWebSearchSetupSaving(false);
    }
  }, [
    applyLoadedWebSearchSettings,
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
      if (!options.activeSessionWorkspace) {
        setWorkspaceSetupMessage({
          tone: "error",
          text: "Select a workspace before changing its default mode.",
        });
        return;
      }

      setWorkspaceSetupSaving(true);
      setWorkspaceSetupMessage(null);

      try {
        await saveWorkspaceDefaultMode(options.activeSessionWorkspace, mode);

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

        await refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace);

        setWorkspaceSetupMessage({
          tone: "success",
          text: `Workspace default mode saved as ${getRunModeLabel(mode)}.`,
        });
      } catch (error) {
        setWorkspaceSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Workspace default mode could not be updated.",
        });
      } finally {
        setWorkspaceSetupSaving(false);
      }
    },
    [
      options.activeSessionWorkspace,
      refreshWorkspaceRuntimeSnapshot,
    ],
  );

  const handleWorkspaceReasoningModeSave = useCallback(
    async (reasoning: RuntimeSnapshot["reasoning"]): Promise<void> => {
      if (!options.activeSessionWorkspace) {
        setWorkspaceSetupMessage({
          tone: "error",
          text: "Select a workspace before changing its reasoning mode.",
        });
        return;
      }

      setWorkspaceSetupSaving(true);
      setWorkspaceSetupMessage(null);

      try {
        await saveWorkspaceReasoningMode(
          options.activeSessionWorkspace,
          reasoning,
        );

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

        await refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace);

        setWorkspaceSetupMessage({
          tone: "success",
          text: `Workspace reasoning saved as ${getReasoningModeLabel(reasoning)}.`,
        });
      } catch (error) {
        setWorkspaceSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Workspace reasoning mode could not be updated.",
        });
      } finally {
        setWorkspaceSetupSaving(false);
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
    setMcpConfigSaving(true);
    setMcpConfigMessage(null);

    try {
      const document = await saveMcpConfigDocument(
        mcpConfigScope,
        mcpConfigDraft,
        options.activeSessionWorkspace,
      );

      setMcpConfigDocuments((prev) => ({
        ...prev,
        [mcpConfigScope]: document,
      }));
      setMcpConfigDrafts((prev) => ({
        ...prev,
        [mcpConfigScope]: document.raw,
      }));
      setMcpConfigMessage({
        tone: "success",
        text:
          mcpConfigScope === "workspace"
            ? "Workspace MCP config saved."
            : "Global MCP config saved.",
      });
    } catch (error) {
      setMcpConfigMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "MCP configuration could not be saved.",
      });
    } finally {
      setMcpConfigSaving(false);
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
      if (!options.activeSessionWorkspace?.trim()) {
        setMcpConfigMessage({
          tone: "error",
          text: "Select a workspace before using MCP discovery.",
        });
        return;
      }

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
            ? await listMcpCachedCapabilities(options.activeSessionWorkspace)
            : action === "refresh"
              ? await refreshMcpDiscoveryCache(
                  options.activeSessionWorkspace,
                  serverId,
                )
              : await discoverMcpServer(options.activeSessionWorkspace, serverId);

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
        setMcpConfigMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "MCP discovery could not be completed.",
        });
      } finally {
        setMcpDiscoveryBusy(false);
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
    const document = await loadMcpConfigDocument(
      "user",
      options.activeSessionWorkspace,
    );

    setMcpConfigDocuments((prev) => ({
      ...prev,
      user: document,
    }));
    setMcpConfigDrafts((prev) => ({
      ...prev,
      user: document.raw,
    }));
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
    if (!options.activeSessionWorkspace?.trim()) {
      setMcpConfigMessage({
        tone: "error",
        text: "Select a workspace before starting MCP OAuth.",
      });
      return;
    }

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
        options.activeSessionWorkspace,
        serverId,
      );

      setMcpDiscoveryOutput(JSON.stringify(result, null, 2));
      await refreshUserMcpConfigDocument();

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
      setMcpConfigMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "MCP OAuth could not be started.",
      });
    } finally {
      setMcpOAuthBusy(false);
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
    if (!options.activeSessionWorkspace?.trim()) {
      setMcpConfigMessage({
        tone: "error",
        text: "Select a workspace before finishing MCP OAuth.",
      });
      return;
    }

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
        options.activeSessionWorkspace,
        serverId,
        authorizationResponse,
      );

      setMcpDiscoveryOutput(JSON.stringify(result, null, 2));
      setMcpOAuthCallback("");
      await refreshUserMcpConfigDocument();
      setMcpConfigMessage({
        tone: "success",
        text:
          result.result.stateVerified === false
            ? "MCP OAuth finished. Callback state was not available to verify."
            : "MCP OAuth finished.",
      });
    } catch (error) {
      setMcpConfigMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "MCP OAuth could not be finished.",
      });
    } finally {
      setMcpOAuthBusy(false);
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
