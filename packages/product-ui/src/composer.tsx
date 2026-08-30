import type { ProductSession, ProductShell } from "@machdoch/fleet-protocol";
import {
  ArrowUp,
  Brain,
  BrainCircuit,
  Check,
  ChevronsUp,
  ChevronDown,
  CircleDashed,
  CircleOff,
  Folder,
  Layers3,
  MessageSquare,
  Monitor,
  Paperclip,
  Search,
  SignalHigh,
  SignalLow,
  SignalMedium,
  SignalZero,
  Sparkles,
  Tally5,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ComposerModelPicker } from "./composer-model-picker";
import type { ProductCommandHandler } from "./product-runtime";

type ProductComposer = NonNullable<ProductShell["composer"]>;
type ProductContextPack = ProductShell["contextPacks"][number];
type ProductWorkspace = ProductShell["workspaces"][number];
type ControlTone =
  | "neutral"
  | "teal"
  | "cyan"
  | "sky"
  | "amber"
  | "fuchsia"
  | "rose"
  | "violet";

interface OptionMenuItem {
  value: string;
  label: string;
  description: string;
  icon: LucideIcon;
  tone: ControlTone;
  disabled?: boolean;
}

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
  pending,
  onCommand,
}: {
  composer: ProductComposer;
  session: ProductSession;
  contextPacks: ProductContextPack[];
  workspaces: ProductWorkspace[];
  webSearchAvailable: boolean;
  pending: boolean;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const [draft, setDraft] = useState(composer.draft);
  const [draftSessionId, setDraftSessionId] = useState(composer.sessionId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (draftSessionId !== composer.sessionId) {
      setDraftSessionId(composer.sessionId);
      setDraft(composer.draft);
    }
  }, [composer.draft, composer.sessionId, draftSessionId]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "";
    if (!draft) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  }, [draft]);

  const canSubmit = draft.trim().length > 0 && composer.canSend;

  const submit = async (): Promise<void> => {
    const prompt = draft.trim();
    if (!prompt || !canSubmit) return;
    setDraft("");
    const succeeded = await onCommand({
      kind: "submit-message",
      sessionId: session.id,
      prompt,
      promptEnhancementMode: composer.promptEnhancementMode,
      interviewEnabled: composer.interviewEnabled,
    });
    if (!succeeded) setDraft((current) => current || prompt);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      void submit();
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
    ...composer.reasoningOptions
      .filter((value) => value !== "default")
      .map((value) => ({
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
      <div className="m-product-composer app-agent-composer">
        <div className="m-product-composer-toolbar app-composer-toolbar">
          <ComposerModelPicker
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
          <OptionMenu
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
            session={session}
            workspaces={workspaces}
            onCommand={onCommand}
          />
          <ContextPackMenu
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
            onClick={() =>
              onCommand({
                kind: "set-session-memory",
                sessionId: session.id,
                enabled: !composer.sessionMemoryEnabled,
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
        </div>
        {composer.attachments.length > 0 ? (
          <div className="m-product-composer-attachments">
            {composer.attachments.map((attachment) => (
              <span key={attachment.id} className="m-product-chip">
                <Paperclip aria-hidden="true" />
                {attachment.name}
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
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
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button
            className="m-product-send app-composer-send-button"
            type="button"
            aria-label={
              session.runningTaskId ? "Queue follow-up" : "Send message"
            }
            disabled={!canSubmit || pending}
            onClick={() => void submit()}
          >
            <ArrowUp aria-hidden="true" />
          </button>
        </div>
      </div>
      {!canSubmit && draft.trim() && composer.sendDisabledReason ? (
        <p className="m-product-composer-error">
          {composer.sendDisabledReason}
        </p>
      ) : null}
    </div>
  );
}

function OptionMenu({
  label,
  activeValue,
  activeLabel,
  activeIcon: ActiveIcon,
  activeTone,
  options,
  onSelect,
}: {
  label: string;
  activeValue: string;
  activeLabel: string;
  activeIcon: LucideIcon;
  activeTone: ControlTone;
  options: OptionMenuItem[];
  onSelect: (value: string) => void;
}): React.ReactElement {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  return (
    <details className="m-product-option-menu" ref={detailsRef}>
      <summary
        aria-label={`${label}: ${activeLabel}`}
        title={`${label}: ${activeLabel}`}
        data-tone={activeTone}
      >
        <ActiveIcon aria-hidden="true" />
      </summary>
      <div className="m-product-option-popover">
        <strong>{label}</strong>
        <div>
          {options.map((option) => {
            const Icon = option.icon;
            const selected = option.value === activeValue;
            return (
              <button
                key={option.value}
                type="button"
                data-active={selected}
                data-tone={option.tone}
                disabled={option.disabled}
                aria-label={`Choose ${option.label}`}
                onClick={() => {
                  onSelect(option.value);
                  if (detailsRef.current) detailsRef.current.open = false;
                }}
              >
                <span>
                  <Icon aria-hidden="true" />
                </span>
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                {selected ? <Check aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </details>
  );
}

function WorkspaceMenu({
  session,
  workspaces,
  onCommand,
}: {
  session: ProductSession;
  workspaces: ProductWorkspace[];
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const current = workspaces.find(
    (workspace) => workspace.root === session.workspace,
  );
  return (
    <details className="m-product-menu">
      <summary title={session.workspace}>
        <Folder aria-hidden="true" />
        <span>{current?.label ?? "Not Set"}</span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="m-product-menu-popover">
        {workspaces.map((workspace) => (
          <button
            type="button"
            key={workspace.root}
            data-active={workspace.root === session.workspace}
            onClick={() =>
              void onCommand({
                kind: "set-session-workspace",
                sessionId: session.id,
                workspace: workspace.root,
              })
            }
          >
            <span>{workspace.label}</span>
            <small>{workspace.sessionCount}</small>
          </button>
        ))}
        {session.workspace ? (
          <button
            type="button"
            onClick={() =>
              void onCommand({
                kind: "clear-session-workspace",
                sessionId: session.id,
              })
            }
          >
            No workspace
          </button>
        ) : null}
      </div>
    </details>
  );
}

function ContextPackMenu({
  sessionId,
  contextPacks,
  onCommand,
}: {
  sessionId: string;
  contextPacks: ProductContextPack[];
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  return (
    <details className="m-product-menu">
      <summary>
        <Layers3 aria-hidden="true" />
        <span>Packs</span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="m-product-menu-popover">
        {contextPacks.length ? (
          contextPacks.map((pack) => (
            <button
              type="button"
              key={pack.id}
              data-active={pack.matched}
              disabled={pack.matched}
              onClick={() =>
                void onCommand({
                  kind: "apply-context-pack",
                  sessionId,
                  contextPackId: pack.id,
                })
              }
            >
              <span>{pack.name}</span>
              {pack.scopeLabel ? <small>{pack.scopeLabel}</small> : null}
            </button>
          ))
        ) : (
          <span className="m-product-menu-empty">No packs</span>
        )}
      </div>
    </details>
  );
}

function Toggle({
  icon,
  label,
  title,
  tone,
  pressed,
  disabled = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  title?: string;
  tone: "emerald" | "sky" | "cyan" | "violet";
  pressed: boolean;
  disabled?: boolean;
  onClick: () => Promise<boolean>;
}): React.ReactElement {
  return (
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
}
