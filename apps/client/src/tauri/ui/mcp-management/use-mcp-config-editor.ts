import { useCallback, useEffect, useRef, useState } from "react";
import { isMcpConfigConflictError } from "../mcp-config-error";
import {
  authorizeMcpOAuth,
  createFallbackMcpConfigDocument,
  createMcpConfigRawWithPreset,
  discoverMcpServer,
  finishMcpOAuth,
  listMcpCachedCapabilities,
  loadMcpConfigDocument,
  MCP_PRESET_SUMMARIES,
  refreshMcpDiscoveryCache,
  saveMcpConfigDocument,
  subscribeToUserSettingsChanged,
  type McpConfigDocument,
  type McpConfigScope,
} from "../runtime";
import type {
  McpSettingsControls,
  SettingsStatusMessage,
} from "../chat-session/components/settings-dialog-panels/types";
import { getFirstMcpServerId } from "./mcp-config-model";

export interface McpConfigEditorOptions {
  scope: McpConfigScope;
  workspaceRoot: string | null;
}

type DiscoveryAction = "discover" | "refresh" | "cache";

const getErrorText = (error: unknown, fallback: string): string => {
  return error instanceof Error ? error.message : fallback;
};

export const useMcpConfigEditor = ({
  scope,
  workspaceRoot,
}: McpConfigEditorOptions): McpSettingsControls => {
  const commandRoot = workspaceRoot?.trim() ? workspaceRoot : null;
  const configRoot = scope === "workspace" ? commandRoot : null;
  const scopeLabel = scope === "workspace" ? "workspace" : "global";
  const [document, setDocument] = useState<McpConfigDocument>(() =>
    createFallbackMcpConfigDocument(scope, configRoot),
  );
  const [draft, setDraft] = useState(document.raw);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [discoveryServerId, setDiscoveryServerId] = useState("");
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [discoveryOutput, setDiscoveryOutput] = useState<string | null>(null);
  const [oauthServerId, setOauthServerId] = useState("");
  const [oauthCallback, setOauthCallback] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const [message, setMessage] = useState<SettingsStatusMessage | null>(null);
  const configRootRef = useRef(configRoot);
  const commandRootRef = useRef(commandRoot);
  const documentRef = useRef(document);
  const draftRef = useRef(draft);
  const draftRevisionRef = useRef(0);
  const loadRequestIdRef = useRef(0);
  const saveRequestIdRef = useRef(0);
  const discoveryRequestIdRef = useRef(0);
  const oauthRequestIdRef = useRef(0);
  const savingRef = useRef(false);
  configRootRef.current = configRoot;
  commandRootRef.current = commandRoot;
  documentRef.current = document;
  draftRef.current = draft;

  const loadDocument = useCallback(
    async (initial: boolean): Promise<void> => {
      const requestId = loadRequestIdRef.current + 1;
      loadRequestIdRef.current = requestId;
      const root = configRoot;
      const draftRevision = draftRevisionRef.current;
      const draftWasClean = draftRef.current === documentRef.current.raw;

      if (initial) {
        setLoading(true);
        setMessage(null);
      }

      try {
        const nextDocument = await loadMcpConfigDocument(scope, root);

        if (
          loadRequestIdRef.current !== requestId ||
          configRootRef.current !== root
        ) {
          return;
        }

        if (!draftWasClean || draftRevisionRef.current !== draftRevision) {
          if (nextDocument.raw !== documentRef.current.raw) {
            setMessage({
              tone: "error",
              text: `The ${scopeLabel} MCP configuration changed while this draft was open. Save again to review the conflict.`,
            });
          }
          return;
        }

        documentRef.current = nextDocument;
        draftRef.current = nextDocument.raw;
        setDocument(nextDocument);
        setDraft(nextDocument.raw);
        setDiscoveryServerId(
          (current) => current || getFirstMcpServerId(nextDocument.raw) || "",
        );
      } catch (error) {
        if (
          loadRequestIdRef.current === requestId &&
          configRootRef.current === root
        ) {
          setMessage({
            tone: "error",
            text: getErrorText(
              error,
              `The ${scopeLabel} MCP configuration could not be loaded.`,
            ),
          });
        }
      } finally {
        if (
          initial &&
          loadRequestIdRef.current === requestId &&
          configRootRef.current === root
        ) {
          setLoading(false);
        }
      }
    },
    [configRoot, scope, scopeLabel],
  );

  useEffect(() => {
    const fallback = createFallbackMcpConfigDocument(scope, configRoot);
    loadRequestIdRef.current += 1;
    saveRequestIdRef.current += 1;
    draftRevisionRef.current = 0;
    savingRef.current = false;
    documentRef.current = fallback;
    draftRef.current = fallback.raw;
    setDocument(fallback);
    setDraft(fallback.raw);
    setSaving(false);
    setDiscoveryServerId("");
    setOauthServerId("");
    setOauthCallback("");
    setMessage(null);
    void loadDocument(true);

    return () => {
      loadRequestIdRef.current += 1;
      saveRequestIdRef.current += 1;
    };
  }, [configRoot, loadDocument, scope]);

  useEffect(() => {
    discoveryRequestIdRef.current += 1;
    oauthRequestIdRef.current += 1;
    setDiscoveryBusy(false);
    setDiscoveryOutput(null);
    setOauthBusy(false);

    return () => {
      discoveryRequestIdRef.current += 1;
      oauthRequestIdRef.current += 1;
    };
  }, [commandRoot]);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToUserSettingsChanged((kind) => {
      if (kind === "mcp" && !savingRef.current) {
        void loadDocument(false);
      }
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
  }, [loadDocument]);

  const updateDraft = useCallback((value: string): void => {
    draftRevisionRef.current += 1;
    draftRef.current = value;
    setDraft(value);
    setMessage(null);
  }, []);

  const saveDocument = useCallback(async (): Promise<void> => {
    const requestId = saveRequestIdRef.current + 1;
    const root = configRoot;
    const submittedDraft = draftRef.current;
    const draftRevision = draftRevisionRef.current;
    const expectedRaw = documentRef.current.raw;
    saveRequestIdRef.current = requestId;
    loadRequestIdRef.current += 1;
    savingRef.current = true;
    setLoading(false);
    setSaving(true);
    setMessage(null);

    try {
      const nextDocument = await saveMcpConfigDocument(
        scope,
        submittedDraft,
        root,
        expectedRaw,
      );

      if (
        saveRequestIdRef.current !== requestId ||
        configRootRef.current !== root
      ) {
        return;
      }

      documentRef.current = nextDocument;
      setDocument(nextDocument);
      const nextDraft =
        draftRevisionRef.current === draftRevision &&
        draftRef.current === submittedDraft
          ? nextDocument.raw
          : draftRef.current;
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      discoveryRequestIdRef.current += 1;
      setDiscoveryBusy(false);
      setDiscoveryOutput(null);
      setMessage({
        tone: "success",
        text: "MCP settings saved. Start a new provider run to use changes.",
      });
    } catch (error) {
      if (saveRequestIdRef.current !== requestId) {
        return;
      }

      if (isMcpConfigConflictError(error)) {
        try {
          const latestDocument = await loadMcpConfigDocument(scope, root);

          if (
            saveRequestIdRef.current !== requestId ||
            configRootRef.current !== root
          ) {
            return;
          }

          documentRef.current = latestDocument;
          setDocument(latestDocument);
          setMessage({
            tone: "error",
            text: "MCP configuration changed elsewhere. The latest version is now the comparison base and your draft was kept; review it before saving again.",
          });
          return;
        } catch (reloadError) {
          console.error(
            `Failed to reload conflicting ${scopeLabel} MCP config`,
            reloadError,
          );
        }
      }

      setMessage({
        tone: "error",
        text: getErrorText(
          error,
          `The ${scopeLabel} MCP configuration could not be saved.`,
        ),
      });
    } finally {
      if (
        saveRequestIdRef.current === requestId &&
        configRootRef.current === root
      ) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }, [configRoot, scope, scopeLabel]);

  const insertPreset = useCallback((presetId: string): void => {
    try {
      const nextDraft = createMcpConfigRawWithPreset(
        draftRef.current,
        presetId,
      );
      const preset = MCP_PRESET_SUMMARIES.find(
        (candidate) => candidate.id === presetId,
      );
      draftRevisionRef.current += 1;
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      setMessage({
        tone: "success",
        text: `${preset?.title ?? "MCP preset"} added to the draft. Save to write the config.`,
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: getErrorText(error, "MCP preset could not be inserted."),
      });
    }
  }, []);

  const runDiscovery = useCallback(
    async (
      action: DiscoveryAction,
      requestedServerId?: string,
    ): Promise<void> => {
      const root = commandRoot;
      const serverId = (requestedServerId ?? discoveryServerId).trim();

      if (!root) {
        setMessage({
          tone: "error",
          text: "Select a workspace before using MCP discovery.",
        });
        return;
      }

      if (action !== "cache" && !serverId) {
        setMessage({
          tone: "error",
          text: "Enter an MCP server id before discovery.",
        });
        return;
      }

      const requestId = discoveryRequestIdRef.current + 1;
      discoveryRequestIdRef.current = requestId;
      setDiscoveryBusy(true);
      setMessage(null);

      try {
        const result =
          action === "cache"
            ? await listMcpCachedCapabilities(root)
            : action === "refresh"
              ? await refreshMcpDiscoveryCache(root, serverId)
              : await discoverMcpServer(root, serverId);

        if (
          discoveryRequestIdRef.current !== requestId ||
          commandRootRef.current !== root
        ) {
          return;
        }

        setDiscoveryOutput(JSON.stringify(result, null, 2));
        setMessage({
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
          discoveryRequestIdRef.current === requestId &&
          commandRootRef.current === root
        ) {
          setMessage({
            tone: "error",
            text: getErrorText(error, "MCP discovery could not be completed."),
          });
        }
      } finally {
        if (discoveryRequestIdRef.current === requestId) {
          setDiscoveryBusy(false);
        }
      }
    },
    [commandRoot, discoveryServerId],
  );

  const startOauth = useCallback(
    async (requestedServerId?: string): Promise<void> => {
      const root = commandRoot;
      const serverId = (requestedServerId ?? oauthServerId).trim();

      if (!root) {
        setMessage({
          tone: "error",
          text: "Select a workspace before starting MCP OAuth.",
        });
        return;
      }

      if (!serverId) {
        setMessage({
          tone: "error",
          text: "Enter an MCP server id before starting OAuth.",
        });
        return;
      }

      const requestId = oauthRequestIdRef.current + 1;
      oauthRequestIdRef.current = requestId;
      setOauthBusy(true);
      setMessage(null);

      try {
        const result = await authorizeMcpOAuth(root, serverId);

        if (
          oauthRequestIdRef.current !== requestId ||
          commandRootRef.current !== root
        ) {
          return;
        }

        setDiscoveryOutput(JSON.stringify(result, null, 2));
        await loadDocument(false);
        setMessage({
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
          oauthRequestIdRef.current === requestId &&
          commandRootRef.current === root
        ) {
          setMessage({
            tone: "error",
            text: getErrorText(error, "MCP OAuth could not be started."),
          });
        }
      } finally {
        if (oauthRequestIdRef.current === requestId) {
          setOauthBusy(false);
        }
      }
    },
    [commandRoot, loadDocument, oauthServerId],
  );

  const finishOauth = useCallback(
    async (
      requestedServerId?: string,
      requestedAuthorizationResponse?: string,
    ): Promise<void> => {
      const root = commandRoot;
      const serverId = (requestedServerId ?? oauthServerId).trim();
      const authorizationResponse = (
        requestedAuthorizationResponse ?? oauthCallback
      ).trim();

      if (!root) {
        setMessage({
          tone: "error",
          text: "Select a workspace before finishing MCP OAuth.",
        });
        return;
      }

      if (!serverId) {
        setMessage({
          tone: "error",
          text: "Enter an MCP server id before finishing OAuth.",
        });
        return;
      }

      if (!authorizationResponse) {
        setMessage({
          tone: "error",
          text: "Paste the OAuth callback URL or code before finishing OAuth.",
        });
        return;
      }

      const requestId = oauthRequestIdRef.current + 1;
      oauthRequestIdRef.current = requestId;
      setOauthBusy(true);
      setMessage(null);

      try {
        const result = await finishMcpOAuth(
          root,
          serverId,
          authorizationResponse,
        );

        if (
          oauthRequestIdRef.current !== requestId ||
          commandRootRef.current !== root
        ) {
          return;
        }

        setDiscoveryOutput(JSON.stringify(result, null, 2));
        setOauthCallback("");
        await loadDocument(false);
        setMessage({
          tone: "success",
          text:
            result.result.stateVerified === false
              ? "MCP OAuth finished. Callback state was not available to verify."
              : "MCP OAuth finished.",
        });
      } catch (error) {
        if (
          oauthRequestIdRef.current === requestId &&
          commandRootRef.current === root
        ) {
          setMessage({
            tone: "error",
            text: getErrorText(error, "MCP OAuth could not be finished."),
          });
        }
      } finally {
        if (oauthRequestIdRef.current === requestId) {
          setOauthBusy(false);
        }
      }
    },
    [commandRoot, loadDocument, oauthCallback, oauthServerId],
  );

  return {
    workspaceRoot: commandRoot,
    document,
    draft,
    presets: MCP_PRESET_SUMMARIES,
    commandsAvailable: commandRoot !== null,
    loading,
    saving,
    discoveryServerId,
    discoveryBusy,
    discoveryOutput,
    oauthServerId,
    oauthCallback,
    oauthBusy,
    message,
    onDraftChange: updateDraft,
    onSave: saveDocument,
    onPresetInsert: insertPreset,
    onDiscoveryServerIdChange: (serverId) => {
      setDiscoveryServerId(serverId);
      setMessage(null);
    },
    onDiscoverServer: (serverId) => runDiscovery("discover", serverId),
    onRefreshDiscoveryCache: (serverId) => runDiscovery("refresh", serverId),
    onListDiscoveryCache: () => runDiscovery("cache"),
    onOAuthServerIdChange: (serverId) => {
      setOauthServerId(serverId);
      setMessage(null);
    },
    onOAuthCallbackChange: (value) => {
      setOauthCallback(value);
      setMessage(null);
    },
    onStartOAuth: startOauth,
    onFinishOAuth: finishOauth,
  };
};
