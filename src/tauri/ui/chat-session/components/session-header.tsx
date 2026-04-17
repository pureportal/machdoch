import { PencilLine, Trash2 } from "lucide-react";
import type { JSX } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import type { ChatSessionRecord } from "../../chat-session.model";

export interface SessionHeaderProps {
  activeSession: ChatSessionRecord;
  currentSessionTitle: string;
  isRenamingSession: boolean;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onCreateSession: () => void;
  onStartRename: () => void;
  onDeleteSession: () => void;
}

export const SessionHeader = ({
  currentSessionTitle,
  isRenamingSession,
  renameValue,
  onRenameValueChange,
  onRenameCommit,
  onRenameCancel,
  onStartRename,
  onDeleteSession,
}: SessionHeaderProps): JSX.Element => {
  return (
    <header className="flex h-16 items-center justify-between gap-4 border-b border-slate-900 bg-slate-950/60 px-8 backdrop-blur-md">
      <div className="min-w-0 flex-1">
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
            className="h-10 w-full max-w-md rounded-2xl border-slate-800 bg-slate-950 text-slate-100"
          />
        ) : (
          <h1 className="truncate text-2xl font-semibold tracking-tight text-white">
            {currentSessionTitle}
          </h1>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Rename session"
          onClick={onStartRename}
          className="h-9 w-9 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
        >
          <PencilLine className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Delete session"
          onClick={onDeleteSession}
          className="h-9 w-9 rounded-2xl text-slate-400 hover:bg-rose-500/10 hover:text-rose-200"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
};
