import { useMemo, useRef } from "react";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import {
  asPaletteCommands,
  type CommandDefinition,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import type {
  WorkspaceTerminalSessionView,
  WorkspaceTerminalStore,
  WorkspaceTerminalStoreSnapshot,
} from "./workspace-terminal-store";
import { terminalStatusLabel } from "./workspace-terminal-tabs";

interface TerminalCommandState {
  store: WorkspaceTerminalStore;
  snapshot: WorkspaceTerminalStoreSnapshot;
  activeTerminal: WorkspaceTerminalSessionView | null;
  chat?: { addText: (text: string) => void };
  closeTerminal: (terminal: WorkspaceTerminalSessionView) => void;
  openExternalTerminal: () => void;
  openSearch: () => void;
  openPalette: () => void;
}

const scope = {
  kind: "view" as const,
  ownerId: "workspaces",
  viewId: "workspaces",
};
const group = "Workspace terminal";

export const useWorkspaceTerminalCommands = (
  current: TerminalCommandState,
): void => {
  const stateRef = useRef(current);
  stateRef.current = current;
  const commands = useMemo<readonly CommandDefinition[]>(() => {
    const state = () => stateRef.current;
    const active = () =>
      state().activeTerminal
        ? ({ state: "enabled" } as const)
        : ({ state: "hidden" } as const);
    const withCommands = () =>
      !state().activeTerminal
        ? ({ state: "hidden" } as const)
        : state().activeTerminal?.hasCommands
          ? ({ state: "enabled" } as const)
          : ({
              state: "disabled",
              reason: "No commands have run in this terminal.",
            } as const);
    const terminalPage = (
      id: string,
      title: string,
      execute: (terminal: WorkspaceTerminalSessionView) => void,
    ) => ({
      id,
      title,
      searchPlaceholder: "Search terminals",
      groups: [
        {
          id: "terminals",
          items: state().snapshot.terminals.map((terminal) => ({
            id: terminal.id,
            title: terminal.label,
            keywords: [
              terminal.title ?? "",
              terminalStatusLabel(terminal.status),
            ],
            current: terminal.id === state().snapshot.activeTerminalId,
            execute: () => execute(terminal),
          })),
        },
      ],
    });
    return asPaletteCommands([
      {
        id: "workspaces.terminal.select",
        title: "Select workspace terminal",
        group,
        scope,
        availability: () =>
          state().snapshot.terminals.length
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () =>
          terminalPage(
            "workspaces.terminal.select.page",
            "Select workspace terminal",
            (terminal) => state().store.selectTerminal(terminal.id),
          ),
      },
      {
        id: "workspaces.terminal.new",
        title: "New workspace terminal",
        group,
        scope,
        availability: () =>
          (state().snapshot.profiles?.visibleShells.length ?? 0) > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No shells are available." },
        children: () => ({
          id: "workspaces.terminal.new.page",
          title: "New workspace terminal",
          searchPlaceholder: "Search shells",
          groups: [
            {
              id: "shells",
              items: (state().snapshot.profiles?.visibleShells ?? []).map(
                (shell) => ({
                  id: shell.id,
                  title: shell.label,
                  execute: () => void state().store.createTerminal(shell.id),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "workspaces.terminal.run",
        title: "Run command in terminal",
        group,
        scope,
        availability: active,
        execute: () => state().openPalette(),
      },
      {
        id: "workspaces.terminal.find",
        title: "Find in terminal",
        group,
        scope,
        availability: active,
        execute: () => state().openSearch(),
      },
      {
        id: "workspaces.terminal.rerun",
        title: "Rerun last terminal command",
        group,
        scope,
        availability: withCommands,
        execute: () => {
          const terminal = state().activeTerminal;
          if (terminal) state().store.rerunLastCommand(terminal.id);
        },
      },
      {
        id: "workspaces.terminal.previous-command",
        title: "Go to previous terminal command",
        group,
        scope,
        availability: withCommands,
        execute: () => {
          const terminal = state().activeTerminal;
          if (terminal) state().store.jumpToCommand(terminal.id, "previous");
        },
      },
      {
        id: "workspaces.terminal.next-command",
        title: "Go to next terminal command",
        group,
        scope,
        availability: withCommands,
        execute: () => {
          const terminal = state().activeTerminal;
          if (terminal) state().store.jumpToCommand(terminal.id, "next");
        },
      },
      {
        id: "workspaces.terminal.send-output",
        title: "Send last terminal output to chat",
        group,
        scope,
        availability: () =>
          state().chat ? withCommands() : { state: "hidden" },
        execute: () => {
          const terminal = state().activeTerminal;
          const output = terminal
            ? state().store.lastCommandOutput(terminal.id)
            : null;
          if (output) state().chat?.addText(output);
        },
      },
      {
        id: "workspaces.terminal.split",
        title: "Split workspace terminal",
        group,
        scope,
        availability: active,
        execute: () => void state().store.splitActiveTerminal("vertical"),
      },
      {
        id: "workspaces.terminal.start",
        title: "Start or restart workspace terminal",
        group,
        scope,
        availability: () =>
          !state().activeTerminal
            ? { state: "hidden" }
            : state().activeTerminal?.transitioning
              ? { state: "disabled", reason: "Terminal is starting." }
              : { state: "enabled" },
        execute: () => void state().store.startActiveTerminal(),
      },
      {
        id: "workspaces.terminal.stop",
        title: "Stop workspace terminal",
        group,
        scope,
        availability: () => {
          const terminal = state().activeTerminal;
          if (!terminal) return { state: "hidden" };
          return terminal.sessionActive || terminal.status === "starting"
            ? { state: "enabled" }
            : { state: "disabled", reason: "Terminal is not running." };
        },
        execute: () => void state().store.stopActiveTerminal(),
      },
      {
        id: "workspaces.terminal.clear",
        title: "Clear workspace terminal",
        group,
        scope,
        availability: active,
        execute: () => state().store.clearActiveTerminal(),
      },
      {
        id: "workspaces.terminal.close",
        title: "Close workspace terminal",
        group,
        scope,
        availability: () =>
          state().snapshot.terminals.length
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () =>
          terminalPage(
            "workspaces.terminal.close.page",
            "Close workspace terminal",
            (terminal) => state().closeTerminal(terminal),
          ),
      },
      {
        id: "workspaces.terminal.open-external",
        title: "Open workspace in external terminal",
        group,
        scope,
        availability: () =>
          state().snapshot.discovery?.externalTerminal
            ? { state: "enabled" }
            : { state: "hidden" },
        execute: () => state().openExternalTerminal(),
      },
    ]);
  }, []);
  useOptionalRegisterCommands(commands);
};
