import {
  Brain,
  BrainCircuit,
  LoaderCircle,
  MessageSquare,
  Mic,
  Monitor,
  Square,
} from "lucide-react";
import { SessionMemoryDialog } from "@machdoch/product-ui";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import type {
  ReasoningMode,
  RunMode,
} from "../../../../core/runtime-contract.generated.js";
import { AppNotification } from "../../components/ui/notification";
import {
  createMemoryManagementEntries,
  type MemorySourceSession,
} from "../../components/memory-management-entries";
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
import { SessionModePicker } from "./session-mode-picker";
import { SessionPromptEnhancementPicker } from "./session-prompt-enhancement-picker";
import { SessionReasoningPicker } from "./session-reasoning-picker";
import { SmartContextPackPicker } from "./smart-context-packs";
import { WorkspacePicker } from "./workspace-picker";

export interface SessionComposerProps {
  activeSession: ChatSessionRecord;
  editingMessageId?: string | null;
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
  statusMessage?: {
    text: string;
    tone: "success" | "error" | "info" | null;
  } | null;
  onStatusMessageDismiss?: () => void;
  contextAttachments: ChatSessionContextAttachment[];
  memorySourceSessions: readonly MemorySourceSession[];
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
    onStatusDismiss: () => void;
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
  onForgetSessionMemory: (memoryId: string) => Promise<unknown> | unknown;
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
  onRunningTaskMessageActionChange: (action: RunningTaskMessageAction) => void;
  onQueuedMessageChange: (messageId: string, content: string) => void;
  onQueuedMessageMove: (messageId: string, direction: -1 | 1) => void;
  onQueuedMessageReorder: (messageId: string, targetIndex: number) => void;
  onQueuedMessageRemove: (messageId: string) => void;
  onQueuedMessageRetry: (messageId: string) => void;
  onQueuedMessageSend: (messageId: string) => void;
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
  isPromptEnhancementActive?: boolean;
}

export const SessionComposer = ({
  activeSession,
  editingMessageId = null,
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
  statusMessage,
  onStatusMessageDismiss,
  contextAttachments,
  memorySourceSessions,
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
  onForgetSessionMemory,
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
  onQueuedMessageRetry,
  onQueuedMessageSend,
  onQueuedMessageSelectContextAttachments,
  onQueuedMessageRemoveContextAttachment,
  onQueuedMessageClearContextAttachments,
  onSend,
  onCancel,
  isExecuting,
  isPromptEnhancementActive = false,
}: SessionComposerProps): JSX.Element => {
  const [sessionMemoryOpen, setSessionMemoryOpen] = useState(false);
  const openSessionMemory = useCallback(() => setSessionMemoryOpen(true), []);
  const closeSessionMemory = useCallback(() => setSessionMemoryOpen(false), []);

  useEffect(() => {
    setSessionMemoryOpen(false);
  }, [activeSession.id]);

  const showSessionMemoryButton = !isQuickVoiceSession(activeSession);
  const sessionMemoryEntries = useMemo(
    () =>
      createMemoryManagementEntries(
        activeSession.sessionMemory,
        memorySourceSessions,
      ),
    [activeSession.sessionMemory, memorySourceSessions],
  );
  const notification =
    statusMessage ??
    (speechInput.statusText
      ? {
          text: speechInput.statusText,
          tone: speechInput.statusTone,
        }
      : null);
  const notificationTone = notification?.tone ?? "info";
  const onNotificationDismiss = statusMessage
    ? onStatusMessageDismiss
    : speechInput.onStatusDismiss;
  const speechInputActionLabel = !speechInput.browserSupported
    ? "Speech input unavailable"
    : speechInput.transcribing
      ? "Transcribing speech"
      : speechInput.recording
        ? "Stop recording"
        : speechInput.enabled
          ? "Speak to text"
          : "Configure speak to text";
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
        webSearchUnavailableReason={promptEnhancementWebSearchUnavailableReason}
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
        activePromptEnhancementMode={promptEnhancementMode}
        activeInterviewEnabled={interviewEnabled}
        activeSessionMemoryEnabled={activeSession.sessionMemoryEnabled}
        activeUseGlobalMemory={activeSession.useGlobalMemory}
        activeUiControlEnabled={activeSession.uiControlEnabled}
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
  const toggles = useMemo<AgentComposerToggle[]>(() => {
    const next: AgentComposerToggle[] = [];
    if (showSessionMemoryButton) {
      next.push({
        id: "session-memory",
        label: "Session memory",
        description: sessionMemoryDescription,
        icon: <Brain className="h-4 w-4" />,
        pressed: activeSession.sessionMemoryEnabled,
        onPressedChange: onSessionMemoryEnabledChange,
        onManage: openSessionMemory,
        manageLabel: "Manage session memory",
        activeClassName:
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/15 hover:text-white",
      });
    }
    next.push(
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
    return next;
  }, [
    activeSession.sessionMemoryEnabled,
    activeSession.uiControlEnabled,
    globalMemoryDescription,
    interviewDescription,
    interviewDisabled,
    interviewEnabled,
    isGlobalMemoryActive,
    isGlobalMemoryAvailable,
    isUiControlAvailable,
    onInterviewEnabledChange,
    openSessionMemory,
    onSessionMemoryEnabledChange,
    onUiControlEnabledChange,
    onUseGlobalMemoryChange,
    sessionMemoryDescription,
    showSessionMemoryButton,
    uiControlDescription,
  ]);

  const actions = useMemo<AgentComposerAction[]>(() => {
    const icon = speechInput.transcribing ? (
      <LoaderCircle className="h-4 w-4 animate-spin" />
    ) : speechInput.recording ? (
      <Square className="h-4 w-4 fill-current" />
    ) : (
      <Mic className="h-4 w-4" />
    );
    return [
      {
        id: "speech-input",
        label: speechInputActionLabel,
        title: speechInputActionLabel,
        icon,
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
  }, [
    speechInput.browserSupported,
    speechInput.enabled,
    speechInput.onAction,
    speechInput.recording,
    speechInput.transcribing,
    speechInputActionLabel,
  ]);

  return (
    <div className="relative grid gap-3">
      {notification ? (
        <div className="pointer-events-none absolute bottom-[calc(100%+0.75rem)] right-0 z-30 flex w-full justify-end">
          <AppNotification
            tone={notificationTone}
            title={
              statusMessage && notificationTone === "error"
                ? "Request not sent"
                : undefined
            }
            presentation="floating"
            dismissAfterMs={null}
            onDismiss={onNotificationDismiss}
            className="app-session-notification pointer-events-auto max-w-md animate-in fade-in-0 slide-in-from-bottom-2"
          >
            {notification.text}
          </AppNotification>
        </div>
      ) : null}

      <AgentComposer
        variant="session"
        draftIdentity={
          editingMessageId
            ? `${activeSession.id}:message-edit:${editingMessageId}`
            : activeSession.id
        }
        draft={activeSession.draft}
        draftRevision={activeSession.draftUpdatedAt}
        textareaLabel={editingMessageId ? "Edit message" : "Task composer"}
        placeholder={
          editingMessageId
            ? "Update the message and its options"
            : "What should machdoch do next?"
        }
        chooserProviders={chooserProviders}
        activeProvider={activeSession.provider}
        activeModel={activeSession.model}
        contextAttachments={contextAttachments}
        imageInputSupported={imageInputSupported}
        imageInputDisabledReason={imageInputDisabledReason}
        canSend={canSendMessage}
        sendDisabledReason={sendDisabledReason}
        isExecuting={editingMessageId ? false : isExecuting}
        autoFocus={Boolean(editingMessageId)}
        submissionLabel={
          editingMessageId
            ? "Save and submit"
            : isPromptEnhancementActive
              ? "Queue message"
              : undefined
        }
        showCancelAlongsideSend={Boolean(editingMessageId)}
        toolbarControls={toolbarControls}
        toggles={toggles}
        actions={actions}
        runningTaskMessageAction={runningTaskMessageAction}
        queuedMessages={editingMessageId ? [] : queuedMessages}
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
        onQueuedMessageRetry={onQueuedMessageRetry}
        onQueuedMessageSend={onQueuedMessageSend}
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
      <SessionMemoryDialog
        open={sessionMemoryOpen}
        enabled={activeSession.sessionMemoryEnabled}
        entries={sessionMemoryEntries}
        emptyLabel="No session memory saved."
        onEnabledChange={onSessionMemoryEnabledChange}
        onForget={onForgetSessionMemory}
        onClose={closeSessionMemory}
      />
    </div>
  );
};
