import { History, Play } from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { WorkspaceRunSnapshot } from "../../../shared/workspace-run.js";
import { loadWorkspaceRunSnapshot } from "../runtime";
import {
  terminalRunTasks,
  type TerminalRunTask,
} from "./workspace-terminal-run";

type PaletteItem =
  | { kind: "history"; id: string; label: string; command: string }
  | {
      kind: "run";
      id: string;
      label: string;
      command: string;
      run: TerminalRunTask;
    };

export const WorkspaceTerminalPalette = ({
  workspaceRoot,
  open,
  history,
  onOpenChange,
  onRunCommand,
  onRunConfiguration,
}: {
  workspaceRoot: string;
  open: boolean;
  history: readonly string[];
  onOpenChange: (open: boolean) => void;
  onRunCommand: (command: string) => void;
  onRunConfiguration: (
    run: TerminalRunTask,
    snapshot: WorkspaceRunSnapshot,
  ) => void;
}): JSX.Element => {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [snapshot, setSnapshot] = useState<WorkspaceRunSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActive(0);
      return;
    }
    let current = true;
    void loadWorkspaceRunSnapshot(workspaceRoot)
      .then((loaded) => {
        if (current) setSnapshot(loaded);
      })
      .catch((failure: unknown) => {
        if (current)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      });
    return () => {
      current = false;
    };
  }, [open, workspaceRoot]);

  const items = useMemo<PaletteItem[]>(() => {
    const needle = query.trim().toLowerCase();
    const runs: PaletteItem[] = terminalRunTasks(
      snapshot?.configurations ?? [],
    ).map((run) => ({
      kind: "run",
      id: `run:${run.task.id}`,
      label: run.task.name,
      command: run.task.command,
      run,
    }));
    const commands: PaletteItem[] = history.map((command) => ({
      kind: "history",
      id: `history:${command}`,
      label: command,
      command,
    }));
    const all = [...runs, ...commands];
    const filtered = needle
      ? all.filter(
          (item) =>
            item.label.toLowerCase().includes(needle) ||
            item.command.toLowerCase().includes(needle),
        )
      : all;
    return needle && !filtered.some((item) => item.command === query.trim())
      ? [
          ...filtered,
          {
            kind: "history",
            id: "typed",
            label: query.trim(),
            command: query.trim(),
          },
        ]
      : filtered;
  }, [history, query, snapshot]);

  const choose = (item: PaletteItem | undefined): void => {
    if (!item) return;
    onOpenChange(false);
    if (item.kind === "run" && snapshot) onRunConfiguration(item.run, snapshot);
    else onRunCommand(item.command);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        className="top-[12%] flex max-h-[70dvh] w-[min(40rem,calc(100vw-2rem))] max-w-none translate-y-0 flex-col gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 sm:max-w-none"
      >
        <DialogTitle className="sr-only">Run in terminal</DialogTitle>
        <input
          autoFocus
          value={query}
          aria-label="Command"
          placeholder="Run a command or configuration"
          spellCheck={false}
          className="h-11 w-full border-b border-border bg-transparent px-4 font-mono text-sm outline-none"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, items.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(items[active]);
            }
          }}
        />
        {error ? (
          <p className="px-4 py-2 text-xs text-destructive">{error}</p>
        ) : null}
        <ul
          role="listbox"
          aria-label="Commands"
          className="max-h-80 overflow-y-auto py-1"
        >
          {items.map((item, index) => (
            <li
              key={item.id}
              role="option"
              aria-selected={index === active}
              className={cn(
                "flex cursor-pointer items-center gap-2 px-4 py-1.5 text-sm",
                index === active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground",
              )}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(item);
              }}
            >
              {item.kind === "run" ? (
                <Play className="size-3.5 shrink-0 text-emerald-400" />
              ) : (
                <History className="size-3.5 shrink-0" />
              )}
              <span
                className={cn(
                  "truncate",
                  item.kind === "history" && "font-mono text-xs",
                )}
              >
                {item.label}
              </span>
              {item.kind === "run" ? (
                <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
                  {item.command}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
};
