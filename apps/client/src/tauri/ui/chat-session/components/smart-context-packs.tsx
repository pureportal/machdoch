import {
  Download,
  Folder,
  Globe2,
  Layers,
  Pencil,
  Play,
  Plus,
  Save,
  Search,
  SlidersHorizontal,
  Trash2,
  Upload,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
} from "react";
import {
  REASONING_MODES,
  RUN_MODES,
  VALID_MODEL_PROVIDERS,
  type ReasoningMode,
  type RunMode,
} from "../../../../core/runtime-contract.generated.js";
import {
  isMediaAssetContextAttachment,
  isPathContextAttachment,
  type ChatSessionContextAttachment,
  type SmartContextPack,
  type SmartContextPackVariable,
} from "../../chat-session.model";
import type { RalphFlow } from "../../../../core/ralph.js";
import { Button } from "../../components/ui/button";
import { useOptionalRegisterCommands } from "../../commands/command-context";
import type {
  CommandDefinition,
  CommandPageItem,
} from "../../commands/command-types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { ControlTooltip } from "../../components/ui/tooltip";
import { SearchField } from "../../components/ui/search-field";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "../../components/ui/submit-shortcut";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { getProviderLabel, type RuntimeProvider } from "../../model-catalog";
import { listRalphFlows, showRalphFlow } from "../../runtime";
import {
  PROMPT_ENHANCEMENT_LABELS,
  PROMPT_ENHANCEMENT_MODES,
  type PromptEnhancementMode,
} from "../_helpers/prompt-enhancement";
import { createContextAttachmentFromReference } from "../_helpers/session-context-attachments";
import {
  extractSmartContextPackVariables,
  getContextPackReasoningLabel,
  getContextPackModeLabel,
  getSmartContextPackMissingVariableNames,
  getSmartContextPackScope,
  getSmartContextPackScopeLabel,
  getSmartContextPackSortTimestamp,
  parseSmartContextPackListInput,
  parseSmartContextPackVariableInput,
  type SaveSmartContextPackInput,
  type SmartContextPackScope,
  type SmartContextPackScopeFilter,
} from "../_helpers/smart-context-packs";

export interface SmartContextPackPickerProps {
  contextPacks: SmartContextPack[];
  workspaceRoot: string | null;
  activeDraft: string;
  activeProvider: RuntimeProvider;
  activeModel: string;
  activeRunMode: RunMode;
  activeReasoning: ReasoningMode;
  activePromptEnhancementMode: PromptEnhancementMode;
  activeInterviewEnabled: boolean;
  activeSessionMemoryEnabled: boolean;
  activeUseGlobalMemory: boolean;
  activeUiControlEnabled: boolean;
  contextAttachments: ChatSessionContextAttachment[];
  matchedContextPackIds: string[];
  imageInputSupported: boolean;
  workspaceLabel: string;
  onSaveContextPack: (input: SaveSmartContextPackInput) => void;
  onApplyContextPack: (
    packId: string,
    variableValues?: Record<string, string>,
  ) => void | Promise<void>;
  onDeleteContextPack: (packId: string) => void;
  onExportContextPacks: (scopeFilter: SmartContextPackScopeFilter) => void;
  onImportContextPacks: (file: File, scope: SmartContextPackScope) => void;
}

type SmartContextPackView = "apply" | "configure";

type SmartContextPackDialogMode = "create" | "edit";

interface SmartContextPackListItem {
  pack: SmartContextPack;
  scope: SmartContextPackScope;
  isMatched: boolean;
  ralphFlowNames: string[];
}

interface SmartContextPackEditorInitialValue {
  id?: string;
  mode: SmartContextPackDialogMode;
  name: string;
  scope: SmartContextPackScope;
  instructions: string;
  prompt: string;
  contextAttachments: ChatSessionContextAttachment[];
  variables: SmartContextPackVariable[];
  triggerPhrases: string[];
  triggerPathPatterns: string[];
  provider?: RuntimeProvider;
  model?: string;
  runMode?: RunMode;
  reasoning?: ReasoningMode;
  promptEnhancementMode?: PromptEnhancementMode;
  interviewEnabled?: boolean;
  sessionMemoryEnabled?: boolean;
  useGlobalMemory?: boolean;
  uiControlEnabled?: boolean;
}

interface SmartContextPackDialogState {
  key: string;
  initialValue: SmartContextPackEditorInitialValue;
}

const PACK_FORM_CLASS = "grid gap-4";

const deriveContextPackName = (draft: string): string => {
  const normalizedDraft = draft.replace(/\s+/gu, " ").trim();

  if (!normalizedDraft) {
    return "";
  }

  return normalizedDraft.length <= 40
    ? normalizedDraft
    : `${normalizedDraft.slice(0, 37)}...`;
};

const normalizeContextPackSearchText = (value: string): string => {
  return value
    .trim()
    .replace(/\\/gu, "/")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
};

const tokenizeContextPackSearchText = (value: string): string[] => {
  const normalized = normalizeContextPackSearchText(value);
  return normalized ? normalized.split(" ") : [];
};

const scoreNormalizedContextPackCandidate = (
  normalizedCandidate: string,
  normalizedQuery: string,
  tokens: readonly string[],
  labelBonus: number,
): number => {
  if (!normalizedCandidate) {
    return 0;
  }

  const words = normalizedCandidate.split(" ");
  let score = 0;

  for (const token of tokens) {
    if (normalizedCandidate === token) {
      score += 500;
      continue;
    }

    if (normalizedCandidate.startsWith(token)) {
      score += 420;
      continue;
    }

    if (words.includes(token)) {
      score += 360;
      continue;
    }

    if (words.some((word) => word.startsWith(token))) {
      score += 300;
      continue;
    }

    const tokenIndex = normalizedCandidate.indexOf(token);

    if (tokenIndex < 0) {
      return 0;
    }

    score += 160 - Math.min(tokenIndex, 100);
  }

  if (normalizedCandidate === normalizedQuery) {
    return score + 800 + labelBonus;
  }

  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return score + 620 + labelBonus;
  }

  const phraseIndex = normalizedCandidate.indexOf(normalizedQuery);

  if (phraseIndex >= 0) {
    return score + 420 - Math.min(phraseIndex, 100) + labelBonus;
  }

  return score + labelBonus;
};

const scoreContextPackSearchItem = (
  item: SmartContextPackListItem,
  searchText: string,
): number => {
  const normalizedQuery = normalizeContextPackSearchText(searchText);
  const tokens = tokenizeContextPackSearchText(searchText);

  if (!normalizedQuery || tokens.length === 0) {
    return 0;
  }

  const { pack } = item;
  const nameScore = scoreNormalizedContextPackCandidate(
    normalizeContextPackSearchText(pack.name),
    normalizedQuery,
    tokens,
    160,
  );
  const triggerScore = scoreNormalizedContextPackCandidate(
    normalizeContextPackSearchText(pack.trigger.phrases.join(" ")),
    normalizedQuery,
    tokens,
    80,
  );
  const promptScore = scoreNormalizedContextPackCandidate(
    normalizeContextPackSearchText(pack.prompt),
    normalizedQuery,
    tokens,
    20,
  );
  const instructionsScore = scoreNormalizedContextPackCandidate(
    normalizeContextPackSearchText(pack.instructions),
    normalizedQuery,
    tokens,
    20,
  );

  return Math.max(nameScore, triggerScore, promptScore, instructionsScore);
};

const formatListInputValue = (values: string[]): string => values.join(", ");

const formatVariableInputValue = (
  variables: SmartContextPackVariable[],
): string => {
  return variables
    .map((variable) =>
      variable.defaultValue
        ? `${variable.name}=${variable.defaultValue}`
        : variable.name,
    )
    .join(", ");
};

const formatAttachmentPathInputValue = (
  attachments: ChatSessionContextAttachment[],
): string =>
  attachments
    .flatMap((attachment) =>
      isPathContextAttachment(attachment) ? [attachment.path] : [],
    )
    .join("\n");

const getAttachmentPathKey = (path: string): string => {
  return path.replace(/\\/gu, "/").trim().toLowerCase();
};

const createContextAttachmentsFromPathInput = (
  value: string,
  sourceAttachments: ChatSessionContextAttachment[],
): ChatSessionContextAttachment[] => {
  const sourceByPath = new Map(
    sourceAttachments.flatMap((attachment) =>
      isPathContextAttachment(attachment)
        ? [[getAttachmentPathKey(attachment.path), attachment] as const]
        : [],
    ),
  );
  const attachments: ChatSessionContextAttachment[] = sourceAttachments.filter(
    isMediaAssetContextAttachment,
  );
  const seenPaths = new Set<string>();

  for (const line of value.split(/\r?\n/u)) {
    const path = line.trim();
    const key = getAttachmentPathKey(path);

    if (!path || seenPaths.has(key)) {
      continue;
    }

    seenPaths.add(key);

    const existingAttachment = sourceByPath.get(key);

    if (existingAttachment) {
      attachments.push(existingAttachment);
      continue;
    }

    const attachment = createContextAttachmentFromReference(path);

    if (attachment) {
      attachments.push(attachment);
    }
  }

  return attachments;
};

const getDefaultRuntimeProvider = (): RuntimeProvider => {
  return VALID_MODEL_PROVIDERS[0] ?? "openai";
};

const formatProviderOptionLabel = (provider: RuntimeProvider): string => {
  return getProviderLabel(provider);
};

const CONTEXT_PACK_INLINE_TOKEN_PATTERN =
  /\{[A-Za-z][A-Za-z0-9_-]{0,39}\}|`[^`\n]+`/gu;
const CONTEXT_PACK_HEADING_PATTERN = /^#{1,6}\s+\S/u;

const ContextPackPromptHighlight = ({
  value,
}: {
  value: string;
}): JSX.Element => {
  const lines = value.split("\n");
  const parts: JSX.Element[] = [];

  lines.forEach((line, lineIndex) => {
    if (CONTEXT_PACK_HEADING_PATTERN.test(line)) {
      parts.push(
        <span
          key={`heading-${lineIndex}`}
          className="font-semibold text-cyan-200"
        >
          {line}
        </span>,
      );
    } else {
      let cursor = 0;

      for (const match of line.matchAll(CONTEXT_PACK_INLINE_TOKEN_PATTERN)) {
        const index = match.index ?? 0;
        const raw = match[0] ?? "";

        if (index > cursor) {
          parts.push(
            <span key={`text-${lineIndex}-${cursor}`}>
              {line.slice(cursor, index)}
            </span>,
          );
        }

        const isVariable =
          raw.startsWith("{") &&
          line[index - 1] !== "{" &&
          line[index + raw.length] !== "}";

        if (isVariable) {
          parts.push(
            <span
              key={`variable-${lineIndex}-${index}`}
              className="rounded bg-emerald-500/15 px-1 py-0.5 font-semibold text-emerald-200"
            >
              {raw}
            </span>,
          );
        } else if (raw.startsWith("`")) {
          parts.push(
            <span
              key={`code-${lineIndex}-${index}`}
              className="text-violet-200"
            >
              {raw}
            </span>,
          );
        } else {
          parts.push(<span key={`raw-${lineIndex}-${index}`}>{raw}</span>);
        }

        cursor = index + raw.length;
      }

      if (cursor < line.length) {
        parts.push(
          <span key={`text-${lineIndex}-${cursor}`}>{line.slice(cursor)}</span>,
        );
      }
    }

    if (lineIndex < lines.length - 1) {
      parts.push(<span key={`newline-${lineIndex}`}>{"\n"}</span>);
    }
  });

  return <>{parts.length > 0 ? parts : " "}</>;
};

const ContextPackPromptEditor = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): JSX.Element => {
  const [scrollTop, setScrollTop] = useState(0);

  return (
    <div className="group/prompt-editor relative min-h-52 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
      <pre
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 font-mono text-sm leading-6 text-slate-300 group-focus-within/prompt-editor:invisible"
      >
        <span
          className="block"
          style={{ transform: `translateY(-${scrollTop}px)` }}
        >
          <ContextPackPromptHighlight value={value || " "} />
        </span>
      </pre>
      <textarea
        aria-label="Prompt"
        value={value}
        spellCheck={false}
        placeholder="Review {target_file} and summarize release risk."
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="absolute inset-0 min-h-52 w-full resize-none overflow-auto rounded-xl border-0 bg-transparent px-3 py-2 font-mono text-sm leading-6 text-transparent caret-slate-100 outline-none placeholder:font-sans placeholder:text-slate-600 selection:bg-sky-500/35 selection:text-slate-100 focus:text-slate-300 focus:ring-1 focus:ring-sky-500/30"
      />
    </div>
  );
};

const formatScopeFilterLabel = (
  scopeFilter: SmartContextPackScopeFilter,
): string => {
  switch (scopeFilter) {
    case "global":
      return "Global";
    case "workspace":
      return "Workspace";
    case "all":
    default:
      return "All";
  }
};

const collectRalphFlowPackIds = (flow: RalphFlow): Set<string> => {
  const packIds = new Set<string>();

  for (const block of flow.blocks) {
    for (const packId of block.settings?.packs ?? []) {
      packIds.add(packId);
    }

    if (block.type === "PACK") {
      for (const packId of block.packIds) {
        packIds.add(packId);
      }
    }
  }

  return packIds;
};

const NO_SAVE_VALUE = "no-save" as const;

type PackBooleanOverride = typeof NO_SAVE_VALUE | "enabled" | "disabled";

const PACK_SELECT_CLASS =
  "h-9 w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 text-sm text-slate-100 outline-none transition focus:border-sky-500/50 focus:ring-2 focus:ring-sky-500/20 disabled:cursor-not-allowed disabled:bg-slate-950/35 disabled:text-slate-600";

const getInitialBooleanOverride = (
  value: boolean | undefined,
): PackBooleanOverride => {
  if (value === undefined) {
    return NO_SAVE_VALUE;
  }

  return value === true ? "enabled" : "disabled";
};

const getBooleanOverrideValue = (
  value: PackBooleanOverride,
): boolean | undefined => {
  if (value === NO_SAVE_VALUE) {
    return undefined;
  }

  return value === "enabled";
};

const PackOption = ({
  label,
  description,
  checked,
  disabled = false,
  checkedLabel = "On",
  uncheckedLabel = "Off",
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  checkedLabel?: string;
  uncheckedLabel?: string;
  onChange: (checked: boolean) => void;
}): JSX.Element => {
  return (
    <label
      className={cn(
        "flex min-h-12 items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/55 px-3 py-2 transition-colors",
        disabled
          ? "cursor-not-allowed opacity-45"
          : "cursor-pointer hover:border-slate-700 hover:bg-slate-900/80",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="relative h-5 w-9 shrink-0 rounded-full border border-slate-700 bg-slate-800 transition-colors after:absolute after:top-0.5 after:left-0.5 after:h-3.5 after:w-3.5 after:rounded-full after:bg-slate-400 after:transition-transform peer-checked:border-sky-500/50 peer-checked:bg-sky-500/25 peer-checked:after:translate-x-4 peer-checked:after:bg-sky-200 peer-focus-visible:ring-2 peer-focus-visible:ring-sky-400/50 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-slate-950"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-slate-200">
          {label}
        </span>
        <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">
          {description}
        </span>
      </span>
      <span
        className={cn(
          "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
          checked
            ? "border-sky-500/25 bg-sky-500/10 text-sky-200"
            : "border-slate-800 bg-slate-900 text-slate-500",
        )}
      >
        {checked ? checkedLabel : uncheckedLabel}
      </span>
    </label>
  );
};

const PackSectionHeading = ({
  icon,
  title,
  description,
}: {
  icon: JSX.Element;
  title: string;
  description: string;
}): JSX.Element => {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/70 text-sky-300">
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        <p className="mt-0.5 text-xs leading-5 text-slate-500">{description}</p>
      </div>
    </div>
  );
};

const PackSettingField = ({
  id,
  label,
  description,
  overridden,
  children,
}: {
  id: string;
  label: string;
  description: string;
  overridden: boolean;
  children: JSX.Element;
}): JSX.Element => {
  const descriptionId = `${id}-description`;

  return (
    <div
      className={cn(
        "grid gap-2 rounded-xl border p-3 transition-colors",
        overridden
          ? "border-sky-500/20 bg-sky-500/[0.06]"
          : "border-slate-800 bg-slate-950/45",
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-semibold text-slate-200">
          {label}
        </label>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
            overridden
              ? "border-sky-500/25 bg-sky-500/10 text-sky-200"
              : "border-slate-800 bg-slate-900 text-slate-500",
          )}
        >
          {overridden ? "Override" : "No Save"}
        </span>
      </div>
      <p id={descriptionId} className="text-[11px] leading-4 text-slate-500">
        {description}
      </p>
      <div aria-describedby={descriptionId}>{children}</div>
    </div>
  );
};

const SmartContextPackEditorDialog = ({
  open,
  initialValue,
  workspaceRoot,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  initialValue: SmartContextPackEditorInitialValue;
  workspaceRoot: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: SaveSmartContextPackInput) => void;
}): JSX.Element => {
  const [name, setName] = useState(initialValue.name);
  const [scope, setScope] = useState<SmartContextPackScope>(initialValue.scope);
  const [instructions, setInstructions] = useState(initialValue.instructions);
  const [prompt, setPrompt] = useState(initialValue.prompt);
  const [attachmentPathsInput, setAttachmentPathsInput] = useState(
    formatAttachmentPathInputValue(initialValue.contextAttachments),
  );
  const [variablesInput, setVariablesInput] = useState(
    formatVariableInputValue(initialValue.variables),
  );
  const [triggerPhrasesInput, setTriggerPhrasesInput] = useState(
    formatListInputValue(initialValue.triggerPhrases),
  );
  const [triggerPathPatternsInput, setTriggerPathPatternsInput] = useState(
    formatListInputValue(initialValue.triggerPathPatterns),
  );
  const [includeModel, setIncludeModel] = useState(
    initialValue.mode === "create" ||
      Boolean(initialValue.provider && initialValue.model),
  );
  const [provider, setProvider] = useState<RuntimeProvider>(
    initialValue.provider ?? getDefaultRuntimeProvider(),
  );
  const [model, setModel] = useState(initialValue.model ?? "");
  const [includeRunMode, setIncludeRunMode] = useState(
    initialValue.mode === "create" || Boolean(initialValue.runMode),
  );
  const [runMode, setRunMode] = useState<RunMode>(
    initialValue.runMode ?? "machdoch",
  );
  const [includeReasoning, setIncludeReasoning] = useState(
    initialValue.mode === "create" || Boolean(initialValue.reasoning),
  );
  const [reasoning, setReasoning] = useState<ReasoningMode>(
    initialValue.reasoning ?? "default",
  );
  const [promptEnhancementOverride, setPromptEnhancementOverride] = useState<
    PromptEnhancementMode | typeof NO_SAVE_VALUE
  >(
    initialValue.promptEnhancementMode !== undefined
      ? (initialValue.promptEnhancementMode ?? "off")
      : NO_SAVE_VALUE,
  );
  const [interviewOverride, setInterviewOverride] =
    useState<PackBooleanOverride>(
      getInitialBooleanOverride(initialValue.interviewEnabled),
    );
  const [sessionMemoryOverride, setSessionMemoryOverride] =
    useState<PackBooleanOverride>(
      getInitialBooleanOverride(initialValue.sessionMemoryEnabled),
    );
  const [globalMemoryOverride, setGlobalMemoryOverride] =
    useState<PackBooleanOverride>(
      getInitialBooleanOverride(initialValue.useGlobalMemory),
    );
  const [uiControlOverride, setUiControlOverride] =
    useState<PackBooleanOverride>(
      getInitialBooleanOverride(initialValue.uiControlEnabled),
    );
  const contextAttachments = useMemo(
    () =>
      createContextAttachmentsFromPathInput(
        attachmentPathsInput,
        initialValue.contextAttachments,
      ),
    [attachmentPathsInput, initialValue.contextAttachments],
  );
  const modelValue = model.trim();
  const canSaveModel = !includeModel || modelValue.length > 0;
  const canSave =
    name.trim().length > 0 &&
    canSaveModel &&
    (instructions.trim().length > 0 ||
      prompt.trim().length > 0 ||
      contextAttachments.length > 0 ||
      (includeModel && modelValue.length > 0) ||
      includeRunMode ||
      includeReasoning ||
      promptEnhancementOverride !== NO_SAVE_VALUE ||
      interviewOverride !== NO_SAVE_VALUE ||
      sessionMemoryOverride !== NO_SAVE_VALUE ||
      globalMemoryOverride !== NO_SAVE_VALUE ||
      uiControlOverride !== NO_SAVE_VALUE);

  useEffect(() => {
    if (!workspaceRoot && scope === "workspace") {
      setScope("global");
    }
  }, [scope, workspaceRoot]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (!canSave) {
      return;
    }

    const interviewEnabled = getBooleanOverrideValue(interviewOverride);
    const sessionMemoryEnabled = getBooleanOverrideValue(sessionMemoryOverride);
    const useGlobalMemory = getBooleanOverrideValue(globalMemoryOverride);
    const uiControlEnabled = getBooleanOverrideValue(uiControlOverride);

    onSubmit({
      ...(initialValue.id ? { id: initialValue.id } : {}),
      name,
      scope,
      instructions,
      prompt,
      contextAttachments,
      variables: [
        ...parseSmartContextPackVariableInput(variablesInput),
        ...extractSmartContextPackVariables(name, instructions, prompt).map(
          (variableName) => ({ name: variableName }),
        ),
      ],
      triggerPhrases: parseSmartContextPackListInput(triggerPhrasesInput),
      triggerPathPatterns: parseSmartContextPackListInput(
        triggerPathPatternsInput,
      ),
      ...(includeModel && modelValue ? { provider, model: modelValue } : {}),
      ...(includeRunMode ? { mode: runMode } : {}),
      ...(includeReasoning ? { reasoning } : {}),
      ...(promptEnhancementOverride !== NO_SAVE_VALUE
        ? { promptEnhancementMode: promptEnhancementOverride }
        : {}),
      ...(interviewEnabled !== undefined ? { interviewEnabled } : {}),
      ...(sessionMemoryEnabled !== undefined ? { sessionMemoryEnabled } : {}),
      ...(useGlobalMemory !== undefined ? { useGlobalMemory } : {}),
      ...(uiControlEnabled !== undefined ? { uiControlEnabled } : {}),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="app-context-pack-dialog grid max-h-[min(840px,calc(100dvh-24px))] w-[min(1120px,calc(100vw-24px))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-2xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl shadow-black/50 sm:max-w-none">
        <DialogHeader className="border-b border-slate-800/80 bg-slate-900/35 px-5 py-4 pr-12 text-left sm:px-6">
          <DialogTitle className="text-xl font-semibold text-white">
            {initialValue.mode === "edit"
              ? "Edit context pack"
              : "Create context pack"}
          </DialogTitle>
          <DialogDescription className="max-w-2xl text-xs leading-5 text-slate-400">
            Save reusable context and choose which chat settings this pack
            should override when applied.
          </DialogDescription>
        </DialogHeader>

        <SubmitShortcut asChild>
          <form
            onSubmit={handleSubmit}
            className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]"
          >
            <div className="grid min-h-0 gap-4 overflow-y-auto bg-slate-950/60 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(15rem,0.65fr)_minmax(21rem,0.9fr)] lg:items-start">
              <section className="grid gap-4 rounded-2xl border border-slate-800/90 bg-slate-900/35 p-4">
                <PackSectionHeading
                  icon={<Layers className="h-4 w-4" />}
                  title="Pack content"
                  description="The reusable prompt, instructions, and context added to the composer."
                />
                <label className="grid gap-1.5">
                  <span className="px-1 text-xs font-medium text-slate-400">
                    Name
                  </span>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Review PR"
                    className="h-9 rounded-xl border-slate-800 bg-slate-900/70 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-sky-500/30"
                  />
                </label>

                <div className="grid gap-1.5">
                  <span className="px-1 text-xs font-medium text-slate-400">
                    Prompt
                  </span>
                  <ContextPackPromptEditor
                    value={prompt}
                    onChange={setPrompt}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="grid gap-1.5">
                    <span className="px-1 text-xs font-medium text-slate-400">
                      Instructions
                    </span>
                    <Textarea
                      value={instructions}
                      onChange={(event) => setInstructions(event.target.value)}
                      placeholder="Focus on regressions, missing tests, and user-facing risk."
                      className="min-h-24 resize-none rounded-xl border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-sky-500/30"
                    />
                  </label>

                  <label className="grid gap-1.5">
                    <span className="px-1 text-xs font-medium text-slate-400">
                      Paths
                    </span>
                    <Textarea
                      value={attachmentPathsInput}
                      onChange={(event) =>
                        setAttachmentPathsInput(event.target.value)
                      }
                      placeholder={
                        "C:\\Project\\src\\App.tsx\nhttps://example.com/spec"
                      }
                      className="min-h-24 resize-none rounded-xl border-slate-800 bg-slate-900/70 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-sky-500/30"
                    />
                  </label>
                </div>
              </section>

              <section className="grid gap-4 rounded-2xl border border-slate-800/90 bg-slate-900/35 p-4">
                <PackSectionHeading
                  icon={<Zap className="h-4 w-4" />}
                  title="Scope and behavior"
                  description="Control where this pack appears, how it matches, and what it changes."
                />
                <fieldset className="grid gap-1.5">
                  <legend className="px-1 text-xs font-medium text-slate-400">
                    Scope
                  </legend>
                  <div className="flex rounded-full border border-slate-800 bg-slate-900/55 p-0.5">
                    {(["workspace", "global"] as const).map((scopeOption) => {
                      const disabled =
                        scopeOption === "workspace" && !workspaceRoot;

                      return (
                        <button
                          key={scopeOption}
                          type="button"
                          disabled={disabled}
                          aria-pressed={scope === scopeOption}
                          onClick={() => setScope(scopeOption)}
                          className={cn(
                            "h-8 flex-1 rounded-full px-3 text-xs font-medium transition-colors",
                            scope === scopeOption
                              ? "bg-slate-100 text-slate-950"
                              : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                            disabled &&
                              "cursor-not-allowed opacity-45 hover:bg-transparent",
                          )}
                        >
                          {getSmartContextPackScopeLabel(scopeOption)}
                        </button>
                      );
                    })}
                  </div>
                </fieldset>

                <label className="grid gap-1.5">
                  <span className="px-1 text-xs font-medium text-slate-400">
                    Variables
                  </span>
                  <Textarea
                    value={variablesInput}
                    onChange={(event) => setVariablesInput(event.target.value)}
                    placeholder="ticket_id, target_file, test_command=npm test"
                    className="min-h-20 resize-none rounded-xl border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-sky-500/30"
                  />
                </label>

                <label className="grid gap-1.5">
                  <span className="px-1 text-xs font-medium text-slate-400">
                    Trigger phrases
                  </span>
                  <Input
                    value={triggerPhrasesInput}
                    onChange={(event) =>
                      setTriggerPhrasesInput(event.target.value)
                    }
                    placeholder="review pr, frontend qa, debug build"
                    className="h-9 rounded-xl border-slate-800 bg-slate-900/70 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-sky-500/30"
                  />
                </label>

                <label className="grid gap-1.5">
                  <span className="px-1 text-xs font-medium text-slate-400">
                    Path patterns
                  </span>
                  <Input
                    value={triggerPathPatternsInput}
                    onChange={(event) =>
                      setTriggerPathPatternsInput(event.target.value)
                    }
                    placeholder="*.tsx, src/ui/**, package.json"
                    className="h-9 rounded-xl border-slate-800 bg-slate-900/70 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-sky-500/30"
                  />
                </label>
              </section>

              <section className="grid gap-3 rounded-2xl border border-slate-800/90 bg-slate-900/35 p-4">
                <PackSectionHeading
                  icon={<SlidersHorizontal className="h-4 w-4" />}
                  title="Setting overrides"
                  description="Optionally replace the active chat and execution settings."
                />

                <div
                  role="note"
                  className="rounded-xl border border-sky-500/15 bg-sky-500/[0.06] px-3 py-2 text-[11px] leading-5 text-slate-400"
                >
                  <span className="font-semibold text-sky-200">No Save</span>{" "}
                  keeps the current or last-used value. Any other choice is
                  applied every time the pack is used.
                </div>

                <div className="grid gap-2 rounded-xl border border-slate-800 bg-slate-950/45 p-3">
                  <PackOption
                    label="Override model"
                    description="Store this provider and model in the pack."
                    checked={includeModel}
                    checkedLabel="Override"
                    uncheckedLabel="No Save"
                    onChange={setIncludeModel}
                  />
                  <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
                    <select
                      id="context-pack-provider"
                      aria-label="Model provider"
                      value={provider}
                      disabled={!includeModel}
                      onChange={(event) =>
                        setProvider(event.target.value as RuntimeProvider)
                      }
                      className={PACK_SELECT_CLASS}
                    >
                      {VALID_MODEL_PROVIDERS.map((providerOption) => (
                        <option key={providerOption} value={providerOption}>
                          {formatProviderOptionLabel(providerOption)}
                        </option>
                      ))}
                    </select>
                    <Input
                      id="context-pack-model"
                      aria-label="Model"
                      value={model}
                      disabled={!includeModel}
                      onChange={(event) => setModel(event.target.value)}
                      placeholder="gpt-5.5"
                      className="h-9 rounded-xl border-slate-800 bg-slate-950/70 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:border-sky-500/50 focus-visible:ring-2 focus-visible:ring-sky-500/20 disabled:cursor-not-allowed disabled:bg-slate-950/35 disabled:text-slate-600"
                    />
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <PackSettingField
                    id="context-pack-mode"
                    label="Execution mode"
                    description="Ask or Machdoch."
                    overridden={includeRunMode}
                  >
                    <select
                      id="context-pack-mode"
                      aria-describedby="context-pack-mode-description"
                      value={includeRunMode ? runMode : NO_SAVE_VALUE}
                      onChange={(event) => {
                        if (event.target.value === NO_SAVE_VALUE) {
                          setIncludeRunMode(false);
                          return;
                        }

                        setIncludeRunMode(true);
                        setRunMode(event.target.value as RunMode);
                      }}
                      className={PACK_SELECT_CLASS}
                    >
                      <option value={NO_SAVE_VALUE}>
                        No Save — keep current
                      </option>
                      {RUN_MODES.map((modeOption) => (
                        <option key={modeOption} value={modeOption}>
                          {getContextPackModeLabel(modeOption)}
                        </option>
                      ))}
                    </select>
                  </PackSettingField>

                  <PackSettingField
                    id="context-pack-reasoning"
                    label="Reasoning"
                    description="Reasoning effort for the model."
                    overridden={includeReasoning}
                  >
                    <select
                      id="context-pack-reasoning"
                      aria-describedby="context-pack-reasoning-description"
                      value={includeReasoning ? reasoning : NO_SAVE_VALUE}
                      onChange={(event) => {
                        if (event.target.value === NO_SAVE_VALUE) {
                          setIncludeReasoning(false);
                          return;
                        }

                        setIncludeReasoning(true);
                        setReasoning(event.target.value as ReasoningMode);
                      }}
                      className={PACK_SELECT_CLASS}
                    >
                      <option value={NO_SAVE_VALUE}>
                        No Save — keep current
                      </option>
                      {REASONING_MODES.map((reasoningOption) => (
                        <option key={reasoningOption} value={reasoningOption}>
                          {getContextPackReasoningLabel(reasoningOption)}
                        </option>
                      ))}
                    </select>
                  </PackSettingField>
                </div>

                <PackSettingField
                  id="context-pack-prompt-enhancer"
                  label="Prompt Enhancer"
                  description="Keep, disable, or select the enhancement mode."
                  overridden={promptEnhancementOverride !== NO_SAVE_VALUE}
                >
                  <select
                    id="context-pack-prompt-enhancer"
                    aria-describedby="context-pack-prompt-enhancer-description"
                    value={promptEnhancementOverride}
                    onChange={(event) =>
                      setPromptEnhancementOverride(
                        event.target.value as
                          | PromptEnhancementMode
                          | typeof NO_SAVE_VALUE,
                      )
                    }
                    className={PACK_SELECT_CLASS}
                  >
                    <option value={NO_SAVE_VALUE}>
                      No Save — keep current
                    </option>
                    {PROMPT_ENHANCEMENT_MODES.map((modeOption) => (
                      <option key={modeOption} value={modeOption}>
                        {PROMPT_ENHANCEMENT_LABELS[modeOption]}
                      </option>
                    ))}
                  </select>
                </PackSettingField>

                <div className="grid gap-2 sm:grid-cols-2">
                  <PackSettingField
                    id="context-pack-interview"
                    label="Interview"
                    description="Pre-task interview flow."
                    overridden={interviewOverride !== NO_SAVE_VALUE}
                  >
                    <select
                      id="context-pack-interview"
                      aria-describedby="context-pack-interview-description"
                      value={interviewOverride}
                      onChange={(event) =>
                        setInterviewOverride(
                          event.target.value as PackBooleanOverride,
                        )
                      }
                      className={PACK_SELECT_CLASS}
                    >
                      <option value={NO_SAVE_VALUE}>
                        No Save — keep current
                      </option>
                      <option value="enabled">Enabled</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  </PackSettingField>

                  <PackSettingField
                    id="context-pack-session-memory"
                    label="Session memory"
                    description="Memory within this chat."
                    overridden={sessionMemoryOverride !== NO_SAVE_VALUE}
                  >
                    <select
                      id="context-pack-session-memory"
                      aria-describedby="context-pack-session-memory-description"
                      value={sessionMemoryOverride}
                      onChange={(event) =>
                        setSessionMemoryOverride(
                          event.target.value as PackBooleanOverride,
                        )
                      }
                      className={PACK_SELECT_CLASS}
                    >
                      <option value={NO_SAVE_VALUE}>
                        No Save — keep current
                      </option>
                      <option value="enabled">Enabled</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  </PackSettingField>

                  <PackSettingField
                    id="context-pack-global-memory"
                    label="Global memory"
                    description="Memory shared across chats."
                    overridden={globalMemoryOverride !== NO_SAVE_VALUE}
                  >
                    <select
                      id="context-pack-global-memory"
                      aria-describedby="context-pack-global-memory-description"
                      value={globalMemoryOverride}
                      onChange={(event) =>
                        setGlobalMemoryOverride(
                          event.target.value as PackBooleanOverride,
                        )
                      }
                      className={PACK_SELECT_CLASS}
                    >
                      <option value={NO_SAVE_VALUE}>
                        No Save — keep current
                      </option>
                      <option value="enabled">Enabled</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  </PackSettingField>

                  <PackSettingField
                    id="context-pack-ui-control"
                    label="UI control"
                    description="Allow desktop UI interaction."
                    overridden={uiControlOverride !== NO_SAVE_VALUE}
                  >
                    <select
                      id="context-pack-ui-control"
                      aria-describedby="context-pack-ui-control-description"
                      value={uiControlOverride}
                      onChange={(event) =>
                        setUiControlOverride(
                          event.target.value as PackBooleanOverride,
                        )
                      }
                      className={PACK_SELECT_CLASS}
                    >
                      <option value={NO_SAVE_VALUE}>
                        No Save — keep current
                      </option>
                      <option value="enabled">Enabled</option>
                      <option value="disabled">Disabled</option>
                    </select>
                  </PackSettingField>
                </div>
              </section>
            </div>

            <DialogFooter className="flex-row items-center justify-end border-t border-slate-800/80 bg-slate-950/95 px-4 py-3 sm:px-5">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                className="h-9 rounded-full px-4 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="outline"
                disabled={!canSave}
                {...SUBMIT_SHORTCUT_ACTION_PROPS}
                className="h-9 rounded-full border-sky-500/25 bg-sky-500/10 px-4 text-xs font-semibold text-sky-100 shadow-none hover:bg-sky-500/15 hover:text-white disabled:border-slate-800 disabled:bg-slate-900/60 disabled:text-slate-600"
              >
                <Save className="h-3.5 w-3.5" />
                {initialValue.mode === "edit" ? "Update pack" : "Save pack"}
              </Button>
            </DialogFooter>
          </form>
        </SubmitShortcut>
      </DialogContent>
    </Dialog>
  );
};

const SmartContextPackCard = ({
  item,
  applyingPackId,
  pendingDeletePackId,
  onEditPack,
  onApplyPack,
  onDeleteContextPack,
}: {
  item: SmartContextPackListItem;
  applyingPackId: string | null;
  pendingDeletePackId: string | null;
  onEditPack: (pack: SmartContextPack) => void;
  onApplyPack: (pack: SmartContextPack) => void;
  onDeleteContextPack: (pack: SmartContextPack) => void | Promise<void>;
}): JSX.Element => {
  const { pack, isMatched, ralphFlowNames } = item;
  const scopeLabel = getSmartContextPackScopeLabel(item.scope);
  const isPendingUsedPackDelete =
    pendingDeletePackId === pack.id && ralphFlowNames.length > 0;

  return (
    <div
      className={cn(
        "rounded-xl border bg-slate-900/55 px-2.5 py-1.5 transition-colors",
        isMatched ? "border-sky-500/30 bg-sky-500/10" : "border-slate-800/90",
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">
            {pack.name}
          </p>
          <ControlTooltip content={`${scopeLabel} context pack`}>
            <span
              role="img"
              aria-label={`${scopeLabel} context pack`}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-800/80 bg-slate-950/60"
            >
              {item.scope === "global" ? (
                <Globe2 className="h-3 w-3 text-emerald-200" />
              ) : (
                <Folder className="h-3 w-3 text-slate-400" />
              )}
            </span>
          </ControlTooltip>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={`Edit context pack ${pack.name}`}
            tooltip={`Edit ${pack.name}`}
            disabled={applyingPackId !== null}
            onClick={() => onEditPack(pack)}
            className="h-7 w-7 rounded-full border-slate-800 bg-transparent text-slate-400 shadow-none hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100 disabled:border-slate-800 disabled:bg-transparent disabled:text-slate-600"
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={`Apply context pack ${pack.name}`}
            tooltip={`Apply ${pack.name}`}
            disabled={applyingPackId !== null}
            onClick={() => onApplyPack(pack)}
            className="h-7 w-7 rounded-full border-sky-500/20 bg-sky-500/10 text-sky-100 shadow-none hover:bg-sky-500/15 hover:text-white disabled:border-slate-800 disabled:bg-transparent disabled:text-slate-600"
          >
            <Play className="h-3 w-3 fill-current" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={`Delete context pack ${pack.name}`}
            tooltip={`Delete ${pack.name}`}
            disabled={applyingPackId === pack.id}
            onClick={() => void onDeleteContextPack(pack)}
            className="h-7 w-7 rounded-full border-rose-500/20 bg-transparent text-rose-200 shadow-none hover:bg-rose-500/10 hover:text-white disabled:border-slate-800 disabled:bg-transparent disabled:text-slate-600"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {isPendingUsedPackDelete ? (
        <div className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-xs leading-5 text-amber-100">
          This pack is used by {ralphFlowNames.join(", ")}. Click delete again
          to remove it anyway.
        </div>
      ) : null}
    </div>
  );
};

export const SmartContextPackPicker = ({
  contextPacks,
  workspaceRoot,
  activeDraft,
  activeProvider,
  activeModel,
  activeRunMode,
  activeReasoning,
  activePromptEnhancementMode,
  activeInterviewEnabled,
  activeSessionMemoryEnabled,
  activeUseGlobalMemory,
  activeUiControlEnabled,
  contextAttachments,
  matchedContextPackIds,
  workspaceLabel,
  onSaveContextPack,
  onApplyContextPack,
  onDeleteContextPack,
  onExportContextPacks,
  onImportContextPacks,
}: SmartContextPackPickerProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<SmartContextPackView>("apply");
  const [packDialog, setPackDialog] =
    useState<SmartContextPackDialogState | null>(null);
  const [scopeFilter, setScopeFilter] =
    useState<SmartContextPackScopeFilter>("all");
  const [packSearchText, setPackSearchText] = useState("");
  const [configuringPackId, setConfiguringPackId] = useState<string | null>(
    null,
  );
  const [variableValues, setVariableValues] = useState<Record<string, string>>(
    {},
  );
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyingPackId, setApplyingPackId] = useState<string | null>(null);
  const [pendingDeletePackId, setPendingDeletePackId] = useState<string | null>(
    null,
  );
  const [ralphPackUsageById, setRalphPackUsageById] = useState<
    Record<string, string[]>
  >({});
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const packSearchInputRef = useRef<HTMLInputElement | null>(null);
  const matchedPackIds = useMemo(
    () => new Set(matchedContextPackIds),
    [matchedContextPackIds],
  );
  const sortedPacks = useMemo(() => {
    return [...contextPacks].sort((left, right) => {
      return (
        getSmartContextPackSortTimestamp(right) -
        getSmartContextPackSortTimestamp(left)
      );
    });
  }, [contextPacks]);
  const packItems = useMemo<SmartContextPackListItem[]>(() => {
    return sortedPacks.map((pack) => ({
      pack,
      scope: getSmartContextPackScope(pack),
      isMatched: matchedPackIds.has(pack.id),
      ralphFlowNames: ralphPackUsageById[pack.id] ?? [],
    }));
  }, [matchedPackIds, ralphPackUsageById, sortedPacks]);
  const scopedPackItems = useMemo(
    () =>
      packItems.filter(
        (item) => scopeFilter === "all" || item.scope === scopeFilter,
      ),
    [packItems, scopeFilter],
  );
  const visiblePackItems = useMemo<SmartContextPackListItem[]>(() => {
    if (!packSearchText.trim()) {
      return scopedPackItems;
    }

    return scopedPackItems
      .map((item, order) => ({
        item,
        order,
        score: scoreContextPackSearchItem(item, packSearchText),
      }))
      .filter((entry) => entry.score > 0)
      .sort((firstEntry, secondEntry) => {
        const scoreDifference = secondEntry.score - firstEntry.score;

        if (scoreDifference !== 0) {
          return scoreDifference;
        }

        return firstEntry.order - secondEntry.order;
      })
      .map((entry) => entry.item);
  }, [packSearchText, scopedPackItems]);
  const workspacePackCount = packItems.filter(
    (item) => item.scope === "workspace",
  ).length;
  const globalPackCount = packItems.filter(
    (item) => item.scope === "global",
  ).length;
  const configuringPack =
    configuringPackId === null
      ? null
      : (sortedPacks.find((pack) => pack.id === configuringPackId) ?? null);
  const missingVariableNames = configuringPack
    ? getSmartContextPackMissingVariableNames(configuringPack, variableValues)
    : [];

  const handlePopoverOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);

    if (nextOpen) {
      setView("apply");
      setPackSearchText("");
      return;
    }

    setView("apply");
    setConfiguringPackId(null);
    setPackSearchText("");
  };

  const openCreateDialog = useCallback((): void => {
    const nextScope =
      !workspaceRoot || scopeFilter === "global" ? "global" : "workspace";

    setPackDialog({
      key: `create-${Date.now()}`,
      initialValue: {
        mode: "create",
        name: deriveContextPackName(activeDraft),
        scope: nextScope,
        instructions: "",
        prompt: activeDraft,
        contextAttachments,
        variables: extractSmartContextPackVariables(activeDraft).map(
          (name) => ({
            name,
          }),
        ),
        triggerPhrases: [],
        triggerPathPatterns: [],
        provider: activeProvider,
        model: activeModel,
        runMode: activeRunMode,
        reasoning: activeReasoning,
        promptEnhancementMode: activePromptEnhancementMode,
        interviewEnabled: activeInterviewEnabled,
        sessionMemoryEnabled: activeSessionMemoryEnabled,
        useGlobalMemory: activeUseGlobalMemory,
        uiControlEnabled: activeUiControlEnabled,
      },
    });
    setOpen(false);
    setView("apply");
    setPackSearchText("");
  }, [
    activeDraft,
    activeInterviewEnabled,
    activeModel,
    activePromptEnhancementMode,
    activeProvider,
    activeReasoning,
    activeRunMode,
    activeSessionMemoryEnabled,
    activeUiControlEnabled,
    activeUseGlobalMemory,
    contextAttachments,
    scopeFilter,
    workspaceRoot,
  ]);

  const openEditDialog = useCallback((pack: SmartContextPack): void => {
    setPackDialog({
      key: `edit-${pack.id}-${Date.now()}`,
      initialValue: {
        id: pack.id,
        mode: "edit",
        name: pack.name,
        scope: getSmartContextPackScope(pack),
        instructions: pack.instructions,
        prompt: pack.prompt,
        contextAttachments: pack.contextAttachments,
        variables: pack.variables,
        triggerPhrases: pack.trigger.phrases,
        triggerPathPatterns: pack.trigger.pathPatterns,
        ...(pack.provider ? { provider: pack.provider } : {}),
        ...(pack.model ? { model: pack.model } : {}),
        ...(pack.mode ? { runMode: pack.mode } : {}),
        ...(pack.reasoning ? { reasoning: pack.reasoning } : {}),
        ...(pack.promptEnhancementMode !== undefined
          ? { promptEnhancementMode: pack.promptEnhancementMode }
          : {}),
        ...(pack.interviewEnabled !== undefined
          ? { interviewEnabled: pack.interviewEnabled }
          : {}),
        ...(pack.sessionMemoryEnabled !== undefined
          ? { sessionMemoryEnabled: pack.sessionMemoryEnabled }
          : {}),
        ...(pack.useGlobalMemory !== undefined
          ? { useGlobalMemory: pack.useGlobalMemory }
          : {}),
        ...(pack.uiControlEnabled !== undefined
          ? { uiControlEnabled: pack.uiControlEnabled }
          : {}),
      },
    });
    setOpen(false);
    setView("apply");
    setPackSearchText("");
  }, []);

  const handlePackDialogSubmit = (input: SaveSmartContextPackInput): void => {
    onSaveContextPack(input);
    setPackDialog(null);
  };

  const openConfigureView = (pack: SmartContextPack): void => {
    setConfiguringPackId(pack.id);
    setApplyError(null);
    setVariableValues(
      Object.fromEntries(
        pack.variables.map((variable) => [
          variable.name,
          variable.defaultValue ?? "",
        ]),
      ),
    );
    setView("configure");
  };

  const applyPack = useCallback(
    (pack: SmartContextPack): void => {
      if (applyingPackId) {
        return;
      }

      if (pack.variables.length > 0) {
        openConfigureView(pack);
        return;
      }

      setApplyingPackId(pack.id);
      void Promise.resolve()
        .then(() => onApplyContextPack(pack.id))
        .then(() => {
          setOpen(false);
          setPackSearchText("");
        })
        .catch((error) => {
          console.error("Failed to apply context pack", error);
        })
        .finally(() => {
          setApplyingPackId(null);
        });
    },
    [applyingPackId, onApplyContextPack],
  );

  const handlePackSearchKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key !== "Enter" || !packSearchText.trim()) {
      return;
    }

    const bestMatch = visiblePackItems[0];

    if (!bestMatch) {
      return;
    }

    event.preventDefault();
    applyPack(bestMatch.pack);
  };

  const loadRalphPackUsage = useCallback(async (): Promise<
    Record<string, string[]>
  > => {
    if (!workspaceRoot) {
      return {};
    }

    const nextUsage: Record<string, string[]> = {};
    const flowList = await listRalphFlows(workspaceRoot);

    for (const summary of flowList.flows) {
      const flowResult = await showRalphFlow(workspaceRoot, summary.id);
      const packIds = collectRalphFlowPackIds(flowResult.flow);

      for (const packId of packIds) {
        nextUsage[packId] = [
          ...(nextUsage[packId] ?? []),
          flowResult.flow.name || flowResult.flow.id,
        ];
      }
    }

    return nextUsage;
  }, [workspaceRoot]);

  useEffect(() => {
    if (!open || !workspaceRoot) {
      setRalphPackUsageById({});
      setPendingDeletePackId(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      const nextUsage = await loadRalphPackUsage();

      if (!cancelled) {
        setRalphPackUsageById(nextUsage);
      }
    })().catch(() => {
      if (!cancelled) {
        setRalphPackUsageById({});
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loadRalphPackUsage, open, workspaceRoot]);

  const requestDeletePack = useCallback(
    async (pack: SmartContextPack): Promise<void> => {
      let latestUsage = ralphPackUsageById;

      try {
        latestUsage = await loadRalphPackUsage();
        setRalphPackUsageById(latestUsage);
      } catch {
        // Keep the last known usage map if the refresh fails.
      }

      const ralphFlowNames = latestUsage[pack.id] ?? [];

      if (ralphFlowNames.length > 0 && pendingDeletePackId !== pack.id) {
        setPendingDeletePackId(pack.id);
        return;
      }

      setPendingDeletePackId(null);
      onDeleteContextPack(pack.id);
    },
    [
      loadRalphPackUsage,
      onDeleteContextPack,
      pendingDeletePackId,
      ralphPackUsageById,
    ],
  );

  const handleConfiguredApply = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (!configuringPack) {
      return;
    }

    if (missingVariableNames.length > 0) {
      setApplyError(`Required: ${missingVariableNames.join(", ")}`);
      return;
    }

    setApplyingPackId(configuringPack.id);
    void Promise.resolve()
      .then(() => onApplyContextPack(configuringPack.id, variableValues))
      .then(() => {
        setOpen(false);
        setView("apply");
        setConfiguringPackId(null);
        setVariableValues({});
        setApplyError(null);
        setPackSearchText("");
      })
      .catch((error) => {
        console.error("Failed to apply context pack", error);
        setApplyError("Could not apply this pack.");
      })
      .finally(() => {
        setApplyingPackId(null);
      });
  };

  const handleImportFileChange = (
    event: ChangeEvent<HTMLInputElement>,
  ): void => {
    const [file] = Array.from(event.target.files ?? []);

    if (file) {
      onImportContextPacks(
        file,
        workspaceRoot && scopeFilter !== "global" ? "workspace" : "global",
      );
    }

    event.target.value = "";
  };
  const contextPackCommands = useMemo<readonly CommandDefinition[]>(
    () => [
      {
        id: "chat.context-pack.apply",
        title: "Apply context pack",
        group: "Chat",
        keywords: ["preset", "setup"],
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        overlayPolicy: "replace-non-modal",
        availability: () =>
          sortedPacks.length === 0
            ? { state: "disabled", reason: "No context packs" }
            : applyingPackId
              ? { state: "disabled", reason: "A context pack is being applied" }
              : { state: "enabled" },
        children: () => ({
          id: "chat-context-pack-apply",
          title: "Apply context pack",
          searchPlaceholder: "Choose context pack",
          groups: [
            {
              id: "packs",
              items: packItems.map(({ pack, scope, isMatched }) => ({
                id: pack.id,
                title: pack.name,
                keywords: [
                  formatScopeFilterLabel(scope),
                  pack.prompt,
                  ...(isMatched ? ["matched"] : []),
                ],
                execute: () => applyPack(pack),
              })),
            },
          ],
        }),
      },
      {
        id: "chat.context-pack.create",
        title: "Save current setup as context pack",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        overlayPolicy: "replace-non-modal",
        execute: () => openCreateDialog(),
      },
      {
        id: "chat.context-pack.edit",
        title: "Edit context pack",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          sortedPacks.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No context packs" },
        children: () => ({
          id: "chat-context-pack-edit",
          title: "Edit context pack",
          searchPlaceholder: "Choose context pack",
          groups: [
            {
              id: "packs",
              items: sortedPacks.map((pack) => ({
                id: pack.id,
                title: pack.name,
                execute: () => openEditDialog(pack),
              })),
            },
          ],
        }),
      },
      {
        id: "chat.context-pack.delete",
        title: "Delete context pack",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          sortedPacks.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No context packs" },
        children: () => ({
          id: "chat-context-pack-delete",
          title: "Delete context pack",
          searchPlaceholder: "Choose context pack",
          groups: [
            {
              id: "packs",
              items: sortedPacks.map((pack) => ({
                id: pack.id,
                title: pack.name,
                execute: async () => requestDeletePack(pack),
              })),
            },
          ],
        }),
      },
      {
        id: "chat.context-pack.import",
        title: "Import context packs",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        overlayPolicy: "replace-non-modal",
        execute: () => importInputRef.current?.click(),
      },
      {
        id: "chat.context-pack.export",
        title: "Export context packs",
        group: "Chat",
        scope: { kind: "view", ownerId: "chat" },
        palette: "visible",
        availability: () =>
          sortedPacks.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No context packs" },
        children: () => ({
          id: "chat-context-pack-export",
          title: "Export context packs",
          searchPlaceholder: "Choose scope",
          numericSelection: true,
          groups: [
            {
              id: "scope",
              items: (["all", "workspace", "global"] as const).map(
                (scope, index): CommandPageItem => ({
                  id: scope,
                  title: formatScopeFilterLabel(scope),
                  numericKey: String(
                    index + 1,
                  ) as CommandPageItem["numericKey"],
                  availability:
                    scope === "workspace" && !workspaceRoot
                      ? { state: "disabled", reason: "No workspace selected" }
                      : packItems.some(
                            (item) => scope === "all" || item.scope === scope,
                          )
                        ? { state: "enabled" }
                        : { state: "disabled", reason: "No matching packs" },
                  execute: () => onExportContextPacks(scope),
                }),
              ),
            },
          ],
        }),
      },
    ],
    [
      applyingPackId,
      applyPack,
      onExportContextPacks,
      openCreateDialog,
      openEditDialog,
      packItems,
      requestDeletePack,
      sortedPacks,
      workspaceRoot,
    ],
  );
  useOptionalRegisterCommands(contextPackCommands);

  return (
    <>
      <Popover open={open} onOpenChange={handlePopoverOpenChange}>
        <ControlTooltip content="Context packs">
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              aria-label="Context packs"
              className="app-context-pack-trigger h-8 rounded-full border-slate-800 bg-slate-950/70 px-3 text-xs font-medium text-slate-300 shadow-none hover:border-sky-500/30 hover:bg-slate-900 hover:text-slate-100"
            >
              <Layers className="h-3.5 w-3.5 text-sky-300" />
              <span className="hidden sm:inline">
                {contextPacks.length > 0
                  ? `Packs (${contextPacks.length})`
                  : "Packs"}
              </span>
            </Button>
          </PopoverTrigger>
        </ControlTooltip>
        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[28rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border-slate-800 bg-slate-950/98 p-0 shadow-xl shadow-slate-950/40 backdrop-blur-xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            packSearchInputRef.current?.focus();
          }}
        >
          <div className="border-b border-slate-800/80 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold tracking-[0.16em] text-slate-500 uppercase">
                  Context packs
                </p>
                <p className="mt-1 truncate text-sm font-semibold text-slate-100">
                  {workspaceLabel}
                </p>
                <p className="mt-1 text-[11px] text-slate-500">
                  {globalPackCount} global / {workspacePackCount} workspace
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <input
                  ref={importInputRef}
                  type="file"
                  aria-label="Context pack import file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={handleImportFileChange}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Import context packs"
                  tooltip={`Import ${formatScopeFilterLabel(
                    workspaceRoot && scopeFilter !== "global"
                      ? "workspace"
                      : "global",
                  ).toLowerCase()} context packs`}
                  onClick={() => importInputRef.current?.click()}
                  className="h-8 w-8 rounded-full border-slate-800 bg-slate-900/70 text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100"
                >
                  <Upload className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label="Export context packs"
                  tooltip={`Export ${formatScopeFilterLabel(
                    scopeFilter,
                  ).toLowerCase()} context packs`}
                  disabled={scopedPackItems.length === 0}
                  onClick={() => onExportContextPacks(scopeFilter)}
                  className="h-8 w-8 rounded-full border-slate-800 bg-slate-900/70 text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100 disabled:text-slate-600"
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={openCreateDialog}
                  className="h-8 rounded-full border-sky-500/20 bg-sky-500/10 px-3 text-xs text-sky-100 shadow-none hover:bg-sky-500/15 hover:text-white"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Save
                </Button>
              </div>
            </div>
            <div className="mt-3 flex rounded-full border border-slate-800 bg-slate-900/55 p-0.5">
              {(["all", "workspace", "global"] as const).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => setScopeFilter(scope)}
                  className={cn(
                    "h-7 flex-1 rounded-full px-2 text-xs font-medium transition-colors",
                    scopeFilter === scope
                      ? "bg-slate-100 text-slate-950"
                      : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                  )}
                >
                  {formatScopeFilterLabel(scope)}
                </button>
              ))}
            </div>
            {view === "apply" ? (
              <SearchField
                ref={packSearchInputRef}
                value={packSearchText}
                onChange={(event) => setPackSearchText(event.target.value)}
                onKeyDown={handlePackSearchKeyDown}
                aria-label="Search context packs"
                placeholder="Search packs"
                autoComplete="off"
                spellCheck={false}
                containerClassName="mt-3"
                className="h-9 rounded-2xl border-slate-800 bg-slate-900/70 pr-3 text-sm text-slate-100 shadow-none placeholder:text-slate-500 focus-visible:border-sky-400/50 focus-visible:ring-sky-400/30"
              />
            ) : null}
          </div>

          {view === "apply" ? (
            <div className="grid max-h-[26rem] gap-1.5 overflow-y-auto p-3">
              {scopedPackItems.length === 0 ? (
                <button
                  type="button"
                  onClick={openCreateDialog}
                  className="grid gap-2 rounded-2xl border border-dashed border-slate-800 bg-slate-900/45 px-4 py-5 text-left text-slate-300 hover:border-sky-500/30 hover:bg-sky-500/10 hover:text-sky-100"
                >
                  <span className="text-sm font-semibold">
                    Save current setup
                  </span>
                  <span className="text-xs leading-5 text-slate-500">
                    Create a reusable pack from the current setup.
                  </span>
                </button>
              ) : null}

              {scopedPackItems.length > 0 && visiblePackItems.length === 0 ? (
                <EmptyState
                  icon={Search}
                  title="No matching context packs"
                  size="compact"
                  role="status"
                  className="rounded-2xl bg-slate-900/60"
                />
              ) : null}

              {visiblePackItems.map((item) => (
                <SmartContextPackCard
                  key={item.pack.id}
                  item={item}
                  applyingPackId={applyingPackId}
                  pendingDeletePackId={pendingDeletePackId}
                  onEditPack={openEditDialog}
                  onApplyPack={applyPack}
                  onDeleteContextPack={requestDeletePack}
                />
              ))}
            </div>
          ) : configuringPack ? (
            <SubmitShortcut asChild>
              <form
                className={PACK_FORM_CLASS}
                onSubmit={handleConfiguredApply}
              >
                <div className="grid gap-1">
                  <p className="text-sm font-semibold text-slate-100">
                    {configuringPack.name}
                  </p>
                  <p className="text-xs leading-5 text-slate-500">
                    Fill variables before applying this pack.
                  </p>
                  {applyError ? (
                    <p className="text-xs leading-5 text-amber-100">
                      {applyError}
                    </p>
                  ) : null}
                </div>

                <div className="grid max-h-64 gap-2 overflow-y-auto pr-1">
                  {configuringPack.variables.map((variable) => (
                    <label key={variable.name} className="grid gap-1.5">
                      <span className="px-1 text-xs font-medium text-slate-400">
                        {variable.name}
                      </span>
                      <Input
                        value={variableValues[variable.name] ?? ""}
                        onChange={(event) =>
                          setVariableValues((prev) => ({
                            ...prev,
                            [variable.name]: event.target.value,
                          }))
                        }
                        onFocus={() => setApplyError(null)}
                        placeholder={variable.defaultValue ?? variable.name}
                        className="h-9 rounded-xl border-slate-800 bg-slate-900/70 text-sm text-slate-100 placeholder:text-slate-600 focus-visible:ring-sky-500/30"
                      />
                    </label>
                  ))}
                </div>

                <div className="flex items-center justify-between gap-2 border-t border-slate-800/80 pt-3">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setView("apply");
                      setConfiguringPackId(null);
                      setVariableValues({});
                      setApplyError(null);
                    }}
                    className="h-8 rounded-full px-3 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                  >
                    Back
                  </Button>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={
                      missingVariableNames.length > 0 ||
                      applyingPackId === configuringPack.id
                    }
                    {...SUBMIT_SHORTCUT_ACTION_PROPS}
                    className="h-8 rounded-full border-sky-500/20 bg-sky-500/10 px-3 text-xs text-sky-100 shadow-none hover:bg-sky-500/15 hover:text-white disabled:border-slate-800 disabled:bg-slate-900/60 disabled:text-slate-600"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                    Apply pack
                  </Button>
                </div>
              </form>
            </SubmitShortcut>
          ) : null}
        </PopoverContent>
      </Popover>
      {packDialog ? (
        <SmartContextPackEditorDialog
          key={packDialog.key}
          open
          initialValue={packDialog.initialValue}
          workspaceRoot={workspaceRoot}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setPackDialog(null);
            }
          }}
          onSubmit={handlePackDialogSubmit}
        />
      ) : null}
    </>
  );
};
