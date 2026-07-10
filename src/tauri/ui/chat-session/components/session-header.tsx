import { GitBranch, PencilLine, Pin, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import type { ChatSessionRecord } from "../../chat-session.model";
import { cn } from "../../lib/utils";

export interface SessionHeaderProps {
  activeSession: ChatSessionRecord;
  currentSessionTitle: string;
  isRenamingSession: boolean;
  renameValue: string;
  canRenameSession: boolean;
  canDeleteSession: boolean;
  canEditSessionMetadata: boolean;
  canPinSession: boolean;
  canBranchSession: boolean;
  showClearSessionHistory: boolean;
  canClearSessionHistory: boolean;
  onTagCommit: (tags: string[]) => void;
  onTogglePinnedSession: () => void;
  onBranchSession: () => void;
  onRenameValueChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onCreateSession: () => void;
  onStartRename: () => void;
  onClearSessionHistory: () => void;
  onDeleteSession: () => void;
}

export const SessionHeader = ({
  activeSession,
  currentSessionTitle,
  isRenamingSession,
  renameValue,
  canRenameSession,
  canDeleteSession,
  canEditSessionMetadata,
  canPinSession,
  canBranchSession,
  showClearSessionHistory,
  canClearSessionHistory,
  onTagCommit,
  onTogglePinnedSession,
  onBranchSession,
  onRenameValueChange,
  onRenameCommit,
  onRenameCancel,
  onStartRename,
  onClearSessionHistory,
  onDeleteSession,
}: SessionHeaderProps): JSX.Element => {
  const [tagDraft, setTagDraft] = useState("");
  const tagSessionIdRef = useRef(activeSession.id);
  const lastExternalTagsRef = useRef(activeSession.tags.join(", "));
  const isPinned = typeof activeSession.pinnedAt === "number";

  useEffect(() => {
    const nextExternalTags = activeSession.tags.join(", ");

    if (tagSessionIdRef.current !== activeSession.id) {
      tagSessionIdRef.current = activeSession.id;
      lastExternalTagsRef.current = nextExternalTags;
      setTagDraft(nextExternalTags);
      return;
    }

    const previousExternalTags = lastExternalTagsRef.current;
    lastExternalTagsRef.current = nextExternalTags;
    setTagDraft((currentDraft) =>
      currentDraft === previousExternalTags ? nextExternalTags : currentDraft,
    );
  }, [activeSession.id, activeSession.tags]);

  const commitTags = (): void => {
    onTagCommit(
      tagDraft
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    );
  };

  return (
    <header className="app-session-header flex h-16 items-center justify-between gap-4 border-b border-slate-900 bg-slate-950/60 px-8 backdrop-blur-md">
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
            className="app-session-rename-input h-10 w-full max-w-md rounded-2xl border-slate-800 bg-slate-950 text-slate-100"
          />
        ) : (
          <h1 className="app-session-title-heading truncate text-2xl font-semibold tracking-tight text-white">
            {currentSessionTitle}
          </h1>
        )}
      </div>

      <div className="app-session-header-controls flex shrink-0 items-center gap-2">
        {canEditSessionMetadata ? (
          <Input
            value={tagDraft}
            aria-label="Session tags"
            placeholder="Tags"
            onChange={(event) => setTagDraft(event.target.value)}
            onBlur={commitTags}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitTags();
              }

              if (event.key === "Escape") {
                event.preventDefault();
                setTagDraft(activeSession.tags.join(", "));
              }
            }}
            className="app-session-tags-input h-9 w-44 rounded-2xl border-slate-800 bg-slate-950 text-xs text-slate-100 placeholder:text-slate-600"
          />
        ) : null}
        {canPinSession ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={isPinned ? "Unpin session" : "Pin session"}
            aria-pressed={isPinned}
            title={isPinned ? "Unpin session" : "Pin session"}
            onClick={onTogglePinnedSession}
            className={cn(
              "h-9 w-9 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100",
              isPinned && "text-amber-200 hover:text-amber-100",
            )}
          >
            <Pin className="h-4 w-4" />
          </Button>
        ) : null}
        {canBranchSession ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Branch session"
            title="Branch session"
            onClick={onBranchSession}
            className="h-9 w-9 rounded-2xl text-slate-400 hover:bg-slate-900 hover:text-slate-100"
          >
            <GitBranch className="h-4 w-4" />
          </Button>
        ) : null}
        {showClearSessionHistory ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Clear Quick Chat history"
            disabled={!canClearSessionHistory}
            onClick={onClearSessionHistory}
            className="h-9 rounded-2xl px-3 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100 disabled:text-slate-700 disabled:opacity-100"
          >
            Clear
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null}
        {canRenameSession ? (
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
        ) : null}
        {canDeleteSession ? (
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
        ) : null}
      </div>
    </header>
  );
};
