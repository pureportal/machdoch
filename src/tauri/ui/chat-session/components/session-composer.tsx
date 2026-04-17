import {
  Brain,
  BrainCircuit,
  FolderOpen,
  Monitor,
  SendHorizonal,
} from "lucide-react";
import type { JSX, KeyboardEvent } from "react";
import type { RunMode } from "../../../../core/types.js";
import type { ChatSessionRecord } from "../../chat-session.model";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { type RuntimeProvider } from "../../model-catalog";
import { type RUN_MODE_META } from "../_helpers/session-shell";
import { MemoryShortcutButton } from "./memory-shortcut-button";
import { SessionModePicker } from "./session-mode-picker";
import { SessionModelPicker } from "./session-model-picker";

export interface SessionComposerProps {
  activeSession: ChatSessionRecord;
  chooserProviders: RuntimeProvider[];
  activeRunMode: RunMode;
  activeRunModeMeta: (typeof RUN_MODE_META)[RunMode];
  defaultRunMode: RunMode;
  isUsingWorkspaceDefaultMode: boolean;
  hasActiveWorkspace: boolean;
  composerWorkspaceLabel: string;
  sessionMemoryDescription: string;
  globalMemoryDescription: string;
  uiControlDescription: string;
  isGlobalMemoryAvailable: boolean;
  isGlobalMemoryActive: boolean;
  isUiControlAvailable: boolean;
  canSendMessage: boolean;
  onSelectFolder: () => Promise<void>;
  onSessionModelSelection: (provider: RuntimeProvider, model: string) => void;
  onSessionModeSelection: (mode: RunMode | null) => void;
  onSessionMemoryEnabledChange: (enabled: boolean) => void;
  onUseGlobalMemoryChange: (enabled: boolean) => void;
  onUiControlEnabledChange: (enabled: boolean) => void;
  onDraftChange: (value: string) => void;
  onComposerHistoryNavigation: (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => void;
  onSend: () => void;
}

export const SessionComposer = ({
  activeSession,
  chooserProviders,
  activeRunMode,
  activeRunModeMeta,
  defaultRunMode,
  isUsingWorkspaceDefaultMode,
  hasActiveWorkspace,
  composerWorkspaceLabel,
  sessionMemoryDescription,
  globalMemoryDescription,
  uiControlDescription,
  isGlobalMemoryAvailable,
  isGlobalMemoryActive,
  isUiControlAvailable,
  canSendMessage,
  onSelectFolder,
  onSessionModelSelection,
  onSessionModeSelection,
  onSessionMemoryEnabledChange,
  onUseGlobalMemoryChange,
  onUiControlEnabledChange,
  onDraftChange,
  onComposerHistoryNavigation,
  onSend,
}: SessionComposerProps): JSX.Element => {
  return (
    <div className="rounded-[1.75rem] border border-slate-800/80 bg-slate-950/75 p-3 shadow-[0_18px_48px_rgba(2,6,23,0.42)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-900/80 pb-3">
        <SessionModelPicker
          chooserProviders={chooserProviders}
          activeProvider={activeSession.provider}
          activeModel={activeSession.model}
          onSessionModelSelection={onSessionModelSelection}
        />

        <SessionModePicker
          activeRunMode={activeRunMode}
          activeRunModeMeta={activeRunModeMeta}
          defaultRunMode={defaultRunMode}
          isUsingWorkspaceDefaultMode={isUsingWorkspaceDefaultMode}
          onSessionModeSelection={onSessionModeSelection}
        />

        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void onSelectFolder();
          }}
          className={cn(
            "h-8 rounded-full border-slate-800 bg-slate-950/70 px-3 text-xs font-medium text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100",
            hasActiveWorkspace &&
              "border-sky-500/20 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15",
          )}
        >
          <FolderOpen
            className={cn(
              "mr-2 h-3.5 w-3.5",
              hasActiveWorkspace ? "text-sky-300" : "text-slate-500",
            )}
          />
          {composerWorkspaceLabel}
        </Button>

        <MemoryShortcutButton
          label="Session memory"
          description={sessionMemoryDescription}
          pressed={activeSession.sessionMemoryEnabled}
          onClick={() =>
            onSessionMemoryEnabledChange(!activeSession.sessionMemoryEnabled)
          }
          icon={<Brain className="h-4 w-4" />}
          className={cn(
            activeSession.sessionMemoryEnabled
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/15 hover:text-white"
              : undefined,
          )}
        />

        <MemoryShortcutButton
          label="Global memory"
          description={globalMemoryDescription}
          pressed={isGlobalMemoryActive}
          disabled={!isGlobalMemoryAvailable}
          onClick={() =>
            onUseGlobalMemoryChange(!activeSession.useGlobalMemory)
          }
          icon={<BrainCircuit className="h-4 w-4" />}
          className={cn(
            isGlobalMemoryAvailable && isGlobalMemoryActive
              ? "border-sky-500/30 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15 hover:text-white"
              : isGlobalMemoryAvailable
                ? undefined
                : "border-dashed border-slate-800 bg-slate-950/40 text-slate-600 hover:bg-slate-950/40 hover:text-slate-600",
          )}
        />

        <MemoryShortcutButton
          label="UI control"
          description={uiControlDescription}
          pressed={activeSession.uiControlEnabled}
          disabled={!isUiControlAvailable}
          onClick={() =>
            onUiControlEnabledChange(!activeSession.uiControlEnabled)
          }
          icon={<Monitor className="h-4 w-4" />}
          className={cn(
            isUiControlAvailable && activeSession.uiControlEnabled
              ? "border-violet-500/30 bg-violet-500/10 text-violet-100 hover:bg-violet-500/15 hover:text-white"
              : isUiControlAvailable
                ? undefined
                : "border-dashed border-slate-800 bg-slate-950/40 text-slate-600 hover:bg-slate-950/40 hover:text-slate-600",
          )}
        />
      </div>

      <form
        className="mt-3 flex items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <Textarea
          aria-label="Task composer"
          value={activeSession.draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (canSendMessage) {
                onSend();
              }
            } else {
              onComposerHistoryNavigation(event);
            }
          }}
          placeholder="What should machdoch do next?"
          className="max-h-[30vh] min-h-14 resize-none overflow-y-auto rounded-[1.4rem] border-slate-800 bg-slate-900/70 px-5 py-4 text-base text-slate-100 shadow-inner shadow-black/20 placeholder:text-slate-500 focus-visible:ring-1 focus-visible:ring-sky-500 disabled:cursor-not-allowed disabled:bg-slate-900/50 disabled:text-slate-500 disabled:opacity-100"
        />

        <Button
          type="submit"
          variant="outline"
          size="icon"
          aria-label="Send message"
          disabled={!canSendMessage}
          className={cn(
            "h-11 w-11 rounded-[1.15rem] border-slate-800 bg-slate-900 text-slate-400 shadow-none hover:bg-slate-800 hover:text-slate-100 disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-600 disabled:opacity-100",
            canSendMessage &&
              "border-sky-500/20 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15 hover:text-white",
          )}
        >
          <SendHorizonal className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
};
