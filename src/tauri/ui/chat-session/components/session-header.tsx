import { PencilLine, Plus, Trash2 } from "lucide-react";
import type { JSX } from "react";
import { StatusBadge } from "../../../../common/_components/status-badge";
import type { ChatSessionRecord } from "../../chat-session.model";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { getProviderLabel } from "../../model-catalog";
import { getWorkspaceLabel } from "../_helpers/session-shell";
import { SessionRuntimePopover } from "./session-runtime-popover";

export interface SessionHeaderProps {
  activeSession: ChatSessionRecord;
  currentSessionTitle: string;
  isRenamingSession: boolean;
  renameValue: string;
  activeRunModeLabel: string;
  activeRunModeBadgeClassName: string;
  isUsingWorkspaceDefaultMode: boolean;
  runtimeSnapshot: import("../../runtime").RuntimeSnapshot | null;
  runtimeLoading: boolean;
  runtimeError: string | null;
  onRenameValueChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onSelectFolder: () => Promise<void>;
  onCreateSession: () => void;
  onStartRename: () => void;
  onDeleteSession: () => void;
}

const getRunModeTone = (
  mode: ChatSessionRecord["mode"],
): "success" | "warning" | "accent" => {
  if (mode === "safe") {
    return "success";
  }

  if (mode === "ask") {
    return "warning";
  }

  return "accent";
};

export const SessionHeader = ({
  activeSession,
  currentSessionTitle,
  isRenamingSession,
  renameValue,
  activeRunModeLabel,
  activeRunModeBadgeClassName,
  isUsingWorkspaceDefaultMode,
  runtimeSnapshot,
  runtimeLoading,
  runtimeError,
  onRenameValueChange,
  onRenameCommit,
  onRenameCancel,
  onSelectFolder,
  onCreateSession,
  onStartRename,
  onDeleteSession,
}: SessionHeaderProps): JSX.Element => {
  return (
    <header className="flex h-20 items-center justify-between border-b border-slate-900 bg-slate-950/60 px-8 backdrop-blur-md">
      <div className="min-w-0">
        <p className="text-xs font-semibold tracking-[0.24em] text-slate-500 uppercase">
          machdoch desktop shell
        </p>

        {isRenamingSession ? (
          <Input
            autoFocus
            value={renameValue}
            onChange={(event) => onRenameValueChange(event.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onRenameCommit();
              }

              if (event.key === "Escape") {
                event.preventDefault();
                onRenameCancel();
              }
            }}
            className="mt-2 h-11 w-full max-w-md rounded-2xl border-slate-800 bg-slate-950 text-slate-100"
          />
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight text-white">
              {currentSessionTitle}
            </h1>
            <StatusBadge tone="info">
              {getProviderLabel(activeSession.provider)}
            </StatusBadge>
            <StatusBadge tone="neutral">{activeSession.model}</StatusBadge>
            <StatusBadge
              tone={getRunModeTone(activeSession.mode)}
              className={activeRunModeBadgeClassName}
            >
              {activeRunModeLabel}
            </StatusBadge>
            {activeSession.workspace ? (
              <StatusBadge tone="neutral">
                {getWorkspaceLabel(activeSession.workspace)}
              </StatusBadge>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <SessionRuntimePopover
          activeSession={activeSession}
          activeRunModeLabel={activeRunModeLabel}
          activeRunModeBadgeClassName={activeRunModeBadgeClassName}
          isUsingWorkspaceDefaultMode={isUsingWorkspaceDefaultMode}
          runtimeSnapshot={runtimeSnapshot}
          runtimeLoading={runtimeLoading}
          runtimeError={runtimeError}
          onSelectFolder={onSelectFolder}
        />

        <Button
          type="button"
          variant="outline"
          onClick={onCreateSession}
          className="h-10 rounded-2xl border-slate-800 bg-slate-950 hover:bg-slate-900 hover:text-slate-100"
        >
          <Plus className="h-4 w-4" />
          New session
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Rename session"
          onClick={onStartRename}
          className="h-10 w-10 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
        >
          <PencilLine className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Delete session"
          onClick={onDeleteSession}
          className="h-10 w-10 rounded-2xl text-slate-400 hover:bg-rose-500/10 hover:text-rose-200"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
};
