import { isTauri } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { getProviderLabel } from "../../model-catalog";
import {
  loadGlobalProviderAvailability,
  loadUserProviderApiKeys,
  loadUserAgentLimitsSettings,
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
  saveUserGlobalMemoryEnabled,
  saveUserVoiceActiveProvider,
  saveUserProviderApiKey,
  subscribeToDesktopSettingsChanged,
  USER_SPEECH_TO_TEXT_PROVIDER_ORDER,
  saveUserWebSearchActiveProvider,
  saveUserWebSearchApiKey,
  USER_WEB_SEARCH_PROVIDER_ORDER,
  type RuntimeProviderAvailability,
  type RuntimeSnapshot,
  type UserSpeechToTextSettings,
  type UserAgentLimitsSettings,
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
import type { SettingsStatusMessage } from "../components/settings-dialog";
import {
  createEmptyUserMemorySettings,
  createEmptyWebSearchSettings,
  getWebSearchProviderLabel,
} from "./session-shell";

export interface UseChatSessionRuntimeOptions {
  catalogOpen: boolean;
  activeSessionProvider: UserApiKeyProvider;
  activeSessionWorkspace: string | null;
  activeSessionProfile?: string;
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
  agentLimitsSetupSaving: boolean;
  agentLimitsSetupMessage: SettingsStatusMessage | null;
  userMemorySettings: UserMemorySettings;
  memorySetupSaving: boolean;
  memorySetupMessage: SettingsStatusMessage | null;
  setGlobalProviders: Dispatch<
    SetStateAction<RuntimeProviderAvailability[] | null>
  >;
  refreshWorkspaceRuntimeSnapshot: (
    workspaceRoot: string | null,
    profile?: string | null,
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
  handleGlobalMemoryEnabledSave: (enabled: boolean) => Promise<void>;
  applyLoadedUserDesktopSettings: (settings: UserDesktopSettings) => void;
  applyLoadedUserAgentLimitsSettings: (
    settings: UserAgentLimitsSettings,
  ) => void;
  applyLoadedUserMemorySettings: (settings: UserMemorySettings) => void;
}

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
  const [agentLimitsSetupSaving, setAgentLimitsSetupSaving] = useState(false);
  const [agentLimitsSetupMessage, setAgentLimitsSetupMessage] =
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
      profile?: string | null,
    ): Promise<RuntimeSnapshot | null> => {
      const requestId = runtimeSnapshotRequestIdRef.current + 1;
      runtimeSnapshotRequestIdRef.current = requestId;
      const isCurrentRequest = (): boolean => {
        return runtimeSnapshotRequestIdRef.current === requestId;
      };

      setRuntimeLoading(true);
      setRuntimeError(null);

      try {
        const snapshot = await loadWorkspaceRuntimeSnapshot(
          workspaceRoot,
          profile,
        );

        if (!isCurrentRequest()) {
          return snapshot;
        }

        setRuntimeSnapshot(snapshot);

        if (!snapshot && isTauri()) {
          setRuntimeError(
            "Runtime metadata is unavailable for this workspace right now.",
          );
        }

        return snapshot;
      } catch (error) {
        if (isCurrentRequest()) {
          console.error("Failed to resolve runtime snapshot", error);
          setRuntimeSnapshot(null);
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

    setProviderSetupProvider(options.activeSessionProvider);
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

    void refreshWorkspaceRuntimeSnapshot(
      options.activeSessionWorkspace,
      options.activeSessionProfile,
    ).catch(
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
    options.activeSessionProfile,
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

      await refreshWorkspaceRuntimeSnapshot(
        options.activeSessionWorkspace,
        options.activeSessionProfile,
      );
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
    options.activeSessionProfile,
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

        await refreshWorkspaceRuntimeSnapshot(
          options.activeSessionWorkspace,
          options.activeSessionProfile,
        );
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
      options.activeSessionProfile,
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

      await refreshWorkspaceRuntimeSnapshot(
        options.activeSessionWorkspace,
        options.activeSessionProfile,
      );

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
    options.activeSessionProfile,
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

        await refreshWorkspaceRuntimeSnapshot(
          options.activeSessionWorkspace,
          options.activeSessionProfile,
        );
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
      options.activeSessionProfile,
      options.activeSessionWorkspace,
      refreshWorkspaceRuntimeSnapshot,
    ],
  );

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
    agentLimitsSetupSaving,
    agentLimitsSetupMessage,
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
    handleGlobalMemoryEnabledSave,
    applyLoadedUserDesktopSettings,
    applyLoadedUserAgentLimitsSettings,
    applyLoadedUserMemorySettings,
  };
};
