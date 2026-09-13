import type { ProductSession, ProductShell } from "@machdoch/fleet-protocol";
import {
  ArrowUp,
  Brain,
  BrainCircuit,
  ChevronsUp,
  ChevronDown,
  CircleDashed,
  CircleOff,
  FolderHeart,
  Infinity as InfinityIcon,
  MessageSquare,
  Monitor,
  Paperclip,
  Search,
  SignalHigh,
  SignalLow,
  SignalMedium,
  SignalZero,
  SlidersHorizontal,
  Sparkles,
  Square,
  Tally5,
  WandSparkles,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
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
import { SessionMemoryDialog } from "./memory-management";
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
    icon: CircleDashed,
    tone: "neutral",
  },
  none: {
    label: "None",
    description: "Use the lowest available reasoning setting.",
    icon: CircleOff,
    tone: "neutral",
  },
  minimal: {
    label: "Minimal",
    description: "Prefer minimal reasoning where supported.",
    icon: SignalZero,
    tone: "teal",
  },
  low: {
    label: "Low",
    description: "Favor speed and lower token use.",
    icon: SignalLow,
    tone: "cyan",
  },
  medium: {
    label: "Medium",
    description: "Balance quality, cost, and latency.",
    icon: SignalMedium,
    tone: "sky",
  },
  high: {
    label: "High",
    description: "Spend more effort on complex tasks.",
    icon: SignalHigh,
    tone: "amber",
  },
  xhigh: {
    label: "XHigh",
    description: "Use extended effort for long-horizon tasks.",
    icon: ChevronsUp,
    tone: "fuchsia",
  },
  max: {
    label: "Max",
    description: "Use the highest mapped reasoning effort.",
    icon: Tally5,
    tone: "rose",
  },
  ultra: {
    label: "Ultra",
    description: "Use maximum reasoning and parallel agents.",
    icon: Sparkles,
    tone: "violet",
  },
  aeon: {
    label: "Aeon",
    description: "Keep working until stopped.",
    icon: InfinityIcon,
    tone: "violet",
  },
};

const MODE_OPTION_BY_VALUE: Record<"ask" | "machdoch", OptionMenuItem> = {
  machdoch: {
    value: "machdoch",
    label: "Machdoch",
    description: "Use all available tools and verify the work.",
    icon: WandSparkles,
    tone: "violet",
  },
  ask: {
    value: "ask",
    label: "Ask mode",
    description: "Use read-only tools.",
    icon: MessageSquare,
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
  const [optionsOpen, setOptionsOpen] = useState(false);
  const composing = useRef(false);
  const touchInput = useMediaQuery("(pointer: coarse)");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const closeSessionMemory = useCallback(() => setSessionMemoryOpen(false), []);
  useEffect(() => {
    setSessionMemoryOpen(false);
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

  const submit = (): void => {
    if (canSubmit) void submitDraft();
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
    icon: CircleDashed,
    tone: "neutral",
  };
  const enhancementOptions: OptionMenuItem[] = [
    offEnhancement,
    {
      value: "simple",
      label: "Enhance",
      description: "Rewrite the request for clarity.",
      icon: Sparkles,
      tone: "fuchsia",
    },
    {
      value: "web-search",
      label: "Enhance with web",
      description: webSearchAvailable
        ? "Research current context before rewriting."
        : "Web search is unavailable.",
      icon: Search,
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
                icon: CircleDashed,
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
            disabled={pending}
            label="Prompt enhancement"
            activeValue={composer.promptEnhancementMode}
            activeLabel={enhancement.label}
            activeIcon={Sparkles}
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
            icon={<Brain />}
            tone="emerald"
            pressed={composer.sessionMemoryEnabled}
            onManage={() => setSessionMemoryOpen(true)}
            manageLabel="Manage session memory"
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
            icon={<FolderHeart />}
            tone="amber"
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
            icon={<BrainCircuit />}
            tone="sky"
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
            icon={<MessageSquare />}
            tone="cyan"
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
            icon={<Monitor />}
            tone="violet"
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
              <Square aria-hidden="true" />
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
      <SessionMemoryDialog
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
  tone,
  pressed,
  disabled = false,
  onManage,
  manageLabel,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  tone: "emerald" | "sky" | "cyan" | "amber" | "violet";
  pressed: boolean;
  disabled?: boolean;
  onManage?: () => void;
  manageLabel?: string;
  onClick: () => Promise<boolean>;
}): React.ReactElement {
  const button = (
    <button
      type="button"
      className="m-product-toggle-button app-composer-toggle-button"
      data-tone={tone}
      data-active={pressed}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled || undefined}
      title={title || label}
      onClick={() => {
        if (!disabled) void onClick();
      }}
    >
      {icon}
    </button>
  );

  if (!onManage) return button;

  return (
    <div
      className="m-product-toggle-group"
      role="group"
      aria-label={`${label} controls`}
    >
      {button}
      <button
        type="button"
        className="m-product-toggle-manage"
        aria-label={manageLabel ?? `Manage ${label}`}
        title={manageLabel ?? `Manage ${label}`}
        onClick={onManage}
      >
        <ChevronDown aria-hidden="true" />
      </button>
    </div>
  );
}
