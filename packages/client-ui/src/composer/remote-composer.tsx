import { SessionAdaptiveControllerPicker } from "./adaptive-controller-picker";
import { SessionPromptEnhancementPicker } from "./prompt-enhancement-picker";
import {
  AskIcon,
  ExecuteIcon,
  GlobalMemoryIcon,
  InterviewIcon,
  FullAccessIcon,
  ModelIcon,
  OffIcon,
  ParallelAgentsIcon,
  ReadOnlyIcon,
  SessionMemoryIcon,
  StopIcon,
  UiControlIcon,
  WorkspaceMemoryIcon,
} from "@machdoch/product-ui";
import { ReasoningIcons } from "@machdoch/product-ui";
import { GoalControl, GoalTrigger } from "@machdoch/product-ui";
import { useGoalDraft } from "@machdoch/product-ui";
import type { ProductShell } from "@machdoch/fleet-protocol";
import { Mic, Volume2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { AgentComposer } from "./agent-composer";
import type { RemoteComposerProps } from "@machdoch/product-ui";
import { toContextAttachment } from "./remote-attachments";
import type { RemoteAttachmentControls } from "./remote-attachments";
import { ComposerModelPicker } from "@machdoch/product-ui";
import {
  OptionMenu,
  WorkspaceMenu,
  type OptionMenuItem,
} from "@machdoch/product-ui/composer-controls";
import { MemoryDialog } from "@machdoch/product-ui";
import { useComposerDraft } from "@machdoch/product-ui/composer-controls";

type ProductComposer = NonNullable<ProductShell["composer"]>;
const WORKSPACE_DEFAULT_VALUE = "workspace-default";

const REASONING_OPTIONS: Record<
  ProductComposer["reasoningOptions"][number],
  Omit<OptionMenuItem, "value">
> = {
  default: {
    label: "Provider default",
    description: "Use the model's default reasoning effort.",
    icon: ReasoningIcons.default,
    tone: "neutral",
  },
  none: {
    label: "None",
    description: "Use the lowest available reasoning setting.",
    icon: ReasoningIcons.none,
    tone: "neutral",
  },
  minimal: {
    label: "Minimal",
    description: "Prefer minimal reasoning where supported.",
    icon: ReasoningIcons.minimal,
    tone: "teal",
  },
  low: {
    label: "Low",
    description: "Favor speed and lower token use.",
    icon: ReasoningIcons.low,
    tone: "cyan",
  },
  medium: {
    label: "Medium",
    description: "Balance quality, cost, and latency.",
    icon: ReasoningIcons.medium,
    tone: "sky",
  },
  high: {
    label: "High",
    description: "Spend more effort on complex tasks.",
    icon: ReasoningIcons.high,
    tone: "amber",
  },
  xhigh: {
    label: "XHigh",
    description: "Use extended effort for long-horizon tasks.",
    icon: ReasoningIcons.xhigh,
    tone: "fuchsia",
  },
  max: {
    label: "Max",
    description: "Use the highest mapped reasoning effort.",
    icon: ReasoningIcons.max,
    tone: "rose",
  },
  ultra: {
    label: "Ultra",
    description: "Use maximum reasoning effort.",
    icon: ReasoningIcons.ultra,
    tone: "violet",
  },
  aeon: {
    label: "Aeon",
    description: "Keep working until stopped.",
    icon: ReasoningIcons.aeon,
    tone: "violet",
  },
};

const MODE_OPTION_BY_VALUE: Record<"ask" | "machdoch", OptionMenuItem> = {
  machdoch: {
    value: "machdoch",
    label: "Machdoch",
    description: "Use all available tools and verify the work.",
    icon: ExecuteIcon,
    tone: "violet",
  },
  ask: {
    value: "ask",
    label: "Ask mode",
    description: "Use read-only tools.",
    icon: AskIcon,
    tone: "amber",
  },
};

const MODE_OPTIONS = [MODE_OPTION_BY_VALUE.machdoch, MODE_OPTION_BY_VALUE.ask];

export function RemoteComposer({
  composer,
  session,
  workspaces,
  webSearchAvailable,
  onBrowseMediaAssets,
  onCreateMediaAsset,
  voice,
  canCancel,
  drafts,
  pending,
  onCommand,
  attachments,
  renderContextPackPicker,
  onHistoryKeyDown,
}: RemoteComposerProps & {
  attachments: RemoteAttachmentControls;
  renderContextPackPicker: (draft: string) => React.ReactNode;
  onHistoryKeyDown?:
    | ((
        event: KeyboardEvent<HTMLTextAreaElement>,
        currentDraft: string,
      ) => void)
    | undefined;
}): React.ReactElement {
  const {
    draft,
    updateDraft,
    submitDraft,
    submitting,
    error,
    failedSubmission,
    restoreFailedSubmission,
    discardFailedSubmission,
  } = useComposerDraft(composer, onCommand, drafts);
  const [sessionMemoryOpen, setSessionMemoryOpen] = useState(false);
  const goalId = useId();
  const [goalOpen, setGoalOpen] = useState(false);
  const goalDraft = useGoalDraft(
    composer.sessionId,
    composer.goal,
    goalOpen && session.specialKind !== "pose",
    composer.isExecuting,
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const closeSessionMemory = useCallback(() => setSessionMemoryOpen(false), []);
  useEffect(() => {
    setSessionMemoryOpen(false);
  }, [composer.sessionId]);

  useEffect(() => {
    setGoalOpen(false);
  }, [composer.sessionId]);

  const canSubmit =
    composer.canSend && !pending && !submitting && failedSubmission === null;
  const parallelAgentMode = composer.availableParallelAgentModes?.includes(
    composer.parallelAgentMode ?? "disabled",
  )
    ? (composer.parallelAgentMode ?? "disabled")
    : "disabled";

  const defaultReasoning = REASONING_OPTIONS[composer.defaultReasoning];
  const reasoningOptions = [
    {
      value: WORKSPACE_DEFAULT_VALUE,
      label: "Workspace default",
      description: `Currently ${defaultReasoning.label}.`,
      icon: defaultReasoning.icon,
      tone: defaultReasoning.tone,
    },
    ...composer.reasoningOptions.map((value) => ({
      value,
      ...REASONING_OPTIONS[value],
    })),
  ];
  const reasoning = REASONING_OPTIONS[composer.reasoning];
  const mode = MODE_OPTION_BY_VALUE[composer.mode];

  return (
    <div className="m-product-composer-wrap">
      {failedSubmission !== null ? (
        <div className="m-product-unsent-message" role="alert">
          <details>
            <summary>Message not sent</summary>
            <pre tabIndex={0}>{failedSubmission}</pre>
          </details>
          <div className="m-product-card-actions">
            <button
              type="button"
              onClick={() => {
                restoreFailedSubmission();
                textareaRef.current?.focus();
              }}
            >
              Add to draft
            </button>
            <button
              type="button"
              onClick={() => {
                discardFailedSubmission();
                textareaRef.current?.focus();
              }}
            >
              Discard
            </button>
          </div>
        </div>
      ) : null}
      <AgentComposer
        variant="session"
        draftIdentity={composer.sessionId}
        draft={draft}
        draftRevision={drafts.getRevision()}
        textareaLabel="Task composer"
        placeholder={
          session.runningTaskId ? "Queue a follow-up" : "Message Machdoch"
        }
        onBrowseMediaAssets={onBrowseMediaAssets}
        onCreateMediaAsset={onCreateMediaAsset}
        textareaRef={textareaRef}
        modelPicker={
          <ComposerModelPicker
            disabled={pending}
            providers={composer.modelCatalog.map((provider) => ({
              id: provider.provider,
              label: provider.label,
              available: provider.available,
              ...(provider.error ? { error: provider.error } : {}),
              models: provider.models,
            }))}
            activeProvider={composer.provider}
            activeProviderLabel={composer.providerLabel}
            activeModel={composer.model}
            activeModelLabel={composer.modelLabel}
            loading={composer.modelCatalogLoading}
            onSelect={(provider, modelId) =>
              void onCommand({
                kind: "set-session-model",
                sessionId: session.id,
                provider,
                model: modelId,
              })
            }
          />
        }
        toolbarControls={
          <fieldset className="m-product-composer-toolbar" disabled={pending}>
            <OptionMenu
              disabled={pending}
              label="Reasoning mode"
              activeValue={session.reasoning ?? WORKSPACE_DEFAULT_VALUE}
              activeLabel={reasoning.label}
              activeIcon={reasoning.icon}
              activeTone={reasoning.tone}
              options={reasoningOptions}
              onSelect={(value) =>
                void onCommand(
                  value === WORKSPACE_DEFAULT_VALUE
                    ? {
                        kind: "clear-session-reasoning",
                        sessionId: session.id,
                      }
                    : {
                        kind: "set-session-reasoning",
                        sessionId: session.id,
                        reasoning:
                          value as ProductComposer["reasoningOptions"][number],
                      },
                )
              }
            />
            <OptionMenu
              disabled={pending}
              label="Execution mode"
              activeValue={session.mode ?? WORKSPACE_DEFAULT_VALUE}
              activeLabel={mode.label}
              activeIcon={mode.icon}
              activeTone={mode.tone}
              options={[
                {
                  value: WORKSPACE_DEFAULT_VALUE,
                  label: "Workspace default",
                  description: `Currently ${MODE_OPTION_BY_VALUE[composer.defaultMode].label}.`,
                  icon: MODE_OPTION_BY_VALUE[composer.defaultMode].icon,
                  tone: "neutral",
                },
                ...MODE_OPTIONS,
              ]}
              onSelect={(value) =>
                void onCommand(
                  value === WORKSPACE_DEFAULT_VALUE
                    ? { kind: "clear-session-mode", sessionId: session.id }
                    : {
                        kind: "set-session-mode",
                        sessionId: session.id,
                        mode: value as "ask" | "machdoch",
                      },
                )
              }
            />
            <OptionMenu
              disabled={
                pending ||
                (composer.availableParallelAgentModes?.length ?? 0) < 2
              }
              label="Parallel agents"
              activeValue={parallelAgentMode}
              activeLabel={
                {
                  disabled: "Disabled",
                  "read-only": "Read Only",
                  machdoch: "Full Mode",
                  native: "Native",
                }[parallelAgentMode]
              }
              activeIcon={ParallelAgentsIcon}
              activeTone="violet"
              options={(
                [
                  {
                    value: "disabled",
                    label: "Disabled",
                    description: "",
                    icon: OffIcon,
                    tone: "neutral",
                  },
                  {
                    value: "read-only",
                    label: "Read Only",
                    description: "",
                    icon: ReadOnlyIcon,
                    tone: "neutral",
                  },
                  {
                    value: "machdoch",
                    label: "Full Mode",
                    description: "",
                    icon: FullAccessIcon,
                    tone: "violet",
                  },
                  {
                    value: "native",
                    label: "Native",
                    description: "",
                    icon: ModelIcon,
                    tone: "violet",
                  },
                ] satisfies OptionMenuItem[]
              ).filter((option) =>
                composer.availableParallelAgentModes?.includes(
                  option.value as NonNullable<
                    ProductComposer["parallelAgentMode"]
                  >,
                ),
              )}
              onSelect={(value) =>
                void onCommand({
                  kind: "set-parallel-agent-mode",
                  sessionId: session.id,
                  mode: value as NonNullable<
                    ProductComposer["parallelAgentMode"]
                  >,
                })
              }
            />
            {composer.adaptiveController ? (
              <SessionAdaptiveControllerPicker
                override={composer.adaptiveController.override}
                defaultEnabled={composer.adaptiveController.defaultEnabled}
                disabled={pending}
                onChange={(override) =>
                  void onCommand({
                    kind: "set-adaptive-controller",
                    sessionId: session.id,
                    mode:
                      override === null
                        ? "default"
                        : override
                          ? "enabled"
                          : "disabled",
                  })
                }
              />
            ) : null}
            {session.specialKind !== "pose" ? (
              <GoalTrigger
                open={goalOpen}
                active={
                  composer.isExecuting && composer.goal?.status === "active"
                }
                controls={goalId}
                disabled={pending}
                onClick={() => setGoalOpen((open) => !open)}
              />
            ) : null}
            <SessionPromptEnhancementPicker
              disabled={pending}
              mode={composer.promptEnhancementMode}
              webSearchAvailable={webSearchAvailable}
              webSearchUnavailableReason="Web search is unavailable."
              onModeChange={(value) =>
                void onCommand({
                  kind: "set-prompt-enhancement-mode",
                  sessionId: session.id,
                  promptEnhancementMode: value,
                })
              }
            />
            <WorkspaceMenu
              disabled={pending}
              session={session}
              workspaces={workspaces}
              onCommand={onCommand}
            />
            {renderContextPackPicker(draft)}
            <div className="m-product-composer-toolbar-spacer" />
            <Toggle
              label="Session memory"
              icon={<SessionMemoryIcon />}
              pressed={composer.sessionMemoryEnabled}
              onManage={() => setSessionMemoryOpen(true)}
              onClick={() =>
                onCommand({
                  kind: "set-session-memory",
                  sessionId: session.id,
                  enabled: !composer.sessionMemoryEnabled,
                })
              }
            />
            <Toggle
              label="Workspace memory"
              icon={<WorkspaceMemoryIcon />}
              pressed={composer.workspaceMemoryEnabled === true}
              disabled={composer.workspaceMemoryAvailable !== true}
              onClick={() =>
                onCommand({
                  kind: "set-workspace-memory",
                  sessionId: session.id,
                  enabled: composer.workspaceMemoryEnabled !== true,
                })
              }
            />
            <Toggle
              label="Global memory"
              icon={<GlobalMemoryIcon />}
              pressed={composer.globalMemoryEnabled}
              disabled={!composer.globalMemoryAvailable}
              onClick={() =>
                onCommand({
                  kind: "set-global-memory",
                  sessionId: session.id,
                  enabled: !composer.globalMemoryEnabled,
                })
              }
            />
            <Toggle
              label="Interview"
              icon={<InterviewIcon />}
              pressed={composer.interviewEnabled}
              disabled={!composer.interviewAvailable}
              onClick={() =>
                onCommand({
                  kind: "set-interview",
                  sessionId: session.id,
                  enabled: !composer.interviewEnabled,
                })
              }
            />
            <Toggle
              label="UI control"
              title={composer.uiControlDescription}
              icon={<UiControlIcon />}
              pressed={composer.uiControlEnabled}
              disabled={!composer.uiControlAvailable}
              onClick={() =>
                onCommand({
                  kind: "set-ui-control",
                  sessionId: session.id,
                  enabled: !composer.uiControlEnabled,
                })
              }
            />
          </fieldset>
        }
        inputHeader={
          session.specialKind !== "pose" ? (
            <div className="m-product-composer-goal">
              <GoalControl
                key={composer.sessionId}
                id={goalId}
                open={goalOpen}
                mode={composer.goalMode ?? "machdoch"}
                modes={composer.availableGoalModes ?? ["machdoch"]}
                goal={composer.goal}
                objective={goalDraft.objective}
                error={goalDraft.error}
                onObjectiveChange={goalDraft.setObjective}
                running={composer.isExecuting}
                disabled={pending}
                onClose={() => setGoalOpen(false)}
                onModeChange={(mode) =>
                  void onCommand({
                    kind: "set-goal-mode",
                    sessionId: session.id,
                    mode,
                  })
                }
                onCommand={(prompt) =>
                  void onCommand({
                    kind: "submit-message",
                    sessionId: session.id,
                    prompt,
                    iterationCount: 1,
                    iterationMode: "continue",
                    promptEnhancementMode: "off",
                    interviewEnabled: false,
                  })
                }
                onPause={() => {
                  if (session.runningTaskId)
                    void onCommand({
                      kind: "cancel",
                      taskId: session.runningTaskId,
                    });
                }}
              />
            </div>
          ) : null
        }
        contextAttachments={composer.attachments.map(toContextAttachment)}
        imageInputSupported={composer.imageInputSupported === true}
        imageInputDisabledReason={composer.imageInputDisabledReason ?? null}
        canSend={canSubmit}
        sendDisabledReason={composer.sendDisabledReason ?? null}
        isExecuting={composer.isExecuting}
        canCancel={canCancel}
        iterationsEnabled={session.specialKind !== "pose"}
        runningTaskMessageAction={composer.runningTaskMessageAction ?? "queue"}
        queuedMessages={(composer.queuedMessages ?? []).map((message) => ({
          ...message,
          attachments: message.attachments.map(toContextAttachment),
        }))}
        onDraftChange={updateDraft}
        onAdditionalTextareaKeyDown={onHistoryKeyDown}
        onSend={(currentDraft, iterationCount, iterationMode) => {
          if (canSubmit && !drafts.submitting) {
            updateDraft(currentDraft);
            void submitDraft(
              goalDraft.submissionObjective,
              iterationCount,
              iterationMode,
              composer.runningTaskMessageAction,
            );
          }
        }}
        onCancel={() => {
          if (session.runningTaskId && canCancel)
            void onCommand({ kind: "cancel", taskId: session.runningTaskId });
        }}
        actions={[
          ...(session.runningTaskId && canCancel
            ? [
                {
                  id: "cancel-task",
                  label: "Stop task",
                  icon: <StopIcon />,
                  disabled: pending,
                  onClick: () => {
                    if (session.runningTaskId)
                      void onCommand({
                        kind: "cancel",
                        taskId: session.runningTaskId,
                      });
                  },
                },
              ]
            : []),
          ...(voice?.supported
            ? [
                {
                  id: "auto-speak",
                  label: "Read responses aloud on device",
                  icon: <Volume2 />,
                  disabled: pending,
                  onClick: () => {
                    void onCommand({
                      kind: "set-auto-speak",
                      enabled: !voice.autoSpeakResponses,
                    });
                  },
                },
              ]
            : []),
          ...(voice?.speechInputSupported
            ? [
                {
                  id: "speech-input",
                  label: voice.speechInputRecording
                    ? "Stop device microphone"
                    : "Start device microphone",
                  icon: <Mic />,
                  disabled:
                    pending ||
                    voice.speechInputBusy ||
                    !voice.speechInputEnabled,
                  onClick: () => {
                    void onCommand({
                      kind: "set-speech-input-recording",
                      sessionId: session.id,
                      enabled: !voice.speechInputRecording,
                    });
                  },
                },
              ]
            : []),
        ]}
        onSelectContextFiles={() => attachments.select("files")}
        onSelectContextFolders={() => attachments.select("folders")}
        onSelectContextImages={() => attachments.select("images")}
        onPasteContextImages={(files) => attachments.upload(files)}
        onOpenContextAttachment={attachments.open}
        onRemoveContextAttachment={(attachmentId) => {
          void onCommand({
            kind: "remove-attachment",
            sessionId: session.id,
            attachmentId,
          });
        }}
        onClearContextAttachments={() => {
          void onCommand({ kind: "clear-attachments", sessionId: session.id });
        }}
        onRunningTaskMessageActionChange={(runningAction) => {
          void onCommand({
            kind: "set-running-message-action",
            sessionId: session.id,
            runningAction,
          });
        }}
        onQueuedMessageChange={(messageId, prompt) => {
          void onCommand({
            kind: "update-queued-message",
            sessionId: session.id,
            messageId,
            prompt,
          });
        }}
        onQueuedMessageMove={(messageId, direction) => {
          void onCommand({
            kind: "move-queued-message",
            sessionId: session.id,
            messageId,
            direction,
          });
        }}
        onQueuedMessageReorder={(messageId, targetIndex) => {
          void onCommand({
            kind: "reorder-queued-message",
            sessionId: session.id,
            messageId,
            targetIndex,
          });
        }}
        onQueuedMessageRemove={(messageId) => {
          void onCommand({
            kind: "remove-queued-message",
            sessionId: session.id,
            messageId,
          });
        }}
        onQueuedMessageRetry={(messageId) => {
          void onCommand({
            kind: "retry-queued-message",
            sessionId: session.id,
            messageId,
          });
        }}
        onQueuedMessageSelectContextAttachments={(messageId, kind) =>
          attachments.select(kind, messageId)
        }
        onQueuedMessagePasteContextImages={(messageId, files) =>
          attachments.upload(files, messageId)
        }
        onQueuedMessageRemoveContextAttachment={(messageId, attachmentId) => {
          void onCommand({
            kind: "remove-queued-attachment",
            sessionId: session.id,
            messageId,
            attachmentId,
          });
        }}
        onQueuedMessageClearContextAttachments={(messageId) => {
          void onCommand({
            kind: "clear-queued-attachments",
            sessionId: session.id,
            messageId,
          });
        }}
      />
      {error && failedSubmission === null ? (
        <p className="m-product-composer-error" role="alert">
          {error}
        </p>
      ) : null}
      {!composer.canSend && draft.trim() && composer.sendDisabledReason ? (
        <p className="m-product-composer-error">
          {composer.sendDisabledReason}
        </p>
      ) : null}
      <MemoryDialog
        title="Session memory"
        open={sessionMemoryOpen}
        enabled={composer.sessionMemoryEnabled}
        entries={composer.sessionMemory.map((entry) => ({
          id: entry.id,
          content: entry.content,
          createdAt: entry.createdAt,
          ...(entry.sourceSession
            ? { sourceLabel: entry.sourceSession.title }
            : {}),
        }))}
        emptyLabel="No session memory saved."
        disabled={pending}
        onEnabledChange={(enabled) =>
          onCommand({
            kind: "set-session-memory",
            sessionId: session.id,
            enabled,
          })
        }
        onForget={(memoryId) =>
          onCommand({
            kind: "forget-session-memory",
            sessionId: session.id,
            memoryId,
          })
        }
        onClose={closeSessionMemory}
      />
    </div>
  );
}

function Toggle({
  icon,
  label,
  title,
  pressed,
  disabled = false,
  onManage,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  pressed: boolean;
  disabled?: boolean;
  onManage?: () => void;
  onClick: () => Promise<boolean>;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="m-product-toggle-button app-composer-toggle-button"
      data-active={pressed && !disabled}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      title={title || label}
      onClick={() => {
        if (!disabled) void onClick();
      }}
      onContextMenu={
        onManage
          ? (event) => {
              event.preventDefault();
              event.currentTarget.focus();
              onManage();
            }
          : undefined
      }
      onKeyDown={
        onManage
          ? (event) => {
              if (
                event.key === "ContextMenu" ||
                (event.shiftKey && event.key === "F10")
              ) {
                event.preventDefault();
                onManage();
              }
            }
          : undefined
      }
    >
      {icon}
    </button>
  );
}
