import { useMemo, useRef } from "react";
import { getDefaultCommandShortcut } from "@machdoch/media-studio/tauri/ui/commands/command-defaults.js";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import {
  asPaletteCommands,
  type CommandAvailability,
  type CommandDefinition,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import type { McpSettingsControls } from "../chat-session/components/settings-dialog-panels/types";

export const useMcpCommands = (setup: McpSettingsControls): void => {
  const setupRef = useRef(setup);
  setupRef.current = setup;
  const commands = useMemo<readonly CommandDefinition[]>(() => {
    const scope = { kind: "view" as const, ownerId: "mcp", viewId: "mcp" };
    const state = () => setupRef.current;
    const discoveryAvailability = (
      requiresServer: boolean,
    ): CommandAvailability => {
      const current = state();
      if (!current.commandsAvailable)
        return { state: "disabled", reason: "Select a workspace first." };
      if (current.discoveryBusy)
        return { state: "disabled", reason: "MCP discovery is busy." };
      if (requiresServer && !current.discoveryServerId.trim())
        return { state: "disabled", reason: "Choose an MCP server first." };
      return { state: "enabled" };
    };
    const oauthAvailability = (
      requiresCallback: boolean,
    ): CommandAvailability => {
      const current = state();
      if (!current.commandsAvailable)
        return { state: "disabled", reason: "Select a workspace first." };
      if (current.oauthBusy || !current.oauthServerId.trim())
        return {
          state: "disabled",
          reason: "Choose an OAuth MCP server first.",
        };
      if (requiresCallback && !current.oauthCallback.trim())
        return { state: "disabled", reason: "Enter the OAuth callback first." };
      return { state: "enabled" };
    };

    return asPaletteCommands([
      {
        id: "mcp.preset.insert",
        title: "Insert MCP preset",
        group: "MCP",
        scope,
        availability: () =>
          state().presets.length
            ? { state: "enabled" }
            : { state: "disabled", reason: "No MCP presets are available." },
        children: () => ({
          id: "mcp.preset.insert.page",
          title: "Insert MCP preset",
          searchPlaceholder: "Search MCP presets",
          groups: [
            {
              id: "presets",
              items: state().presets.map((preset) => ({
                id: preset.id,
                title: preset.title,
                keywords: [preset.description],
                execute: () => state().onPresetInsert(preset.id),
              })),
            },
          ],
        }),
      },
      {
        id: "mcp.config.save",
        title: "Save MCP configuration",
        group: "MCP",
        scope,
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("mcp.config.save"),
            runtimes: ["tauri", "browser"],
            allowIn: [
              "document",
              "text-entry",
              "interactive-control",
              "command-surface",
            ],
          },
        ],
        availability: () => {
          const current = state();
          if (current.loading || current.saving)
            return { state: "disabled", reason: "MCP settings are busy." };
          if (current.draft === current.document.raw)
            return { state: "disabled", reason: "No changes to save." };
          return { state: "enabled" };
        },
        execute: () => void state().onSave(),
      },
      {
        id: "mcp.discovery.run",
        title: "Discover MCP capabilities",
        group: "MCP",
        scope,
        availability: () => discoveryAvailability(true),
        execute: () => void state().onDiscoverServer(state().discoveryServerId),
      },
      {
        id: "mcp.discovery-cache.refresh",
        title: "Refresh MCP discovery cache",
        group: "MCP",
        scope,
        availability: () => discoveryAvailability(false),
        execute: () =>
          void state().onRefreshDiscoveryCache(
            state().discoveryServerId || undefined,
          ),
      },
      {
        id: "mcp.discovery-cache.list",
        title: "List MCP discovery cache",
        group: "MCP",
        scope,
        availability: () => discoveryAvailability(false),
        execute: () => void state().onListDiscoveryCache(),
      },
      {
        id: "mcp.oauth.start",
        title: "Start MCP OAuth",
        group: "MCP",
        scope,
        availability: () => oauthAvailability(false),
        execute: () => void state().onStartOAuth(state().oauthServerId),
      },
      {
        id: "mcp.oauth.finish",
        title: "Finish MCP OAuth",
        group: "MCP",
        scope,
        availability: () => oauthAvailability(true),
        execute: () =>
          void state().onFinishOAuth(
            state().oauthServerId,
            state().oauthCallback,
          ),
      },
    ]);
  }, []);

  useOptionalRegisterCommands(commands);
};
