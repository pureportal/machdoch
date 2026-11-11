import { useMemo, useState } from "react";
import type { McpSettingsControls } from "../chat-session/components/settings-dialog-panels/types";
import {
  getRecord,
  getServerId,
  getServerKey,
  parseDiscoverySummary,
  parseDraft,
  setRecordValue,
  stringifyDraft,
  validateServers,
  type DiscoverySummary,
  type ParsedMcpDraft,
  type ServerRecord,
  type ValidationIssue,
} from "./mcp-config-model";

export type McpServerTab = "setup" | "auth" | "capabilities" | "advanced";

export interface McpServerEditor {
  setup: McpSettingsControls;
  parsed: ParsedMcpDraft;
  validationIssues: ValidationIssue[];
  dirty: boolean;
  disabled: boolean;
  saveDisabled: boolean;
  actionDisabled: boolean;
  selectedIndex: number;
  selectedServer: ServerRecord | undefined;
  selectedServerId: string;
  selectedServerKey: string;
  selectedIssues: ValidationIssue[];
  selectedHasErrors: boolean;
  selectedTab: McpServerTab;
  discoverySummary: DiscoverySummary | null;
  oauthCallback: string;
  setSelectedTab: (tab: McpServerTab) => void;
  setOauthCallback: (value: string) => void;
  selectServer: (serverId: string) => void;
  renameSelectedServer: (serverId: string) => void;
  updateSelectedField: (key: string, value: unknown) => void;
  updateSelectedRecord: (
    key: string,
    updater: (record: ServerRecord) => ServerRecord,
  ) => void;
  addServer: (server: ServerRecord) => void;
  addPreset: (presetId: string, serverId: string) => void;
  removeSelectedServer: () => void;
  discardChanges: () => void;
}

export const useMcpServerEditor = (
  setup: McpSettingsControls,
): McpServerEditor => {
  const [requestedServerId, setRequestedServerId] = useState<string | null>(
    null,
  );
  const [selectedTab, setSelectedTab] = useState<McpServerTab>("setup");
  const [oauthCallbackDraft, setOauthCallbackDraft] = useState("");
  const parsed = useMemo(() => parseDraft(setup.draft), [setup.draft]);
  const validationIssues = useMemo(
    () => (parsed.error ? [] : validateServers(parsed.servers)),
    [parsed.error, parsed.servers],
  );
  const discoverySummary = useMemo(
    () => parseDiscoverySummary(setup.discoveryOutput),
    [setup.discoveryOutput],
  );
  const dirty = setup.draft !== setup.document.raw;
  const disabled = setup.loading || setup.saving || Boolean(parsed.error);
  const requestedIndex = parsed.servers.findIndex(
    (server, index) => getServerId(server, index) === requestedServerId,
  );
  const selectedIndex =
    requestedIndex >= 0 ? requestedIndex : parsed.servers.length > 0 ? 0 : -1;
  const selectedServer =
    selectedIndex >= 0 ? parsed.servers[selectedIndex] : undefined;
  const selectedServerKey = selectedServer
    ? getServerKey(selectedServer, selectedIndex)
    : "";
  const selectedIssues = validationIssues.filter(
    (issue) => issue.serverKey === selectedServerKey,
  );

  const writeServers = (servers: ServerRecord[]): void => {
    setup.onDraftChange(stringifyDraft(parsed.config, servers));
  };

  const updateSelectedServer = (
    updater: (server: ServerRecord) => ServerRecord,
  ): void => {
    if (selectedIndex < 0) {
      return;
    }

    writeServers(
      parsed.servers.map((server, index) =>
        index === selectedIndex ? updater(server) : server,
      ),
    );
  };

  const selectServer = (serverId: string): void => {
    setRequestedServerId(serverId);
    setup.onDiscoveryServerIdChange(serverId);
    setup.onOAuthServerIdChange(serverId);
  };

  return {
    setup,
    parsed,
    validationIssues,
    dirty,
    disabled,
    saveDisabled:
      disabled ||
      !dirty ||
      validationIssues.some((issue) => issue.tone === "error"),
    actionDisabled:
      setup.loading ||
      setup.saving ||
      setup.discoveryBusy ||
      setup.oauthBusy ||
      !setup.commandsAvailable ||
      Boolean(parsed.error),
    selectedIndex,
    selectedServer,
    selectedServerId: selectedServer
      ? getServerId(selectedServer, selectedIndex)
      : "",
    selectedServerKey,
    selectedIssues,
    selectedHasErrors: selectedIssues.some((issue) => issue.tone === "error"),
    selectedTab,
    discoverySummary,
    oauthCallback: oauthCallbackDraft || setup.oauthCallback,
    setSelectedTab,
    setOauthCallback: (value) => {
      setOauthCallbackDraft(value);
      setup.onOAuthCallbackChange(value);
    },
    selectServer,
    renameSelectedServer: (serverId) => {
      updateSelectedServer((server) => setRecordValue(server, "id", serverId));
      selectServer(serverId);
    },
    updateSelectedField: (key, value) => {
      updateSelectedServer((server) => setRecordValue(server, key, value));
    },
    updateSelectedRecord: (key, updater) => {
      updateSelectedServer((server) => ({
        ...server,
        [key]: updater(getRecord(server, key) ?? {}),
      }));
    },
    addServer: (server) => {
      writeServers([...parsed.servers, server]);
      selectServer(getServerId(server, parsed.servers.length));
      setSelectedTab("setup");
    },
    addPreset: (presetId, serverId) => {
      setup.onPresetInsert(presetId);
      selectServer(serverId);
      setSelectedTab("setup");
    },
    removeSelectedServer: () => {
      if (selectedIndex < 0) {
        return;
      }

      const nextServers = parsed.servers.filter(
        (_server, index) => index !== selectedIndex,
      );
      const nextSelected = nextServers[selectedIndex] ?? nextServers.at(-1);

      writeServers(nextServers);
      setRequestedServerId(
        nextSelected
          ? getServerId(nextSelected, Math.max(0, selectedIndex - 1))
          : null,
      );
    },
    discardChanges: () => setup.onDraftChange(setup.document.raw),
  };
};
