import { canUseDeviceSettings } from "../../device-settings-platform";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { type RuntimeProvider } from "../../model-catalog";
import { getProviderLabel } from "@machdoch/client-ui/provider-labels";
import { speechProviderLabel } from "../../../../shared/local-speech";
import {
  DEFAULT_USER_AGENT_LIMITS_SETTINGS,
  DEFAULT_USER_DESKTOP_SETTINGS,
} from "../../../../core/runtime-contract.generated.js";
import type { ConversationMemoryEntry } from "../../../../core/types.js";
import { DEFAULT_USER_WORKSPACE_RUN_SETTINGS } from "../../../../core/runtime-contract.generated.js";
import {
  forgetUserGlobalMemoryEntry,
  loadGlobalProviderAvailability,
  loadUserProviderApiKeys,
  loadUserAgentLimitsSettings,
  loadUserReviewModelSettings,
  loadUserWorkspaceRunSettings,
  loadUserDesktopSettings,
  loadUserSpeechToTextSettings,
  loadUserMemorySettings,
  loadUserVoiceSettings,
  loadUserWebSearchSettings,
  loadWorkspaceRuntimeSnapshot,
  loadWorkspaceMemoryEntries,
  openUserProviderApiKeyPortal,
  saveUserSpeechToTextActiveProvider,
  saveUserSpeechToTextInputDevice,
  saveUserSpeechToTextKeyTerms,
  saveUserSpeechToTextContext,
  saveUserSpeechToTextProcessing,
  saveUserDesktopSettings,
  saveUserAgentLimitsSettings,
  saveUserReviewModelSettings,
  saveUserWorkspaceRunSettings,
  saveUserGlobalMemoryEnabled,
  saveUserWorkspaceMemoryDefaultEnabled,
  saveUserVoiceActiveProvider,
  saveUserProviderApiKey,
  subscribeToDesktopSettingsChanged,
  subscribeToUserSettingsChanged,
  getUserApiKeyProviderLabel,
  USER_API_KEY_PROVIDER_ORDER,
  saveUserWebSearchActiveProvider,
  saveUserWebSearchApiKey,
  USER_WEB_SEARCH_PROVIDER_ORDER,
  type RuntimeProviderAvailability,
  type RuntimeSnapshot,
  type UserSpeechToTextSettings,
  type UserAgentLimitsSettings,
  type UserReviewModelSettings,
  type UserDesktopSettings,
  type UserWorkspaceRunSettings,
  type SpeechToTextProvider,
  type UserApiKeyProvider,
  type UserMemorySettings,
  type UserProviderApiKeys,
  type UserVoiceSettings,
  type VoiceAiProvider,
  type UserWebSearchApiKeyProvider,
  type UserWebSearchApiKeys,
  type UserWebSearchSettings,
  type WebSearchProviderAvailability,
  type WebSearchProvider,
} from "../../runtime";
import type { SettingsStatusMessage } from "../components/settings-dialog-panels/types";
import {
  createEmptyUserMemorySettings,
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
  providerSetupLoading: boolean;
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
  webSearchProviderAvailability: WebSearchProviderAvailability[];
  webSearchSetupProvider: UserWebSearchApiKeyProvider;
  webSearchSetupKey: string;
  webSearchSetupLoading: boolean;
  webSearchSetupSaving: boolean;
  webSearchSetupMessage: SettingsStatusMessage | null;
  userDesktopSettings: UserDesktopSettings;
  userDesktopSettingsLoaded: boolean;
  desktopSetupSaving: boolean;
  desktopSetupMessage: SettingsStatusMessage | null;
  userWorkspaceRunSettings: UserWorkspaceRunSettings;
  workspaceRunSetupSaving: boolean;
  workspaceRunSetupMessage: SettingsStatusMessage | null;
  userAgentLimitsSettings: UserAgentLimitsSettings;
  userAgentLimitsSettingsLoaded: boolean;
  userReviewModelSettings: UserReviewModelSettings;
  agentLimitsSetupSaving: boolean;
  agentLimitsSetupMessage: SettingsStatusMessage | null;
  userMemorySettings: UserMemorySettings;
  workspaceMemoryEntries: ConversationMemoryEntry[];
  memorySetupSaving: boolean;
  memorySetupMessage: SettingsStatusMessage | null;
  setGlobalProviders: Dispatch<
    SetStateAction<RuntimeProviderAvailability[] | null>
  >;
  refreshWorkspaceRuntimeSnapshot: (
    workspaceRoot: string | null,
  ) => Promise<RuntimeSnapshot | null>;
  handleProviderSetupProviderChange: (provider: UserApiKeyProvider) => void;
  handleProviderSetupPortalOpen: (
    provider: UserApiKeyProvider,
  ) => Promise<void>;
  handleProviderSetupKeyChange: (value: string) => void;
  handleProviderSetupSave: (keyValue?: string) => Promise<boolean>;
  handleVoiceActiveProviderSave: (provider: VoiceAiProvider) => Promise<void>;
  handleSpeechToTextActiveProviderSave: (
    provider: SpeechToTextProvider,
  ) => Promise<void>;
  handleSpeechToTextInputDeviceSave: (
    inputDeviceId: string | null,
  ) => Promise<void>;
  handleSpeechToTextKeyTermsSave: (keyTerms: string[]) => Promise<void>;
  handleSpeechToTextContextSave: (speechContext: string) => Promise<void>;
  handleSpeechToTextProcessingSave: (options: {
    autoTranslateToEnglish: boolean;
    autoFormat: boolean;
  }) => Promise<void>;
  handleWebSearchActiveProviderSave: (
    provider: WebSearchProvider,
  ) => Promise<void>;
  handleWebSearchSetupProviderChange: (
    provider: UserWebSearchApiKeyProvider,
  ) => void;
  handleWebSearchSetupKeyChange: (value: string) => void;
  handleWebSearchSetupSave: (keyValue?: string) => Promise<boolean>;
  handleDesktopSettingsSave: (settings: UserDesktopSettings) => Promise<void>;
  handleWorkspaceRunSettingsSave: (
    settings: UserWorkspaceRunSettings,
  ) => Promise<boolean>;
  handleAgentLimitsSettingsSave: (
    settings: UserAgentLimitsSettings,
  ) => Promise<boolean>;
  handleReviewModelSettingsSave: (
    settings: UserReviewModelSettings,
  ) => Promise<boolean>;
  handleGlobalMemoryEnabledSave: (enabled: boolean) => Promise<void>;
  handleWorkspaceMemoryDefaultEnabledSave: (enabled: boolean) => Promise<void>;
  handleGlobalMemoryForget: (id: string) => Promise<void>;
  refreshWorkspaceMemoryEntries: () => Promise<void>;
  applyLoadedUserDesktopSettings: (settings: UserDesktopSettings) => void;
  applyLoadedUserWorkspaceRunSettings: (
    settings: UserWorkspaceRunSettings,
  ) => void;
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
    ...DEFAULT_USER_DESKTOP_SETTINGS,
  };
};

const createEmptyUserAgentLimitsSettings = (): UserAgentLimitsSettings => {
  return { ...DEFAULT_USER_AGENT_LIMITS_SETTINGS };
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
  const surfacesDescription = settings.quickVoiceEnabled ? "quick voice" : "";

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
    return "Agent loop limits saved. Executor and Machdoch continuation counts are unlimited; the inactivity safety timeout still applies.";
  }

  return `Agent loop limits saved. Executor turns: ${settings.executorTurns}; Machdoch continuations: ${settings.autopilotExecutorIterations}.`;
};

const getReviewModelSettingsSavedMessage = (
  settings: UserReviewModelSettings,
): string => {
  if (settings.mode !== "dedicated" || !settings.provider || !settings.model) {
    return "Review model saved. Validator passes will use the base request model.";
  }

  return `Review model saved. Validator passes will use ${getProviderLabel(settings.provider)} / ${settings.model}.`;
};

const createRuntimeSnapshotRequestKey = (
  workspaceRoot: string | null,
): string => {
  const normalizedWorkspace = workspaceRoot
    ? workspaceRoot.trim().replace(/\\/gu, "/").toLowerCase()
    : "";

  return normalizedWorkspace;
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
  const [providerSetupLoading, setProviderSetupLoading] = useState(false);
  const [providerSetupSaving, setProviderSetupSaving] = useState(false);
  const [providerSetupMessage, setProviderSetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [userVoiceSettings, setUserVoiceSettings] = useState<UserVoiceSettings>(
    {
      activeProvider: "none",
      providerAvailability: [],
    },
  );
  const [voiceSetupSaving, setVoiceSetupSaving] = useState(false);
  const [voiceSetupMessage, setVoiceSetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [userSpeechToTextSettings, setUserSpeechToTextSettings] =
    useState<UserSpeechToTextSettings>({
      activeProvider: "whisper",
      inputDeviceId: null,
      keyTerms: [],
      speechContext: "",
      autoTranslateToEnglish: false,
      autoFormat: false,
      providerAvailability: [],
    });
  const [speechToTextSetupSaving, setSpeechToTextSetupSaving] = useState(false);
  const [speechInputDeviceSaving, setSpeechInputDeviceSaving] = useState(false);
  const [speechToTextSetupMessage, setSpeechToTextSetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [webSearchActiveProvider, setWebSearchActiveProvider] =
    useState<WebSearchProvider>("none");
  const [webSearchProviderAvailability, setWebSearchProviderAvailability] =
    useState<WebSearchProviderAvailability[]>([]);
  const [webSearchSetupProvider, setWebSearchSetupProvider] =
    useState<UserWebSearchApiKeyProvider>("perplexity");
  const [webSearchSetupKeys, setWebSearchSetupKeys] =
    useState<UserWebSearchApiKeys>({});
  const [webSearchSetupKey, setWebSearchSetupKey] = useState("");
  const [webSearchSetupLoading, setWebSearchSetupLoading] = useState(false);
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
  const [userWorkspaceRunSettings, setUserWorkspaceRunSettings] =
    useState<UserWorkspaceRunSettings>({
      ...DEFAULT_USER_WORKSPACE_RUN_SETTINGS,
    });
  const [workspaceRunSetupSaving, setWorkspaceRunSetupSaving] = useState(false);
  const [workspaceRunSetupMessage, setWorkspaceRunSetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [userAgentLimitsSettings, setUserAgentLimitsSettings] =
    useState<UserAgentLimitsSettings>(createEmptyUserAgentLimitsSettings());
  const [userAgentLimitsSettingsLoaded, setUserAgentLimitsSettingsLoaded] =
    useState(false);
  const [userReviewModelSettings, setUserReviewModelSettings] =
    useState<UserReviewModelSettings>(createEmptyUserReviewModelSettings());
  const [agentLimitsSetupSaving, setAgentLimitsSetupSaving] = useState(false);
  const [agentLimitsSetupMessage, setAgentLimitsSetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [userMemorySettings, setUserMemorySettings] =
    useState<UserMemorySettings>(createEmptyUserMemorySettings());
  const [workspaceMemorySnapshot, setWorkspaceMemorySnapshot] = useState<{
    workspaceRoot: string | null;
    entries: ConversationMemoryEntry[];
  }>({ workspaceRoot: null, entries: [] });
  const workspaceMemoryEntries =
    workspaceMemorySnapshot.workspaceRoot ===
    (options.activeSessionWorkspace?.trim() || null)
      ? workspaceMemorySnapshot.entries
      : [];
  const [memorySetupSaving, setMemorySetupSaving] = useState(false);
  const [memorySetupMessage, setMemorySetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [globalProviders, setGlobalProviders] = useState<
    RuntimeProviderAvailability[] | null
  >(null);
  const runtimeSnapshotRequestIdRef = useRef(0);
  const runtimeSnapshotRequestKeyRef = useRef<string | null>(null);
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
  const activeWorkspaceKeyRef = useRef(activeWorkspaceKey);
  const voiceMutationRevisionRef = useRef(0);
  const speechMutationRevisionRef = useRef(0);
  const settingsEventSequenceRef = useRef(new Map<string, number>());
  activeSessionProviderRef.current = options.activeSessionProvider;
  providerSetupProviderRef.current = providerSetupProvider;
  providerSetupKeyRef.current = providerSetupKey;
  webSearchSetupProviderRef.current = webSearchSetupProvider;
  webSearchSetupKeyRef.current = webSearchSetupKey;
  activeWorkspaceKeyRef.current = activeWorkspaceKey;

  const applyLoadedWebSearchSettings = useCallback(
    (settings: UserWebSearchSettings): void => {
      const nextKeyProvider =
        settings.activeProvider === "none"
          ? USER_WEB_SEARCH_PROVIDER_ORDER[0]
          : settings.activeProvider;

      setWebSearchActiveProvider(settings.activeProvider);
      setWebSearchProviderAvailability(settings.providerAvailability);
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
      setUserAgentLimitsSettingsLoaded(true);
      setUserAgentLimitsSettings({
        ...createEmptyUserAgentLimitsSettings(),
        ...settings,
      });
    },
    [],
  );

  const applyLoadedUserWorkspaceRunSettings = useCallback(
    (settings: UserWorkspaceRunSettings): void => {
      setUserWorkspaceRunSettings(settings);
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
    async (workspaceRoot: string | null): Promise<RuntimeSnapshot | null> => {
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

        if (!snapshot && canUseDeviceSettings()) {
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
        setVoiceSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? `Voice settings could not be loaded: ${error.message}`
              : "Voice settings could not be loaded.",
        });
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
        setSpeechToTextSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? `Speech-input settings could not be loaded: ${error.message}`
              : "Speech-input settings could not be loaded.",
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

    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const loadSettings = (): void => {
      void loadUserAgentLimitsSettings()
        .then((settings) => {
          if (!cancelled) applyLoadedUserAgentLimitsSettings(settings);
        })
        .catch((error) => {
          if (!cancelled) {
            console.error("Failed to load user agent limit settings", error);
            retryTimer = setTimeout(loadSettings, 2_000);
          }
        });
    };
    loadSettings();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [applyLoadedUserAgentLimitsSettings]);

  useEffect(() => {
    let cancelled = false;

    void loadUserWorkspaceRunSettings()
      .then((settings) => {
        if (!cancelled) {
          applyLoadedUserWorkspaceRunSettings(settings);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load Workspace Run settings", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [applyLoadedUserWorkspaceRunSettings]);

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
            if (
              disposed ||
              settingsEventSequenceRef.current.get(kind) !== sequence
            ) {
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
            if (
              disposed ||
              settingsEventSequenceRef.current.get(kind) !== sequence
            ) {
              return;
            }
            setWebSearchActiveProvider(settings.activeProvider);
            setWebSearchProviderAvailability(settings.providerAvailability);
            const editedProvider = webSearchSetupProviderRef.current;
            setWebSearchSetupKeys({
              ...settings.apiKeys,
              ...(webSearchSetupOpenRef.current
                ? { [editedProvider]: webSearchSetupKeyRef.current }
                : {}),
            });
          } else if (kind === "voice") {
            const settings = await loadUserVoiceSettings();
            if (
              !disposed &&
              settingsEventSequenceRef.current.get(kind) === sequence
            ) {
              applyLoadedUserVoiceSettings(settings);
            }
          } else if (kind === "speech-to-text") {
            const settings = await loadUserSpeechToTextSettings();
            if (
              !disposed &&
              settingsEventSequenceRef.current.get(kind) === sequence
            ) {
              applyLoadedUserSpeechToTextSettings(settings);
            }
          } else if (kind === "memory") {
            const settings = await loadUserMemorySettings();
            if (
              !disposed &&
              settingsEventSequenceRef.current.get(kind) === sequence
            ) {
              applyLoadedUserMemorySettings(settings);
              if (options.activeSessionWorkspace?.trim()) {
                await refreshWorkspaceRuntimeSnapshot(
                  options.activeSessionWorkspace,
                );
              }
            }
          } else if (kind === "agent-limits") {
            const settings = await loadUserAgentLimitsSettings();
            if (
              !disposed &&
              settingsEventSequenceRef.current.get(kind) === sequence
            ) {
              applyLoadedUserAgentLimitsSettings(settings);
            }
          } else if (kind === "workspace-run") {
            const settings = await loadUserWorkspaceRunSettings();
            if (
              !disposed &&
              settingsEventSequenceRef.current.get(kind) === sequence
            ) {
              applyLoadedUserWorkspaceRunSettings(settings);
            }
          } else if (kind === "review-model") {
            const settings = await loadUserReviewModelSettings();
            if (
              !disposed &&
              settingsEventSequenceRef.current.get(kind) === sequence
            ) {
              applyLoadedUserReviewModelSettings(settings);
            }
          } else if (
            kind === "provider-enrollment" &&
            options.activeSessionWorkspace?.trim()
          ) {
            // Provider sync settings are loaded by the settings/onboarding
            // controls. Avoid reconciling from unrelated helper windows.
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
    applyLoadedUserWorkspaceRunSettings,
    applyLoadedUserSpeechToTextSettings,
    applyLoadedUserVoiceSettings,
    options.activeSessionWorkspace,
    refreshWorkspaceRuntimeSnapshot,
  ]);

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
        setDesktopSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? `Desktop settings could not be loaded: ${error.message}`
              : "Desktop settings could not be loaded.",
        });
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
        setAgentLimitsSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? `Agent limits could not be loaded: ${error.message}`
              : "Agent limits could not be loaded.",
        });
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
        setAgentLimitsSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? `Review-model settings could not be loaded: ${error.message}`
              : "Review-model settings could not be loaded.",
        });
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

  const refreshWorkspaceMemoryEntries = useCallback(async (): Promise<void> => {
    const workspaceRoot = options.activeSessionWorkspace?.trim();

    if (!workspaceRoot) {
      setWorkspaceMemorySnapshot({ workspaceRoot: null, entries: [] });
      return;
    }

    const entries = await loadWorkspaceMemoryEntries(workspaceRoot);
    setWorkspaceMemorySnapshot({ workspaceRoot, entries });
  }, [options.activeSessionWorkspace]);

  useEffect(() => {
    let cancelled = false;
    const workspaceRoot = options.activeSessionWorkspace?.trim();

    if (!workspaceRoot) {
      setWorkspaceMemorySnapshot({ workspaceRoot: null, entries: [] });
      return;
    }

    void loadWorkspaceMemoryEntries(workspaceRoot)
      .then((entries) => {
        if (!cancelled) {
          setWorkspaceMemorySnapshot({ workspaceRoot, entries });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load workspace memory", error);
          setWorkspaceMemorySnapshot({ workspaceRoot, entries: [] });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [options.activeSessionWorkspace]);

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
          setAgentLimitsSetupMessage({
            tone: "error",
            text:
              error instanceof Error
                ? `Provider availability could not be loaded: ${error.message}`
                : "Provider availability could not be loaded.",
          });
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
    setProviderSetupLoading(true);

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
          setProviderSetupMessage({
            tone: "error",
            text:
              error instanceof Error
                ? `Provider keys could not be loaded: ${error.message}`
                : "Provider keys could not be loaded.",
          });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setProviderSetupLoading(false);
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
    setWebSearchSetupLoading(true);

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
        setWebSearchSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? `Web-search settings could not be loaded: ${error.message}`
              : "Web-search settings could not be loaded.",
        });
      })
      .finally(() => {
        if (!cancelled) {
          setWebSearchSetupLoading(false);
        }
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
        setMemorySetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? `Memory settings could not be loaded: ${error.message}`
              : "Memory settings could not be loaded.",
        });
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
  }, [options.activeSessionWorkspace, refreshWorkspaceRuntimeSnapshot]);

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

  const handleProviderSetupSave = useCallback(
    async (keyValue?: string): Promise<boolean> => {
      const normalizedKey = (keyValue ?? providerSetupKey).trim();
      const provider = providerSetupProvider;
      const editRevision = providerSetupEditRevisionRef.current;
      const requestId = providerSetupSaveRequestIdRef.current + 1;

      if (!normalizedKey || !canUseDeviceSettings()) {
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
    },
    [
      applyLoadedUserVoiceSettings,
      applyLoadedUserSpeechToTextSettings,
      options.activeSessionWorkspace,
      providerSetupKey,
      providerSetupProvider,
      refreshWorkspaceRuntimeSnapshot,
    ],
  );

  const handleVoiceActiveProviderSave = useCallback(
    async (provider: VoiceAiProvider): Promise<void> => {
      const mutationRevision = voiceMutationRevisionRef.current + 1;
      voiceMutationRevisionRef.current = mutationRevision;
      setVoiceSetupSaving(true);
      setVoiceSetupMessage(null);

      try {
        const settings = await saveUserVoiceActiveProvider(provider);
        const providerLabel =
          provider === "none"
            ? "System voices"
            : provider === "fish" ? "Fish Audio · Drama 3" : getProviderLabel(provider);

        if (voiceMutationRevisionRef.current !== mutationRevision) {
          return;
        }
        applyLoadedUserVoiceSettings(settings);
        setVoiceSetupMessage({
          tone: "success",
          text:
            provider === "none"
              ? "System voices selected."
              : settings.providerAvailability.some(
                    (entry) => entry.provider === provider && entry.configured,
                  )
                ? `${providerLabel} will handle new spoken replies.`
                : `Configure ${providerLabel} before playing replies.`,
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
        const providerLabel = speechProviderLabel(provider);

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

      if (!canUseDeviceSettings()) {
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

  const handleSpeechToTextProcessingSave = useCallback(
    async (options: {
      autoTranslateToEnglish: boolean;
      autoFormat: boolean;
    }): Promise<void> => {
      const mutationRevision = speechMutationRevisionRef.current + 1;
      speechMutationRevisionRef.current = mutationRevision;
      const previousSettings = userSpeechToTextSettings;
      setUserSpeechToTextSettings((settings) => ({ ...settings, ...options }));
      try {
        const settings = await saveUserSpeechToTextProcessing(options);
        if (speechMutationRevisionRef.current === mutationRevision) {
          applyLoadedUserSpeechToTextSettings(settings);
        }
      } catch (error) {
        if (speechMutationRevisionRef.current === mutationRevision) {
          applyLoadedUserSpeechToTextSettings(previousSettings);
        }
        throw error;
      }
    },
    [applyLoadedUserSpeechToTextSettings, userSpeechToTextSettings],
  );

  const handleSpeechToTextKeyTermsSave = useCallback(
    async (keyTerms: string[]): Promise<void> => {
      setSpeechToTextSetupSaving(true);
      setSpeechToTextSetupMessage(null);
      try {
        const settings = await saveUserSpeechToTextKeyTerms(keyTerms);
        applyLoadedUserSpeechToTextSettings(settings);
        setSpeechToTextSetupMessage({
          tone: "success",
          text: "Key terms saved.",
        });
      } catch (error) {
        setSpeechToTextSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Key terms could not be saved.",
        });
      } finally {
        setSpeechToTextSetupSaving(false);
      }
    },
    [applyLoadedUserSpeechToTextSettings],
  );

  const handleSpeechToTextContextSave = useCallback(
    async (speechContext: string): Promise<void> => {
      setSpeechToTextSetupSaving(true);
      setSpeechToTextSetupMessage(null);
      try {
        const settings = await saveUserSpeechToTextContext(speechContext);
        applyLoadedUserSpeechToTextSettings(settings);
        setSpeechToTextSetupMessage({
          tone: "success",
          text: "Speech context saved.",
        });
      } catch (error) {
        setSpeechToTextSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Speech context could not be saved.",
        });
      } finally {
        setSpeechToTextSetupSaving(false);
      }
    },
    [applyLoadedUserSpeechToTextSettings],
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
        setWebSearchProviderAvailability(settings.providerAvailability);
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
    [options.activeSessionWorkspace, refreshWorkspaceRuntimeSnapshot],
  );

  const handleWebSearchSetupSave = useCallback(
    async (keyValue?: string): Promise<boolean> => {
      const normalizedKey = (keyValue ?? webSearchSetupKey).trim();
      const provider = webSearchSetupProvider;
      const editRevision = webSearchSetupEditRevisionRef.current;
      const requestId = webSearchSetupSaveRequestIdRef.current + 1;

      if (!normalizedKey || !canUseDeviceSettings()) {
        return false;
      }

      webSearchSetupSaveRequestIdRef.current = requestId;
      setWebSearchSetupSaving(true);
      setWebSearchSetupMessage(null);

      try {
        const settings = await saveUserWebSearchApiKey(provider, normalizedKey);

        if (webSearchSetupSaveRequestIdRef.current !== requestId) {
          return false;
        }

        setWebSearchActiveProvider(settings.activeProvider);
        setWebSearchProviderAvailability(settings.providerAvailability);
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
    },
    [
      options.activeSessionWorkspace,
      refreshWorkspaceRuntimeSnapshot,
      webSearchSetupKey,
      webSearchSetupProvider,
    ],
  );

  const handleDesktopSettingsSave = useCallback(
    async (settings: UserDesktopSettings): Promise<void> => {
      if (!canUseDeviceSettings()) {
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
    async (settings: UserAgentLimitsSettings): Promise<boolean> => {
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
        return true;
      } catch (error) {
        setAgentLimitsSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Agent loop limits could not be updated.",
        });
        return false;
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

  const handleWorkspaceRunSettingsSave = useCallback(
    async (settings: UserWorkspaceRunSettings): Promise<boolean> => {
      setWorkspaceRunSetupSaving(true);
      setWorkspaceRunSetupMessage(null);

      try {
        const nextSettings = await saveUserWorkspaceRunSettings(settings);
        applyLoadedUserWorkspaceRunSettings(nextSettings);
        setWorkspaceRunSetupMessage({
          tone: "success",
          text: "Run timeouts saved.",
        });
        return true;
      } catch (error) {
        setWorkspaceRunSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Run timeouts could not be saved.",
        });
        return false;
      } finally {
        setWorkspaceRunSetupSaving(false);
      }
    },
    [applyLoadedUserWorkspaceRunSettings],
  );

  const handleReviewModelSettingsSave = useCallback(
    async (settings: UserReviewModelSettings): Promise<boolean> => {
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
        return true;
      } catch (error) {
        setAgentLimitsSetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Review model settings could not be updated.",
        });
        return false;
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

  const handleGlobalMemoryEnabledSave = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!canUseDeviceSettings()) {
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

  const handleWorkspaceMemoryDefaultEnabledSave = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!canUseDeviceSettings()) {
        applyLoadedUserMemorySettings({
          ...userMemorySettings,
          workspaceDefaultEnabled: enabled,
        });
        setRuntimeSnapshot((currentSnapshot) =>
          currentSnapshot?.workspaceMemoryOverride === null
            ? { ...currentSnapshot, workspaceMemoryEnabled: enabled }
            : currentSnapshot,
        );
        return;
      }

      setMemorySetupSaving(true);
      setMemorySetupMessage(null);

      try {
        const settings = await saveUserWorkspaceMemoryDefaultEnabled(enabled);

        applyLoadedUserMemorySettings(settings);
        await refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace);
        setMemorySetupMessage({
          tone: "success",
          text: "Default workspace memory updated.",
        });
      } catch (error) {
        setMemorySetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Default workspace memory could not be updated.",
        });
      } finally {
        setMemorySetupSaving(false);
      }
    },
    [
      applyLoadedUserMemorySettings,
      options.activeSessionWorkspace,
      refreshWorkspaceRuntimeSnapshot,
      userMemorySettings,
    ],
  );

  const handleGlobalMemoryForget = useCallback(
    async (id: string): Promise<void> => {
      setMemorySetupSaving(true);
      setMemorySetupMessage(null);

      try {
        if (canUseDeviceSettings()) {
          applyLoadedUserMemorySettings(await forgetUserGlobalMemoryEntry(id));
        } else {
          applyLoadedUserMemorySettings({
            ...userMemorySettings,
            entries: userMemorySettings.entries.filter(
              (entry) => entry.id !== id,
            ),
          });
        }
        setMemorySetupMessage({ tone: "success", text: "Memory removed." });
      } catch (error) {
        setMemorySetupMessage({
          tone: "error",
          text:
            error instanceof Error
              ? error.message
              : "Memory could not be removed.",
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
    providerSetupLoading,
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
    webSearchProviderAvailability,
    webSearchSetupProvider,
    webSearchSetupKey,
    webSearchSetupLoading,
    webSearchSetupSaving,
    webSearchSetupMessage,
    userDesktopSettings,
    userDesktopSettingsLoaded,
    desktopSetupSaving,
    desktopSetupMessage,
    userWorkspaceRunSettings,
    workspaceRunSetupSaving,
    workspaceRunSetupMessage,
    userAgentLimitsSettings,
    userAgentLimitsSettingsLoaded,
    userReviewModelSettings,
    agentLimitsSetupSaving,
    agentLimitsSetupMessage,
    userMemorySettings,
    workspaceMemoryEntries,
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
    handleSpeechToTextKeyTermsSave,
    handleSpeechToTextContextSave,
    handleSpeechToTextProcessingSave,
    handleWebSearchActiveProviderSave,
    handleWebSearchSetupProviderChange,
    handleWebSearchSetupKeyChange,
    handleWebSearchSetupSave,
    handleDesktopSettingsSave,
    handleWorkspaceRunSettingsSave,
    handleAgentLimitsSettingsSave,
    handleReviewModelSettingsSave,
    handleGlobalMemoryEnabledSave,
    handleWorkspaceMemoryDefaultEnabledSave,
    handleGlobalMemoryForget,
    refreshWorkspaceMemoryEntries,
    applyLoadedUserDesktopSettings,
    applyLoadedUserWorkspaceRunSettings,
    applyLoadedUserAgentLimitsSettings,
    applyLoadedUserReviewModelSettings,
    applyLoadedUserMemorySettings,
  };
};
