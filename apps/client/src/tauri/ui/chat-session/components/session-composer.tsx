import {
  Languages,
  LoaderCircle,
  Mic,
  Square,
  WandSparkles,
} from "lucide-react";
import {
  GlobalMemoryIcon,
  InterviewIcon,
  SessionMemoryIcon,
  UiControlIcon,
  WorkspaceMemoryIcon,
  GoalControl,
  GoalTrigger,
  MemoryDialog,
  useGoalDraft,
} from "@machdoch/product-ui";
import {
  getAvailableGoalModes,
  isGoalCommand,
  resolveGoalMode,
  type GoalMode,
} from "../../../../shared/goals.js";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import type {
  ReasoningMode,
  RunMode,
  SpeechToTextProvider,
} from "../../../../core/runtime-contract.generated.js";
import { isLocalSpeechProvider } from "../../../../shared/local-speech.js";
import type {
  ConversationMemoryEntry,
  ParallelAgentMode,
} from "../../../../core/types.js";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import type { CommandDefinition } from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import {
  getAvailableParallelAgentModes,
  resolveParallelAgentMode,
} from "../../../../core/parallel-agent-capabilities.js";
import { AppNotification } from "@machdoch/media-studio/tauri/ui/components/ui/notification.js";
import {
  createMemoryManagementEntries,
  type MemorySourceSession,
} from "../../components/memory-management-entries";
import { isQuickVoiceSession, type ChatSessionRecord } from "../../chat-session.model";
import { type SmartContextPack } from "@machdoch/client-ui/context-packs/model";
import type { AttachmentSelectionKind, ChatSessionContextAttachment, RequestIterationMode } from "@machdoch/client-ui/composer/model";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { RunningTaskMessageAction } from "../../lib/shell-store";
import type { RuntimeProvider } from "../../model-catalog";
import { type PromptEnhancementMode } from "@machdoch/client-ui/composer/prompt-enhancement-options";
import { type SaveSmartContextPackInput, type SmartContextPackScope, type SmartContextPackScopeFilter } from "@machdoch/client-ui/context-packs/model";
import type { RUN_MODE_META } from "../_helpers/session-shell";
import {
  AgentComposer,
  type AgentComposerAction,
  type AgentComposerQueuedMessage,
  type AgentComposerToggle,
} from "@machdoch/client-ui/composer/agent-composer";
import { SessionModelPicker } from "./session-model-picker";
import { SessionModePicker } from "./session-mode-picker";
import { SessionParallelAgentPicker } from "./session-parallel-agent-picker";
import { SessionAdaptiveControllerPicker } from "@machdoch/client-ui/composer/adaptive-controller-picker";
import { SessionPromptEnhancementPicker } from "@machdoch/client-ui/composer/prompt-enhancement-picker";
import { SessionReasoningPicker } from "./session-reasoning-picker";
import { SmartContextPackPicker } from "@machdoch/client-ui/context-packs/picker";
import { loadRalphContextPackUsage } from "@machdoch/client-ui/context-packs/ralph-usage";
import { listRalphFlows, showRalphFlow } from "../../runtime";

const loadContextPackUsage = (workspaceRoot: string) => loadRalphContextPackUsage(workspaceRoot, listRalphFlows, showRalphFlow);
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
  defaultAdaptiveControllerEnabled?: boolean | null;
  hasActiveWorkspace: boolean;
  workspaceLocked: boolean;
  workspaceSwitchBlocked?: boolean;
  recentWorkspaces: string[];
  composerWorkspaceLabel: string;
  sessionMemoryDescription: string;
  workspaceMemoryDescription?: string;
  globalMemoryDescription: string;
  uiControlDescription: string;
  interviewDescription: string;
  isGlobalMemoryAvailable: boolean;
  isGlobalMemoryActive: boolean;
  isWorkspaceMemoryAvailable?: boolean;
  isWorkspaceMemoryActive?: boolean;
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
  workspaceMemoryEntries: readonly ConversationMemoryEntry[];
  globalMemoryEntries: readonly ConversationMemoryEntry[];
  contextPacks: SmartContextPack[];
  matchedContextPackIds: string[];
  imageInputSupported: boolean;
  imageInputDisabledReason: string | null;
  speechInput: {
    provider: SpeechToTextProvider;
    browserSupported: boolean;
    enabled: boolean;
    recording: boolean;
    transcribing: boolean;
    statusText: string | null;
    statusTone: "success" | "error" | "info" | null;
    autoTranslateToEnglish: boolean;
    autoFormat: boolean;
    onAction: () => void;
    onProcessingChange: (options: {
      autoTranslateToEnglish: boolean;
      autoFormat: boolean;
    }) => Promise<void>;
    onStatusDismiss: () => void;
  };
  canSendMessage: boolean;
  sendDisabledReason: string | null;
  runningTaskMessageAction: RunningTaskMessageAction;
  queuedMessages: AgentComposerQueuedMessage[];
  onSelectFolder: (overrideLock?: boolean) => Promise<void>;
  onWorkspaceSelection: (
    workspace: string | null,
    overrideLock?: boolean,
  ) => void;
  onWorkspaceRemoval: (workspace: string) => void;
  onSessionModelSelection: (provider: RuntimeProvider, model: string) => void;
  onSessionModeSelection: (mode: RunMode | null) => void;
  onParallelAgentModeSelection?: (mode: ParallelAgentMode) => void;
  onGoalModeSelection?: (mode: GoalMode) => void;
  onAdaptiveControllerOverrideChange?: (override: boolean | null) => void;
  onSessionReasoningSelection: (reasoning: ReasoningMode | null) => void;
  onSessionMemoryEnabledChange: (enabled: boolean) => void;
  onForgetSessionMemory: (memoryId: string) => Promise<unknown> | unknown;
  onUseWorkspaceMemoryChange?: (enabled: boolean) => void;
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
  onQueuedMessageSelectContextAttachments: (
    messageId: string,
    selectionKind: AttachmentSelectionKind,
  ) => Promise<void>;
  onQueuedMessagePasteContextImages?: (
    messageId: string,
    files: File[],
  ) => Promise<void>;
  onQueuedMessageRemoveContextAttachment: (
    messageId: string,
    attachmentId: string,
  ) => void;
  onQueuedMessageClearContextAttachments: (messageId: string) => void;
  onSend: (
    draft: string,
    iterationCount?: number,
    iterationMode?: RequestIterationMode,
    goalObjective?: string,
  ) => void;
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
  defaultAdaptiveControllerEnabled = null,
  hasActiveWorkspace,
  workspaceLocked,
  workspaceSwitchBlocked = false,
  recentWorkspaces,
  composerWorkspaceLabel,
  sessionMemoryDescription,
  workspaceMemoryDescription = "",
  globalMemoryDescription,
  uiControlDescription,
  interviewDescription,
  isGlobalMemoryAvailable,
  isGlobalMemoryActive,
  isWorkspaceMemoryAvailable = false,
  isWorkspaceMemoryActive = false,
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
  workspaceMemoryEntries,
  globalMemoryEntries,
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
  onParallelAgentModeSelection = () => undefined,
  onGoalModeSelection = () => undefined,
  onAdaptiveControllerOverrideChange = () => undefined,
  onSessionReasoningSelection,
  onSessionMemoryEnabledChange,
  onForgetSessionMemory,
  onUseWorkspaceMemoryChange = () => undefined,
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
  onQueuedMessageSelectContextAttachments,
  onQueuedMessagePasteContextImages,
  onQueuedMessageRemoveContextAttachment,
  onQueuedMessageClearContextAttachments,
  onSend,
  onCancel,
  isExecuting,
  isPromptEnhancementActive = false,
}: SessionComposerProps): JSX.Element => {
  const goalId = useId();
  const [goalOpen, setGoalOpen] = useState(false);
  const showGoalControl =
    !isQuickVoiceSession(activeSession) &&
    activeSession.specialSession !== "pose";
  const goalDraft = useGoalDraft(
    activeSession.id,
    activeSession.goal,
    showGoalControl && goalOpen && !editingMessageId,
    isExecuting,
  );

  useEffect(() => {
    setGoalOpen(false);
  }, [activeSession.id]);

  const [memoryScope, setMemoryScope] = useState<
    "session" | "workspace" | "global" | null
  >(null);
  const openSessionMemory = useCallback(() => setMemoryScope("session"), []);
  const openWorkspaceMemory = useCallback(
    () => setMemoryScope("workspace"),
    [],
  );
  const openGlobalMemory = useCallback(() => setMemoryScope("global"), []);
  const closeMemory = useCallback(() => setMemoryScope(null), []);

  useEffect(() => {
    setMemoryScope(null);
  }, [activeSession.id, activeSession.workspace]);

  const showSessionMemoryButton = !isQuickVoiceSession(activeSession);
  const sessionMemoryEntries = useMemo(
    () =>
      createMemoryManagementEntries(
        activeSession.sessionMemory,
        memorySourceSessions,
      ),
    [activeSession.sessionMemory, memorySourceSessions],
  );
  const memoryCommands = useMemo<readonly CommandDefinition[]>(
    () =>
      showSessionMemoryButton
        ? [
            {
              id: "chat.session.memory.forget",
              title: "Forget session memory",
              group: "Chat",
              scope: { kind: "view", ownerId: "chat" },
              palette: "visible",
              availability: () =>
                sessionMemoryEntries.length > 0
                  ? { state: "enabled" }
                  : { state: "disabled", reason: "No session memory saved" },
              children: () => ({
                id: "chat-session-memory-forget",
                title: "Forget session memory",
                searchPlaceholder: "Choose memory",
                groups: [
                  {
                    id: "memories",
                    items: sessionMemoryEntries.map((entry) => ({
                      id: entry.id,
                      title: entry.content,
                      keywords: entry.sourceLabel
                        ? [entry.sourceLabel]
                        : undefined,
                      execute: async () => {
                        await onForgetSessionMemory(entry.id);
                      },
                    })),
                  },
                ],
              }),
            },
          ]
        : [],
    [onForgetSessionMemory, sessionMemoryEntries, showSessionMemoryButton],
  );
  useOptionalRegisterCommands(memoryCommands);
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
      <WorkspacePicker
        currentWorkspace={activeSession.workspace}
        workspaceLabel={composerWorkspaceLabel}
        recentWorkspaces={recentWorkspaces}
        hasActiveWorkspace={hasActiveWorkspace}
        highlightSelection={false}
        workspaceLocked={workspaceLocked}
        workspaceSwitchBlocked={workspaceSwitchBlocked}
        buttonClassName="app-composer-toolbar-pill app-composer-toolbar-control h-8 max-w-40 rounded-full px-3 text-xs font-medium shadow-none"
        onSelectWorkspace={onWorkspaceSelection}
        onRemoveWorkspace={onWorkspaceRemoval}
        onChooseNewWorkspace={onSelectFolder}
      />

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

      <SessionAdaptiveControllerPicker
        override={activeSession.adaptiveControllerOverride ?? null}
        defaultEnabled={defaultAdaptiveControllerEnabled}
        onChange={onAdaptiveControllerOverrideChange}
      />

      <SessionParallelAgentPicker
        mode={resolveParallelAgentMode(
          activeSession.provider,
          activeSession.model,
          activeSession.parallelAgentMode,
        )}
        availableModes={getAvailableParallelAgentModes(
          activeSession.provider,
          activeSession.model,
        )}
        onChange={onParallelAgentModeSelection}
      />

      {showGoalControl ? (
        <GoalTrigger
          open={goalOpen}
          active={isExecuting && activeSession.goal?.status === "active"}
          controls={goalId}
          disabled={Boolean(editingMessageId)}
          onClick={() => setGoalOpen((open) => !open)}
        />
      ) : null}

      <SessionPromptEnhancementPicker
        mode={promptEnhancementMode}
        webSearchAvailable={promptEnhancementWebSearchAvailable}
        webSearchUnavailableReason={promptEnhancementWebSearchUnavailableReason}
        onModeChange={onPromptEnhancementModeChange}
      />

      <SmartContextPackPicker
        loadRalphPackUsage={loadContextPackUsage}
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
        icon: <SessionMemoryIcon className="h-4 w-4" />,
        pressed: activeSession.sessionMemoryEnabled,
        onPressedChange: onSessionMemoryEnabledChange,
        onManage: openSessionMemory,
        manageLabel: "Manage session memory",
      });
    }
    next.push(
      {
        id: "workspace-memory",
        label: "Workspace memory",
        description: workspaceMemoryDescription,
        icon: <WorkspaceMemoryIcon className="h-4 w-4" />,
        pressed: isWorkspaceMemoryActive,
        disabled: !isWorkspaceMemoryAvailable,
        onPressedChange: onUseWorkspaceMemoryChange,
        onManage: openWorkspaceMemory,
        manageLabel: "View workspace memory",
      },
      {
        id: "global-memory",
        label: "Global memory",
        description: globalMemoryDescription,
        icon: <GlobalMemoryIcon className="h-4 w-4" />,
        pressed: isGlobalMemoryActive,
        disabled: !isGlobalMemoryAvailable,
        onPressedChange: onUseGlobalMemoryChange,
        onManage: openGlobalMemory,
        manageLabel: "View global memory",
      },
      {
        id: "interview",
        label: "Interview",
        description: interviewDescription,
        icon: <InterviewIcon className="h-4 w-4" />,
        pressed: interviewEnabled,
        disabled: interviewDisabled,
        onPressedChange: onInterviewEnabledChange,
      },
      {
        id: "ui-control",
        label: "UI control",
        description: uiControlDescription,
        icon: <UiControlIcon className="h-4 w-4" />,
        pressed: activeSession.uiControlEnabled,
        disabled: !isUiControlAvailable,
        onPressedChange: onUiControlEnabledChange,
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
    isWorkspaceMemoryActive,
    isWorkspaceMemoryAvailable,
    isUiControlAvailable,
    onInterviewEnabledChange,
    openSessionMemory,
    openWorkspaceMemory,
    openGlobalMemory,
    onSessionMemoryEnabledChange,
    onUseWorkspaceMemoryChange,
    onUiControlEnabledChange,
    onUseGlobalMemoryChange,
    sessionMemoryDescription,
    showSessionMemoryButton,
    uiControlDescription,
    workspaceMemoryDescription,
  ]);

  const actions = useMemo<AgentComposerAction[]>(() => {
    const canTranslate =
      speechInput.provider !== "none" &&
      (!isLocalSpeechProvider(speechInput.provider) ||
        speechInput.provider === "whisper" ||
        speechInput.provider === "whisper-tiny");
    const canFormat =
      speechInput.provider === "openai" || speechInput.provider === "google";
    const translateEnabled = canTranslate && speechInput.autoTranslateToEnglish;
    const formatEnabled = canFormat && speechInput.autoFormat;
    const enabledProcessing = [
      translateEnabled ? "translate to English" : null,
      formatEnabled ? "format and improve text" : null,
    ].filter((option): option is string => option !== null);
    const actionLabel = enabledProcessing.length
      ? `${speechInputActionLabel} (${enabledProcessing.join(", ")})`
      : speechInputActionLabel;
    const glyph = speechInput.transcribing ? (
      <LoaderCircle className="h-4 w-4 animate-spin" />
    ) : speechInput.recording ? (
      <Square className="h-4 w-4 fill-current" />
    ) : (
      <Mic className="h-4 w-4" />
    );
    const icon = (
      <>
        {glyph}
        {translateEnabled ? (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-sky-400 text-slate-950"
          >
            <Languages className="size-3" />
          </span>
        ) : null}
        {formatEnabled ? (
          <span
            aria-hidden="true"
            className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full bg-amber-400 text-slate-950"
          >
            <WandSparkles className="size-3" />
          </span>
        ) : null}
      </>
    );
    return [
      {
        id: "speech-input",
        label: actionLabel,
        title: actionLabel,
        icon,
        disabled: !speechInput.browserSupported || speechInput.transcribing,
        onClick: speechInput.onAction,
        contextActions: [
          ...(canTranslate
            ? [
                {
                  label: "Translate to English",
                  checked: speechInput.autoTranslateToEnglish,
                  onSelect: () =>
                    speechInput.onProcessingChange({
                      autoTranslateToEnglish:
                        !speechInput.autoTranslateToEnglish,
                      autoFormat: speechInput.autoFormat,
                    }),
                },
              ]
            : []),
          ...(canFormat
            ? [
                {
                  label: "Format and improve text",
                  checked: speechInput.autoFormat,
                  onSelect: () =>
                    speechInput.onProcessingChange({
                      autoTranslateToEnglish:
                        speechInput.autoTranslateToEnglish,
                      autoFormat: !speechInput.autoFormat,
                    }),
                },
              ]
            : []),
        ],
        className: cn(
          "relative",
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
    speechInput.autoFormat,
    speechInput.autoTranslateToEnglish,
    speechInput.browserSupported,
    speechInput.enabled,
    speechInput.onAction,
    speechInput.onProcessingChange,
    speechInput.provider,
    speechInput.recording,
    speechInput.transcribing,
    speechInputActionLabel,
  ]);

  return (
    <div className="relative grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
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
        modelPicker={<SessionModelPicker chooserProviders={chooserProviders} activeProvider={activeSession.provider} activeModel={activeSession.model} onSessionModelSelection={onSessionModelSelection} />}
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
        inputHeader={
          showGoalControl ? (
            <GoalControl
              key={activeSession.id}
              id={goalId}
              open={goalOpen}
              mode={resolveGoalMode(
                activeSession.provider,
                activeSession.goalMode,
              )}
              modes={getAvailableGoalModes(activeSession.provider)}
              goal={activeSession.goal}
              objective={goalDraft.objective}
              error={goalDraft.error}
              onObjectiveChange={goalDraft.setObjective}
              running={isExecuting}
              disabled={Boolean(editingMessageId)}
              onClose={() => setGoalOpen(false)}
              onModeChange={onGoalModeSelection}
              onCommand={(command) => onSend(command)}
              onPause={onCancel}
            />
          ) : null
        }
        toggles={toggles}
        actions={actions}
        runningTaskMessageAction={runningTaskMessageAction}
        queuedMessages={editingMessageId ? [] : queuedMessages}
        iterationsEnabled={
          !editingMessageId &&
          !interviewEnabled &&
          !goalDraft.submissionObjective
        }
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
        onQueuedMessageSelectContextAttachments={
          onQueuedMessageSelectContextAttachments
        }
        onQueuedMessagePasteContextImages={onQueuedMessagePasteContextImages}
        onQueuedMessageRemoveContextAttachment={
          onQueuedMessageRemoveContextAttachment
        }
        onQueuedMessageClearContextAttachments={
          onQueuedMessageClearContextAttachments
        }
        onSend={(draft, iterationCount, iterationMode) => {
          if (goalDraft.submissionObjective && !isGoalCommand(draft)) {
            onSend(
              draft,
              iterationCount,
              iterationMode,
              goalDraft.submissionObjective,
            );
          } else {
            onSend(draft, iterationCount, iterationMode);
          }
        }}
        onCancel={onCancel}
      />
      {memoryScope ? (
        <MemoryDialog
          title={
            memoryScope === "session"
              ? "Session memory"
              : memoryScope === "workspace"
                ? "Workspace memory"
                : "Global memory"
          }
          open
          enabled={
            memoryScope === "session"
              ? activeSession.sessionMemoryEnabled
              : memoryScope === "workspace"
                ? isWorkspaceMemoryActive
                : isGlobalMemoryActive
          }
          entries={
            memoryScope === "session"
              ? sessionMemoryEntries
              : createMemoryManagementEntries(
                  memoryScope === "workspace"
                    ? workspaceMemoryEntries
                    : globalMemoryEntries,
                  memorySourceSessions,
                )
          }
          emptyLabel={`No ${memoryScope} memory saved.`}
          disabled={
            memoryScope === "workspace"
              ? !isWorkspaceMemoryAvailable
              : memoryScope === "global" && !isGlobalMemoryAvailable
          }
          onEnabledChange={
            memoryScope === "session"
              ? onSessionMemoryEnabledChange
              : memoryScope === "workspace"
                ? onUseWorkspaceMemoryChange
                : onUseGlobalMemoryChange
          }
          {...(memoryScope === "session"
            ? { onForget: onForgetSessionMemory }
            : {})}
          onClose={closeMemory}
        />
      ) : null}
    </div>
  );
};
