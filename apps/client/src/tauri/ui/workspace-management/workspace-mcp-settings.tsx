import { useCallback, useEffect, useRef, useState, type JSX } from "react";
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
} from "../runtime";
import { McpSettingsPanel } from "../chat-session/components/settings-dialog-panels/mcp-settings-panel";
import type { SettingsStatusMessage } from "../chat-session/components/settings-dialog-panels/types";

export interface WorkspaceMcpSettingsProps {
  workspaceRoot: string;
  onDirtyChange?: (dirty: boolean) => void;
}

export const WorkspaceMcpSettings = ({
  workspaceRoot,
  onDirtyChange,
}: WorkspaceMcpSettingsProps): JSX.Element => {
  const initialDocument = createFallbackMcpConfigDocument(
    "workspace",
    workspaceRoot,
  );
  const [document, setDocument] = useState<McpConfigDocument>(initialDocument);
  const [draft, setDraft] = useState(initialDocument.raw);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [discoveryServerId, setDiscoveryServerId] = useState("");
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const [discoveryOutput, setDiscoveryOutput] = useState<string | null>(null);
  const [oauthServerId, setOauthServerId] = useState("");
  const [oauthCallback, setOauthCallback] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const [message, setMessage] = useState<SettingsStatusMessage | null>(null);
  const workspaceRootRef = useRef(workspaceRoot);
  const documentRef = useRef(document);
  const draftRef = useRef(draft);
  const draftRevisionRef = useRef(0);
  const loadRequestIdRef = useRef(0);
  const saveRequestIdRef = useRef(0);
  const discoveryRequestIdRef = useRef(0);
  const oauthRequestIdRef = useRef(0);
  const savingRef = useRef(false);
  workspaceRootRef.current = workspaceRoot;
  documentRef.current = document;
  draftRef.current = draft;

  const dirty = draft !== document.raw;

  useEffect(() => {
    onDirtyChange?.(dirty || saving);
  }, [dirty, onDirtyChange, saving]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const loadDocument = useCallback(
    async (initial: boolean): Promise<void> => {
      const requestId = loadRequestIdRef.current + 1;
      loadRequestIdRef.current = requestId;
      const root = workspaceRoot;
      const draftRevision = draftRevisionRef.current;
      const draftWasClean = draftRef.current === documentRef.current.raw;

      if (initial) {
        setLoading(true);
        setMessage(null);
      }

      try {
        const nextDocument = await loadMcpConfigDocument("workspace", root);

        if (
          loadRequestIdRef.current !== requestId ||
          workspaceRootRef.current !== root
        ) {
          return;
        }

        if (!draftWasClean || draftRevisionRef.current !== draftRevision) {
          if (nextDocument.raw !== documentRef.current.raw) {
            setMessage({
              tone: "error",
              text: "The workspace MCP configuration changed while this draft was open. Save again to review the conflict.",
            });
          }
          return;
        }

        documentRef.current = nextDocument;
        draftRef.current = nextDocument.raw;
        setDocument(nextDocument);
        setDraft(nextDocument.raw);
      } catch (error) {
        if (
          loadRequestIdRef.current === requestId &&
          workspaceRootRef.current === root
        ) {
          setMessage({
            tone: "error",
            text:
              error instanceof Error
                ? error.message
                : "Workspace MCP configuration could not be loaded.",
          });
        }
      } finally {
        if (
          initial &&
          loadRequestIdRef.current === requestId &&
          workspaceRootRef.current === root
        ) {
          setLoading(false);
        }
      }
    },
    [workspaceRoot],
  );

  useEffect(() => {
    const fallback = createFallbackMcpConfigDocument(
      "workspace",
      workspaceRoot,
    );
    loadRequestIdRef.current += 1;
    saveRequestIdRef.current += 1;
    discoveryRequestIdRef.current += 1;
    oauthRequestIdRef.current += 1;
    draftRevisionRef.current = 0;
    savingRef.current = false;
    documentRef.current = fallback;
    draftRef.current = fallback.raw;
    setDocument(fallback);
    setDraft(fallback.raw);
    setSaving(false);
    setDiscoveryServerId("");
    setDiscoveryBusy(false);
    setDiscoveryOutput(null);
    setOauthServerId("");
    setOauthCallback("");
    setOauthBusy(false);
    setMessage(null);
    void loadDocument(true);

    return () => {
      loadRequestIdRef.current += 1;
      saveRequestIdRef.current += 1;
      discoveryRequestIdRef.current += 1;
      oauthRequestIdRef.current += 1;
    };
  }, [loadDocument, workspaceRoot]);

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
    const root = workspaceRoot;
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
        "workspace",
        submittedDraft,
        root,
        expectedRaw,
      );

      if (
        saveRequestIdRef.current !== requestId ||
        workspaceRootRef.current !== root
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
      setMessage({ tone: "success", text: "Workspace MCP config saved." });
    } catch (error) {
      if (saveRequestIdRef.current !== requestId) {
        return;
      }

      if (isMcpConfigConflictError(error)) {
        try {
          const latestDocument = await loadMcpConfigDocument("workspace", root);

          if (
            saveRequestIdRef.current !== requestId ||
            workspaceRootRef.current !== root
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
            "Failed to reload conflicting workspace MCP config",
            reloadError,
          );
        }
      }

      setMessage({
        tone: "error",
        text:
          error instanceof Error
            ? error.message
            : "Workspace MCP configuration could not be saved.",
      });
    } finally {
      if (
        saveRequestIdRef.current === requestId &&
        workspaceRootRef.current === root
      ) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }, [workspaceRoot]);

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
        text:
          error instanceof Error
            ? error.message
            : "MCP preset could not be inserted.",
      });
    }
  }, []);

  const runDiscovery = useCallback(
    async (
      action: "discover" | "refresh" | "cache",
      requestedServerId?: string,
    ): Promise<void> => {
      const requestId = discoveryRequestIdRef.current + 1;
      const root = workspaceRoot;
      const serverId = (requestedServerId ?? discoveryServerId).trim();

      if (action !== "cache" && !serverId) {
        setMessage({
          tone: "error",
          text: "Enter an MCP server id before discovery.",
        });
        return;
      }

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
          workspaceRootRef.current !== root
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
          workspaceRootRef.current === root
        ) {
          setMessage({
            tone: "error",
            text:
              error instanceof Error
                ? error.message
                : "MCP discovery could not be completed.",
          });
        }
      } finally {
        if (discoveryRequestIdRef.current === requestId) {
          setDiscoveryBusy(false);
        }
      }
    },
    [discoveryServerId, workspaceRoot],
  );

  const startOauth = useCallback(
    async (requestedServerId?: string): Promise<void> => {
      const requestId = oauthRequestIdRef.current + 1;
      const root = workspaceRoot;
      const serverId = (requestedServerId ?? oauthServerId).trim();

      if (!serverId) {
        setMessage({
          tone: "error",
          text: "Enter an MCP server id before starting OAuth.",
        });
        return;
      }

      oauthRequestIdRef.current = requestId;
      setOauthBusy(true);
      setMessage(null);

      try {
        const result = await authorizeMcpOAuth(root, serverId);

        if (
          oauthRequestIdRef.current !== requestId ||
          workspaceRootRef.current !== root
        ) {
          return;
        }

        setDiscoveryOutput(JSON.stringify(result, null, 2));
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
          workspaceRootRef.current === root
        ) {
          setMessage({
            tone: "error",
            text:
              error instanceof Error
                ? error.message
                : "MCP OAuth could not be started.",
          });
        }
      } finally {
        if (oauthRequestIdRef.current === requestId) {
          setOauthBusy(false);
        }
      }
    },
    [oauthServerId, workspaceRoot],
  );

  const finishOauth = useCallback(
    async (
      requestedServerId?: string,
      requestedAuthorizationResponse?: string,
    ): Promise<void> => {
      const requestId = oauthRequestIdRef.current + 1;
      const root = workspaceRoot;
      const serverId = (requestedServerId ?? oauthServerId).trim();
      const authorizationResponse = (
        requestedAuthorizationResponse ?? oauthCallback
      ).trim();

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
          workspaceRootRef.current !== root
        ) {
          return;
        }

        setDiscoveryOutput(JSON.stringify(result, null, 2));
        setOauthCallback("");
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
          workspaceRootRef.current === root
        ) {
          setMessage({
            tone: "error",
            text:
              error instanceof Error
                ? error.message
                : "MCP OAuth could not be finished.",
          });
        }
      } finally {
        if (oauthRequestIdRef.current === requestId) {
          setOauthBusy(false);
        }
      }
    },
    [oauthCallback, oauthServerId, workspaceRoot],
  );

  return (
    <McpSettingsPanel
      setup={{
        workspaceRoot,
        document,
        draft,
        presets: MCP_PRESET_SUMMARIES,
        commandsAvailable: true,
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
        onRefreshDiscoveryCache: (serverId) =>
          runDiscovery("refresh", serverId),
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
      }}
    />
  );
};
