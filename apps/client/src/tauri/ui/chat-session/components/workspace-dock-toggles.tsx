import { FolderTree, SquareTerminal } from "lucide-react";
import { useSyncExternalStore, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { detectCommandPlatform } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import { getDefaultCommandShortcut } from "@machdoch/media-studio/tauri/ui/commands/command-defaults.js";
import { formatShortcut } from "@machdoch/media-studio/tauri/ui/commands/shortcut.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { useWorkspaceDock } from "../../workspace-management/workspace-dock-store";
import { getWorkspaceTerminalStore } from "../../workspace-management/workspace-terminal-store";
import { openWorkspaceFeature } from "./open-workspace-feature";

const shortcutLabel = (chord: string): string =>
  formatShortcut(chord, detectCommandPlatform());

const RunningTerminals = ({
  workspaceRoot,
}: {
  workspaceRoot: string;
}): JSX.Element | null => {
  const store = getWorkspaceTerminalStore(workspaceRoot);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const running = snapshot.terminals.filter(
    (terminal) => terminal.sessionActive,
  ).length;
  return running > 0 ? (
    <span className="rounded-full bg-emerald-500/15 px-1.5 leading-4 text-emerald-300">
      {running}
    </span>
  ) : null;
};

export const WorkspaceDockToggles = ({
  workspaceRoot,
}: {
  workspaceRoot: string | null | undefined;
}): JSX.Element | null => {
  const root = workspaceRoot?.trim() || null;
  const dock = useWorkspaceDock(root);
  if (!root || !dock) return null;
  const filesOpen = dock.layout.filesOpen && dock.layout.filesDock === "side";
  const terminalOpen = dock.layout.terminalOpen;
  const toggleClass = (open: boolean) =>
    cn(
      "h-7 shrink-0 gap-1.5 rounded-lg px-2 text-[11px] text-slate-400 hover:bg-slate-900 hover:text-white",
      open && "bg-slate-900 text-slate-100",
    );

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={filesOpen}
        tooltip={`Files (${shortcutLabel(getDefaultCommandShortcut("workspaces.files.explorer"))})`}
        className={toggleClass(filesOpen)}
        onClick={() => openWorkspaceFeature(root, "files")}
      >
        <FolderTree aria-hidden="true" className="size-3.5" />
        Files
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={terminalOpen}
        tooltip={`Terminal (${shortcutLabel(getDefaultCommandShortcut("workspaces.terminal.toggle"))})`}
        className={toggleClass(terminalOpen)}
        onClick={() => openWorkspaceFeature(root, "terminal")}
      >
        <SquareTerminal aria-hidden="true" className="size-3.5" />
        Terminal
        <RunningTerminals workspaceRoot={root} />
      </Button>
    </>
  );
};
