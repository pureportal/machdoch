import {
  Brain,
  BrainCircuit,
  LoaderCircle,
  Mic,
  Monitor,
  Square,
} from "lucide-react";
import type { JSX, KeyboardEvent } from "react";
import type { ReasoningMode, RunMode } from "../../../../core/types.js";
import {
  isQuickVoiceSession,
  type ChatSessionContextAttachment,
  type ChatSessionRecord,
  type SmartContextPack,
} from "../../chat-session.model";
import { cn } from "../../lib/utils";
import type { RuntimeProvider } from "../../model-catalog";
import type { SaveSmartContextPackInput } from "../_helpers/smart-context-packs";
import type { RUN_MODE_META } from "../_helpers/session-shell";
import {
  AgentComposer,
  type AgentComposerAction,
  type AgentComposerToggle,
} from "./agent-composer";
import { SessionModePicker } from "./session-mode-picker";
import { SessionReasoningPicker } from "./session-reasoning-picker";
import { SmartContextPackPicker } from "./smart-context-packs";
import { WorkspacePicker } from "./workspace-picker";

export interface SessionComposerProps {
  activeSession: ChatSessionRecord;
  chooserProviders: RuntimeProvider[];
  activeRunMode: RunMode;
  activeRunModeMeta: (typeof RUN_MODE_META)[RunMode];
  defaultRunMode: RunMode;
  defaultReasoning: ReasoningMode;
  activeReasoning: ReasoningMode;
  isUsingWorkspaceDefaultMode: boolean;
  isUsingWorkspaceDefaultReasoning: boolean;
  hasActiveWorkspace: boolean;
  recentWorkspaces: string[];
  composerWorkspaceLabel: string;
  sessionMemoryDescription: string;
  globalMemoryDescription: string;
  uiControlDescription: string;
  isGlobalMemoryAvailable: boolean;
  isGlobalMemoryActive: boolean;
  isUiControlAvailable: boolean;
  contextAttachments: ChatSessionContextAttachment[];
  contextPacks: SmartContextPack[];
  matchedContextPackIds: string[];
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
  onWorkspaceSelection: (workspace: string) => void;
  onSessionModelSelection: (provider: RuntimeProvider, model: string) => void;
  onSessionModeSelection: (mode: RunMode | null) => void;
  onSessionReasoningSelection: (reasoning: ReasoningMode | null) => void;
  onSessionMemoryEnabledChange: (enabled: boolean) => void;
  onUseGlobalMemoryChange: (enabled: boolean) => void;
  onUiControlEnabledChange: (enabled: boolean) => void;
  onSelectContextFiles: () => Promise<void>;
  onSelectContextFolders: () => Promise<void>;
  onSelectContextImages: () => Promise<void>;
  onPasteContextImages: (files: File[]) => Promise<void>;
  onRemoveContextAttachment: (attachmentId: string) => void;
  onClearContextAttachments: () => void;
  onSaveContextPack: (input: SaveSmartContextPackInput) => void;
  onApplyContextPack: (
    packId: string,
    variableValues?: Record<string, string>,
  ) => void | Promise<void>;
  onDeleteContextPack: (packId: string) => void;
  onExportContextPacks: () => void;
  onImportContextPacks: (file: File) => void;
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
  defaultReasoning,
  activeReasoning,
  isUsingWorkspaceDefaultMode,
  isUsingWorkspaceDefaultReasoning,
  hasActiveWorkspace,
  recentWorkspaces,
  composerWorkspaceLabel,
  sessionMemoryDescription,
  globalMemoryDescription,
  uiControlDescription,
  isGlobalMemoryAvailable,
  isGlobalMemoryActive,
  isUiControlAvailable,
  contextAttachments,
  contextPacks,
  matchedContextPackIds,
  imageInputSupported,
  imageInputDisabledReason,
  speechInput,
  canSendMessage,
  sendDisabledReason,
  onSelectFolder,
  onWorkspaceSelection,
  onSessionModelSelection,
  onSessionModeSelection,
  onSessionReasoningSelection,
  onSessionMemoryEnabledChange,
  onUseGlobalMemoryChange,
  onUiControlEnabledChange,
  onSelectContextFiles,
  onSelectContextFolders,
  onSelectContextImages,
  onPasteContextImages,
  onRemoveContextAttachment,
  onClearContextAttachments,
  onSaveContextPack,
  onApplyContextPack,
  onDeleteContextPack,
  onExportContextPacks,
  onImportContextPacks,
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

      <SessionReasoningPicker
        provider={activeSession.provider}
        model={activeSession.model}
        activeReasoning={activeReasoning}
        defaultReasoning={defaultReasoning}
        isUsingWorkspaceDefaultReasoning={isUsingWorkspaceDefaultReasoning}
        onSessionReasoningSelection={onSessionReasoningSelection}
      />

      <WorkspacePicker
        currentWorkspace={activeSession.workspace}
        workspaceLabel={composerWorkspaceLabel}
        recentWorkspaces={recentWorkspaces}
        hasActiveWorkspace={hasActiveWorkspace}
        onSelectWorkspace={onWorkspaceSelection}
        onChooseNewWorkspace={onSelectFolder}
      />

      <SmartContextPackPicker
        contextPacks={contextPacks}
        workspaceRoot={activeSession.workspace}
        activeDraft={activeSession.draft}
        activeProvider={activeSession.provider}
        activeModel={activeSession.model}
        activeRunMode={activeRunMode}
        activeReasoning={activeReasoning}
        contextAttachments={contextAttachments}
        matchedContextPackIds={matchedContextPackIds}
        imageInputSupported={imageInputSupported}
        workspaceLabel={composerWorkspaceLabel}
        onSaveContextPack={onSaveContextPack}
        onApplyContextPack={onApplyContextPack}
        onDeleteContextPack={onDeleteContextPack}
        onExportContextPacks={onExportContextPacks}
        onImportContextPacks={onImportContextPacks}
      />
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
      onPasteContextImages={onPasteContextImages}
      onRemoveContextAttachment={onRemoveContextAttachment}
      onClearContextAttachments={onClearContextAttachments}
      onDraftChange={onDraftChange}
      onAdditionalTextareaKeyDown={onComposerHistoryNavigation}
      onSend={onSend}
      onCancel={onCancel}
    />
  );
};
