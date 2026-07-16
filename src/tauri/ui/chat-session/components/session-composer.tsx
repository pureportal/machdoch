import {
  Brain,
  BrainCircuit,
  CircleAlert,
  CircleCheck,
  Info,
  LoaderCircle,
  MessageSquare,
  Mic,
  Monitor,
  Square,
  X,
} from "lucide-react";
import type { JSX, KeyboardEvent } from "react";
import type {
  ReasoningMode,
  RunMode,
} from "../../../../core/runtime-contract.generated.js";
import {
  isQuickVoiceSession,
  type ChatSessionContextAttachment,
  type ChatSessionRecord,
  type SmartContextPack,
} from "../../chat-session.model";
import { cn } from "../../lib/utils";
import type { RunningTaskMessageAction } from "../../lib/shell-store";
import type { RuntimeProvider } from "../../model-catalog";
import type { PromptEnhancementMode } from "../_helpers/prompt-enhancement";
import type { AttachmentSelectionKind } from "../_helpers/session-context-attachments";
import type {
  SaveSmartContextPackInput,
  SmartContextPackScope,
  SmartContextPackScopeFilter,
} from "../_helpers/smart-context-packs";
import type { RUN_MODE_META } from "../_helpers/session-shell";
import {
  AgentComposer,
  type AgentComposerAction,
  type AgentComposerQueuedMessage,
  type AgentComposerToggle,
} from "./agent-composer";
import { PromptEnhancementPending } from "./prompt-enhancement-pending";
import { SessionModePicker } from "./session-mode-picker";
import { SessionPromptEnhancementPicker } from "./session-prompt-enhancement-picker";
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
  workspaceLocked: boolean;
  recentWorkspaces: string[];
  composerWorkspaceLabel: string;
  sessionMemoryDescription: string;
  globalMemoryDescription: string;
  uiControlDescription: string;
  interviewDescription: string;
  isGlobalMemoryAvailable: boolean;
  isGlobalMemoryActive: boolean;
  isUiControlAvailable: boolean;
  interviewEnabled: boolean;
  interviewDisabled: boolean;
  promptEnhancementMode: PromptEnhancementMode;
  promptEnhancementWebSearchAvailable: boolean;
  promptEnhancementWebSearchUnavailableReason: string;
  promptEnhancementPending?: {
    modeLabel: string;
  } | null;
  statusMessage?: {
    text: string;
    tone: "success" | "error" | "info" | null;
  } | null;
  onStatusMessageDismiss?: () => void;
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
  runningTaskMessageAction: RunningTaskMessageAction;
  queuedMessages: AgentComposerQueuedMessage[];
  onSelectFolder: () => Promise<void>;
  onWorkspaceSelection: (workspace: string | null) => void;
  onWorkspaceRemoval: (workspace: string) => void;
  onSessionModelSelection: (provider: RuntimeProvider, model: string) => void;
  onSessionModeSelection: (mode: RunMode | null) => void;
  onSessionReasoningSelection: (reasoning: ReasoningMode | null) => void;
  onSessionMemoryEnabledChange: (enabled: boolean) => void;
  onUseGlobalMemoryChange: (enabled: boolean) => void;
  onUiControlEnabledChange: (enabled: boolean) => void;
  onInterviewEnabledChange: (enabled: boolean) => void;
  onPromptEnhancementModeChange: (mode: PromptEnhancementMode) => void;
  onSelectContextFiles: () => Promise<void>;
  onSelectContextFolders: () => Promise<void>;
  onSelectContextImages: () => Promise<void>;
  onBrowseMediaAssets?: () => void;
  onCreateMediaAsset?: (prompt: string) => void;
  onPasteContextImages: (files: File[]) => Promise<void>;
  onOpenContextAttachment: (attachment: ChatSessionContextAttachment) => void;
  onRemoveContextAttachment: (attachmentId: string) => void;
  onClearContextAttachments: () => void;
  onSaveContextPack: (input: SaveSmartContextPackInput) => void;
  onApplyContextPack: (
    packId: string,
    variableValues?: Record<string, string>,
  ) => void | Promise<void>;
  onDeleteContextPack: (packId: string) => void;
  onExportContextPacks: (scopeFilter: SmartContextPackScopeFilter) => void;
  onImportContextPacks: (file: File, scope: SmartContextPackScope) => void;
  onDraftChange: (value: string) => void;
  onComposerHistoryNavigation: (
    event: KeyboardEvent<HTMLTextAreaElement>,
    currentDraft: string,
  ) => void;
  onRunningTaskMessageActionChange: (
    action: RunningTaskMessageAction,
  ) => void;
  onQueuedMessageChange: (messageId: string, content: string) => void;
  onQueuedMessageMove: (messageId: string, direction: -1 | 1) => void;
  onQueuedMessageReorder: (messageId: string, targetIndex: number) => void;
  onQueuedMessageRemove: (messageId: string) => void;
  onQueuedMessageSelectContextAttachments: (
    messageId: string,
    selectionKind: AttachmentSelectionKind,
  ) => Promise<void>;
  onQueuedMessageRemoveContextAttachment: (
    messageId: string,
    attachmentId: string,
  ) => void;
  onQueuedMessageClearContextAttachments: (messageId: string) => void;
  onSend: (draft: string) => void;
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
  workspaceLocked,
  recentWorkspaces,
  composerWorkspaceLabel,
  sessionMemoryDescription,
  globalMemoryDescription,
  uiControlDescription,
  interviewDescription,
  isGlobalMemoryAvailable,
  isGlobalMemoryActive,
  isUiControlAvailable,
  interviewEnabled,
  interviewDisabled,
  promptEnhancementMode,
  promptEnhancementWebSearchAvailable,
  promptEnhancementWebSearchUnavailableReason,
  promptEnhancementPending = null,
  statusMessage,
  onStatusMessageDismiss,
  contextAttachments,
  contextPacks,
  matchedContextPackIds,
  imageInputSupported,
  imageInputDisabledReason,
  speechInput,
  canSendMessage,
  sendDisabledReason,
  runningTaskMessageAction,
  queuedMessages,
  onSelectFolder,
  onWorkspaceSelection,
  onWorkspaceRemoval,
  onSessionModelSelection,
  onSessionModeSelection,
  onSessionReasoningSelection,
  onSessionMemoryEnabledChange,
  onUseGlobalMemoryChange,
  onUiControlEnabledChange,
  onInterviewEnabledChange,
  onPromptEnhancementModeChange,
  onSelectContextFiles,
  onSelectContextFolders,
  onSelectContextImages,
  onBrowseMediaAssets,
  onCreateMediaAsset,
  onPasteContextImages,
  onOpenContextAttachment,
  onRemoveContextAttachment,
  onClearContextAttachments,
  onSaveContextPack,
  onApplyContextPack,
  onDeleteContextPack,
  onExportContextPacks,
  onImportContextPacks,
  onDraftChange,
  onComposerHistoryNavigation,
  onRunningTaskMessageActionChange,
  onQueuedMessageChange,
  onQueuedMessageMove,
  onQueuedMessageReorder,
  onQueuedMessageRemove,
  onQueuedMessageSelectContextAttachments,
  onQueuedMessageRemoveContextAttachment,
  onQueuedMessageClearContextAttachments,
  onSend,
  onCancel,
  isExecuting,
}: SessionComposerProps): JSX.Element => {
  const showSessionMemoryButton = !isQuickVoiceSession(activeSession);
  const promptEnhancementBlocked = Boolean(promptEnhancementPending);
  const notification =
    statusMessage ??
    (speechInput.statusText
      ? {
          text: speechInput.statusText,
          tone: speechInput.statusTone,
        }
      : null);
  const NotificationIcon =
    notification?.tone === "error"
      ? CircleAlert
      : notification?.tone === "success"
        ? CircleCheck
        : Info;
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
      <SessionReasoningPicker
        provider={activeSession.provider}
        model={activeSession.model}
        activeReasoning={activeReasoning}
        defaultReasoning={defaultReasoning}
        isUsingWorkspaceDefaultReasoning={isUsingWorkspaceDefaultReasoning}
        onSessionReasoningSelection={onSessionReasoningSelection}
      />

      <SessionModePicker
        activeRunMode={activeRunMode}
        activeRunModeMeta={activeRunModeMeta}
        defaultRunMode={defaultRunMode}
        isUsingWorkspaceDefaultMode={isUsingWorkspaceDefaultMode}
        onSessionModeSelection={onSessionModeSelection}
      />

      <SessionPromptEnhancementPicker
        mode={promptEnhancementMode}
        webSearchAvailable={promptEnhancementWebSearchAvailable}
        webSearchUnavailableReason={
          promptEnhancementWebSearchUnavailableReason
        }
        onModeChange={onPromptEnhancementModeChange}
      />

      <WorkspacePicker
        currentWorkspace={activeSession.workspace}
        workspaceLabel={composerWorkspaceLabel}
        recentWorkspaces={recentWorkspaces}
        hasActiveWorkspace={hasActiveWorkspace}
        workspaceLocked={workspaceLocked}
        onSelectWorkspace={onWorkspaceSelection}
        onRemoveWorkspace={onWorkspaceRemoval}
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
      id: "interview",
      label: "Interview",
      description: interviewDescription,
      icon: <MessageSquare className="h-4 w-4" />,
      pressed: interviewEnabled,
      disabled: interviewDisabled,
      onPressedChange: onInterviewEnabledChange,
      activeClassName:
        "border-cyan-500/30 bg-cyan-500/10 text-cyan-100 hover:bg-cyan-500/15 hover:text-white",
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
    <div className="relative grid gap-3">
      {notification ? (
        <div className="pointer-events-none absolute bottom-[calc(100%+0.75rem)] right-0 z-30 flex w-full justify-end">
          <div
            role={notification.tone === "error" ? "alert" : "status"}
            aria-atomic="true"
            className={cn(
              "app-session-notification pointer-events-auto flex w-full max-w-md animate-in items-start gap-3 rounded-xl border px-4 py-3 shadow-2xl backdrop-blur-xl fade-in-0 slide-in-from-bottom-2",
              notification.tone === "error"
                ? "border-rose-400/25 bg-rose-950/90 text-rose-100"
                : notification.tone === "success"
                  ? "border-emerald-400/25 bg-emerald-950/90 text-emerald-100"
                  : "border-slate-700/80 bg-slate-900/95 text-slate-100",
            )}
          >
            <NotificationIcon
              aria-hidden="true"
              className={cn(
                "mt-0.5 h-4 w-4 shrink-0",
                notification.tone === "error"
                  ? "text-rose-300"
                  : notification.tone === "success"
                    ? "text-emerald-300"
                    : "text-sky-300",
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold leading-5">
                {notification.tone === "error"
                  ? "Request not sent"
                  : notification.tone === "success"
                    ? "Done"
                    : "Notice"}
              </p>
              <p className="text-xs leading-5 text-current/80">
                {notification.text}
              </p>
            </div>
            {statusMessage && onStatusMessageDismiss ? (
              <button
                type="button"
                aria-label="Dismiss notification"
                className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-current/60 transition-colors hover:bg-white/10 hover:text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current/40"
                onClick={onStatusMessageDismiss}
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {promptEnhancementPending ? (
        <PromptEnhancementPending
          modeLabel={promptEnhancementPending.modeLabel}
          className="app-prompt-enhancement-blocker"
        />
      ) : null}

      <div className="relative">
        <AgentComposer
          variant="session"
          draftIdentity={activeSession.id}
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
          inputBlocked={promptEnhancementBlocked}
          toolbarControls={toolbarControls}
          toggles={toggles}
          actions={actions}
          runningTaskMessageAction={runningTaskMessageAction}
          queuedMessages={queuedMessages}
          onModelSelection={onSessionModelSelection}
          onSelectContextFiles={onSelectContextFiles}
          onSelectContextFolders={onSelectContextFolders}
          onSelectContextImages={onSelectContextImages}
          onBrowseMediaAssets={onBrowseMediaAssets}
          onCreateMediaAsset={onCreateMediaAsset}
          onPasteContextImages={onPasteContextImages}
          onOpenContextAttachment={onOpenContextAttachment}
          onRemoveContextAttachment={onRemoveContextAttachment}
          onClearContextAttachments={onClearContextAttachments}
          onDraftChange={onDraftChange}
          onAdditionalTextareaKeyDown={onComposerHistoryNavigation}
          onRunningTaskMessageActionChange={onRunningTaskMessageActionChange}
          onQueuedMessageChange={onQueuedMessageChange}
          onQueuedMessageMove={onQueuedMessageMove}
          onQueuedMessageReorder={onQueuedMessageReorder}
          onQueuedMessageRemove={onQueuedMessageRemove}
          onQueuedMessageSelectContextAttachments={
            onQueuedMessageSelectContextAttachments
          }
          onQueuedMessageRemoveContextAttachment={
            onQueuedMessageRemoveContextAttachment
          }
          onQueuedMessageClearContextAttachments={
            onQueuedMessageClearContextAttachments
          }
          onSend={onSend}
          onCancel={onCancel}
        />

        {promptEnhancementBlocked ? (
          <div
            className="absolute inset-0 z-20 cursor-wait rounded-[1.75rem] bg-slate-950/35 backdrop-blur-[1px]"
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  );
};
