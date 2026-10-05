import {
  AskIcon,
  ExecuteIcon,
  GlobalMemoryIcon,
  InterviewIcon,
  FullAccessIcon,
  ModelIcon,
  OffIcon,
  ParallelAgentsIcon,
  PromptEnhancementIcon,
  ReadOnlyIcon,
  SearchIcon,
  SessionMemoryIcon,
  StopIcon,
  UiControlIcon,
  WorkspaceMemoryIcon,
} from "./composer-icons";
import { ReasoningIcons } from "./reasoning-icons";
import { GoalControl, GoalTrigger } from "./goal-control";
import { useGoalDraft } from "./use-goal-draft";
import type { ProductSession, ProductShell } from "@machdoch/fleet-protocol";
import { ArrowUp, Paperclip, SlidersHorizontal, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useMediaQuery } from "./responsive-layout";
import { ComposerModelPicker } from "./composer-model-picker";
import {
  ContextPackMenu,
  OptionMenu,
  WorkspaceMenu,
  type OptionMenuItem,
} from "./composer-menus";
import { MemoryDialog } from "./memory-management";
import type { ProductCommandHandler } from "./product-runtime";
import {
  useComposerDraft,
  type ComposerDraftStore,
} from "./use-composer-draft";

type ProductComposer = NonNullable<ProductShell["composer"]>;
type ProductContextPack = ProductShell["contextPacks"][number];
type ProductWorkspace = ProductShell["workspaces"][number];
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

export function Composer({
  composer,
  session,
  contextPacks,
  workspaces,
  webSearchAvailable,
  canCancel,
  drafts,
  pending,
  onCommand,
}: {
  composer: ProductComposer;
  session: ProductSession;
  contextPacks: ProductContextPack[];
  workspaces: ProductWorkspace[];
  webSearchAvailable: boolean;
  canCancel: boolean;
  drafts: ComposerDraftStore;
  pending: boolean;
  onCommand: ProductCommandHandler;
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
  const [optionsOpen, setOptionsOpen] = useState(false);
  const composing = useRef(false);
  const touchInput = useMediaQuery("(pointer: coarse)");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const closeSessionMemory = useCallback(() => setSessionMemoryOpen(false), []);
  useEffect(() => {
    setSessionMemoryOpen(false);
  }, [composer.sessionId]);

  useEffect(() => {
    setGoalOpen(false);
  }, [composer.sessionId]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "";
    if (!draft) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  }, [draft]);

  const canSubmit =
    draft.trim().length > 0 &&
    composer.canSend &&
    !pending &&
    !submitting &&
    failedSubmission === null;
  const parallelAgentMode = composer.availableParallelAgentModes?.includes(
    composer.parallelAgentMode ?? "disabled",
  )
    ? (composer.parallelAgentMode ?? "disabled")
    : "disabled";

  const submit = (): void => {
    if (canSubmit) void submitDraft(goalDraft.submissionObjective);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key === "Enter" &&
      !window.matchMedia("(pointer: coarse)").matches &&
      !composing.current &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229 &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      submit();
    }
  };

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
  const offEnhancement: OptionMenuItem = {
    value: "off",
    label: "Off",
    description: "Send the request as written.",
    icon: OffIcon,
    tone: "neutral",
  };
  const enhancementOptions: OptionMenuItem[] = [
    offEnhancement,
    {
      value: "simple",
      label: "Enhance",
      description: "Rewrite the request for clarity.",
      icon: PromptEnhancementIcon,
      tone: "fuchsia",
    },
    {
      value: "web-search",
      label: "Enhance with web",
      description: webSearchAvailable
        ? "Research current context before rewriting."
        : "Web search is unavailable.",
      icon: SearchIcon,
      tone: "fuchsia",
      disabled: !webSearchAvailable,
    },
  ];
  const enhancement =
    enhancementOptions.find(
      (option) => option.value === composer.promptEnhancementMode,
    ) ?? offEnhancement;

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
      <div className="m-product-composer app-agent-composer">
        <fieldset
          className="m-product-composer-toolbar app-composer-toolbar"
          data-options-open={optionsOpen}
          disabled={pending}
        >
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
          <button
            type="button"
            className="m-product-composer-options-toggle"
            aria-label="Composer options"
            aria-expanded={optionsOpen}
            onClick={() => setOptionsOpen((current) => !current)}
          >
            <SlidersHorizontal aria-hidden="true" />
            <span>Options</span>
          </button>
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
              pending || (composer.availableParallelAgentModes?.length ?? 0) < 2
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
          <OptionMenu
            disabled={pending}
            label="Prompt enhancement"
            activeValue={composer.promptEnhancementMode}
            activeLabel={enhancement.label}
            activeIcon={PromptEnhancementIcon}
            activeTone={
              composer.promptEnhancementMode === "off" ? "neutral" : "fuchsia"
            }
            options={enhancementOptions}
            onSelect={(value) =>
              void onCommand({
                kind: "set-prompt-enhancement-mode",
                sessionId: session.id,
                promptEnhancementMode:
                  value as ProductComposer["promptEnhancementMode"],
              })
            }
          />
          <WorkspaceMenu
            disabled={pending}
            session={session}
            workspaces={workspaces}
            onCommand={onCommand}
          />
          <ContextPackMenu
            disabled={pending}
            sessionId={session.id}
            contextPacks={contextPacks}
            onCommand={onCommand}
          />
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
        {composer.attachments.length > 0 ? (
          <div className="m-product-composer-attachments">
            {composer.attachments.map((attachment) => (
              <span key={attachment.id} className="m-product-chip">
                <Paperclip aria-hidden="true" />
                {attachment.name}
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  disabled={pending}
                  onClick={() =>
                    void onCommand({
                      kind: "remove-attachment",
                      sessionId: session.id,
                      attachmentId: attachment.id,
                    })
                  }
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {session.specialKind !== "pose" ? (
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
        ) : null}
        <div className="m-product-composer-input-row app-composer-form">
          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            placeholder={
              session.runningTaskId ? "Queue a follow-up" : "Message Machdoch"
            }
            aria-label="Task composer"
            enterKeyHint={touchInput ? "enter" : "send"}
            onChange={(event) => updateDraft(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={handleKeyDown}
          />
          {session.runningTaskId && canCancel ? (
            <button
              className="m-product-send m-product-danger-button"
              type="button"
              aria-label="Stop task"
              disabled={pending}
              onClick={() =>
                void onCommand({
                  kind: "cancel",
                  taskId: session.runningTaskId!,
                })
              }
            >
              <StopIcon aria-hidden="true" />
            </button>
          ) : null}
          <button
            className="m-product-send app-composer-send-button"
            type="button"
            aria-label={
              session.runningTaskId ? "Queue follow-up" : "Send message"
            }
            disabled={!canSubmit}
            onClick={submit}
          >
            <ArrowUp aria-hidden="true" />
          </button>
        </div>
      </div>
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
