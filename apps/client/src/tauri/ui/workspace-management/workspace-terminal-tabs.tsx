import { Columns2, Eye, Palette, Pencil, Rows2, X } from "lucide-react";
import { useState, type JSX } from "react";
import { ContextActionMenu } from "@machdoch/media-studio/tauri/ui/components/ui/context-action-menu.js";
import { ControlTooltip } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  TERMINAL_COLORS,
  type TerminalColor,
  type TerminalLayout,
  type TerminalSplitDirection,
} from "./workspace-terminal-layout";
import type {
  WorkspaceTerminalSessionView,
  WorkspaceTerminalStatus,
} from "./workspace-terminal-store";

export const terminalStatusLabel = (
  status: WorkspaceTerminalStatus,
): string => {
  switch (status) {
    case "loading":
      return "Loading";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "exited":
      return "Exited";
    case "error":
      return "Unavailable";
  }
};

const COLOR_CLASSES: Record<TerminalColor, string> = {
  sky: "bg-sky-400",
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  rose: "bg-rose-400",
  violet: "bg-violet-400",
  slate: "bg-slate-400",
};

const colorLabel = (color: TerminalColor): string =>
  `${color.charAt(0).toUpperCase()}${color.slice(1)}`;

const statusClass = (terminal: WorkspaceTerminalSessionView): string => {
  if (terminal.status === "running") {
    return terminal.lastExitCode !== null && terminal.lastExitCode !== 0
      ? "bg-red-400"
      : "bg-emerald-400";
  }
  if (terminal.status === "starting" || terminal.status === "loading") {
    return "animate-pulse bg-sky-400";
  }
  return terminal.status === "error" ? "bg-red-400" : "bg-slate-600";
};

export interface TerminalTabActions {
  select: (terminalId: string) => void;
  rename: (terminalId: string, name: string) => void;
  color: (terminalId: string, color: TerminalColor | null) => void;
  split: (terminalId: string, direction: TerminalSplitDirection) => void;
  close: (terminal: WorkspaceTerminalSessionView) => void;
}

const TerminalTab = ({
  terminal,
  name,
  color,
  active,
  actions,
}: {
  terminal: WorkspaceTerminalSessionView;
  name: string;
  color: TerminalColor | null;
  active: boolean;
  actions: TerminalTabActions;
}): JSX.Element => {
  const [editing, setEditing] = useState(false);

  return (
    <ContextActionMenu
      label={`${name} actions`}
      actions={() => [
        { label: "Rename", icon: Pencil, onSelect: () => setEditing(true) },
        ...TERMINAL_COLORS.map((option) => ({
          label: colorLabel(option),
          icon: Palette,
          checked: color === option,
          onSelect: () =>
            actions.color(terminal.id, color === option ? null : option),
        })),
        {
          label: "Split right",
          icon: Columns2,
          onSelect: () => actions.split(terminal.id, "vertical"),
        },
        {
          label: "Split down",
          icon: Rows2,
          onSelect: () => actions.split(terminal.id, "horizontal"),
        },
        {
          label: "Close",
          icon: X,
          destructive: true,
          onSelect: () => actions.close(terminal),
        },
      ]}
    >
      <div
        className={cn(
          "group relative flex h-7 max-w-52 shrink-0 items-center overflow-hidden rounded-md border",
          active
            ? "border-slate-700 bg-slate-900 text-slate-200"
            : "border-transparent text-slate-500 hover:bg-slate-900/60 hover:text-slate-300",
        )}
      >
        {color ? (
          <span
            aria-hidden
            className={cn(
              "absolute inset-y-1 left-0 w-0.5 rounded-full",
              COLOR_CLASSES[color],
            )}
          />
        ) : null}
        {editing ? (
          <input
            autoFocus
            defaultValue={name}
            aria-label="Terminal name"
            className="mx-1.5 h-5 w-32 rounded border border-sky-600 bg-slate-950 px-1 text-[11px] text-slate-100 outline-none"
            onFocus={(event) => event.currentTarget.select()}
            onBlur={(event) => {
              actions.rename(terminal.id, event.currentTarget.value);
              setEditing(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <ControlTooltip
            content={`${terminal.title ?? name} · ${terminalStatusLabel(terminal.status)}${terminal.cwd && terminal.cwd !== "." ? ` · ${terminal.cwd}` : ""}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => actions.select(terminal.id)}
              onDoubleClick={() => setEditing(true)}
              onAuxClick={(event) => {
                if (event.button === 1) actions.close(terminal);
              }}
              className="flex min-w-0 items-center gap-1.5 py-1 pl-2 text-[11px] outline-none focus-visible:text-sky-300"
            >
              <span
                role="status"
                aria-label={`${name}: ${terminalStatusLabel(terminal.status)}`}
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  statusClass(terminal),
                )}
              />
              <span className="truncate">{name}</span>
              {terminal.agentReading ? (
                <Eye
                  aria-label="Agent is reading"
                  className="size-3 shrink-0 animate-pulse text-violet-300"
                />
              ) : null}
            </button>
          </ControlTooltip>
        )}
        <button
          type="button"
          aria-label={`Close ${name}`}
          onClick={() => actions.close(terminal)}
          className={cn(
            "mx-1 grid size-4 shrink-0 place-items-center rounded-sm text-slate-600 outline-none hover:bg-slate-800 hover:text-slate-300 focus-visible:ring-1 focus-visible:ring-sky-400",
            !active &&
              "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
          )}
        >
          <X className="size-3" />
        </button>
      </div>
    </ContextActionMenu>
  );
};

export const WorkspaceTerminalTabs = ({
  terminals,
  layout,
  activeTerminalId,
  actions,
}: {
  terminals: readonly WorkspaceTerminalSessionView[];
  layout: TerminalLayout;
  activeTerminalId: string | null;
  actions: TerminalTabActions;
}): JSX.Element => (
  <div
    role="tablist"
    aria-label="Terminals"
    className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none]"
  >
    {terminals.map((terminal) => {
      const tab = layout.tabs.find((candidate) => candidate.id === terminal.id);
      return (
        <TerminalTab
          key={terminal.id}
          terminal={terminal}
          name={tab?.name ?? terminal.label}
          color={tab?.color ?? null}
          active={terminal.id === activeTerminalId}
          actions={actions}
        />
      );
    })}
  </div>
);
