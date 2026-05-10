import {
  Brain,
  BrainCircuit,
  FolderOpen,
  LoaderCircle,
  Mic,
  Monitor,
  Square,
} from "lucide-react";
import type { JSX, KeyboardEvent } from "react";
import type { RunMode } from "../../../../core/types.js";
import {
  isQuickVoiceSession,
  type ChatSessionContextAttachment,
  type ChatSessionRecord,
} from "../../chat-session.model";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import type { RuntimeProvider } from "../../model-catalog";
import type { RUN_MODE_META } from "../_helpers/session-shell";
import {
  AgentComposer,
  type AgentComposerAction,
  type AgentComposerToggle,
} from "./agent-composer";
import { SessionModePicker } from "./session-mode-picker";

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
  contextAttachments: ChatSessionContextAttachment[];
  imageInputSupported: boolean;
  imageInputDisabledReason: string | null;
  speechInput: {
    browserSupported: boolean;
    enabled: boolean;
    recording: boolean;
    transcribing: boolean;
    statusText: string | null;
    statusTone: "success" | "error" | "info" | null;
    onAction: () => void;
  };
  canSendMessage: boolean;
  sendDisabledReason: string | null;
  onSelectFolder: () => Promise<void>;
  onSessionModelSelection: (provider: RuntimeProvider, model: string) => void;
  onSessionModeSelection: (mode: RunMode | null) => void;
  onSessionMemoryEnabledChange: (enabled: boolean) => void;
  onUseGlobalMemoryChange: (enabled: boolean) => void;
  onUiControlEnabledChange: (enabled: boolean) => void;
  onSelectContextFiles: () => Promise<void>;
  onSelectContextFolders: () => Promise<void>;
  onSelectContextImages: () => Promise<void>;
  onRemoveContextAttachment: (attachmentId: string) => void;
  onClearContextAttachments: () => void;
  onDraftChange: (value: string) => void;
  onComposerHistoryNavigation: (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => void;
  onSend: () => void;
  onCancel: () => void;
  isExecuting: boolean;
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
  contextAttachments,
  imageInputSupported,
  imageInputDisabledReason,
  speechInput,
  canSendMessage,
  sendDisabledReason,
  onSelectFolder,
  onSessionModelSelection,
  onSessionModeSelection,
  onSessionMemoryEnabledChange,
  onUseGlobalMemoryChange,
  onUiControlEnabledChange,
  onSelectContextFiles,
  onSelectContextFolders,
  onSelectContextImages,
  onRemoveContextAttachment,
  onClearContextAttachments,
  onDraftChange,
  onComposerHistoryNavigation,
  onSend,
  onCancel,
  isExecuting,
}: SessionComposerProps): JSX.Element => {
  const showSessionMemoryButton = !isQuickVoiceSession(activeSession);
  const speechInputActionLabel = !speechInput.browserSupported
    ? "Speech input unavailable"
    : speechInput.transcribing
      ? "Transcribing speech"
      : speechInput.recording
        ? "Stop recording"
        : speechInput.enabled
          ? "Speak to text"
          : "Configure speak to text";
  const speechInputIcon = speechInput.transcribing ? (
    <LoaderCircle className="h-4 w-4 animate-spin" />
  ) : speechInput.recording ? (
    <Square className="h-4 w-4 fill-current" />
  ) : (
    <Mic className="h-4 w-4" />
  );
  const toolbarControls = (
    <>
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
          "app-composer-toolbar-pill",
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
    </>
  );
  const toggles: AgentComposerToggle[] = [];

  if (showSessionMemoryButton) {
    toggles.push({
      id: "session-memory",
      label: "Session memory",
      description: sessionMemoryDescription,
      icon: <Brain className="h-4 w-4" />,
      pressed: activeSession.sessionMemoryEnabled,
      onPressedChange: onSessionMemoryEnabledChange,
      activeClassName:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/15 hover:text-white",
    });
  }

  toggles.push(
    {
      id: "global-memory",
      label: "Global memory",
      description: globalMemoryDescription,
      icon: <BrainCircuit className="h-4 w-4" />,
      pressed: isGlobalMemoryActive,
      disabled: !isGlobalMemoryAvailable,
      onPressedChange: onUseGlobalMemoryChange,
      activeClassName:
        "border-sky-500/30 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15 hover:text-white",
      unavailableClassName:
        "border-dashed border-slate-800 bg-slate-950/40 text-slate-600 hover:bg-slate-950/40 hover:text-slate-600",
    },
    {
      id: "ui-control",
      label: "UI control",
      description: uiControlDescription,
      icon: <Monitor className="h-4 w-4" />,
      pressed: activeSession.uiControlEnabled,
      disabled: !isUiControlAvailable,
      onPressedChange: onUiControlEnabledChange,
      activeClassName:
        "border-violet-500/30 bg-violet-500/10 text-violet-100 hover:bg-violet-500/15 hover:text-white",
      unavailableClassName:
        "border-dashed border-slate-800 bg-slate-950/40 text-slate-600 hover:bg-slate-950/40 hover:text-slate-600",
    },
  );

  const actions: AgentComposerAction[] = [
    {
      id: "speech-input",
      label: speechInputActionLabel,
      title: speechInputActionLabel,
      icon: speechInputIcon,
      disabled: !speechInput.browserSupported || speechInput.transcribing,
      onClick: speechInput.onAction,
      className: cn(
        speechInput.recording &&
          "border-rose-500/20 bg-rose-500/10 text-rose-100 hover:bg-rose-500/15 hover:text-white",
        speechInput.transcribing &&
          "border-amber-500/20 bg-amber-500/10 text-amber-100 hover:bg-amber-500/10 hover:text-amber-100",
        !speechInput.recording &&
          !speechInput.transcribing &&
          speechInput.enabled &&
          "border-violet-500/20 bg-violet-500/10 text-violet-100 hover:bg-violet-500/15 hover:text-white",
      ),
    },
  ];

  return (
    <AgentComposer
      variant="session"
      draft={activeSession.draft}
      textareaLabel="Task composer"
      placeholder="What should machdoch do next?"
      chooserProviders={chooserProviders}
      activeProvider={activeSession.provider}
      activeModel={activeSession.model}
      contextAttachments={contextAttachments}
      imageInputSupported={imageInputSupported}
      imageInputDisabledReason={imageInputDisabledReason}
      canSend={canSendMessage}
      sendDisabledReason={sendDisabledReason}
      isExecuting={isExecuting}
      toolbarControls={toolbarControls}
      toggles={toggles}
      actions={actions}
      statusMessage={
        speechInput.statusText
          ? {
              text: speechInput.statusText,
              tone: speechInput.statusTone,
            }
          : null
      }
      onModelSelection={onSessionModelSelection}
      onSelectContextFiles={onSelectContextFiles}
      onSelectContextFolders={onSelectContextFolders}
      onSelectContextImages={onSelectContextImages}
      onRemoveContextAttachment={onRemoveContextAttachment}
      onClearContextAttachments={onClearContextAttachments}
      onDraftChange={onDraftChange}
      onAdditionalTextareaKeyDown={onComposerHistoryNavigation}
      onSend={onSend}
      onCancel={onCancel}
    />
  );
};
