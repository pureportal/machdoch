import { isTauri } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { getProviderLabel } from "../../model-catalog";
import {
  loadGlobalProviderAvailability,
  loadUserMemorySettings,
  loadUserWebSearchSettings,
  loadWorkspaceRuntimeSnapshot,
  openUserProviderApiKeyPortal,
  saveUserGlobalMemoryEnabled,
  saveUserProviderApiKey,
  saveUserWebSearchActiveProvider,
  saveUserWebSearchApiKey,
  USER_WEB_SEARCH_PROVIDER_ORDER,
  type RuntimeProviderAvailability,
  type RuntimeSnapshot,
  type UserApiKeyProvider,
  type UserMemorySettings,
  type UserProviderApiKeys,
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
  webSearchActiveProvider: WebSearchProvider;
  webSearchSetupProvider: UserWebSearchApiKeyProvider;
  webSearchSetupKey: string;
  webSearchSetupSaving: boolean;
  webSearchSetupMessage: SettingsStatusMessage | null;
  userMemorySettings: UserMemorySettings;
  memorySetupSaving: boolean;
  memorySetupMessage: SettingsStatusMessage | null;
  setGlobalProviders: Dispatch<
    SetStateAction<RuntimeProviderAvailability[] | null>
  >;
  refreshWorkspaceRuntimeSnapshot: (
    workspaceRoot: string | null,
  ) => Promise<void>;
  handleProviderSetupProviderChange: (provider: UserApiKeyProvider) => void;
  handleProviderSetupPortalOpen: (provider: UserApiKeyProvider) => Promise<void>;
  handleProviderSetupKeyChange: (value: string) => void;
  handleProviderSetupSave: () => Promise<void>;
  handleWebSearchActiveProviderSave: (
    provider: WebSearchProvider,
  ) => Promise<void>;
  handleWebSearchSetupProviderChange: (
    provider: UserWebSearchApiKeyProvider,
  ) => void;
  handleWebSearchSetupKeyChange: (value: string) => void;
  handleWebSearchSetupSave: () => Promise<void>;
  handleGlobalMemoryEnabledSave: (enabled: boolean) => Promise<void>;
  applyLoadedUserMemorySettings: (settings: UserMemorySettings) => void;
}

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
  const [userMemorySettings, setUserMemorySettings] =
    useState<UserMemorySettings>(createEmptyUserMemorySettings());
  const [memorySetupSaving, setMemorySetupSaving] = useState(false);
  const [memorySetupMessage, setMemorySetupMessage] =
    useState<SettingsStatusMessage | null>(null);
  const [globalProviders, setGlobalProviders] = useState<
    RuntimeProviderAvailability[] | null
  >(null);

  const applyLoadedWebSearchSettings = useCallback(
    (settings: UserWebSearchSettings): void => {
      const nextKeyProvider =
        settings.activeProvider === "none"
          ? USER_WEB_SEARCH_PROVIDER_ORDER[0]
          : settings.activeProvider;

      setWebSearchActiveProvider(settings.activeProvider);
      setWebSearchSetupProvider(nextKeyProvider);
    },
    [],
  );

  const applyLoadedUserMemorySettings = useCallback(
    (settings: UserMemorySettings): void => {
      setUserMemorySettings(settings);
    },
    [],
  );

  const refreshWorkspaceRuntimeSnapshot = useCallback(
    async (workspaceRoot: string | null): Promise<void> => {
      setRuntimeLoading(true);
      setRuntimeError(null);

      try {
        const snapshot = await loadWorkspaceRuntimeSnapshot(workspaceRoot);

        setRuntimeSnapshot(snapshot);

        if (!snapshot && isTauri()) {
          setRuntimeError(
            "Runtime metadata is unavailable for this workspace right now.",
          );
        }
      } catch (error) {
        console.error("Failed to resolve runtime snapshot", error);
        setRuntimeSnapshot(null);
        setRuntimeError(
          "Runtime metadata could not be loaded for this workspace.",
        );
      } finally {
        setRuntimeLoading(false);
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

    setProviderSetupProvider(options.activeSessionProvider);
    setProviderSetupKeys({});
    setProviderSetupKey("");
    setProviderSetupMessage(null);
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
  }, [options.activeSessionWorkspace, refreshWorkspaceRuntimeSnapshot]);

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

  const handleProviderSetupSave = useCallback(async (): Promise<void> => {
    const normalizedKey = providerSetupKey.trim();

    if (!normalizedKey || !isTauri()) {
      return;
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
        [providerSetupProvider]: "",
      }));
      setProviderSetupKey("");
      setProviderSetupMessage({
        tone: "success",
        text: `${getProviderLabel(providerSetupProvider)} is ready to use.`,
      });

      await refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace);
    } catch (error) {
      setProviderSetupMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The API key could not be saved.",
      });
    } finally {
      setProviderSetupSaving(false);
    }
  }, [
    options.activeSessionWorkspace,
    providerSetupKey,
    providerSetupProvider,
    refreshWorkspaceRuntimeSnapshot,
  ]);

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

  const handleWebSearchSetupSave = useCallback(async (): Promise<void> => {
    const normalizedKey = webSearchSetupKey.trim();

    if (!normalizedKey || !isTauri()) {
      return;
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
        [webSearchSetupProvider]: "",
      }));
      setWebSearchSetupKey("");
      setWebSearchSetupMessage({
        tone: "success",
        text: `${getWebSearchProviderLabel(webSearchSetupProvider)} is ready for web search.`,
      });

      await refreshWorkspaceRuntimeSnapshot(options.activeSessionWorkspace);
    } catch (error) {
      setWebSearchSetupMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "The web-search API key could not be saved.",
      });
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
    webSearchActiveProvider,
    webSearchSetupProvider,
    webSearchSetupKey,
    webSearchSetupSaving,
    webSearchSetupMessage,
    userMemorySettings,
    memorySetupSaving,
    memorySetupMessage,
    setGlobalProviders,
    refreshWorkspaceRuntimeSnapshot,
    handleProviderSetupProviderChange,
    handleProviderSetupPortalOpen,
    handleProviderSetupKeyChange,
    handleProviderSetupSave,
    handleWebSearchActiveProviderSave,
    handleWebSearchSetupProviderChange,
    handleWebSearchSetupKeyChange,
    handleWebSearchSetupSave,
    handleGlobalMemoryEnabledSave,
    applyLoadedUserMemorySettings,
  };
};
