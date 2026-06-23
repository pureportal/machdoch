import {
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type NodeChange,
  type ProOptions,
  type OnNodeDrag,
  type ReactFlowInstance,
  type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  FileJson,
  FileText,
  Globe2,
  GripVertical,
  History,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  Octagon,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  RotateCcw,
  Route,
  Save,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Undo2,
  Variable,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  createImageInputUnsupportedModelMessage,
  getSupportedImageInputExtensions,
  modelSupportsImageInput,
} from "../../../core/model-capabilities.js";
import type {
  RalphGenerationEvent,
  RalphGenerationInterviewSession,
} from "../../../core/ralph-generation.js";
import type {
  RalphAttachmentReference,
  RalphBlockSettings,
  RalphBlockType,
  RalphExecutionOutput,
  RalphFlow,
  RalphFlowBlock,
  RalphFlowEdge,
  RalphFlowScope,
  RalphFlowRevisionSummary,
  RalphFlowSummary,
  RalphInputField,
  RalphInputValue,
  RalphPromptBlock,
  RalphPosition,
  RalphRunResult,
  RalphRunSummary,
  RalphUtilityCondition,
  RalphUtilityConfig,
  RalphUtilityConditionStyle,
  RalphUtilityType,
  RalphValidationScope,
  RalphVariableType,
} from "../../../core/ralph.js";
import type { TaskExecutionProgress } from "../../../core/types.js";
import type {
  ReasoningMode,
  RunMode,
} from "../../../core/runtime-contract.generated.js";
import {
  getCatalogModelsForProvider,
  getDefaultModelForProvider,
  type ProviderModelCatalogSnapshot,
  type RuntimeProvider,
} from "../model-catalog";
import {
  cancelDesktopTask,
  createRalphFlow,
  deleteRalphFlow,
  listRalphFlowRevisions,
  listRalphFlows,
  listRalphRuns,
  loadActiveDesktopTasks,
  loadProviderModelCatalog,
  resolveDroppedPaths,
  restoreRalphFlowRevision,
  resumeRalphRun,
  runRalphFlow,
  runRalphGenerationInterview,
  saveRalphFlow,
  showRalphRunDetail,
  showRalphRunLog,
  showRalphFlow,
  subscribeToDesktopTaskProgress,
  type RalphCreateFlowResult,
  type RalphGenerationInterviewResult,
  type RalphRunDetailResult,
} from "../runtime";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import {
  ContextAttachmentMenuButton,
  ContextAttachmentsList,
} from "../chat-session/components/context-attachments";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import {
  getReasoningModesForProvider,
  normalizeReasoningModeForProvider,
  REASONING_LABELS,
} from "../reasoning-options";
import { createFlowAlias } from "./_helpers/create-flow-alias.helper";
import {
  getBlockOutputs,
  isExecutableRalphCanvasBlock,
  isVisualRalphCanvasBlock,
} from "./_helpers/get-block-outputs.helper";
import {
  validateFlowLocally,
} from "./_helpers/validate-flow-locally.helper";
import {
  createRalphPathAttachment,
  getRalphPathAttachmentPreviews,
  getRalphVariableAttachmentItems,
  mergeRalphAttachments,
} from "./_helpers/ralph-attachments.helper";
import {
  RALPH_BLOCK_FALLBACK_HEIGHT,
  RALPH_CANVAS_X_GAP,
  RALPH_CANVAS_Y_GAP,
  RALPH_GROUP_DEFAULT_SIZE,
  RALPH_NOTE_DEFAULT_SIZE,
  createDerivedGroupChildrenById,
  flowToEdges,
  flowToNodes,
  forceRalphFlowLayout,
  getBlockFallbackWidth,
  getDefaultCanvasPosition,
  getSelectableRouteTargets,
  normalizeDerivedGroupMembership,
  type RalphCanvasEdge,
  type RalphCanvasNode,
} from "./_helpers/ralph-canvas-layout.helper";
import {
  formatCatalogModelLabel,
  formatFlowSubtitle,
  formatProviderOptionLabel,
  formatRouteOptionTargetLabel,
  formatRouteTargetLabel,
  formatUnconnectedRouteLabel,
  formatUtilityTypeLabel,
  formatValidationScopeLabel,
  titleFromId,
  type RalphProviderOption,
} from "./_helpers/format-ralph-flow-labels.helper";
import {
  getBlockTone,
  getBlockVisual,
  getUtilityTone,
} from "./_helpers/get-ralph-block-visual.helper";
import { getPromptLikeText } from "./_helpers/get-ralph-node-preview.helper";
import {
  DEFAULT_RALPH_FLOW_SCOPE,
  RALPH_FLOW_LIBRARY_LABELS,
  RALPH_FLOW_LIBRARY_MODES,
  RALPH_FLOW_SCOPES,
  RALPH_FLOW_SCOPE_LABELS,
  getDefaultCreationScope,
  isFlowScopeVisibleInLibraryMode,
  type RalphFlowLibraryMode,
} from "./_helpers/normalize-ralph-flow-scope.helper";
import {
  compareFlowSummaries,
  createUniqueFlowAlias,
  flowToSummary,
  getFlowSelectionKey,
  getFlowSummaryScope,
  getFlowSummarySelectionKey,
  hasFlowSelection,
  upsertFlowSummary,
  withFlowSummaryScope,
} from "./_helpers/upsert-flow-summary.helper";
import {
  createBlankFlow,
  getFlowAlias,
} from "./_helpers/create-blank-ralph-flow.helper";
import {
  EMPTY_RALPH_AI_PROMPT_HISTORY,
  addRalphAiPromptHistoryEntry,
  areRalphAiPromptHistoriesEqual,
  normalizeRalphAiPromptHistory,
} from "./_helpers/normalize-ralph-ai-prompt-history.helper";
import {
  formatDurationMs,
  formatRunRecordDuration,
  getTimestampMs,
} from "./_helpers/format-duration-ms.helper";
import { getRalphRecordEventLabel } from "./_helpers/get-ralph-record-event-label.helper";
import {
  createRalphRunTaskId,
  getRalphTaskAction,
  getRalphTaskFlowReference,
  getRalphTaskFlowScope,
  normalizeWorkspaceForTaskComparison,
  parseRalphRunTaskId,
} from "./_helpers/parse-ralph-run-task-id.helper";
import {
  createDefaultRalphInputValues,
  formatRalphInputValueForPrompt,
  getDefaultRalphInputValue,
  validateRalphInputFieldValues,
} from "./_helpers/validate-ralph-input-field-values.helper";
import {
  RALPH_EDGE_TYPES,
  RALPH_NODE_TYPES,
} from "./components/ralph-flow-canvas-elements";

export type { RalphFlowLibraryMode } from "./_helpers/normalize-ralph-flow-scope.helper";

export interface RalphFlowEditorProps {
  workspaceRoot: string | null;
  initialPrompt?: string;
  isActive?: boolean;
  flowLibraryMode?: RalphFlowLibraryMode;
  onFlowLibraryModeChange?: (mode: RalphFlowLibraryMode) => void;
  runMode: RunMode;
  generationProvider: RuntimeProvider;
  generationModel: string;
  generationProfile?: string;
  generationReasoning?: ReasoningMode;
  runProvider: RuntimeProvider;
  runModel: string;
  runProfile?: string;
  runReasoning?: ReasoningMode;
  defaultMaxTransitions?: number;
  providerOptions?: readonly RuntimeProvider[];
  generationPromptHistory?: readonly string[];
  onGenerationPromptHistoryChange?: (history: string[]) => void;
}

type RalphEditorMode = "design" | "generate" | "run" | "review";
type RalphAiTarget = "flow" | "prompt-block" | "refactor";
type RalphAiGenerationMode = "do-it" | "interview";
type RalphRunPanelTab = "setup" | "live" | "history" | "details" | "logs";
type ActiveRalphRunStatus = "running" | "stopping";
type RalphRunEventTone = NonNullable<
  NonNullable<TaskExecutionProgress["timelineEvent"]>["tone"]
>;
type RalphRunEventPhase =
  NonNullable<TaskExecutionProgress["timelineEvent"]>["phase"];
type ClipboardCopyState = "idle" | "copied" | "failed";
type RalphInspectorSectionId =
  | "content"
  | "execution"
  | "behavior"
  | "routes"
  | "advanced";
type RalphExpandedEditorMode = "text" | "code" | "json";
type RalphGenerationStatus =
  | "running"
  | "stopping"
  | "created"
  | "blocked"
  | "failed";
type RalphAttachmentSelectionKind = "files" | "folders" | "images";
type RalphCanvasMenu =
  | {
      type: "pane";
      left: number;
      top: number;
      position: RalphPosition;
    }
  | {
      type: "node";
      left: number;
      top: number;
      blockId: string;
    }
  | {
      type: "edge";
      left: number;
      top: number;
      edgeId: string;
    };

type RalphFlowListRow =
  | {
      type: "heading";
      scope: RalphFlowScope;
      count: number;
    }
  | {
      type: "flow";
      flow: RalphFlowSummary;
    };

interface RalphFlowListMenu {
  left: number;
  top: number;
  flow: RalphFlowSummary;
}

interface ActiveRalphRun {
  id: string;
  flowId: string;
  scope: RalphFlowScope;
  flowName: string;
  startedAt: number;
  status: ActiveRalphRunStatus;
  mode: RunMode;
  provider: RuntimeProvider;
  model: string;
  profile?: string;
  reasoning?: ReasoningMode;
  maxTransitions?: number;
  variableValues: Record<string, string>;
  events: ActiveRalphRunEvent[];
  currentBlockId?: string;
  currentBlockTitle?: string;
  lastEventType?: string;
  lastOutput?: string;
  lastMessage?: string;
}

interface ActiveRalphRunEvent {
  id: string;
  timestamp: number;
  eventType: string;
  label: string;
  phase: RalphRunEventPhase;
  tone: RalphRunEventTone;
  blockId?: string;
  blockTitle?: string;
  activeBlockId?: string;
  activeBlockTitle?: string;
  nextBlockId?: string;
  nextBlockTitle?: string;
  output?: string;
  attempt?: number;
  detail?: string;
}

interface RalphGenerationJob {
  id: string;
  target: RalphAiTarget;
  mode: RalphAiGenerationMode;
  scope: RalphFlowScope;
  targetFlowId: string | null;
  targetAlias: string;
  startedAt: number;
  status: RalphGenerationStatus;
  summary: string;
  activity: RalphGenerationActivityEvent[];
  currentRound?: number;
  maxRounds?: number;
  currentActor?: string;
  provider?: string;
  model?: string;
  flowPath?: string;
  tempFlowPath?: string;
  generationLogPath?: string;
  traceLogPath?: string;
  validationValid?: boolean;
  validationErrorCount?: number;
  validationWarningCount?: number;
  validatorDecision?: string;
  blockCount?: number;
  edgeCount?: number;
  result?: RalphCreateFlowResult;
  error?: string;
}

interface RalphAiGenerationStartContext {
  userPrompt: string;
  generationPrompt: string;
  target: RalphAiTarget;
  generationMode: RalphAiGenerationMode;
  targetScope: RalphFlowScope;
  targetFlowName: string;
  existingFlow?: RalphFlow;
  targetFlowId: string | null;
  selectedIdAtStart: string | null;
  selectedScopeAtStart: RalphFlowScope;
  draftSnapshotAtStart: string;
  savedSnapshotAtStart: string;
  draftWasDirtyAtStart: boolean;
  promptBlockLabel?: string;
}

type RalphGenerationInterviewDialogStatus =
  | "loading"
  | "ready"
  | "generating"
  | "blocked";

interface RalphGenerationInterviewDialogState {
  context: RalphAiGenerationStartContext;
  status: RalphGenerationInterviewDialogStatus;
  session?: RalphGenerationInterviewSession;
  fields: RalphInputField[];
  values: Record<string, RalphInputValue>;
  answerComments: Record<string, string>;
  expandedCommentFieldIds: string[];
  skippedFieldIds: string[];
  validationErrors: Record<string, string>;
  summary: string;
  findings: string[];
  assumptions: string[];
  relevantFiles: string[];
  finalPrompt?: string;
  provider?: string | null;
  model?: string | null;
  error?: string;
  taskId?: string;
}

interface RalphGenerationActivityEvent {
  id: string;
  type: string;
  label: string;
  timestamp: number;
  detail?: string;
  round?: number;
  maxRounds?: number;
  actor?: string;
  provider?: string;
  model?: string;
  flowPath?: string;
  tempFlowPath?: string;
  validationValid?: boolean;
  validationErrorCount?: number;
  validationWarningCount?: number;
  validatorDecision?: string;
  blockCount?: number;
  edgeCount?: number;
}

interface RalphExpandedEditorState {
  title: string;
  description: string;
  ariaLabel: string;
  mode: RalphExpandedEditorMode;
  value: string;
  supportsVariables?: boolean;
  onApply: (value: string) => void;
}

const getFlowRunStatusLabel = (runs: ActiveRalphRun[]): string | null => {
  if (runs.length === 0) {
    return null;
  }

  if (runs.some((run) => run.status === "stopping")) {
    return runs.length > 1 ? `${runs.length} stopping` : "Stopping";
  }

  return runs.length > 1 ? `${runs.length} running` : "Running";
};

const getFlowStatusPresentation = (
  statusLabel: string,
): {
  icon: LucideIcon;
  className: string;
  spin?: boolean;
} => {
  const normalizedStatus = statusLabel.toLowerCase();

  if (
    normalizedStatus.includes("running") ||
    normalizedStatus.includes("stopping")
  ) {
    return {
      icon: LoaderCircle,
      className: "text-sky-200",
      spin: true,
    };
  }

  if (statusLabel === "Generated") {
    return { icon: Sparkles, className: "text-emerald-200" };
  }

  if (statusLabel === "Unsaved") {
    return { icon: FileText, className: "text-amber-200" };
  }

  if (statusLabel === "Warnings") {
    return { icon: AlertTriangle, className: "text-amber-200" };
  }

  if (statusLabel === "Errors") {
    return { icon: AlertTriangle, className: "text-red-200" };
  }

  if (statusLabel === "Ready") {
    return { icon: Check, className: "text-emerald-200" };
  }

  return { icon: CheckCircle2, className: "text-slate-500" };
};

const EDITOR_MODES: Array<{
  id: RalphEditorMode;
  label: string;
}> = [
  { id: "design", label: "Design" },
  { id: "generate", label: "Generate" },
  { id: "run", label: "Run" },
  { id: "review", label: "Review" },
];

const BLOCK_ACTIONS: Array<{
  type: RalphBlockType;
  label: string;
}> = [
  { type: "START", label: "Start" },
  { type: "PROMPT", label: "Prompt" },
  { type: "VALIDATOR", label: "Validate" },
  { type: "DECISION", label: "Decision" },
  { type: "PACK", label: "Pack" },
  { type: "INPUT", label: "Input" },
  { type: "INTERVIEW", label: "Interview" },
  { type: "UTILITY", label: "Utility" },
  { type: "NOTE", label: "Note" },
  { type: "GROUP", label: "Group" },
  { type: "END", label: "End" },
];

const MCP_BLOCK_ACTIONS: Array<{
  type: RalphBlockType;
  label: string;
}> = [
  { type: "MCP_TOOL", label: "Tool" },
  { type: "MCP_RESOURCE", label: "Resource" },
  { type: "MCP_PROMPT", label: "Prompt" },
];

const UTILITY_TYPE_OPTIONS: RalphUtilityType[] = [
  "WAIT",
  "HTTP_FETCH",
  "POLL",
  "RUN_COMMAND",
  "READ_FILE",
  "WRITE_FILE",
  "SEARCH_FILES",
  "RUN_CHECK",
  "UI_ANALYZE",
  "GIT_STATUS",
  "SET_VARIABLE",
  "TRANSFORM_JSON",
  "VALIDATE_JSON",
  "NOTIFY",
];

const RALPH_INSPECTOR_STORAGE_KEY = "machdoch.ralph.inspector-width";
const RALPH_INSPECTOR_MIN_WIDTH = 352;
const RALPH_INSPECTOR_DEFAULT_WIDTH = 448;
const RALPH_INSPECTOR_MAX_WIDTH = 704;
const RALPH_INSPECTOR_SCROLL_EPSILON = 4;

const RALPH_INSPECTOR_SECTIONS: Array<{
  id: RalphInspectorSectionId;
  label: string;
}> = [
  { id: "content", label: "Content" },
  { id: "behavior", label: "Behavior" },
  { id: "execution", label: "Execution" },
  { id: "advanced", label: "Advanced" },
  { id: "routes", label: "Routes" },
];

const RALPH_VARIABLE_SNIPPETS = [
  "{{scope:path=ALL}}",
  "{{lastResult}}",
  "{{lastResultSummary}}",
  "{{targetUrl:url=http://localhost:1420}}",
  "{{verificationCommand:string=pnpm typecheck:ui}}",
] as const;

const clampRalphInspectorWidth = (
  value: number,
  viewportWidth = typeof window === "undefined" ? undefined : window.innerWidth,
): number => {
  const viewportMax =
    typeof viewportWidth === "number" && Number.isFinite(viewportWidth)
      ? Math.max(
          RALPH_INSPECTOR_MIN_WIDTH,
          Math.floor(viewportWidth * 0.48),
        )
      : RALPH_INSPECTOR_MAX_WIDTH;
  const maxWidth = Math.min(RALPH_INSPECTOR_MAX_WIDTH, viewportMax);

  return Math.min(
    maxWidth,
    Math.max(RALPH_INSPECTOR_MIN_WIDTH, Math.round(value)),
  );
};

const loadRalphInspectorWidth = (): number => {
  if (typeof window === "undefined") {
    return RALPH_INSPECTOR_DEFAULT_WIDTH;
  }

  try {
    const storedWidth = window.localStorage.getItem(RALPH_INSPECTOR_STORAGE_KEY);
    const parsedWidth = storedWidth ? Number.parseInt(storedWidth, 10) : NaN;

    return Number.isFinite(parsedWidth)
      ? clampRalphInspectorWidth(parsedWidth)
      : clampRalphInspectorWidth(RALPH_INSPECTOR_DEFAULT_WIDTH);
  } catch {
    return clampRalphInspectorWidth(RALPH_INSPECTOR_DEFAULT_WIDTH);
  }
};

const saveRalphInspectorWidth = (width: number): void => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(RALPH_INSPECTOR_STORAGE_KEY, String(width));
  } catch {
    // Inspector width is a preference; ignore persistence failures.
  }
};

interface RalphInspectorFieldProps {
  label: string;
  help?: string;
  className?: string;
  action?: ReactNode;
  children: ReactNode;
}

const RalphInspectorField = ({
  label,
  help,
  className,
  action,
  children,
}: RalphInspectorFieldProps): JSX.Element => {
  return (
    <div className={cn("grid gap-1.5 text-sm text-slate-100", className)}>
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate font-semibold">{label}</span>
        {action ? <span className="shrink-0">{action}</span> : null}
      </span>
      {children}
      {help ? (
        <span className="text-xs leading-4 text-slate-400">{help}</span>
      ) : null}
    </div>
  );
};

interface RalphInspectorDetailsProps {
  title: string;
  help?: string;
  children: ReactNode;
}

const RalphInspectorDetails = ({
  title,
  help,
  children,
}: RalphInspectorDetailsProps): JSX.Element => {
  return (
    <details className="group grid gap-2 rounded-lg bg-slate-900/35 px-3 py-2 ring-1 ring-slate-800/60">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-cyan-200 [&::-webkit-details-marker]:hidden">
        <span>{title}</span>
        <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" />
      </summary>
      <div className="mt-2 grid gap-2">
        {help ? (
          <p className="text-xs leading-4 text-slate-400">{help}</p>
        ) : null}
        {children}
      </div>
    </details>
  );
};

const PROVIDER_OPTIONS = [
  "default",
  "openai",
  "anthropic",
  "google",
  "codex-cli",
  "claude-cli",
  "copilot-cli",
] as const;

const DEFAULT_RUNTIME_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(
  (provider): provider is RuntimeProvider => provider !== "default",
);

const createRalphProviderOptions = (
  providers: readonly RuntimeProvider[],
): RalphProviderOption[] => {
  const options: RalphProviderOption[] = ["default"];
  const seen = new Set<RalphProviderOption>(options);

  for (const provider of providers) {
    if (!seen.has(provider)) {
      options.push(provider);
      seen.add(provider);
    }
  }

  return options;
};

const VARIABLE_TYPES: RalphVariableType[] = [
  "string",
  "text",
  "path",
  "file",
  "files",
  "url",
  "number",
  "boolean",
  "image",
  "images",
  "model",
  "provider",
  "pack",
];

const VALIDATION_SCOPE_OPTIONS: RalphValidationScope["mode"][] = [
  "sinceLastValidator",
  "previousBlock",
  "selectedBlocks",
  "wholeFlow",
];

const END_STATUS_OPTIONS = [
  "success",
  "failed",
  "cancelled",
  "review",
] as const;

const ANNOTATION_TONES: RalphAnnotationTone[] = [
  "slate",
  "amber",
  "sky",
  "lime",
  "rose",
  "violet",
];

const PLACEHOLDER_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/gu;
const MAX_RALPH_HISTORY_ENTRIES = 80;
const RALPH_CONTEXT_MENU_WIDTH = 224;
const RALPH_CONTEXT_MENU_HEIGHT = 360;
const RALPH_BLOCK_DUPLICATE_OFFSET = 36;
const RALPH_VALIDATION_JUMP_DURATION_MS = 220;
const RALPH_REACT_FLOW_PRO_OPTIONS = {
  hideAttribution: true,
} satisfies ProOptions;

const getCanvasMenuPlacement = (
  event: ReactMouseEvent,
): Pick<RalphCanvasMenu, "left" | "top"> => {
  const margin = 8;
  const maxLeft =
    typeof window === "undefined"
      ? event.clientX
      : Math.max(margin, window.innerWidth - RALPH_CONTEXT_MENU_WIDTH - margin);
  const maxTop =
    typeof window === "undefined"
      ? event.clientY
      : Math.max(margin, window.innerHeight - RALPH_CONTEXT_MENU_HEIGHT - margin);

  return {
    left: Math.max(margin, Math.min(event.clientX, maxLeft)),
    top: Math.max(margin, Math.min(event.clientY, maxTop)),
  };
};

const isEditableShortcutTarget = (target: EventTarget | null): boolean => {
  if (
    typeof HTMLElement === "undefined" ||
    !(target instanceof HTMLElement)
  ) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
};

const createBlockId = (
  flow: RalphFlow,
  type: RalphBlockType,
): string => {
  const base = type.toLowerCase();
  const usedIds = new Set(flow.blocks.map((block) => block.id));

  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;

    if (!usedIds.has(candidate)) {
      return candidate;
    }
  }

  return `${base}-${Date.now()}`;
};

const createCopiedBlock = (
  flow: RalphFlow,
  block: RalphFlowBlock,
  position?: RalphPosition,
): RalphFlowBlock | null => {
  if (block.type === "START" && flow.blocks.some((candidate) => candidate.type === "START")) {
    return null;
  }

  const id = createBlockId(flow, block.type);
  const cloned = JSON.parse(JSON.stringify(block)) as RalphFlowBlock;
  const fallbackPosition = block.position
    ? {
        x: block.position.x + RALPH_BLOCK_DUPLICATE_OFFSET,
        y: block.position.y + RALPH_BLOCK_DUPLICATE_OFFSET,
      }
    : getDefaultCanvasPosition(flow.blocks.length);

  return {
    ...cloned,
    id,
    title: block.type === "START" ? "Start" : `${block.title} Copy`,
    position: position ?? fallbackPosition,
  };
};

const createEdgeId = (
  flow: RalphFlow,
  from: string,
  output: RalphExecutionOutput,
  to: string,
): string => {
  const safeOutput = String(output)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  const base = `${from}-${safeOutput || "out"}-${to}`.slice(0, 110);
  const usedIds = new Set(flow.edges.map((edge) => edge.id));

  if (!usedIds.has(base)) {
    return base;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`.slice(0, 119);

    if (!usedIds.has(candidate)) {
      return candidate;
    }
  }

  return `${base}-${Date.now()}`.slice(0, 119);
};

const createDefaultUtilityConfig = (
  type: RalphUtilityType,
): RalphUtilityConfig => {
  switch (type) {
    case "WAIT":
      return { type, mode: "delay", delaySeconds: 1 };
    case "HTTP_FETCH":
      return {
        type,
        method: "GET",
        url: "{{url:url}}",
        timeoutSeconds: 30,
        maxOutputBytes: 1_000_000,
      };
    case "POLL":
      return {
        type,
        method: "GET",
        url: "{{url:url}}",
        intervalSeconds: 30,
        maxAttempts: null,
        ignoreErrors: true,
        condition: {
          style: "simple",
          expression: "status == 200",
        },
      };
    case "RUN_COMMAND":
      return { type, command: "npm test", timeoutSeconds: 120 };
    case "RUN_CHECK":
      return { type, command: "npm run typecheck", timeoutSeconds: 120 };
    case "UI_ANALYZE":
      return {
        type,
        adapter: "browser",
        targetUrl: "{{targetUrl:url=http://localhost:1420}}",
        server: {
          mode: "existing",
          healthUrl: "{{targetUrl:url=http://localhost:1420}}",
          reuseExisting: true,
        },
        checks: {
          screenshots: true,
          accessibility: true,
          console: true,
          network: true,
          responsive: true,
        },
        viewports: [
          { name: "desktop", width: 1280, height: 900 },
          { name: "mobile", width: 390, height: 844 },
        ],
        timeoutSeconds: 30,
        fullPage: true,
        waitUntil: "domcontentloaded",
      };
    case "READ_FILE":
      return { type, path: "{{file:path}}" };
    case "WRITE_FILE":
      return { type, path: "{{file:path}}", content: "{{lastResult}}" };
    case "SEARCH_FILES":
      return { type, rootPath: ".", pattern: "{{query:string}}" };
    case "GIT_STATUS":
      return { type, cwd: "." };
    case "SET_VARIABLE":
      return { type, variableName: "value", value: "{{lastResultSummary}}" };
    case "TRANSFORM_JSON":
      return { type, expression: "input" };
    case "VALIDATE_JSON":
      return {
        type,
        schema: {
          type: "object",
        },
      };
    case "NOTIFY":
      return { type, message: "{{lastResultSummary}}" };
  }
};

const formatJsonDraft = (value: unknown): string => {
  return JSON.stringify(value ?? {}, null, 2);
};

const parseJsonDraft = (value: string): unknown | undefined => {
  if (!value.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

const parseStringRecordDraft = (
  value: string,
): Record<string, string> | undefined => {
  const parsed = parseJsonDraft(value);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(parsed).flatMap(([key, entry]) =>
      typeof entry === "string" ? ([[key, entry]] as const) : [],
    ),
  );
};

const parseNumberList = (value: string): number[] | undefined => {
  const numbers = value
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isInteger(entry));

  return numbers.length > 0 ? numbers : undefined;
};

const getProviderOption = (
  provider: RalphBlockSettings["provider"] | undefined,
): RalphProviderOption => {
  return PROVIDER_OPTIONS.includes(provider as RalphProviderOption)
    ? (provider as RalphProviderOption)
    : "default";
};

const getEffectiveProvider = (
  provider: RalphProviderOption,
  activeProvider: RuntimeProvider,
): RuntimeProvider => {
  return provider === "default" ? activeProvider : provider;
};

const getPreferredModelForProvider = (
  provider: RuntimeProvider,
  snapshot: ProviderModelCatalogSnapshot | null,
): string => {
  const models = getCatalogModelsForProvider(provider, snapshot);
  const defaultModel = getDefaultModelForProvider(provider);

  return models.some((model) => model.id === defaultModel)
    ? defaultModel
    : models[0]?.id ?? defaultModel;
};

const formatCreateFlowMessage = (result: RalphCreateFlowResult): string => {
  const details = [
    ...result.validation.errors.map((error) => `Error: ${error}`),
    ...result.validation.warnings.map((warning) => `Warning: ${warning}`),
  ];

  return details.length > 0
    ? `${result.summary} ${details.join(" ")}`
    : result.summary;
};

const isRalphPromptBlock = (
  block: RalphFlowBlock | null | undefined,
): block is RalphPromptBlock => block?.type === "PROMPT";

const formatPromptBlockTargetLabel = (block: RalphPromptBlock): string =>
  `${block.title || block.id} (${block.id})`;

const createPromptBlockGenerationPrompt = (
  userPrompt: string,
  block: RalphPromptBlock,
): string => [
  "Update the selected PROMPT block in the current Ralph flow.",
  [
    "Use the prompt block below as the target for this Prompt change.",
    "Preserve its id and existing routes unless the user explicitly asks to change them.",
  ].join(" "),
  "",
  "Selected PROMPT block:",
  JSON.stringify(
    {
      id: block.id,
      title: block.title,
      prompt: getPromptLikeText(block),
    },
    null,
    2,
  ),
  "",
  "Requested change:",
  userPrompt,
].join("\n");

const getTrimmedGenerationInterviewAnswerComments = (
  answerComments: Record<string, string>,
): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(answerComments).flatMap(([fieldId, comment]) => {
      const trimmedComment = comment.trim();

      return trimmedComment ? [[fieldId, trimmedComment]] : [];
    }),
  );
};

const formatGenerationInterviewAnswerForPrompt = (
  label: string,
  value: RalphInputValue | undefined,
  comment?: string,
): string[] => {
  const lines = [`- ${label}: ${formatRalphInputValueForPrompt(value)}`];
  const trimmedComment = comment?.trim();

  if (trimmedComment) {
    lines.push(`  Comment: ${trimmedComment}`);
  }

  return lines;
};

const createLocalGenerationInterviewPrompt = (
  context: RalphAiGenerationStartContext,
  session: RalphGenerationInterviewSession | undefined,
  fields: readonly RalphInputField[],
  values: Record<string, RalphInputValue>,
  answerComments: Record<string, string> = {},
): string => [
  context.generationPrompt,
  "",
  "Interview context for generation:",
  session?.contextSummary ?? context.userPrompt,
  "",
  "Collected interview answers:",
  ...(session?.transcript ?? []).flatMap((turn) => [
    `Turn ${turn.turn}:`,
    ...turn.answers.flatMap((answer) =>
      formatGenerationInterviewAnswerForPrompt(
        answer.label,
        answer.value,
        answer.comment,
      ),
    ),
  ]),
  ...(fields.length > 0
    ? [
        "Current answers:",
        ...fields.flatMap((field) =>
          formatGenerationInterviewAnswerForPrompt(
            field.label,
            values[field.id],
            answerComments[field.id],
          ),
        ),
      ]
    : []),
  "",
  "Use this interview context when generating the Ralph flow changes.",
].join("\n");

const getGenerationJobStatusLabel = (status: RalphGenerationStatus): string => {
  switch (status) {
    case "running":
      return "Generating";
    case "stopping":
      return "Stopping";
    case "created":
      return "Generated";
    case "blocked":
      return "Blocked";
    case "failed":
      return "Failed";
  }
};

const canCopyGenerationError = (
  job: RalphGenerationJob | null,
): job is RalphGenerationJob => job?.status === "blocked" || job?.status === "failed";

const formatGenerationErrorClipboardText = (
  job: RalphGenerationJob,
): string => `${getGenerationJobStatusLabel(job.status)}\n\n${job.summary}`;

const formatGenerationActivityTime = (timestamp: number): string => {
  const date = new Date(timestamp);

  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

const getGenerationPhaseLabel = (job: RalphGenerationJob): string => {
  const actor = job.currentActor ? `${titleFromId(job.currentActor)} ` : "";
  const round =
    job.currentRound !== undefined
      ? `Round ${job.currentRound}${job.maxRounds ? `/${job.maxRounds}` : ""}`
      : null;

  return [round, actor ? `${actor.trim()} phase` : null]
    .filter((value): value is string => Boolean(value))
    .join(" - ");
};

const formatRunMessage = (run: RalphRunResult): string => {
  return `${run.summary} Status: ${run.status}. ${run.blockResults.length} block result${run.blockResults.length === 1 ? "" : "s"}.`;
};

const getRunStatusPresentation = (
  status: RalphRunStatus | ActiveRalphRunStatus,
): {
  label: string;
  icon: LucideIcon;
  className: string;
  chipClassName: string;
  spin?: boolean;
} => {
  switch (status) {
    case "running":
      return {
        label: "Running",
        icon: LoaderCircle,
        className: "text-sky-200",
        chipClassName: "border-sky-400/30 bg-sky-500/10 text-sky-100",
        spin: true,
      };
    case "stopping":
      return {
        label: "Stopping",
        icon: LoaderCircle,
        className: "text-amber-200",
        chipClassName: "border-amber-400/30 bg-amber-500/10 text-amber-100",
        spin: true,
      };
    case "completed":
      return {
        label: "Completed",
        icon: CheckCircle2,
        className: "text-emerald-200",
        chipClassName: "border-emerald-400/30 bg-emerald-500/10 text-emerald-100",
      };
    case "blocked":
      return {
        label: "Blocked",
        icon: AlertTriangle,
        className: "text-amber-200",
        chipClassName: "border-amber-400/30 bg-amber-500/10 text-amber-100",
      };
    case "crashed":
      return {
        label: "Crashed",
        icon: Octagon,
        className: "text-rose-200",
        chipClassName: "border-rose-400/30 bg-rose-500/10 text-rose-100",
      };
    case "stopped":
      return {
        label: "Stopped",
        icon: Octagon,
        className: "text-slate-300",
        chipClassName: "border-slate-700 bg-slate-900 text-slate-300",
      };
  }
};

const getOutputChipClassName = (output: string | undefined): string => {
  if (!output) {
    return "border-slate-800 bg-slate-950 text-slate-500";
  }

  if (output === "SUCCESS") {
    return "border-emerald-400/30 bg-emerald-500/10 text-emerald-100";
  }

  if (output === "ERROR") {
    return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  }

  if (output === "RETRY") {
    return "border-amber-400/30 bg-amber-500/10 text-amber-100";
  }

  return "border-sky-400/30 bg-sky-500/10 text-sky-100";
};

const getRunEventToneClassName = (tone: RalphRunEventTone): string => {
  switch (tone) {
    case "danger":
      return "border-rose-400/30 bg-rose-500/10 text-rose-100";
    case "warning":
      return "border-amber-400/30 bg-amber-500/10 text-amber-100";
    case "success":
      return "border-emerald-400/30 bg-emerald-500/10 text-emerald-100";
    case "info":
      return "border-sky-400/30 bg-sky-500/10 text-sky-100";
    case "neutral":
      return "border-slate-800 bg-slate-950 text-slate-300";
  }
};

const ACTIVE_TASK_REGISTRATION_GRACE_MS = 5_000;

type RalphProgressMetadata =
  NonNullable<TaskExecutionProgress["timelineEvent"]>["metadata"];

interface RalphProgressSnapshot {
  eventType: string;
  label: string;
  phase: RalphRunEventPhase;
  tone: RalphRunEventTone;
  blockId?: string;
  blockTitle?: string;
  activeBlockId?: string;
  activeBlockTitle?: string;
  nextBlockId?: string;
  nextBlockTitle?: string;
  output?: string;
  attempt?: number;
  detail?: string;
}

const RALPH_PROGRESS_EVENT_TYPES = new Set([
  "block-start",
  "block-output",
  "edge-route",
  "retry",
  "input-required",
  "input-submitted",
  "input-cancelled",
  "crash",
  "end",
]);

const RALPH_GENERATION_ACTIVITY_LIMIT = 80;

const getProgressMetadataString = (
  metadata: RalphProgressMetadata | undefined,
  key: string,
): string | undefined => {
  const value = metadata?.[key];

  return typeof value === "string" && value.trim() ? value : undefined;
};

const getProgressMetadataNumber = (
  metadata: RalphProgressMetadata | undefined,
  key: string,
): number | undefined => {
  const value = metadata?.[key];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const getProgressMetadataBoolean = (
  metadata: RalphProgressMetadata | undefined,
  key: string,
): boolean | undefined => {
  const value = metadata?.[key];

  return typeof value === "boolean" ? value : undefined;
};

const getRalphProgressSnapshot = (
  progress: TaskExecutionProgress,
): RalphProgressSnapshot | null => {
  const metadata = progress.timelineEvent?.metadata;
  const eventType = getProgressMetadataString(metadata, "ralphEventType");

  if (!eventType || !RALPH_PROGRESS_EVENT_TYPES.has(eventType)) {
    return null;
  }

  const activeBlockId =
    getProgressMetadataString(metadata, "ralphActiveBlockId") ??
    getProgressMetadataString(metadata, "ralphBlockId");
  const blockId = getProgressMetadataString(metadata, "ralphBlockId");
  const blockTitle = getProgressMetadataString(metadata, "ralphBlockTitle");
  const activeBlockTitle =
    getProgressMetadataString(metadata, "ralphActiveBlockTitle") ??
    blockTitle ??
    activeBlockId;
  const nextBlockId = getProgressMetadataString(metadata, "ralphNextBlockId");
  const nextBlockTitle = getProgressMetadataString(
    metadata,
    "ralphNextBlockTitle",
  );
  const phase: RalphRunEventPhase =
    progress.timelineEvent?.phase ??
    (eventType === "crash"
      ? "failed"
      : eventType === "end" ||
          eventType === "block-output" ||
          eventType === "input-submitted" ||
          eventType === "input-cancelled"
        ? "completed"
        : "started");
  const tone: RalphRunEventTone =
    progress.timelineEvent?.tone ??
    (eventType === "crash"
      ? "danger"
      : eventType === "retry"
        ? "warning"
        : eventType === "input-cancelled"
          ? "warning"
        : eventType === "end"
          ? "success"
          : "info");

  return {
    eventType,
    label: progress.timelineEvent?.label || progress.message || eventType,
    phase,
    tone,
    ...(blockId ? { blockId } : {}),
    ...(blockTitle ? { blockTitle } : {}),
    ...(activeBlockId ? { activeBlockId } : {}),
    ...(activeBlockTitle ? { activeBlockTitle } : {}),
    ...(nextBlockId ? { nextBlockId } : {}),
    ...(nextBlockTitle ? { nextBlockTitle } : {}),
    ...(getProgressMetadataString(metadata, "ralphOutput")
      ? { output: getProgressMetadataString(metadata, "ralphOutput") }
      : {}),
    ...(getProgressMetadataNumber(metadata, "ralphAttempt") !== undefined
      ? { attempt: getProgressMetadataNumber(metadata, "ralphAttempt") }
      : {}),
    ...(progress.timelineEvent?.detail
      ? { detail: progress.timelineEvent.detail }
      : {}),
  };
};

const createGenerationActivityFromProgress = (
  progress: TaskExecutionProgress,
  timestamp: number,
): RalphGenerationActivityEvent | null => {
  const metadata = progress.timelineEvent?.metadata;
  const type = getProgressMetadataString(metadata, "ralphGenerationEventType");

  if (!type) {
    return null;
  }

  const label = progress.timelineEvent?.label || progress.message || type;
  const round = getProgressMetadataNumber(metadata, "ralphGenerationRound");
  const maxRounds = getProgressMetadataNumber(metadata, "ralphGenerationMaxRounds");
  const actor = getProgressMetadataString(metadata, "ralphGenerationActor");
  const provider = progress.timelineEvent?.provider ?? undefined;
  const model = progress.timelineEvent?.model ?? undefined;

  return {
    id: `${timestamp}-${type}-${round ?? 0}-${label}`,
    type,
    label,
    timestamp,
    ...(progress.timelineEvent?.detail ? { detail: progress.timelineEvent.detail } : {}),
    ...(round !== undefined ? { round } : {}),
    ...(maxRounds !== undefined ? { maxRounds } : {}),
    ...(actor ? { actor } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(getProgressMetadataString(metadata, "ralphGenerationFlowPath")
      ? { flowPath: getProgressMetadataString(metadata, "ralphGenerationFlowPath") }
      : {}),
    ...(getProgressMetadataString(metadata, "ralphGenerationTempFlowPath")
      ? { tempFlowPath: getProgressMetadataString(metadata, "ralphGenerationTempFlowPath") }
      : {}),
    ...(getProgressMetadataBoolean(metadata, "ralphGenerationValidationValid") !== undefined
      ? {
          validationValid: getProgressMetadataBoolean(
            metadata,
            "ralphGenerationValidationValid",
          ),
        }
      : {}),
    ...(getProgressMetadataNumber(metadata, "ralphGenerationValidationErrorCount") !== undefined
      ? {
          validationErrorCount: getProgressMetadataNumber(
            metadata,
            "ralphGenerationValidationErrorCount",
          ),
        }
      : {}),
    ...(getProgressMetadataNumber(metadata, "ralphGenerationValidationWarningCount") !== undefined
      ? {
          validationWarningCount: getProgressMetadataNumber(
            metadata,
            "ralphGenerationValidationWarningCount",
          ),
        }
      : {}),
    ...(getProgressMetadataString(metadata, "ralphGenerationValidatorDecision")
      ? {
          validatorDecision: getProgressMetadataString(
            metadata,
            "ralphGenerationValidatorDecision",
          ),
        }
      : {}),
    ...(getProgressMetadataNumber(metadata, "ralphGenerationBlockCount") !== undefined
      ? {
          blockCount: getProgressMetadataNumber(
            metadata,
            "ralphGenerationBlockCount",
          ),
        }
      : {}),
    ...(getProgressMetadataNumber(metadata, "ralphGenerationEdgeCount") !== undefined
      ? {
          edgeCount: getProgressMetadataNumber(metadata, "ralphGenerationEdgeCount"),
        }
      : {}),
  };
};

const createGenerationActivityFromResultEvent = (
  event: RalphGenerationEvent,
): RalphGenerationActivityEvent => {
  const timestamp = Date.parse(event.createdAt);

  return {
    id: `${event.createdAt}-${event.type}-${event.round ?? 0}-${event.message}`,
    type: event.type,
    label: event.message,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    ...(event.round !== undefined ? { round: event.round } : {}),
    ...(event.maxRounds !== undefined ? { maxRounds: event.maxRounds } : {}),
    ...(event.actor ? { actor: event.actor } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.flowPath ? { flowPath: event.flowPath } : {}),
    ...(event.generationFlowPath ? { tempFlowPath: event.generationFlowPath } : {}),
    ...(event.validationValid !== undefined
      ? { validationValid: event.validationValid }
      : {}),
    ...(event.validationErrorCount !== undefined
      ? { validationErrorCount: event.validationErrorCount }
      : {}),
    ...(event.validationWarningCount !== undefined
      ? { validationWarningCount: event.validationWarningCount }
      : {}),
    ...(event.validatorDecision ? { validatorDecision: event.validatorDecision } : {}),
    ...(event.blockCount !== undefined ? { blockCount: event.blockCount } : {}),
    ...(event.edgeCount !== undefined ? { edgeCount: event.edgeCount } : {}),
  };
};

const appendGenerationActivity = (
  current: RalphGenerationActivityEvent[],
  nextEvents: RalphGenerationActivityEvent[],
): RalphGenerationActivityEvent[] => {
  if (nextEvents.length === 0) {
    return current;
  }

  const seen = new Set(current.map((event) => event.id));
  const merged = [...current];

  for (const event of nextEvents) {
    if (seen.has(event.id)) {
      continue;
    }

    seen.add(event.id);
    merged.push(event);
  }

  return merged
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-RALPH_GENERATION_ACTIVITY_LIMIT);
};

const applyGenerationActivity = (
  job: RalphGenerationJob,
  event: RalphGenerationActivityEvent,
): RalphGenerationJob => {
  return {
    ...job,
    summary: event.label || job.summary,
    activity: appendGenerationActivity(job.activity, [event]),
    ...(event.round !== undefined ? { currentRound: event.round } : {}),
    ...(event.maxRounds !== undefined ? { maxRounds: event.maxRounds } : {}),
    ...(event.actor ? { currentActor: event.actor } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.flowPath ? { flowPath: event.flowPath } : {}),
    ...(event.tempFlowPath ? { tempFlowPath: event.tempFlowPath } : {}),
    ...(event.validationValid !== undefined
      ? { validationValid: event.validationValid }
      : {}),
    ...(event.validationErrorCount !== undefined
      ? { validationErrorCount: event.validationErrorCount }
      : {}),
    ...(event.validationWarningCount !== undefined
      ? { validationWarningCount: event.validationWarningCount }
      : {}),
    ...(event.validatorDecision ? { validatorDecision: event.validatorDecision } : {}),
    ...(event.blockCount !== undefined ? { blockCount: event.blockCount } : {}),
    ...(event.edgeCount !== undefined ? { edgeCount: event.edgeCount } : {}),
  };
};

type RalphPersistedFlowResult = Awaited<ReturnType<typeof saveRalphFlow>>;

const formatSaveFlowMessage = (result: RalphPersistedFlowResult): string => {
  if (result.validation.errors.length > 0) {
    return `Saved with ${result.validation.errors.length} error(s). Fix them before running.`;
  }

  if (result.validation.warnings.length > 0) {
    return `Saved with ${result.validation.warnings.length} warning(s).`;
  }

  return "Flow saved.";
};

const formatRevisionDate = (createdAt: string): string => {
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }

  return date.toLocaleString();
};

const updatePromptLikeText = (
  block: RalphFlowBlock,
  prompt: string,
): RalphFlowBlock => {
  switch (block.type) {
    case "PROMPT":
    case "VALIDATOR":
    case "DECISION":
    case "INTERVIEW":
      return { ...block, prompt };
    case "INPUT":
      return { ...block, prompt };
    case "NOTE":
      return { ...block, text: prompt };
    case "GROUP":
      return { ...block, description: prompt };
    case "START":
    case "PACK":
    case "UTILITY":
    case "MCP_TOOL":
    case "MCP_RESOURCE":
    case "MCP_PROMPT":
    case "END":
      return block;
  }
};

const createBlock = (
  flow: RalphFlow,
  type: RalphBlockType,
): RalphFlowBlock => {
  const id = createBlockId(flow, type);
  const position = getDefaultCanvasPosition(flow.blocks.length);
  const settings: RalphBlockSettings = {
    workspace: { mode: "default" },
    provider: "default",
    reasoning: "default",
    webAccess: true,
    fileAccess: true,
    maxIterations: 1,
    internalValidatorEnabled: false,
    retry: { mode: "infinite", maxRetries: null },
  };
  const title = titleFromId(id);

  switch (type) {
    case "START":
      return { id, type, title: "Start", position };
    case "PROMPT":
      return { id, type, title, position, prompt: "", settings };
    case "VALIDATOR":
      return {
        id,
        type,
        title,
        position,
        prompt: "",
        validationScope: { mode: "sinceLastValidator" },
        settings,
      };
    case "DECISION":
      return {
        id,
        type,
        title,
        position,
        prompt: "",
        labels: ["YES", "NO"],
        settings,
      };
    case "PACK":
      return {
        id,
        type,
        title,
        position,
        packIds: [],
        propagationMode: "untilOverridden",
        settings,
      };
    case "INPUT":
      return {
        id,
        type,
        title: "Input",
        position,
        prompt: "Collect the values needed before continuing.",
        fields: [
          {
            id: "details",
            label: "Details",
            type: "textarea",
            required: false,
            skippable: true,
            variableName: "details",
          },
        ],
        submitLabel: "Continue",
        cancelLabel: "Cancel",
        timeoutSeconds: null,
        settings,
      };
    case "INTERVIEW":
      return {
        id,
        type,
        title: "Interview",
        position,
        prompt: "Clarify the request until there is enough detail to continue.",
        completionCriteria: "The request is specific enough to implement and test.",
        maxTurns: 5,
        questionsPerTurn: 3,
        outputVariableName: `${id.replace(/[^A-Za-z0-9_]+/gu, "_")}_interview`,
        submitLabel: "Continue",
        cancelLabel: "Cancel interview",
        settings,
      };
    case "UTILITY":
      return {
        id,
        type,
        title: formatUtilityTypeLabel("WAIT"),
        position,
        utility: createDefaultUtilityConfig("WAIT"),
        settings: {
          workspace: { mode: "default" },
          retry: { mode: "infinite", maxRetries: null },
        },
      };
    case "MCP_TOOL":
      return {
        id,
        type,
        title,
        position,
        serverId: "",
        toolName: "",
        arguments: {},
        settings,
      };
    case "MCP_RESOURCE":
      return {
        id,
        type,
        title,
        position,
        serverId: "",
        uri: "",
        settings,
      };
    case "MCP_PROMPT":
      return {
        id,
        type,
        title,
        position,
        serverId: "",
        promptName: "",
        arguments: {},
        settings,
      };
    case "NOTE":
      return {
        id,
        type,
        title: "Note",
        position,
        size: RALPH_NOTE_DEFAULT_SIZE,
        text: "",
        tone: "amber",
        tags: [],
        pinnedBlockIds: [],
      };
    case "GROUP":
      return {
        id,
        type,
        title: titleFromId(id),
        position,
        size: RALPH_GROUP_DEFAULT_SIZE,
        tone: "slate",
        description: "",
        childBlockIds: [],
        collapsed: false,
        locked: false,
        moveChildren: true,
        layoutMode: "freeform",
        executionBoundary: { mode: "none" },
      };
    case "END":
      return { id, type, title: "End", position, status: "success" };
  }
};

const shouldSyncUtilityTitle = (
  title: string,
  previousType: RalphUtilityType,
): boolean => {
  const trimmedTitle = title.trim();

  return (
    trimmedTitle.length === 0 ||
    /^Utility(?:\s+\d+)?$/iu.test(trimmedTitle) ||
    trimmedTitle === formatUtilityTypeLabel(previousType)
  );
};

const isGroupChildMoveSuppressed = (event: MouseEvent | TouchEvent): boolean => {
  return "ctrlKey" in event && event.ctrlKey;
};

const renderPromptHighlight = (value: string): JSX.Element[] => {
  const parts: JSX.Element[] = [];
  let cursor = 0;

  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    const index = match.index ?? 0;
    const raw = match[0] ?? "";

    if (index > cursor) {
      parts.push(
        <span key={`text-${cursor}`}>
          {value.slice(cursor, index)}
        </span>,
      );
    }

    parts.push(
      <span
        key={`var-${index}`}
        className="rounded bg-emerald-500/15 px-1 py-0.5 font-semibold text-emerald-200"
      >
        {raw}
      </span>,
    );
    cursor = index + raw.length;
  }

  if (cursor < value.length) {
    parts.push(
      <span key={`text-${cursor}`}>
        {value.slice(cursor)}
      </span>,
    );
  }

  return parts;
};

const getFlowSnapshot = (flow: RalphFlow | null): string => {
  return flow ? JSON.stringify(flow) : "";
};

const getFlowLayoutKey = (flow: RalphFlow | null): string => {
  if (!flow) {
    return "";
  }

  return flow.blocks
    .map((block) => {
      const x = block.position?.x ?? "auto";
      const y = block.position?.y ?? "auto";

      return `${block.id}:${x}:${y}`;
    })
    .join("|");
};

const getCanvasNodePositions = (
  nodes: RalphCanvasNode[],
): Map<string, RalphCanvasNode["position"]> => {
  return new Map(nodes.map((node) => [node.id, node.position]));
};

const arePositionsEqual = (
  current: RalphFlowBlock["position"] | undefined,
  next: RalphCanvasNode["position"],
): boolean => {
  return Boolean(current) && current.x === next.x && current.y === next.y;
};

const getNodeChangeDimensions = (
  change: NodeChange<RalphCanvasNode>,
): { width: number; height: number } | null => {
  if (change.type !== "dimensions") {
    return null;
  }

  const dimensions = (
    change as NodeChange<RalphCanvasNode> & {
      dimensions?: { width?: number; height?: number };
    }
  ).dimensions;

  if (
    typeof dimensions?.width !== "number" ||
    typeof dimensions.height !== "number"
  ) {
    return null;
  }

  return {
    width: Math.round(dimensions.width),
    height: Math.round(dimensions.height),
  };
};

export const RalphFlowEditor = ({
  workspaceRoot,
  initialPrompt = "",
  isActive = true,
  flowLibraryMode = "workspace",
  onFlowLibraryModeChange,
  runMode,
  generationProvider,
  generationModel,
  generationProfile,
  generationReasoning,
  runProvider,
  runModel,
  runProfile,
  runReasoning,
  defaultMaxTransitions,
  providerOptions = DEFAULT_RUNTIME_PROVIDER_OPTIONS,
  generationPromptHistory = EMPTY_RALPH_AI_PROMPT_HISTORY,
  onGenerationPromptHistoryChange,
}: RalphFlowEditorProps): JSX.Element => {
  const [flows, setFlows] = useState<RalphFlowSummary[]>([]);
  const [revisions, setRevisions] = useState<RalphFlowRevisionSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedScope, setSelectedScope] = useState<RalphFlowScope>(
    DEFAULT_RALPH_FLOW_SCOPE,
  );
  const [draftFlow, setDraftFlow] = useState<RalphFlow | null>(null);
  const [draftFlowScope, setDraftFlowScope] = useState<RalphFlowScope>(
    DEFAULT_RALPH_FLOW_SCOPE,
  );
  const [canvasNodes, setCanvasNodes] = useState<RalphCanvasNode[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [unsavedFlowId, setUnsavedFlowId] = useState<string | null>(null);
  const [unsavedFlowScope, setUnsavedFlowScope] = useState<RalphFlowScope>(
    DEFAULT_RALPH_FLOW_SCOPE,
  );
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [flowAliasDraft, setFlowAliasDraft] = useState("");
  const [aiPromptDraft, setAiPromptDraft] = useState("");
  const [aiPromptHistory, setAiPromptHistory] = useState<string[]>(() =>
    normalizeRalphAiPromptHistory(generationPromptHistory),
  );
  const [aiPromptHistoryIndex, setAiPromptHistoryIndex] = useState<
    number | null
  >(null);
  const [aiPromptDraftBeforeHistory, setAiPromptDraftBeforeHistory] =
    useState("");
  const [editorMode, setEditorMode] = useState<RalphEditorMode>("design");
  const [flowListOpen, setFlowListOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorWidth, setInspectorWidth] = useState(loadRalphInspectorWidth);
  const [activeInspectorSection, setActiveInspectorSection] =
    useState<RalphInspectorSectionId>("content");
  const [inspectorScrollState, setInspectorScrollState] = useState({
    atBottom: true,
    atTop: true,
  });
  const [expandedEditor, setExpandedEditor] =
    useState<RalphExpandedEditorState | null>(null);
  const [expandedEditorDraft, setExpandedEditorDraft] = useState("");
  const [expandedEditorWrap, setExpandedEditorWrap] = useState(true);
  const [aiTarget, setAiTarget] = useState<RalphAiTarget>("flow");
  const [aiPromptBlockId, setAiPromptBlockId] = useState<string | null>(null);
  const [creationScope, setCreationScope] = useState<RalphFlowScope>(() =>
    getDefaultCreationScope(flowLibraryMode),
  );
  const [aiGenerationMode, setAiGenerationMode] =
    useState<RalphAiGenerationMode>("do-it");
  const [modelCatalog, setModelCatalog] =
    useState<ProviderModelCatalogSnapshot | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [lastRun, setLastRun] = useState<RalphRunResult | null>(null);
  const [pendingInputValues, setPendingInputValues] = useState<
    Record<string, RalphInputValue>
  >({});
  const [inputSubmitting, setInputSubmitting] = useState(false);
  const [runHistory, setRunHistory] = useState<RalphRunSummary[]>([]);
  const [runHistoryLoading, setRunHistoryLoading] = useState(false);
  const [runPanelTab, setRunPanelTab] = useState<RalphRunPanelTab>("setup");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] =
    useState<RalphRunDetailResult | null>(null);
  const [selectedRunLog, setSelectedRunLog] = useState<{
    runId: string;
    kind: "simple" | "trace";
    content: string;
    path: string;
  } | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runDetailError, setRunDetailError] = useState<string | null>(null);
  const [runLogLoading, setRunLogLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [flowsLoading, setFlowsLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeRuns, setActiveRuns] = useState<ActiveRalphRun[]>([]);
  const [generationJob, setGenerationJob] = useState<RalphGenerationJob | null>(
    null,
  );
  const [generationInterview, setGenerationInterview] =
    useState<RalphGenerationInterviewDialogState | null>(null);
  const [generationErrorCopyState, setGenerationErrorCopyState] =
    useState<ClipboardCopyState>("idle");
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [copiedBlock, setCopiedBlock] = useState<RalphFlowBlock | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [canvasMenu, setCanvasMenu] = useState<RalphCanvasMenu | null>(null);
  const [flowListMenu, setFlowListMenu] = useState<RalphFlowListMenu | null>(
    null,
  );
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [utilityJsonDraft, setUtilityJsonDraft] = useState("");
  const [utilityJsonError, setUtilityJsonError] = useState<string | null>(null);
  const previousFlowLayoutKeyRef = useRef("");
  const inspectorScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const expandedEditorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const reactFlowInstanceRef =
    useRef<ReactFlowInstance<RalphCanvasNode, RalphCanvasEdge> | null>(null);
  const selectedIdRef = useRef(selectedId);
  const selectedScopeRef = useRef(selectedScope);
  const draftFlowRef = useRef<RalphFlow | null>(draftFlow);
  const savedSnapshotRef = useRef(savedSnapshot);
  const flowListRequestRef = useRef(0);
  const saveRequestRef = useRef(0);
  const restoreRequestRef = useRef(0);
  const generationRequestRef = useRef<string | null>(null);
  const initialPromptAppliedRef = useRef(false);
  const activeProvider = runProvider;
  const activeModel = runModel;
  const showInspectorPanel = editorMode === "design" && inspectorOpen;
  const hasDraftFlow = Boolean(draftFlow);
  const replaceSelectedId = (
    nextSelectedId: string,
    nextSelectedScope: RalphFlowScope = selectedScopeRef.current,
  ): void => {
    selectedIdRef.current = nextSelectedId;
    selectedScopeRef.current = nextSelectedScope;
    setSelectedId(nextSelectedId);
    setSelectedScope(nextSelectedScope);
  };
  const replaceDraftFlow = (
    nextDraftFlow: RalphFlow | null,
    nextDraftFlowScope: RalphFlowScope = selectedScopeRef.current,
  ): void => {
    draftFlowRef.current = nextDraftFlow;
    setDraftFlow(nextDraftFlow);
    setDraftFlowScope(nextDraftFlowScope);
    setUndoStack([]);
    setRedoStack([]);
    setSelectedEdgeId(null);
    setAiPromptBlockId(null);
    setCanvasMenu(null);
    setFlowListMenu(null);
  };
  const replaceSavedSnapshot = (nextSavedSnapshot: string): void => {
    savedSnapshotRef.current = nextSavedSnapshot;
    setSavedSnapshot(nextSavedSnapshot);
  };
  const issues = useMemo(
    () =>
      draftFlow
        ? validateFlowLocally(draftFlow, modelCatalog, flows, selectedScope)
        : [],
    [draftFlow, flows, modelCatalog, selectedScope],
  );
  const dirty = draftFlow ? savedSnapshot !== getFlowSnapshot(draftFlow) : false;
  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;
  const selectedBlock = useMemo(
    () => draftFlow?.blocks.find((block) => block.id === selectedBlockId) ?? null,
    [draftFlow, selectedBlockId],
  );
  const aiPromptBlock = useMemo(
    () =>
      draftFlow?.blocks.find(
        (block): block is RalphPromptBlock =>
          block.id === aiPromptBlockId && isRalphPromptBlock(block),
      ) ?? null,
    [aiPromptBlockId, draftFlow],
  );
  const selectedEdge = useMemo(
    () => draftFlow?.edges.find((edge) => edge.id === selectedEdgeId) ?? null,
    [draftFlow, selectedEdgeId],
  );
  const selectedCanvasBlockIds = useMemo(
    () => canvasNodes.filter((node) => node.selected).map((node) => node.id),
    [canvasNodes],
  );
  const selectedUtility =
    selectedBlock?.type === "UTILITY" ? selectedBlock.utility : null;
  const utilityJsonDraftInlineError = useMemo(() => {
    if (!selectedUtility || !utilityJsonDraft.trim()) {
      return null;
    }

    try {
      JSON.parse(utilityJsonDraft);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Invalid JSON.";
    }
  }, [selectedUtility, utilityJsonDraft]);
  const selectedBlockUsesAgentSettings =
    selectedBlock?.type === "PROMPT" ||
    selectedBlock?.type === "VALIDATOR" ||
    selectedBlock?.type === "DECISION" ||
    selectedBlock?.type === "INTERVIEW";
  const pendingInput = lastRun?.pendingInput ?? null;

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (!pendingInput) {
      setPendingInputValues({});
      return;
    }

    setPendingInputValues(
      Object.fromEntries(
        pendingInput.fields.map((field) => [
          field.id,
          field.defaultValue ?? (field.type === "boolean" ? false : null),
        ]),
      ),
    );
  }, [pendingInput]);

  useEffect(() => {
    selectedScopeRef.current = selectedScope;
  }, [selectedScope]);

  useEffect(() => {
    if (flowLibraryMode === "workspace" || flowLibraryMode === "user") {
      setCreationScope(flowLibraryMode);
    }
  }, [flowLibraryMode]);

  useEffect(() => {
    draftFlowRef.current = draftFlow;
  }, [draftFlow]);

  useEffect(() => {
    savedSnapshotRef.current = savedSnapshot;
  }, [savedSnapshot]);

  useEffect(() => {
    if (selectedEdgeId) {
      setAiPromptBlockId(null);
      return;
    }

    if (!selectedBlockId) {
      return;
    }

    setAiPromptBlockId(isRalphPromptBlock(selectedBlock) ? selectedBlock.id : null);
  }, [selectedBlock, selectedBlockId, selectedEdgeId]);

  useEffect(() => {
    if (!aiPromptBlockId || aiPromptBlock) {
      return;
    }

    setAiPromptBlockId(null);
  }, [aiPromptBlock, aiPromptBlockId]);

  useEffect(() => {
    if (aiTarget === "prompt-block" && !aiPromptBlock) {
      setAiTarget("flow");
    }
  }, [aiPromptBlock, aiTarget]);

  useEffect(() => {
    if (editorMode === "design" && (selectedBlockId || selectedEdgeId)) {
      setInspectorOpen(true);
    }
  }, [editorMode, selectedBlockId, selectedEdgeId]);

  useEffect(() => {
    if (generationErrorCopyState === "idle") {
      return;
    }

    const timeout = window.setTimeout(
      () => setGenerationErrorCopyState("idle"),
      1_800,
    );

    return () => window.clearTimeout(timeout);
  }, [generationErrorCopyState]);

  useEffect(() => {
    setGenerationErrorCopyState("idle");
  }, [generationJob?.id, generationJob?.summary]);

  useEffect(() => {
    const normalizedHistory =
      normalizeRalphAiPromptHistory(generationPromptHistory);

    setAiPromptHistory((current) =>
      areRalphAiPromptHistoriesEqual(current, normalizedHistory)
        ? current
        : normalizedHistory,
    );
    setAiPromptHistoryIndex(null);
    setAiPromptDraftBeforeHistory("");
  }, [generationPromptHistory]);

  const resetAiPromptHistoryNavigation = useCallback((): void => {
    setAiPromptHistoryIndex(null);
    setAiPromptDraftBeforeHistory("");
  }, []);

  const handleAiPromptDraftChange = useCallback(
    (value: string): void => {
      resetAiPromptHistoryNavigation();
      setAiPromptDraft(value);
    },
    [resetAiPromptHistoryNavigation],
  );

  const rememberAiPromptHistoryEntry = useCallback(
    (prompt: string): void => {
      const nextHistory = addRalphAiPromptHistoryEntry(aiPromptHistory, prompt);

      if (areRalphAiPromptHistoriesEqual(aiPromptHistory, nextHistory)) {
        return;
      }

      setAiPromptHistory(nextHistory);
      onGenerationPromptHistoryChange?.(nextHistory);
    },
    [aiPromptHistory, onGenerationPromptHistoryChange],
  );

  const handleAiPromptHistoryNavigation = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
        return;
      }

      if (aiPromptHistory.length === 0) {
        return;
      }

      event.preventDefault();

      if (event.key === "ArrowUp") {
        if (aiPromptHistoryIndex === null) {
          const nextIndex = aiPromptHistory.length - 1;

          setAiPromptDraftBeforeHistory(aiPromptDraft);
          setAiPromptHistoryIndex(nextIndex);
          setAiPromptDraft(aiPromptHistory[nextIndex] ?? "");
          return;
        }

        const nextIndex = Math.max(aiPromptHistoryIndex - 1, 0);

        setAiPromptHistoryIndex(nextIndex);
        setAiPromptDraft(aiPromptHistory[nextIndex] ?? "");
        return;
      }

      if (aiPromptHistoryIndex === null) {
        return;
      }

      const nextIndex = aiPromptHistoryIndex + 1;

      if (nextIndex >= aiPromptHistory.length) {
        setAiPromptHistoryIndex(null);
        setAiPromptDraft(aiPromptDraftBeforeHistory);
        setAiPromptDraftBeforeHistory("");
        return;
      }

      setAiPromptHistoryIndex(nextIndex);
      setAiPromptDraft(aiPromptHistory[nextIndex] ?? "");
    },
    [
      aiPromptDraft,
      aiPromptDraftBeforeHistory,
      aiPromptHistory,
      aiPromptHistoryIndex,
    ],
  );

  const updateInspectorScrollState = useCallback((): void => {
    const container = inspectorScrollContainerRef.current;

    if (!container) {
      setInspectorScrollState({ atBottom: true, atTop: true });
      return;
    }

    const nextState = {
      atTop: container.scrollTop <= RALPH_INSPECTOR_SCROLL_EPSILON,
      atBottom:
        container.scrollHeight -
          container.scrollTop -
          container.clientHeight <=
        RALPH_INSPECTOR_SCROLL_EPSILON,
    };

    setInspectorScrollState((current) =>
      current.atTop === nextState.atTop &&
      current.atBottom === nextState.atBottom
        ? current
        : nextState,
    );
  }, []);

  useEffect(() => {
    if (!showInspectorPanel) {
      return;
    }

    const frame = window.requestAnimationFrame(updateInspectorScrollState);

    return () => window.cancelAnimationFrame(frame);
  }, [
    activeInspectorSection,
    draftFlow,
    expandedEditor,
    selectedBlockId,
    selectedEdgeId,
    showAdvancedSettings,
    showInspectorPanel,
    updateInspectorScrollState,
    utilityJsonDraft,
  ]);

  useEffect(() => {
    inspectorScrollContainerRef.current?.scrollTo?.({ top: 0 });
    if (inspectorScrollContainerRef.current) {
      inspectorScrollContainerRef.current.scrollTop = 0;
    }
  }, [selectedBlockId, selectedEdgeId]);

  const scrollInspectorSectionIntoView = (
    sectionId: RalphInspectorSectionId,
  ): void => {
    setActiveInspectorSection(sectionId);

    const container = inspectorScrollContainerRef.current;
    const target = container?.querySelector<HTMLElement>(
      `[data-ralph-inspector-section="${sectionId}"]`,
    );

    if (!container || !target) {
      return;
    }

    container.scrollTo({
      top: Math.max(0, target.offsetTop - 12),
      behavior: "smooth",
    });
  };

  const handleInspectorResizePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const startX = event.clientX;
    const startWidth = inspectorWidth;
    const previousRootCursor = document.documentElement.style.cursor;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.documentElement.style.cursor = "col-resize";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: PointerEvent): void => {
      const nextWidth = clampRalphInspectorWidth(
        startWidth + startX - moveEvent.clientX,
      );

      setInspectorWidth(nextWidth);
    };

    const restorePointerState = (): void => {
      document.documentElement.style.cursor = previousRootCursor;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", restorePointerState);
    };

    const handlePointerUp = (upEvent: PointerEvent): void => {
      const nextWidth = clampRalphInspectorWidth(
        startWidth + startX - upEvent.clientX,
      );

      setInspectorWidth(nextWidth);
      saveRalphInspectorWidth(nextWidth);
      restorePointerState();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", restorePointerState, { once: true });
  };

  const resetInspectorWidth = (): void => {
    const nextWidth = clampRalphInspectorWidth(RALPH_INSPECTOR_DEFAULT_WIDTH);
    setInspectorWidth(nextWidth);
    saveRalphInspectorWidth(nextWidth);
  };

  const openExpandedEditor = (editor: RalphExpandedEditorState): void => {
    setExpandedEditor(editor);
    setExpandedEditorDraft(editor.value);
    setExpandedEditorWrap(editor.mode !== "code");
  };

  const applyExpandedEditor = (): void => {
    if (!expandedEditor) {
      return;
    }

    expandedEditor.onApply(expandedEditorDraft);
    setExpandedEditor(null);
  };

  const copyExpandedEditorDraft = async (): Promise<void> => {
    if (!navigator.clipboard) {
      return;
    }

    await navigator.clipboard.writeText(expandedEditorDraft);
  };

  const insertExpandedEditorSnippet = (snippet: string): void => {
    const textarea = expandedEditorTextareaRef.current;
    const start = textarea?.selectionStart ?? expandedEditorDraft.length;
    const end = textarea?.selectionEnd ?? expandedEditorDraft.length;
    const nextDraft = `${expandedEditorDraft.slice(0, start)}${snippet}${expandedEditorDraft.slice(end)}`;

    setExpandedEditorDraft(nextDraft);

    window.requestAnimationFrame(() => {
      expandedEditorTextareaRef.current?.focus();
      expandedEditorTextareaRef.current?.setSelectionRange(
        start + snippet.length,
        start + snippet.length,
      );
    });
  };

  const selectedBlockOutputs = useMemo(
    () => (selectedBlock ? getBlockOutputs(selectedBlock) : []),
    [selectedBlock],
  );
  const selectedRouteTargets = useMemo(
    () =>
      draftFlow && selectedBlock
        ? getSelectableRouteTargets(draftFlow)
        : [],
    [draftFlow, selectedBlock],
  );
  const selectedBlockProviderOption = getProviderOption(
    selectedBlock?.settings?.provider,
  );
  const selectedBlockProviderOptions = useMemo(
    () => createRalphProviderOptions(providerOptions),
    [providerOptions],
  );
  const selectedBlockEffectiveProvider = getEffectiveProvider(
    selectedBlockProviderOption,
    activeProvider,
  );
  const selectedBlockModelOptions = useMemo(
    () => getCatalogModelsForProvider(selectedBlockEffectiveProvider, modelCatalog),
    [modelCatalog, selectedBlockEffectiveProvider],
  );
  const activeProviderModelOptions = useMemo(
    () => getCatalogModelsForProvider(activeProvider, modelCatalog),
    [activeProvider, modelCatalog],
  );
  const activeModelLabel = formatCatalogModelLabel(
    activeProviderModelOptions,
    activeModel,
  );
  const selectedBlockStoredModel = selectedBlock?.settings?.model;
  const selectedBlockModelValue =
    selectedBlockStoredModel && selectedBlockStoredModel !== "default"
      ? selectedBlockStoredModel
      : selectedBlockProviderOption === "default"
        ? "default"
        : getPreferredModelForProvider(selectedBlockEffectiveProvider, modelCatalog);
  const selectedBlockModelLabel =
    selectedBlockModelValue === "default"
      ? `Default (${activeModelLabel})`
      : formatCatalogModelLabel(selectedBlockModelOptions, selectedBlockModelValue);
  const selectedBlockEffectiveModel =
    selectedBlockModelValue === "default" ? activeModel : selectedBlockModelValue;
  const selectedBlockReasoningValue = normalizeReasoningModeForProvider(
    selectedBlock?.settings?.reasoning ?? "default",
    selectedBlockEffectiveProvider,
    selectedBlockEffectiveModel,
  );
  const selectedBlockReasoningOptions = getReasoningModesForProvider(
    selectedBlockEffectiveProvider,
    selectedBlockEffectiveModel,
  );
  const selectedBlockImageInputSupported = modelSupportsImageInput(
    selectedBlockEffectiveProvider,
    selectedBlockEffectiveModel,
  );
  const selectedBlockImageInputDisabledReason = selectedBlockImageInputSupported
    ? null
    : createImageInputUnsupportedModelMessage(
        selectedBlockEffectiveProvider,
        selectedBlockEffectiveModel,
      );
  const selectedBlockPathAttachments = useMemo(
    () => getRalphPathAttachmentPreviews(selectedBlock?.settings?.attachments),
    [selectedBlock?.settings?.attachments],
  );
  const selectedBlockVariableAttachmentItems = useMemo(
    () => getRalphVariableAttachmentItems(selectedBlock?.settings?.attachments),
    [selectedBlock?.settings?.attachments],
  );
  const selectedRoutesByOutput = useMemo(() => {
    const routes = new Map<RalphExecutionOutput, RalphFlowEdge>();

    if (!draftFlow || !selectedBlock) {
      return routes;
    }

    for (const edge of draftFlow.edges) {
      if (edge.from === selectedBlock.id) {
        routes.set(edge.fromOutput, edge);
      }
    }

    return routes;
  }, [draftFlow, selectedBlock]);
  const selectedBlockIssueCounts = useMemo(() => {
    if (!selectedBlock) {
      return { errors: 0, warnings: 0 };
    }

    let errors = 0;
    let warnings = 0;

    for (const issue of issues) {
      if (issue.blockId !== selectedBlock.id) {
        continue;
      }

      if (issue.level === "error") {
        errors += 1;
      } else {
        warnings += 1;
      }
    }

    return { errors, warnings };
  }, [issues, selectedBlock]);
  const missingSelectedRouteCount = useMemo(() => {
    if (!selectedBlock) {
      return 0;
    }

    return selectedBlockOutputs.filter((output) => !selectedRoutesByOutput.has(output))
      .length;
  }, [selectedBlock, selectedBlockOutputs, selectedRoutesByOutput]);
  const connectedSelectedRouteCount =
    selectedBlockOutputs.length - missingSelectedRouteCount;
  const availableInspectorSections = useMemo(() => {
    if (!selectedBlock) {
      return [];
    }

    const sectionIds: RalphInspectorSectionId[] = ["content"];

    if (selectedBlock.type === "UTILITY" || selectedBlockUsesAgentSettings) {
      sectionIds.push("execution");
    }

    if (
      isExecutableRalphCanvasBlock(selectedBlock) ||
      selectedBlock.type === "NOTE" ||
      selectedBlock.type === "GROUP"
    ) {
      sectionIds.push("behavior");
    }

    if (selectedBlockOutputs.length > 0) {
      sectionIds.push("routes");
    }

    if (selectedBlock.type === "UTILITY" || selectedBlockUsesAgentSettings) {
      sectionIds.push("advanced");
    }

    return RALPH_INSPECTOR_SECTIONS.filter((section) =>
      sectionIds.includes(section.id),
    );
  }, [selectedBlock, selectedBlockOutputs.length, selectedBlockUsesAgentSettings]);

  useEffect(() => {
    if (
      availableInspectorSections.length === 0 ||
      availableInspectorSections.some(
        (section) => section.id === activeInspectorSection,
      )
    ) {
      return;
    }

    setActiveInspectorSection(availableInspectorSections[0]?.id ?? "content");
  }, [activeInspectorSection, availableInspectorSections]);
  const selectedFlowKey = selectedId
    ? getFlowSelectionKey(selectedId, selectedScope)
    : "";
  const selectedSummary = useMemo(
    () =>
      flows.find((flow) => hasFlowSelection(flow, selectedId, selectedScope)) ??
      null,
    [flows, selectedId, selectedScope],
  );
  const selectedFlowUnsaved =
    Boolean(selectedId) &&
    unsavedFlowId === selectedId &&
    unsavedFlowScope === selectedScope;
  const selectedScopeLabel = RALPH_FLOW_SCOPE_LABELS[selectedScope];
  const creationScopeLabel = RALPH_FLOW_SCOPE_LABELS[creationScope];
  const displayFlows = useMemo(() => {
    const visibleFlows = [...flows];

    if (
      draftFlow &&
      draftFlow.id === selectedId &&
      draftFlowScope === selectedScope &&
      !visibleFlows.some((flow) => hasFlowSelection(flow, draftFlow.id, draftFlowScope))
    ) {
      visibleFlows.unshift(flowToSummary(draftFlow, "", draftFlowScope));
    }

    for (const run of activeRuns) {
      if (
        visibleFlows.some((flow) =>
          hasFlowSelection(flow, run.flowId, run.scope),
        )
      ) {
        continue;
      }

      visibleFlows.push({
        id: run.flowId,
        name: run.flowName,
        scope: run.scope,
        path: "",
        blockCount: 0,
        edgeCount: 0,
        variableCount: 0,
      });
    }

    return visibleFlows.sort(compareFlowSummaries);
  }, [activeRuns, draftFlow, draftFlowScope, flows, selectedId, selectedScope]);
  const displayFlowRows = useMemo<RalphFlowListRow[]>(() => {
    if (flowLibraryMode !== "all") {
      return displayFlows.map((flow) => ({ type: "flow", flow }));
    }

    return RALPH_FLOW_SCOPES.flatMap((scope) => {
      const scopedFlows = displayFlows.filter(
        (flow) => getFlowSummaryScope(flow) === scope,
      );

      return scopedFlows.length > 0
        ? [
            {
              type: "heading" as const,
              scope,
              count: scopedFlows.length,
            },
            ...scopedFlows.map((flow) => ({ type: "flow" as const, flow })),
          ]
        : [];
    });
  }, [displayFlows, flowLibraryMode]);
  const activeRunsByFlowKey = useMemo(() => {
    const runsByFlowKey = new Map<string, ActiveRalphRun[]>();

    for (const run of activeRuns) {
      const key = getFlowSelectionKey(run.flowId, run.scope);
      const existingRuns = runsByFlowKey.get(key);

      if (existingRuns) {
        existingRuns.push(run);
      } else {
        runsByFlowKey.set(key, [run]);
      }
    }

    return runsByFlowKey;
  }, [activeRuns]);
  const selectedFlowActiveRuns = activeRunsByFlowKey.get(selectedFlowKey) ?? [];
  const selectedFlowActiveRunCount = selectedFlowActiveRuns.length;
  const selectedActiveRun = useMemo(
    () => activeRuns.find((run) => run.id === selectedRunId) ?? null,
    [activeRuns, selectedRunId],
  );
  const selectedRunSummary = useMemo(
    () => runHistory.find((run) => run.id === selectedRunId) ?? null,
    [runHistory, selectedRunId],
  );
  const selectedRunRecord = selectedRunDetail?.record ?? null;
  const liveRunForPanel = selectedActiveRun ?? activeRuns[0] ?? null;
  const activeCanvasRun = useMemo(
    () => {
      if (!draftFlow) {
        return null;
      }

      const selectedRunMatchesCanvas =
        selectedActiveRun?.flowId === draftFlow.id &&
        selectedActiveRun.scope === selectedScope &&
        selectedActiveRun.currentBlockId
          ? selectedActiveRun
          : null;

      return (
        selectedRunMatchesCanvas ??
        selectedFlowActiveRuns.find((run) => run.currentBlockId) ??
        null
      );
    },
    [draftFlow, selectedActiveRun, selectedFlowActiveRuns, selectedScope],
  );
  const activeCanvasBlockId = activeCanvasRun?.currentBlockId ?? null;
  const flowNodes = useMemo(
    () =>
      draftFlow
        ? flowToNodes(draftFlow, issues, selectedBlockId, activeCanvasBlockId)
        : [],
    [activeCanvasBlockId, draftFlow, issues, selectedBlockId],
  );
  const flowLayoutKey = useMemo(
    () => getFlowLayoutKey(draftFlow),
    [draftFlow],
  );
  const edges = useMemo(
    () =>
      draftFlow ? flowToEdges(draftFlow, selectedEdgeId, selectedBlockId) : [],
    [draftFlow, selectedBlockId, selectedEdgeId],
  );
  const requiredMissingVariables = useMemo(() => {
    if (!draftFlow) {
      return [];
    }

    return (draftFlow.variables ?? [])
      .filter((variable) => variable.required)
      .filter((variable) => !(variableValues[variable.name] ?? "").trim())
      .map((variable) => variable.name);
  }, [draftFlow, variableValues]);
  const hasBlockingIssues = issues.some((issue) => issue.level === "error");
  const errorCount = issues.filter((issue) => issue.level === "error").length;
  const warningCount = issues.length - errorCount;
  const showMiniMap = editorMode === "design" && canvasNodes.length >= 4;
  const activeRunCount = activeRuns.length;
  const runButtonLabel =
    selectedFlowActiveRunCount > 0 ? "Run again" : "Run";
  const flowHasStart = Boolean(
    draftFlow?.blocks.some((block) => block.type === "START"),
  );
  const generationRunning =
    generationJob?.status === "running" || generationJob?.status === "stopping";
  const generationInterviewRunning =
    generationInterview?.status === "loading" ||
    generationInterview?.status === "generating";
  const generationJobStatusLabel = generationJob
    ? getGenerationJobStatusLabel(generationJob.status)
    : null;
  const selectedMatchesDraft = Boolean(draftFlow && selectedId === draftFlow.id);
  const canSaveFlow =
    Boolean(workspaceRoot && draftFlow && selectedMatchesDraft) &&
    !loading &&
    !detailsLoading &&
    dirty;
  const canRunFlow =
    Boolean(workspaceRoot && selectedId && draftFlow && selectedMatchesDraft) &&
    !loading &&
    !detailsLoading &&
    !(generationRunning && generationJob?.targetFlowId === draftFlow?.id) &&
    !dirty &&
    !hasBlockingIssues &&
    requiredMissingVariables.length === 0;
  const flowTitle = draftFlow?.name ?? selectedSummary?.name ?? "Ralph Flow";
  const normalizedFlowAliasDraft = createFlowAlias(flowAliasDraft);
  const canUseCurrentFlowForAi = Boolean(draftFlow);
  const aiPromptBlockLabel = aiPromptBlock
    ? formatPromptBlockTargetLabel(aiPromptBlock)
    : "";
  const aiTargetOptions: {
    target: RalphAiTarget;
    label: string;
    disabled: boolean;
    title: string;
  }[] = [
    {
      target: "flow",
      label: "Flow",
      disabled: false,
      title: "Generate a complete Ralph flow.",
    },
    {
      target: "refactor",
      label: "Improve",
      disabled: false,
      title: "Improve the selected Ralph flow.",
    },
    {
      target: "prompt-block",
      label: "Prompt",
      disabled: !aiPromptBlock,
      title: aiPromptBlock
        ? `Improve prompt block ${aiPromptBlockLabel}.`
        : "Select a PROMPT block in the flow before using Prompt.",
    },
  ];
  const canGenerateWithAgent =
    Boolean(
      workspaceRoot &&
      aiPromptDraft.trim() &&
      !loading &&
      !generationRunning &&
      !generationInterviewRunning,
    ) &&
    (aiTarget === "flow" ||
      (aiTarget === "prompt-block" ? Boolean(aiPromptBlock) : canUseCurrentFlowForAi));
  const runBlockedReason = useMemo(() => {
    if (!workspaceRoot) {
      return "Select a workspace before running.";
    }

    if (!draftFlow) {
      return "Create or select a flow before running.";
    }

    if (loading) {
      return "Wait for the current edit operation to finish.";
    }

    if (generationRunning && generationJob?.targetFlowId === draftFlow.id) {
      return "Wait for the current AI flow change to finish.";
    }

    if (detailsLoading) {
      return "Loading flow details.";
    }

    if (!selectedMatchesDraft) {
      return "Finish loading the selected flow before running.";
    }

    if (!selectedId || dirty || selectedFlowUnsaved) {
      return "Save flow before running.";
    }

    if (hasBlockingIssues) {
      return `Fix ${errorCount} validation error${errorCount === 1 ? "" : "s"} before running.`;
    }

    if (requiredMissingVariables.length > 0) {
      return `Set required variable${requiredMissingVariables.length === 1 ? "" : "s"}: ${requiredMissingVariables.join(", ")}.`;
    }

    return null;
  }, [
    detailsLoading,
    dirty,
    draftFlow,
    errorCount,
    generationJob,
    generationRunning,
    hasBlockingIssues,
    loading,
    requiredMissingVariables,
    selectedId,
    selectedFlowUnsaved,
    selectedMatchesDraft,
    workspaceRoot,
  ]);
  const runReadyMessage =
    warningCount > 0
      ? `Ready to run with ${warningCount} warning${warningCount === 1 ? "" : "s"}.`
      : "Ready to run.";
  const flowListColumnWidth = flowListOpen ? "15rem" : "2.75rem";
  const editorGridTemplateColumns = showInspectorPanel
    ? `${flowListColumnWidth} minmax(0,1fr) ${inspectorWidth}px`
    : `${flowListColumnWidth} minmax(0,1fr)`;
  const editorGridStyle = {
    gridTemplateColumns: editorGridTemplateColumns,
  };
  const inspectorTwoColumnClass =
    inspectorWidth >= 430 ? "grid-cols-2" : "grid-cols-1";
  const inspectorThreeColumnClass =
    inspectorWidth >= 620
      ? "grid-cols-3"
      : inspectorWidth >= 430
        ? "grid-cols-2"
        : "grid-cols-1";
  const inspectorHttpGridClass =
    inspectorWidth >= 500 ? "grid-cols-[0.55fr_1.45fr]" : "grid-cols-1";
  const editorRowsClass =
    editorMode === "design"
      ? "grid-rows-[minmax(0,1fr)_4.25rem]"
      : editorMode === "run"
        ? "grid-rows-[minmax(12rem,1fr)_minmax(18rem,38vh)]"
        : editorMode === "generate"
          ? "grid-rows-[minmax(12rem,1fr)_minmax(17rem,34vh)]"
          : issues.length > 0
            ? "grid-rows-[minmax(12rem,1fr)_minmax(12rem,30vh)]"
            : "grid-rows-[minmax(0,1fr)_6.5rem]";
  const bottomPanelSpanClass = showInspectorPanel
    ? "col-start-1 col-span-3"
    : "col-start-1 col-span-2";
  const staleRunMessage = Boolean(
    message && /Ralph flow [`'"]?[^`'"]+[`'"]? was not found/u.test(message),
  );

  useEffect(() => {
    if (!isActive || initialPromptAppliedRef.current) {
      return;
    }

    const firstLine = initialPrompt.split(/\r?\n/u)[0] ?? "";
    setAiPromptDraft(initialPrompt);
    setFlowAliasDraft(createFlowAlias(firstLine));
    initialPromptAppliedRef.current = true;
  }, [initialPrompt, isActive]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToDesktopTaskProgress((event) => {
      const generationActivity = createGenerationActivityFromProgress(
        event.progress,
        event.timestamp,
      );

      if (generationActivity) {
        setGenerationJob((current) => {
          const currentJob =
            current?.id === event.taskId
              ? current
              : current === null
                ? {
                    id: event.taskId,
                    target: "flow",
                    mode: "do-it",
                    scope: DEFAULT_RALPH_FLOW_SCOPE,
                    targetFlowId: null,
                    targetAlias: "ralph-flow",
                    startedAt: event.timestamp,
                    status: "running" as RalphGenerationStatus,
                    summary: "Ralph flow generation is running.",
                    activity: [],
                  }
                : current;

          return currentJob.id === event.taskId
            ? applyGenerationActivity(currentJob, generationActivity)
            : currentJob;
        });
      }

      const snapshot = getRalphProgressSnapshot(event.progress);

      if (!snapshot) {
        return;
      }

      setActiveRuns((current) =>
        current.map((run) => {
          if (run.id !== event.taskId) {
            return run;
          }

          const runEvent: ActiveRalphRunEvent = {
            id: `${event.timestamp}-${snapshot.eventType}-${snapshot.blockId ?? snapshot.activeBlockId ?? "run"}-${run.events.length}`,
            timestamp: event.timestamp,
            eventType: snapshot.eventType,
            label: snapshot.label,
            phase: snapshot.phase,
            tone: snapshot.tone,
            ...(snapshot.blockId ? { blockId: snapshot.blockId } : {}),
            ...(snapshot.blockTitle ? { blockTitle: snapshot.blockTitle } : {}),
            ...(snapshot.activeBlockId
              ? { activeBlockId: snapshot.activeBlockId }
              : {}),
            ...(snapshot.activeBlockTitle
              ? { activeBlockTitle: snapshot.activeBlockTitle }
              : {}),
            ...(snapshot.nextBlockId ? { nextBlockId: snapshot.nextBlockId } : {}),
            ...(snapshot.nextBlockTitle
              ? { nextBlockTitle: snapshot.nextBlockTitle }
              : {}),
            ...(snapshot.output ? { output: snapshot.output } : {}),
            ...(snapshot.attempt !== undefined ? { attempt: snapshot.attempt } : {}),
            ...(snapshot.detail ? { detail: snapshot.detail } : {}),
          };

          return {
            ...run,
            ...(snapshot.activeBlockId
              ? { currentBlockId: snapshot.activeBlockId }
              : {}),
            ...(snapshot.activeBlockTitle
              ? { currentBlockTitle: snapshot.activeBlockTitle }
              : {}),
            lastEventType: snapshot.eventType,
            lastMessage: snapshot.label,
            ...(snapshot.output ? { lastOutput: snapshot.output } : {}),
            events: [...run.events, runEvent].slice(-RALPH_GENERATION_ACTIVITY_LIMIT),
          };
        }),
      );
    }).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }

      unsubscribe = dispose;
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const shouldResetPositions =
      previousFlowLayoutKeyRef.current !== flowLayoutKey;
    previousFlowLayoutKeyRef.current = flowLayoutKey;

    setCanvasNodes((currentNodes) => {
      if (shouldResetPositions || currentNodes.length === 0) {
        return flowNodes;
      }

      const currentNodesById = new Map(
        currentNodes.map((node) => [node.id, node]),
      );
      const positionsById = getCanvasNodePositions(currentNodes);

      return flowNodes.map((node) => {
        const currentNode = currentNodesById.get(node.id);
        const currentPosition = currentNode
          ? positionsById.get(node.id)
          : undefined;
        const selected = currentNode?.selected ?? node.selected;

        return currentNode
          ? {
              ...node,
              position: currentPosition ?? node.position,
              selected,
              data: {
                ...node.data,
                selected: selected || node.data.selected,
              },
            }
          : node;
      });
    });
  }, [flowLayoutKey, flowNodes]);

  const refreshFlows = async (): Promise<void> => {
    if (!workspaceRoot) {
      return;
    }

    const requestId = flowListRequestRef.current + 1;
    flowListRequestRef.current = requestId;
    setFlowsLoading(true);
    setMessage(null);

    try {
      const scopeResults =
        flowLibraryMode === "all"
          ? await Promise.all(
              RALPH_FLOW_SCOPES.map(async (scope) => ({
                scope,
                result: await listRalphFlows(workspaceRoot, scope),
              })),
            )
          : [
              {
                scope: flowLibraryMode,
                result: await listRalphFlows(workspaceRoot, flowLibraryMode),
              },
            ];
      if (requestId !== flowListRequestRef.current) {
        return;
      }

      const loadedFlows = scopeResults
        .flatMap(({ scope, result }) =>
          result.flows.map((flow) => withFlowSummaryScope(flow, scope)),
        )
        .sort(compareFlowSummaries);
      setFlows(loadedFlows);

      const currentId = selectedIdRef.current;
      const currentScope = selectedScopeRef.current;
      const currentDraft = draftFlowRef.current;
      const currentDraftDirty = Boolean(
        currentDraft && getFlowSnapshot(currentDraft) !== savedSnapshotRef.current,
      );
      const currentDraftUnsaved =
        Boolean(currentDraft) &&
        unsavedFlowId === currentDraft?.id &&
        unsavedFlowScope === currentScope;
      const nextSelection = (() => {
        if (!currentId) {
          if (loadedFlows[0]) {
            return {
              id: loadedFlows[0].id,
              scope: getFlowSummaryScope(loadedFlows[0]),
            };
          }

          return currentDraft
            ? { id: currentDraft.id, scope: currentScope }
            : { id: "", scope: currentScope };
        }

        if (
          currentDraft?.id === currentId &&
          (currentDraftUnsaved || currentDraftDirty)
        ) {
          return { id: currentId, scope: currentScope };
        }

        const currentFlowStillVisible = loadedFlows.find((flow) =>
          hasFlowSelection(flow, currentId, currentScope),
        );

        if (currentFlowStillVisible) {
          return { id: currentId, scope: currentScope };
        }

        if (loadedFlows[0]) {
          return {
            id: loadedFlows[0].id,
            scope: getFlowSummaryScope(loadedFlows[0]),
          };
        }

        return currentDraft
          ? { id: currentDraft.id, scope: currentScope }
          : { id: "", scope: currentScope };
      })();

      replaceSelectedId(nextSelection.id, nextSelection.scope);
    } catch (error) {
      if (requestId === flowListRequestRef.current) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === flowListRequestRef.current) {
        setFlowsLoading(false);
      }
    }
  };

  const refreshRevisions = async (
    flowId: string,
    scope: RalphFlowScope = selectedScopeRef.current,
  ): Promise<void> => {
    if (!workspaceRoot || !flowId) {
      setRevisions([]);
      setRevisionsLoading(false);
      return;
    }

    setRevisionsLoading(true);

    try {
      const result = await listRalphFlowRevisions(workspaceRoot, flowId, scope);
      setRevisions(result.revisions);
    } catch (error) {
      setRevisions([]);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRevisionsLoading(false);
    }
  };

  const refreshRunHistory = async (
    flowId: string | null = selectedIdRef.current,
    scope: RalphFlowScope = selectedScopeRef.current,
  ): Promise<void> => {
    if (!workspaceRoot) {
      setRunHistory([]);
      setRunHistoryLoading(false);
      return;
    }

    setRunHistoryLoading(true);

    try {
      const result = await listRalphRuns(workspaceRoot, flowId || undefined, scope);
      setRunHistory(result.runs);
    } catch (error) {
      setRunHistory([]);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunHistoryLoading(false);
    }
  };

  const openRunDetail = async (
    runId: string,
    scope: RalphFlowScope = selectedScopeRef.current,
    options: { selectTab?: boolean } = {},
  ): Promise<void> => {
    if (!workspaceRoot) {
      return;
    }

    setSelectedRunId(runId);
    setRunDetailLoading(true);
    setRunDetailError(null);

    try {
      const result = await showRalphRunDetail(workspaceRoot, runId, scope);
      setSelectedRunDetail(result);
      setEditorMode("run");

      if (options.selectTab ?? true) {
        setRunPanelTab("details");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRunDetailError(message);
      setMessage(message);
    } finally {
      setRunDetailLoading(false);
    }
  };

  const openRunLog = async (
    runId: string,
    kind: "simple" | "trace",
    scope: RalphFlowScope = selectedScopeRef.current,
  ): Promise<void> => {
    if (!workspaceRoot) {
      return;
    }

    setRunLogLoading(true);

    try {
      const result = await showRalphRunLog(workspaceRoot, runId, kind, scope);
      setSelectedRunId(result.id);
      setSelectedRunLog({
        runId: result.id,
        kind: result.kind,
        content: result.content,
        path: result.path,
      });
      setEditorMode("run");
      setRunPanelTab("logs");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunLogLoading(false);
    }
  };

  const reconcileActiveRalphRuns = async (): Promise<void> => {
    const activeTasks = await loadActiveDesktopTasks();

    if (!activeTasks) {
      return;
    }

    const workspaceKey = normalizeWorkspaceForTaskComparison(workspaceRoot);
    const activeRalphTasks = activeTasks.filter(
      (task) =>
        task.kind === "ralph" &&
        normalizeWorkspaceForTaskComparison(task.workspaceRoot) === workspaceKey,
    );
    const flowNameByKey = new Map(
      flows.map((flow) => [
        getFlowSummarySelectionKey(flow),
        flow.name,
      ] as const),
    );
    const flowIdByReference = new Map<string, string>();

    for (const flow of flows) {
      const scope = getFlowSummaryScope(flow);
      flowIdByReference.set(getFlowSelectionKey(flow.id, scope), flow.id);

      if (flow.alias) {
        flowIdByReference.set(getFlowSelectionKey(flow.alias, scope), flow.id);
      }
    }

    if (draftFlow) {
      flowNameByKey.set(
        getFlowSelectionKey(draftFlow.id, selectedScope),
        draftFlow.name || draftFlow.id,
      );
      flowIdByReference.set(
        getFlowSelectionKey(draftFlow.id, selectedScope),
        draftFlow.id,
      );

      if (draftFlow.alias) {
        flowIdByReference.set(
          getFlowSelectionKey(draftFlow.alias, selectedScope),
          draftFlow.id,
        );
      }
    }

    const activeRalphRunTasks = activeRalphTasks
      .filter((task) => getRalphTaskAction(task) === "run")
      .map((task) => {
        const flowReference = getRalphTaskFlowReference(task);
        const scope = getRalphTaskFlowScope(task);
        const parsed = parseRalphRunTaskId(task.id);
        const flowId =
          (flowReference
            ? flowIdByReference.get(getFlowSelectionKey(flowReference, scope))
            : undefined) ??
          flowReference ??
          parsed?.flowId;

        return flowId
          ? {
              id: task.id,
              flowId,
              scope,
              startedAt: task.startedAt || parsed?.startedAt || Date.now(),
            }
          : null;
      })
      .filter(
        (
          task,
        ): task is {
          id: string;
          flowId: string;
          scope: RalphFlowScope;
          startedAt: number;
        } => Boolean(task),
      );
    const activeIds = new Set(activeRalphRunTasks.map((task) => task.id));
    const now = Date.now();

    setActiveRuns((current) => {
      const currentById = new Map(current.map((run) => [run.id, run] as const));
      const next = current
        .filter((run) => activeIds.has(run.id) || now - run.startedAt < 5_000)
        .map((run) => ({
          ...run,
          flowName:
            flowNameByKey.get(getFlowSelectionKey(run.flowId, run.scope)) ??
            run.flowName,
        }));

      for (const task of activeRalphRunTasks) {
        if (currentById.has(task.id)) {
          continue;
        }

        next.push({
          id: task.id,
          flowId: task.flowId,
          scope: task.scope,
          flowName:
            flowNameByKey.get(getFlowSelectionKey(task.flowId, task.scope)) ??
            titleFromId(task.flowId),
          startedAt: task.startedAt,
          status: "running",
          mode: runMode,
          provider: runProvider,
          model: runModel,
          ...(runProfile ? { profile: runProfile } : {}),
          ...(runReasoning ? { reasoning: runReasoning } : {}),
          ...(defaultMaxTransitions
            ? { maxTransitions: defaultMaxTransitions }
            : {}),
          variableValues: {},
          events: [],
        });
      }

      return next.sort((left, right) => right.startedAt - left.startedAt);
    });

    const activeGenerationTasks = activeRalphTasks.filter(
      (task) => getRalphTaskAction(task) === "create",
    );
    const newestGenerationTask = [...activeGenerationTasks].sort(
      (left, right) => right.startedAt - left.startedAt,
    )[0];
    const currentGenerationFinished =
      Boolean(generationJob) &&
      (generationJob?.status === "running" || generationJob?.status === "stopping") &&
      !activeRalphTasks.some((task) => task.id === generationJob?.id) &&
      (generationJob?.status !== "running" ||
        now - generationJob.startedAt > ACTIVE_TASK_REGISTRATION_GRACE_MS);

    if (currentGenerationFinished) {
      void refreshFlows();
    }

    setGenerationJob((current) => {
      if (current?.status === "running" || current?.status === "stopping") {
        if (!activeRalphTasks.some((task) => task.id === current.id)) {
          if (
            current.status === "running" &&
            now - current.startedAt <= ACTIVE_TASK_REGISTRATION_GRACE_MS
          ) {
            return current;
          }

          return {
            ...current,
            status: current.status === "stopping" ? "failed" : "blocked",
            summary:
              current.status === "stopping"
                ? "AI flow generation stopped."
                : "AI flow generation finished in the background. Refresh flows to inspect the result.",
          };
        }

        return current;
      }

      if (!current && newestGenerationTask) {
        const alias =
          getRalphTaskFlowReference(newestGenerationTask) ?? "ralph-flow";

        return {
          id: newestGenerationTask.id,
          target: "flow",
          mode: "do-it",
          scope: getRalphTaskFlowScope(newestGenerationTask),
          targetFlowId: null,
          targetAlias: alias,
          startedAt: newestGenerationTask.startedAt,
          status: "running",
          summary: `AI flow generation \`${alias}\` is running in the background.`,
          activity: [],
        };
      }

      return current;
    });
  };

  useEffect(() => {
    if (!isActive || !workspaceRoot) {
      return;
    }

    void refreshFlows();
  }, [flowLibraryMode, isActive, workspaceRoot]);

  useEffect(() => {
    if (!isActive || !workspaceRoot) {
      return;
    }

    let cancelled = false;
    const reconcile = (): void => {
      void reconcileActiveRalphRuns().catch((error) => {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : String(error));
        }
      });
    };
    reconcile();
    const interval = window.setInterval(reconcile, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    draftFlow?.id,
    draftFlow?.name,
    flows,
    generationJob?.id,
    generationJob?.status,
    isActive,
    defaultMaxTransitions,
    runMode,
    runModel,
    runProfile,
    runProvider,
    runReasoning,
    selectedScope,
    workspaceRoot,
  ]);

  useEffect(() => {
    if (!isActive || !workspaceRoot || !selectedId || selectedFlowUnsaved) {
      setRevisions([]);
      setRevisionsLoading(false);
      return;
    }

    void refreshRevisions(selectedId, selectedScope);
  }, [isActive, selectedFlowUnsaved, selectedId, selectedScope, workspaceRoot]);

  useEffect(() => {
    if (!isActive || !workspaceRoot || !selectedId || selectedFlowUnsaved) {
      setRunHistory([]);
      setRunHistoryLoading(false);
      setSelectedRunLog(null);
      setSelectedRunId(null);
      setSelectedRunDetail(null);
      setRunDetailError(null);
      return;
    }

    setSelectedRunId(null);
    setSelectedRunDetail(null);
    setRunDetailError(null);
    setSelectedRunLog(null);
    void refreshRunHistory(selectedId, selectedScope);
  }, [isActive, selectedFlowUnsaved, selectedId, selectedScope, workspaceRoot]);

  useEffect(() => {
    if (!isActive || !hasDraftFlow) {
      return;
    }

    let cancelled = false;

    void loadProviderModelCatalog()
      .then((catalog) => {
        if (!cancelled) {
          setModelCatalog(catalog);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModelCatalog(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hasDraftFlow, isActive]);

  useEffect(() => {
    if (!selectedUtility) {
      setUtilityJsonDraft("");
      setUtilityJsonError(null);
      return;
    }

    setUtilityJsonDraft(formatJsonDraft(selectedUtility));
    setUtilityJsonError(null);
  }, [selectedBlock?.id, selectedUtility]);

  useEffect(() => {
    if (!isActive || !workspaceRoot || !selectedId) {
      setDetailsLoading(false);
      replaceDraftFlow(null, selectedScope);
      replaceSavedSnapshot("");
      setVariableValues({});
      setSelectedBlockId(null);
      setLastRun(null);
      return;
    }

    if (selectedFlowUnsaved && draftFlow?.id === selectedId) {
      setDetailsLoading(false);
      return;
    }

    let cancelled = false;

    setDetailsLoading(true);
    void showRalphFlow(workspaceRoot, selectedId, selectedScope)
      .then((result) => {
        if (cancelled) {
          return;
        }

        replaceDraftFlow(result.flow, selectedScope);
        replaceSavedSnapshot(getFlowSnapshot(result.flow));
        setSelectedBlockId(result.flow.blocks[0]?.id ?? null);
        setVariableValues(
          Object.fromEntries(
            (result.flow.variables ?? []).map((variable) => [
              variable.name,
              variable.default ?? "",
            ]),
          ),
        );
        setLastRun(null);
      })
      .catch((error) => {
        if (!cancelled) {
          replaceDraftFlow(null, selectedScope);
          replaceSavedSnapshot("");
          setVariableValues({});
          setSelectedBlockId(null);
          setLastRun(null);
          setMessage(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    draftFlow?.id,
    isActive,
    selectedFlowUnsaved,
    selectedId,
    selectedScope,
    workspaceRoot,
  ]);

  const restoreDraftSnapshotFromHistory = (snapshot: string): RalphFlow | null => {
    try {
      const restored = JSON.parse(snapshot) as RalphFlow;
      draftFlowRef.current = restored;
      setDraftFlow(restored);
      setSelectedEdgeId(null);
      setCanvasMenu(null);
      setSelectedBlockId((current) =>
        current === null
          ? null
          : current && restored.blocks.some((block) => block.id === current)
          ? current
          : restored.blocks[0]?.id ?? null,
      );
      return restored;
    } catch {
      setMessage("Could not restore the editor history snapshot.");
      return null;
    }
  };

  const undoFlowEdit = (): void => {
    if (!draftFlow || undoStack.length === 0) {
      return;
    }

    const currentSnapshot = getFlowSnapshot(draftFlow);
    const previousSnapshot = undoStack[undoStack.length - 1];

    if (!previousSnapshot) {
      return;
    }

    setUndoStack((current) => current.slice(0, -1));
    setRedoStack((current) =>
      [currentSnapshot, ...current].slice(0, MAX_RALPH_HISTORY_ENTRIES),
    );
    restoreDraftSnapshotFromHistory(previousSnapshot);
  };

  const redoFlowEdit = (): void => {
    if (!draftFlow || redoStack.length === 0) {
      return;
    }

    const currentSnapshot = getFlowSnapshot(draftFlow);
    const nextSnapshot = redoStack[0];

    if (!nextSnapshot) {
      return;
    }

    setRedoStack((current) => current.slice(1));
    setUndoStack((current) =>
      [...current, currentSnapshot].slice(-MAX_RALPH_HISTORY_ENTRIES),
    );
    restoreDraftSnapshotFromHistory(nextSnapshot);
  };

  const updateDraftFlow = (
    updater: (flow: RalphFlow) => RalphFlow,
  ): void => {
    setDraftFlow((current) => {
      if (!current) {
        draftFlowRef.current = current;
        return current;
      }

      const next = updater(current);
      const currentSnapshot = getFlowSnapshot(current);
      const nextSnapshot = getFlowSnapshot(next);

      if (currentSnapshot !== nextSnapshot) {
        setUndoStack((history) =>
          [...history, currentSnapshot].slice(-MAX_RALPH_HISTORY_ENTRIES),
        );
        setRedoStack([]);
      }

      draftFlowRef.current = next;
      return next;
    });
  };

  const updateBlock = (
    blockId: string,
    updater: (block: RalphFlowBlock) => RalphFlowBlock,
  ): void => {
    updateDraftFlow((flow) => ({
      ...flow,
      blocks: flow.blocks.map((block) =>
        block.id === blockId ? updater(block) : block,
      ),
    }));
  };

  const updateSelectedBlockSettings = (
    patch: Partial<RalphBlockSettings>,
  ): void => {
    if (!selectedBlock) {
      return;
    }

    updateBlock(selectedBlock.id, (block) => ({
      ...block,
      settings: {
        ...(block.settings ?? {}),
        ...patch,
      },
    }));
  };

  const updateSelectedUtility = (
    patch: Partial<RalphUtilityConfig>,
  ): void => {
    if (!selectedBlock || selectedBlock.type !== "UTILITY") {
      return;
    }

    updateBlock(selectedBlock.id, (block) =>
      block.type === "UTILITY"
        ? {
            ...block,
            utility: {
              ...block.utility,
              ...patch,
            },
          }
        : block,
    );
  };

  const replaceSelectedUtility = (utility: RalphUtilityConfig): void => {
    if (!selectedBlock || selectedBlock.type !== "UTILITY") {
      return;
    }

    updateBlock(selectedBlock.id, (block) =>
      block.type === "UTILITY"
        ? {
            ...block,
            title: shouldSyncUtilityTitle(block.title, block.utility.type)
              ? formatUtilityTypeLabel(utility.type)
              : block.title,
            utility,
          }
        : block,
    );
  };

  const updateSelectedDecisionLabels = (
    updater: (labels: string[]) => string[],
  ): void => {
    if (!selectedBlock || selectedBlock.type !== "DECISION") {
      return;
    }

    updateBlock(selectedBlock.id, (block) =>
      block.type === "DECISION"
        ? {
            ...block,
            labels: updater(block.labels)
              .map((label) => label.trim().toUpperCase())
              .filter(Boolean),
          }
        : block,
    );
  };

  const updateSelectedValidatorScope = (
    updater: (scope: RalphValidationScope) => RalphValidationScope,
  ): void => {
    if (!selectedBlock || selectedBlock.type !== "VALIDATOR") {
      return;
    }

    updateBlock(selectedBlock.id, (block) =>
      block.type === "VALIDATOR"
        ? {
            ...block,
            validationScope: updater(
              block.validationScope ?? { mode: "sinceLastValidator" },
            ),
          }
        : block,
    );
  };

  const updateSelectedMcpArguments = (value: string): void => {
    if (
      !selectedBlock ||
      (selectedBlock.type !== "MCP_TOOL" && selectedBlock.type !== "MCP_PROMPT")
    ) {
      return;
    }

    const parsed = parseJsonDraft(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setMessage("MCP arguments must be a JSON object.");
      return;
    }

    updateBlock(selectedBlock.id, (block) =>
      block.type === "MCP_TOOL" || block.type === "MCP_PROMPT"
        ? {
            ...block,
            arguments: parsed as Record<string, unknown>,
          }
        : block,
    );
    setMessage(null);
  };

  const applyUtilityJsonDraft = (): void => {
    const parsed = parseJsonDraft(utilityJsonDraft);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setUtilityJsonError("Utility JSON must be an object.");
      return;
    }

    const utilityType = (parsed as { type?: unknown }).type;
    if (!UTILITY_TYPE_OPTIONS.includes(utilityType as RalphUtilityType)) {
      setUtilityJsonError("Utility JSON requires a valid type.");
      return;
    }

    replaceSelectedUtility(parsed as RalphUtilityConfig);
    setUtilityJsonError(null);
  };

  const attachPathsToBlock = async (
    blockId: string,
    paths: string[],
  ): Promise<void> => {
    const resolution = await resolveDroppedPaths(paths);
    const incomingAttachments = resolution.entries.map(createRalphPathAttachment);

    if (incomingAttachments.length === 0) {
      return;
    }

    updateBlock(blockId, (block) => ({
      ...block,
      settings: {
        ...(block.settings ?? {}),
        attachments: mergeRalphAttachments(
          block.settings?.attachments ?? [],
          incomingAttachments,
        ),
      },
    }));
  };

  const handleSelectBlockAttachments = async (
    selectionKind: RalphAttachmentSelectionKind,
  ): Promise<void> => {
    if (!selectedBlock) {
      return;
    }

    if (selectionKind === "images" && !selectedBlockImageInputSupported) {
      setMessage(selectedBlockImageInputDisabledReason);
      return;
    }

    const blockId = selectedBlock.id;

    if (!isTauri()) {
      await attachPathsToBlock(blockId, [
        selectionKind === "folders"
          ? "/mock/context-folder"
          : selectionKind === "images"
            ? "/mock/screenshot.png"
            : "/mock/document.txt",
      ]);
      return;
    }

    const selectingFolders = selectionKind === "folders";
    const selectingImages = selectionKind === "images";

    try {
      const selected = (await openDialog({
        directory: selectingFolders,
        multiple: true,
        title: selectingFolders
          ? "Add Folders as Context"
          : selectingImages
            ? "Add Images as Context"
            : "Add Files as Context",
        ...(selectingImages
          ? {
              filters: [
                {
                  name: "Images",
                  extensions: getSupportedImageInputExtensions(
                    selectedBlockEffectiveProvider,
                  ),
                },
              ],
            }
          : {}),
      })) as string | string[] | null;

      const paths = Array.isArray(selected)
        ? selected
        : selected
          ? [selected]
          : [];

      await attachPathsToBlock(blockId, paths);
    } catch (error) {
      console.error("Failed to select Ralph block attachments", error);
      setMessage("Failed to select Ralph block attachments.");
    }
  };

  const removeSelectedBlockPathAttachment = (attachmentId: string): void => {
    if (!selectedBlock) {
      return;
    }

    updateBlock(selectedBlock.id, (block) => ({
      ...block,
      settings: {
        ...(block.settings ?? {}),
        attachments: (block.settings?.attachments ?? []).filter(
          (attachment, index) =>
            attachment.source !== "path" ||
            (attachment.id ?? `ralph-path-${index}`) !== attachmentId,
        ),
      },
    }));
  };

  const clearSelectedBlockPathAttachments = (): void => {
    if (!selectedBlock) {
      return;
    }

    updateBlock(selectedBlock.id, (block) => ({
      ...block,
      settings: {
        ...(block.settings ?? {}),
        attachments: (block.settings?.attachments ?? []).filter(
          (attachment) => attachment.source !== "path",
        ),
      },
    }));
  };

  const addSelectedBlockVariableAttachment = (): void => {
    if (!selectedBlock) {
      return;
    }

    const existingVariables = selectedBlockVariableAttachmentItems.length;
    const value = `{{attachment_${existingVariables + 1}:file}}`;

    updateBlock(selectedBlock.id, (block) => ({
      ...block,
      settings: {
        ...(block.settings ?? {}),
        attachments: mergeRalphAttachments(block.settings?.attachments ?? [], [
          {
            id: crypto.randomUUID(),
            source: "variable",
            value,
            kind: "file",
          },
        ]),
      },
    }));
  };

  const updateSelectedBlockVariableAttachment = (
    attachmentKey: string,
    value: string,
  ): void => {
    if (!selectedBlock) {
      return;
    }

    updateBlock(selectedBlock.id, (block) => ({
      ...block,
      settings: {
        ...(block.settings ?? {}),
        attachments: (block.settings?.attachments ?? []).flatMap(
          (attachment, index): RalphAttachmentReference[] => {
            const currentKey = attachment.id ?? `ralph-variable-${index}`;
            const matches =
              attachment.source === "variable" &&
              currentKey === attachmentKey;

            if (!matches) {
              return [attachment];
            }

            const normalizedValue = value.trim();

            return normalizedValue
              ? [
                  {
                    ...attachment,
                    value,
                  },
                ]
              : [];
          },
        ),
      },
    }));
  };

  const removeSelectedBlockVariableAttachment = (
    attachmentKey: string,
  ): void => {
    updateSelectedBlockVariableAttachment(attachmentKey, "");
  };

  const applyNewLocalFlow = (): void => {
    const nextAlias = createUniqueFlowAlias(
      normalizedFlowAliasDraft || "ralph-flow",
      displayFlows,
      creationScope,
    );
    const nextFlow = createBlankFlow(nextAlias);

    setDetailsLoading(false);
    replaceDraftFlow(nextFlow, creationScope);
    replaceSavedSnapshot("");
    replaceSelectedId(nextFlow.id, creationScope);
    setUnsavedFlowId(nextFlow.id);
    setUnsavedFlowScope(creationScope);
    setFlowAliasDraft(nextAlias);
    setSelectedBlockId("start");
    setVariableValues({});
    setRevisions([]);
    setLastRun(null);
    setEditorMode("design");
    setMessage("Draft flow created. Save it before running.");
  };

  const applyGeneratedFlow = (
    generatedFlow: RalphFlow,
    scope: RalphFlowScope,
  ): void => {
    replaceDraftFlow(generatedFlow, scope);
    replaceSavedSnapshot(getFlowSnapshot(generatedFlow));
    replaceSelectedId(generatedFlow.id, scope);
    setUnsavedFlowId((current) =>
      current === generatedFlow.id && unsavedFlowScope === scope ? null : current,
    );
    setSelectedBlockId(generatedFlow.blocks[0]?.id ?? null);
    setVariableValues(
      Object.fromEntries(
        (generatedFlow.variables ?? []).map((variable) => [
          variable.name,
          variable.default ?? "",
        ]),
      ),
    );
    setEditorMode("design");
    setMessage(null);
  };

  const createAiGenerationStartContext = (
    normalizedAiPrompt: string,
  ): RalphAiGenerationStartContext | null => {
    if (!workspaceRoot || !normalizedAiPrompt) {
      return null;
    }

    if (aiTarget === "prompt-block" && !aiPromptBlock) {
      setAiTarget("flow");
      setMessage("Select a PROMPT block before using Prompt.");
      return null;
    }

    const currentDraft = draftFlowRef.current;

    if (aiTarget !== "flow" && !currentDraft) {
      setMessage("Select or create a flow before applying AI changes.");
      return null;
    }

    const targetScope = aiTarget === "flow" ? creationScope : selectedScope;
    const targetFlowName =
      aiTarget === "flow"
        ? createUniqueFlowAlias(
            normalizedFlowAliasDraft || "ralph-flow",
            displayFlows,
            targetScope,
          )
        : currentDraft
          ? getFlowAlias(currentDraft)
          : "";
    const existingFlow = aiTarget === "flow" ? undefined : currentDraft ?? undefined;
    const generationPrompt =
      aiTarget === "prompt-block" && aiPromptBlock
        ? createPromptBlockGenerationPrompt(normalizedAiPrompt, aiPromptBlock)
        : normalizedAiPrompt;

    if (!targetFlowName) {
      setMessage("Expected a Ralph flow alias before generating a flow.");
      return null;
    }

    const draftSnapshotAtStart = currentDraft ? getFlowSnapshot(currentDraft) : "";
    const savedSnapshotAtStart = savedSnapshotRef.current;

    return {
      userPrompt: normalizedAiPrompt,
      generationPrompt,
      target: aiTarget,
      generationMode: aiGenerationMode,
      targetScope,
      targetFlowName,
      ...(existingFlow ? { existingFlow } : {}),
      targetFlowId: existingFlow?.id ?? null,
      selectedIdAtStart: selectedIdRef.current,
      selectedScopeAtStart: selectedScopeRef.current,
      draftSnapshotAtStart,
      savedSnapshotAtStart,
      draftWasDirtyAtStart: Boolean(
        currentDraft && draftSnapshotAtStart !== savedSnapshotAtStart,
      ),
      ...(aiTarget === "prompt-block" && aiPromptBlock
        ? { promptBlockLabel: formatPromptBlockTargetLabel(aiPromptBlock) }
        : {}),
    };
  };

  const executeFlowGenerationWithAgent = async (
    context: RalphAiGenerationStartContext,
    generationPrompt: string,
    generationMode: RalphAiGenerationMode,
  ): Promise<void> => {
    if (!workspaceRoot) {
      return;
    }

    const jobId = `generation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    generationRequestRef.current = jobId;
    setGenerationErrorCopyState("idle");
    setGenerationJob({
      id: jobId,
      target: context.target,
      mode: generationMode,
      scope: context.targetScope,
      targetFlowId: context.targetFlowId,
      targetAlias: context.targetFlowName,
      startedAt: Date.now(),
      status: "running",
      summary:
        context.target === "flow"
          ? `Generating new Ralph flow \`${context.targetFlowName}\`.`
          : `Applying AI flow changes to \`${context.targetFlowName}\`.`,
      activity: [],
      ...(generationProvider ? { provider: generationProvider } : {}),
      ...(generationModel ? { model: generationModel } : {}),
    });
    setMessage(null);

    try {
      const result = await createRalphFlow(workspaceRoot, {
        prompt: generationPrompt,
        scope: context.targetScope,
        mode: runMode,
        provider: generationProvider,
        model: generationModel,
        ...(generationProfile ? { profile: generationProfile } : {}),
        ...(generationReasoning ? { reasoning: generationReasoning } : {}),
        name: context.targetFlowName,
        ...(context.existingFlow ? { existingFlow: context.existingFlow } : {}),
        target: context.target,
        generationMode,
        taskId: jobId,
      });
      if (generationRequestRef.current !== jobId) {
        return;
      }

      const formattedMessage = formatCreateFlowMessage(result);
      setGenerationJob((current) =>
        current?.id === jobId
          ? result.events?.reduce(
              (job, event) =>
                applyGenerationActivity(
                  job,
                  createGenerationActivityFromResultEvent(event),
                ),
              {
                ...current,
                status: result.status,
                summary: formattedMessage,
                result,
                flowPath: result.flowPath,
                ...(result.generationLogPath
                  ? { generationLogPath: result.generationLogPath }
                  : {}),
                ...(result.traceLogPath ? { traceLogPath: result.traceLogPath } : {}),
                validationValid: result.validation.valid,
                validationErrorCount: result.validation.errors.length,
                validationWarningCount: result.validation.warnings.length,
                ...(result.flow
                  ? {
                      blockCount: result.flow.blocks.length,
                      edgeCount: result.flow.edges.length,
                    }
                  : {}),
              },
            ) ?? {
              ...current,
              status: result.status,
              summary: formattedMessage,
              result,
              flowPath: result.flowPath,
              ...(result.generationLogPath
                ? { generationLogPath: result.generationLogPath }
                : {}),
              ...(result.traceLogPath ? { traceLogPath: result.traceLogPath } : {}),
              validationValid: result.validation.valid,
              validationErrorCount: result.validation.errors.length,
              validationWarningCount: result.validation.warnings.length,
              ...(result.flow
                ? {
                    blockCount: result.flow.blocks.length,
                    edgeCount: result.flow.edges.length,
                  }
                : {}),
            }
          : current,
      );
      setMessage(formattedMessage);

      if (result.flow?.id) {
        setFlows((current) =>
          upsertFlowSummary(
            current,
            flowToSummary(result.flow, result.flowPath, context.targetScope),
          ),
        );
        const currentDraft = draftFlowRef.current;
        const currentDraftSnapshot = currentDraft
          ? getFlowSnapshot(currentDraft)
          : "";
        const canAdoptGeneratedFlow =
          selectedIdRef.current === context.selectedIdAtStart &&
          (context.target === "flow"
            ? !context.draftWasDirtyAtStart
            : selectedScopeRef.current === context.selectedScopeAtStart &&
              selectedScopeRef.current === context.targetScope &&
              currentDraft?.id === context.targetFlowId &&
              currentDraftSnapshot === context.draftSnapshotAtStart);

        if (canAdoptGeneratedFlow) {
          replaceDraftFlow(result.flow, context.targetScope);
          replaceSavedSnapshot(getFlowSnapshot(result.flow));
          replaceSelectedId(result.flow.id, context.targetScope);
          setUnsavedFlowId((current) =>
            current === result.flow?.id && unsavedFlowScope === context.targetScope
              ? null
              : current,
          );
          setSelectedBlockId(result.flow.blocks[0]?.id ?? null);
          setVariableValues(
            Object.fromEntries(
              (result.flow.variables ?? []).map((variable) => [
                variable.name,
                variable.default ?? "",
              ]),
            ),
          );
        }
        setRevisions([]);
      }
    } catch (error) {
      if (generationRequestRef.current !== jobId) {
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      setGenerationJob((current) =>
        current?.id === jobId
          ? {
              ...current,
              status: "failed",
              summary: errorMessage,
              error: errorMessage,
            }
          : current,
      );
      setMessage(errorMessage);
    } finally {
      if (generationRequestRef.current === jobId) {
        generationRequestRef.current = null;
      }
    }
  };

  const applyGenerationInterviewResult = async (
    context: RalphAiGenerationStartContext,
    taskId: string,
    result: RalphGenerationInterviewResult,
  ): Promise<void> => {
    const fields = result.fields ?? [];
    const nextValues = createDefaultRalphInputValues(fields);
    const findings = result.session.findings ?? [];
    const assumptions = result.session.assumptions ?? [];
    const relevantFiles = result.session.relevantFiles ?? [];

    if (result.status === "questions") {
      setGenerationInterview((current) =>
        current?.taskId === taskId
          ? {
              ...current,
              status: "ready",
              session: result.session,
              fields,
              values: nextValues,
              answerComments: {},
              expandedCommentFieldIds: [],
              skippedFieldIds: [],
              validationErrors: {},
              summary: result.summary,
              findings,
              assumptions,
              relevantFiles,
              provider: result.provider,
              model: result.model,
              error: undefined,
            }
          : current,
      );
      setMessage("Answer the interview questions to continue Ralph generation.");
      return;
    }

    if (result.status === "blocked") {
      setGenerationInterview((current) =>
        current?.taskId === taskId
          ? {
              ...current,
              status: "blocked",
              session: result.session,
              fields,
              values: nextValues,
              answerComments: {},
              expandedCommentFieldIds: [],
              skippedFieldIds: [],
              validationErrors: {},
              summary: result.summary,
              findings,
              assumptions,
              relevantFiles,
              provider: result.provider,
              model: result.model,
              error: result.summary,
            }
          : current,
      );
      setMessage(result.summary);
      return;
    }

    const finalPrompt =
      result.finalPrompt ??
      createLocalGenerationInterviewPrompt(context, result.session, [], {});

    setGenerationInterview((current) =>
      current?.taskId === taskId
        ? {
            ...current,
            status: "generating",
            session: result.session,
            fields: [],
            values: {},
            answerComments: {},
            expandedCommentFieldIds: [],
            skippedFieldIds: [],
            validationErrors: {},
            summary: result.summary,
            findings,
            assumptions,
            relevantFiles,
            finalPrompt,
            provider: result.provider,
            model: result.model,
          }
        : current,
    );
    await executeFlowGenerationWithAgent(context, finalPrompt, "do-it");
    setGenerationInterview((current) =>
      current?.taskId === taskId ? null : current,
    );
  };

  const requestGenerationInterviewRound = async (
    context: RalphAiGenerationStartContext,
    session?: RalphGenerationInterviewSession,
    answers?: Record<string, RalphInputValue>,
    answerComments?: Record<string, string>,
  ): Promise<void> => {
    if (!workspaceRoot) {
      return;
    }

    const taskId = `generation-interview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    setGenerationInterview((current) => ({
      context,
      status: "loading",
      session: session ?? current?.session,
      fields: current?.fields ?? [],
      values: current?.values ?? {},
      answerComments: current?.answerComments ?? {},
      expandedCommentFieldIds: current?.expandedCommentFieldIds ?? [],
      skippedFieldIds: current?.skippedFieldIds ?? [],
      validationErrors: {},
      summary: session
        ? "Reviewing answers"
        : "Preparing questions",
      findings: current?.findings ?? [],
      assumptions: current?.assumptions ?? [],
      relevantFiles: current?.relevantFiles ?? [],
      taskId,
    }));

    try {
      const result = await runRalphGenerationInterview(workspaceRoot, {
        prompt: context.generationPrompt,
        scope: context.targetScope,
        name: context.targetFlowName,
        mode: runMode,
        provider: generationProvider,
        model: generationModel,
        ...(generationProfile ? { profile: generationProfile } : {}),
        ...(generationReasoning ? { reasoning: generationReasoning } : {}),
        ...(context.existingFlow ? { existingFlow: context.existingFlow } : {}),
        target: context.target,
        maxTurns: 5,
        taskId,
        ...(session ? { session } : {}),
        ...(answers ? { answers } : {}),
        ...(answerComments && Object.keys(answerComments).length > 0
          ? { answerComments }
          : {}),
      });

      await applyGenerationInterviewResult(context, taskId, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setGenerationInterview((current) =>
        current?.taskId === taskId
          ? {
              ...current,
              status: "blocked",
              summary: errorMessage,
              error: errorMessage,
            }
          : current,
      );
      setMessage(errorMessage);
    }
  };

  const createFlowWithAgent = async (): Promise<void> => {
    const normalizedAiPrompt = aiPromptDraft.trim();
    const context = createAiGenerationStartContext(normalizedAiPrompt);

    if (!context) {
      return;
    }

    rememberAiPromptHistoryEntry(normalizedAiPrompt);
    resetAiPromptHistoryNavigation();

    if (context.generationMode === "interview") {
      await requestGenerationInterviewRound(context);
      return;
    }

    await executeFlowGenerationWithAgent(
      context,
      context.generationPrompt,
      context.generationMode,
    );
  };

  const copyGenerationError = async (): Promise<void> => {
    if (!canCopyGenerationError(generationJob) || !navigator.clipboard) {
      setGenerationErrorCopyState("failed");
      return;
    }

    try {
      await navigator.clipboard.writeText(
        formatGenerationErrorClipboardText(generationJob),
      );
      setGenerationErrorCopyState("copied");
    } catch {
      setGenerationErrorCopyState("failed");
    }
  };

  const persistFlow = async (
    formatMessage: (result: RalphPersistedFlowResult) => string,
  ): Promise<boolean> => {
    if (!workspaceRoot || !draftFlow) {
      return false;
    }

    if (
      selectedId &&
      (draftFlow.id !== selectedId || draftFlowScope !== selectedScope)
    ) {
      setMessage(
        "The selected flow changed while details were loading. Reopen the flow before saving.",
      );
      return false;
    }

    const requestId = saveRequestRef.current + 1;
    saveRequestRef.current = requestId;
    const saveScope = selectedScope;
    const flowToSave = normalizeDerivedGroupMembership(draftFlow);
    setLoading(true);
    setMessage(null);

    try {
      const result = await saveRalphFlow(workspaceRoot, {
        flow: flowToSave,
        scope: saveScope,
      });
      if (requestId !== saveRequestRef.current) {
        return false;
      }

      replaceDraftFlow(result.flow, saveScope);
      replaceSavedSnapshot(getFlowSnapshot(result.flow));
      replaceSelectedId(result.flow.id, saveScope);
      setUnsavedFlowId((current) =>
        current === result.flow.id && unsavedFlowScope === saveScope
          ? null
          : current,
      );
      setVariableValues(
        Object.fromEntries(
          (result.flow.variables ?? []).map((variable) => [
            variable.name,
            variable.default ?? "",
          ]),
        ),
      );
      setMessage(formatMessage(result));
      setFlows((current) =>
        upsertFlowSummary(
          current,
          flowToSummary(result.flow, result.path, saveScope),
        ),
      );
      setRevisions([]);
      return true;
    } catch (error) {
      if (requestId === saveRequestRef.current) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
      return false;
    } finally {
      if (requestId === saveRequestRef.current) {
        setLoading(false);
      }
    }
  };

  const saveFlow = async (): Promise<void> => {
    await persistFlow(formatSaveFlowMessage);
  };

  const saveDirtyDraftBeforeReplacement = async (
    action: string,
  ): Promise<boolean> => {
    if (!dirty) {
      return true;
    }

    if (loading) {
      setMessage("Wait for the current edit operation to finish.");
      return false;
    }

    if (generationRunning && generationJob?.targetFlowId === draftFlow?.id) {
      setMessage("Wait for the current AI flow change to finish before switching flows.");
      return false;
    }

    return persistFlow((result) => {
      const message = formatSaveFlowMessage(result);

      return message === "Flow saved."
        ? `Flow saved before ${action}.`
        : message;
    });
  };

  const createLocalFlow = async (): Promise<void> => {
    if (!(await saveDirtyDraftBeforeReplacement("creating a new flow"))) {
      return;
    }

    applyNewLocalFlow();
  };

  const openGeneratedFlow = async (): Promise<void> => {
    const generatedFlow = generationJob?.result?.flow;
    const generatedScope = generationJob?.scope ?? creationScope;

    if (!generatedFlow) {
      return;
    }

    if (!(await saveDirtyDraftBeforeReplacement("opening the generated flow"))) {
      return;
    }

    applyGeneratedFlow(generatedFlow, generatedScope);
  };

  const selectFlow = async (flow: RalphFlowSummary): Promise<void> => {
    const flowScope = getFlowSummaryScope(flow);

    if (flow.id === selectedId && flowScope === selectedScope) {
      return;
    }

    const canLoadFlow =
      Boolean(flow.path) ||
      (draftFlow?.id === flow.id && flowScope === selectedScope);

    if (!canLoadFlow) {
      setMessage(
        `Ralph run \`${flow.name}\` is active, but its saved flow is not available in this workspace.`,
      );
      setEditorMode("run");
      return;
    }

    if (!(await saveDirtyDraftBeforeReplacement("switching flows"))) {
      return;
    }

    replaceSelectedId(flow.id, flowScope);
  };

  const closeFlowListMenu = (): void => {
    setFlowListMenu(null);
  };

  const getFlowActiveRuns = (flow: RalphFlowSummary): ActiveRalphRun[] => {
    return (
      activeRunsByFlowKey.get(
        getFlowSelectionKey(flow.id, getFlowSummaryScope(flow)),
      ) ?? []
    );
  };

  const isGenerationTargetingFlow = (flow: RalphFlowSummary): boolean => {
    return Boolean(
      generationRunning &&
        generationJob?.targetFlowId === flow.id &&
        generationJob.scope === getFlowSummaryScope(flow),
    );
  };

  const loadTargetFlowExists = async (
    flow: RalphFlowSummary,
    targetScope: RalphFlowScope,
  ): Promise<boolean> => {
    if (flows.some((candidate) => hasFlowSelection(candidate, flow.id, targetScope))) {
      return true;
    }

    if (isFlowScopeVisibleInLibraryMode(targetScope, flowLibraryMode)) {
      return false;
    }

    const result = await listRalphFlows(workspaceRoot, targetScope);

    return result.flows.some((candidate) => candidate.id === flow.id);
  };

  const copyOrMoveFlowToScope = async (
    flow: RalphFlowSummary,
    targetScope: RalphFlowScope,
    operation: "copy" | "move",
  ): Promise<void> => {
    closeFlowListMenu();

    if (!workspaceRoot || !flow.path) {
      return;
    }

    const sourceScope = getFlowSummaryScope(flow);
    const sourceScopeLabel = RALPH_FLOW_SCOPE_LABELS[sourceScope].toLowerCase();
    const targetScopeLabel = RALPH_FLOW_SCOPE_LABELS[targetScope].toLowerCase();

    if (sourceScope === targetScope) {
      setMessage(`Ralph flow \`${flow.name}\` is already ${targetScopeLabel}.`);
      return;
    }

    const activeFlowRuns = getFlowActiveRuns(flow);

    if (operation === "move" && activeFlowRuns.length > 0) {
      setMessage(`Stop Ralph run \`${flow.name}\` before moving this flow.`);
      setEditorMode("run");
      return;
    }

    if (operation === "move" && isGenerationTargetingFlow(flow)) {
      setMessage("Wait for the current AI flow change to finish before moving this flow.");
      return;
    }

    const selectedSourceFlow =
      selectedIdRef.current === flow.id &&
      selectedScopeRef.current === sourceScope;

    if (
      selectedSourceFlow &&
      !(await saveDirtyDraftBeforeReplacement(
        operation === "move" ? "moving this flow" : "copying this flow",
      ))
    ) {
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const targetExists = await loadTargetFlowExists(flow, targetScope);

      if (
        (targetExists || operation === "move") &&
        !window.confirm(
          targetExists
            ? `${operation === "move" ? "Move" : "Copy"} Ralph flow "${flow.name}" to ${targetScopeLabel} and overwrite the existing ${targetScopeLabel} flow?`
            : `Move Ralph flow "${flow.name}" from ${sourceScopeLabel} to ${targetScopeLabel}?`,
        )
      ) {
        return;
      }

      const sourceResult = await showRalphFlow(workspaceRoot, flow.id, sourceScope);
      const savedResult = await saveRalphFlow(workspaceRoot, {
        flow: sourceResult.flow,
        scope: targetScope,
      });
      const targetSummary = flowToSummary(
        savedResult.flow,
        savedResult.path,
        targetScope,
      );
      const sourceFlowKey = getFlowSelectionKey(flow.id, sourceScope);
      let deletedPath: string | null = null;

      if (operation === "move") {
        const deleteResult = await deleteRalphFlow(workspaceRoot, flow.id, sourceScope);
        deletedPath = deleteResult.path;
      }

      setFlows((current) => {
        const withoutMovedSource =
          operation === "move"
            ? current.filter(
                (candidate) =>
                  getFlowSummarySelectionKey(candidate) !== sourceFlowKey &&
                  candidate.path !== deletedPath,
              )
            : current;

        if (
          !isFlowScopeVisibleInLibraryMode(targetScope, flowLibraryMode) &&
          !(operation === "move" && selectedSourceFlow)
        ) {
          return withoutMovedSource;
        }

        return upsertFlowSummary(withoutMovedSource, targetSummary);
      });

      if (operation === "move" && selectedSourceFlow) {
        replaceSelectedId(savedResult.flow.id, targetScope);
        replaceDraftFlow(savedResult.flow, targetScope);
        replaceSavedSnapshot(getFlowSnapshot(savedResult.flow));
        setUnsavedFlowId(null);
        setRevisions([]);
        setLastRun(null);
        onFlowLibraryModeChange?.(targetScope);
      }

      setMessage(
        `${operation === "move" ? "Moved" : "Copied"} Ralph flow \`${flow.name}\` to ${targetScopeLabel}.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const openFlowListMenu = (
    event: ReactMouseEvent,
    flow: RalphFlowSummary,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    setCanvasMenu(null);
    setFlowListMenu({
      flow,
      ...getCanvasMenuPlacement(event),
    });
  };

  const deleteFlow = async (flow: RalphFlowSummary): Promise<void> => {
    closeFlowListMenu();

    if (!workspaceRoot || !flow.path) {
      return;
    }

    const flowScope = getFlowSummaryScope(flow);
    const flowKey = getFlowSelectionKey(flow.id, flowScope);
    const activeFlowRuns = getFlowActiveRuns(flow);

    if (activeFlowRuns.length > 0) {
      setMessage(`Stop Ralph run \`${flow.name}\` before deleting this flow.`);
      setEditorMode("run");
      return;
    }

    if (isGenerationTargetingFlow(flow)) {
      setMessage("Wait for the current AI flow change to finish before deleting this flow.");
      return;
    }

    if (
      !window.confirm(
        `Delete Ralph flow "${flow.name}"? This removes the saved flow and its revisions.`,
      )
    ) {
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const result = await deleteRalphFlow(workspaceRoot, flow.id, flowScope);
      setFlows((current) =>
        current.filter(
          (candidate) =>
            getFlowSummarySelectionKey(candidate) !== flowKey &&
            !(
              candidate.id === result.id &&
              getFlowSummaryScope(candidate) === flowScope
            ) &&
            candidate.path !== result.path,
        ),
      );

      if (
        (selectedIdRef.current === flow.id ||
          selectedIdRef.current === result.id) &&
        selectedScopeRef.current === flowScope
      ) {
        replaceSelectedId("", flowScope);
        replaceDraftFlow(null, flowScope);
        replaceSavedSnapshot("");
        setUnsavedFlowId(null);
        setSelectedBlockId(null);
        setSelectedEdgeId(null);
        setVariableValues({});
        setRevisions([]);
        setLastRun(null);
      }

      setMessage(`Deleted Ralph flow \`${flow.name}\`.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const restoreRevision = async (revisionId: string): Promise<void> => {
    if (!workspaceRoot || !selectedId) {
      return;
    }

    if (dirty) {
      setMessage("Save or discard changes before restoring a revision.");
      return;
    }

    if (generationRunning && generationJob?.targetFlowId === selectedId) {
      setMessage("Wait for the current AI flow change to finish before restoring a revision.");
      return;
    }

    const requestId = restoreRequestRef.current + 1;
    restoreRequestRef.current = requestId;
    const selectedIdAtStart = selectedId;
    const selectedScopeAtStart = selectedScope;
    setLoading(true);
    setMessage(null);

    try {
      const result = await restoreRalphFlowRevision(workspaceRoot, {
        name: selectedId,
        revision: revisionId,
        scope: selectedScopeAtStart,
      });
      if (
        requestId !== restoreRequestRef.current ||
        selectedIdRef.current !== selectedIdAtStart ||
        selectedScopeRef.current !== selectedScopeAtStart
      ) {
        return;
      }

      replaceDraftFlow(result.flow, selectedScopeAtStart);
      replaceSavedSnapshot(getFlowSnapshot(result.flow));
      replaceSelectedId(result.flow.id, selectedScopeAtStart);
      setUnsavedFlowId(null);
      setSelectedBlockId(result.flow.blocks[0]?.id ?? null);
      setVariableValues(
        Object.fromEntries(
          (result.flow.variables ?? []).map((variable) => [
            variable.name,
            variable.default ?? "",
          ]),
        ),
      );
      setLastRun(null);
      setMessage(
        result.validation.errors.length > 0
          ? `Revision restored with ${result.validation.errors.length} error(s). Fix them before running.`
          : "Revision restored.",
      );
      setFlows((current) =>
        upsertFlowSummary(
          current,
          flowToSummary(result.flow, result.path, selectedScopeAtStart),
        ),
      );
      setRevisions([result.revision]);
    } catch (error) {
      if (requestId === restoreRequestRef.current) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === restoreRequestRef.current) {
        setLoading(false);
      }
    }
  };

  const stopRalphRun = async (taskId: string): Promise<void> => {
    const run = activeRuns.find((activeRun) => activeRun.id === taskId);

    setActiveRuns((current) =>
      current.map((activeRun) =>
        activeRun.id === taskId
          ? { ...activeRun, status: "stopping" }
          : activeRun,
      ),
    );
    setMessage(
      run
        ? `Stopping Ralph run \`${run.flowName}\`.`
        : "Stopping Ralph run.",
    );

    try {
      await cancelDesktopTask(taskId);
    } catch (error) {
      setActiveRuns((current) =>
        current.map((activeRun) =>
          activeRun.id === taskId
            ? { ...activeRun, status: "running" }
            : activeRun,
        ),
      );
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const stopGeneration = async (): Promise<void> => {
    if (!generationJob || generationJob.status !== "running") {
      return;
    }

    const taskId = generationJob.id;
    setGenerationJob((current) =>
      current?.id === taskId
        ? {
            ...current,
            status: "stopping",
            summary: `Stopping AI flow generation \`${current.targetAlias}\`.`,
          }
        : current,
    );
    setMessage(`Stopping AI flow generation \`${generationJob.targetAlias}\`.`);

    try {
      await cancelDesktopTask(taskId);
    } catch (error) {
      setGenerationJob((current) =>
        current?.id === taskId
          ? {
              ...current,
              status: "running",
              summary: error instanceof Error ? error.message : String(error),
            }
          : current,
      );
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const updatePendingInputValue = (
    fieldId: string,
    value: RalphInputValue,
  ): void => {
    setPendingInputValues((current) => ({
      ...current,
      [fieldId]: value,
    }));
  };

  const updateGenerationInterviewValue = (
    fieldId: string,
    value: RalphInputValue,
  ): void => {
    setGenerationInterview((current) =>
      current
        ? {
            ...current,
            values: {
              ...current.values,
              [fieldId]: value,
            },
            skippedFieldIds: current.skippedFieldIds.filter((id) => id !== fieldId),
            validationErrors: {
              ...current.validationErrors,
              [fieldId]: "",
            },
          }
        : current,
    );
  };

  const updateGenerationInterviewComment = (
    fieldId: string,
    comment: string,
  ): void => {
    setGenerationInterview((current) =>
      current
        ? {
            ...current,
            answerComments: {
              ...current.answerComments,
              [fieldId]: comment,
            },
          }
        : current,
    );
  };

  const toggleGenerationInterviewComment = (fieldId: string): void => {
    setGenerationInterview((current) =>
      current
        ? {
            ...current,
            expandedCommentFieldIds: current.expandedCommentFieldIds.includes(fieldId)
              ? current.expandedCommentFieldIds.filter((id) => id !== fieldId)
              : [...current.expandedCommentFieldIds, fieldId],
          }
        : current,
    );
  };

  const skipGenerationInterviewField = (fieldId: string): void => {
    setGenerationInterview((current) =>
      current
        ? {
            ...current,
            values: {
              ...current.values,
              [fieldId]: null,
            },
            skippedFieldIds: current.skippedFieldIds.includes(fieldId)
              ? current.skippedFieldIds
              : [...current.skippedFieldIds, fieldId],
            validationErrors: {
              ...current.validationErrors,
              [fieldId]: "",
            },
          }
        : current,
    );
  };

  const submitGenerationInterviewAnswers = async (): Promise<void> => {
    if (
      !generationInterview?.session ||
      generationInterview.status !== "ready"
    ) {
      return;
    }

    const validationErrors = validateRalphInputFieldValues(
      generationInterview.fields,
      generationInterview.values,
    );

    if (Object.keys(validationErrors).length > 0) {
      setGenerationInterview((current) =>
        current ? { ...current, validationErrors } : current,
      );
      return;
    }

    const answerComments = getTrimmedGenerationInterviewAnswerComments(
      generationInterview.answerComments,
    );

    await requestGenerationInterviewRound(
      generationInterview.context,
      generationInterview.session,
      generationInterview.values,
      answerComments,
    );
  };

  const generateFromInterviewNow = async (): Promise<void> => {
    if (!generationInterview) {
      return;
    }

    const validationErrors = validateRalphInputFieldValues(
      generationInterview.fields,
      generationInterview.values,
    );

    if (Object.keys(validationErrors).length > 0) {
      setGenerationInterview((current) =>
        current ? { ...current, validationErrors } : current,
      );
      return;
    }

    const taskId =
      generationInterview.taskId ??
      `generation-interview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const answerComments = getTrimmedGenerationInterviewAnswerComments(
      generationInterview.answerComments,
    );
    const finalPrompt =
      generationInterview.finalPrompt ??
      createLocalGenerationInterviewPrompt(
        generationInterview.context,
        generationInterview.session,
        generationInterview.fields,
        generationInterview.values,
        answerComments,
      );

    setGenerationInterview((current) =>
      current
        ? {
            ...current,
            status: "generating",
            summary: "Starting Ralph generation with interview context.",
            finalPrompt,
            taskId,
          }
        : current,
    );
    await executeFlowGenerationWithAgent(
      generationInterview.context,
      finalPrompt,
      "do-it",
    );
    setGenerationInterview((current) =>
      current?.taskId === taskId || current?.context === generationInterview.context
        ? null
        : current,
    );
  };

  const submitPendingInput = async (
    action: "submit" | "cancel",
  ): Promise<void> => {
    if (!workspaceRoot || !pendingInput || !lastRun?.runId) {
      return;
    }

    setInputSubmitting(true);
    setMessage(
      action === "cancel"
        ? `Cancelling input for ${pendingInput.title}.`
        : `Submitting input for ${pendingInput.title}.`,
    );

    try {
      const result = await resumeRalphRun(workspaceRoot, {
        runId: lastRun.runId,
        scope: selectedScope,
        taskId: createRalphRunTaskId(`${lastRun.runId}-resume`),
        mode: runMode,
        provider: runProvider,
        model: runModel,
        ...(runProfile ? { profile: runProfile } : {}),
        ...(runReasoning ? { reasoning: runReasoning } : {}),
        ...(defaultMaxTransitions
          ? { maxTransitions: defaultMaxTransitions }
          : {}),
        inputResponse: {
          requestId: pendingInput.id,
          action,
          ...(action === "submit" ? { values: pendingInputValues } : {}),
        },
      });

      setLastRun(result.run);
      setMessage(
        result.runLogPath
          ? `${formatRunMessage(result.run)} Run log: ${result.runLogPath}`
          : formatRunMessage(result.run),
      );
      if (result.run.runId) {
        void openRunDetail(result.run.runId, selectedScope, { selectTab: false });
      }
      if (selectedId) {
        void refreshRunHistory(selectedId, selectedScope);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setInputSubmitting(false);
    }
  };

  const renderRalphInputControl = (
    field: RalphInputField,
    value: RalphInputValue | undefined,
    onChange: (value: RalphInputValue) => void,
  ): JSX.Element => {
    const commonInputClassName =
      "border-slate-700 bg-slate-950 text-sm text-slate-100";

    if (field.type === "textarea") {
      return (
        <Textarea
          value={typeof value === "string" ? value : ""}
          aria-label={field.label}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value)}
          className={cn("min-h-24", commonInputClassName)}
        />
      );
    }

    if (field.type === "number") {
      return (
        <Input
          type="number"
          value={typeof value === "number" ? value : typeof value === "string" ? value : ""}
          aria-label={field.label}
          placeholder={field.placeholder}
          onChange={(event) =>
            onChange(event.target.value ? Number(event.target.value) : null)
          }
          className={cn("h-9", commonInputClassName)}
        />
      );
    }

    if (field.type === "boolean") {
      return (
        <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          Yes
        </label>
      );
    }

    if (field.type === "select") {
      return (
        <select
          value={typeof value === "string" ? value : ""}
          aria-label={field.label}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
        >
          <option value="">Select...</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    }

    if (field.type === "multiselect") {
      const values = Array.isArray(value) ? value : [];

      return (
        <div className="grid gap-1.5 rounded border border-slate-800 bg-slate-950 p-2">
          {(field.options ?? []).map((option) => {
            const checked = values.includes(option.value);

            return (
              <label
                key={option.value}
                className="flex items-center gap-2 text-sm text-slate-200"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    const nextValues = event.target.checked
                      ? [...values, option.value]
                      : values.filter((entry) => entry !== option.value);
                    onChange(nextValues);
                  }}
                />
                {option.label}
              </label>
            );
          })}
        </div>
      );
    }

    if (field.type === "files" || field.type === "images") {
      return (
        <Textarea
          value={Array.isArray(value) ? value.join("\n") : ""}
          aria-label={field.label}
          placeholder={field.placeholder ?? "One path per line"}
          onChange={(event) =>
            onChange(
              event.target.value
                .split("\n")
                .map((entry) => entry.trim())
                .filter(Boolean),
            )
          }
          className={cn("min-h-20 font-mono text-xs", commonInputClassName)}
        />
      );
    }

    return (
      <Input
        value={typeof value === "string" ? value : ""}
        aria-label={field.label}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "h-9",
          field.type === "path" ||
            field.type === "file" ||
            field.type === "image" ||
            field.type === "url"
            ? "font-mono text-xs"
            : "",
          commonInputClassName,
        )}
      />
    );
  };

  const renderPendingInputControl = (
    field: RalphInputField,
  ): JSX.Element => {
    return renderRalphInputControl(
      field,
      pendingInputValues[field.id] ?? null,
      (value) => updatePendingInputValue(field.id, value),
    );
  };

  const runFlow = async (): Promise<void> => {
    if (!workspaceRoot || !selectedId || !draftFlow) {
      return;
    }

    if (draftFlow.id !== selectedId) {
      setMessage("The selected flow is still loading. Try running it again after it finishes loading.");
      return;
    }

    if (dirty) {
      setMessage("Save the flow before running it.");
      return;
    }

    if (requiredMissingVariables.length > 0) {
      setMessage(`Missing required variable(s): ${requiredMissingVariables.join(", ")}.`);
      return;
    }

    const flowToRun = draftFlow;
    const runScope = selectedScope;
    const flowSnapshotAtStart = getFlowSnapshot(flowToRun);
    const taskId = createRalphRunTaskId(flowToRun.id);
    const flowName = flowToRun.name || flowToRun.id;
    const runVariableValues = Object.fromEntries(
      Object.entries(variableValues)
        .map(([name, value]) => [name.trim(), value] as const)
        .filter(([name]) => Boolean(name)),
    );
    setActiveRuns((current) => [
      {
        id: taskId,
        flowId: flowToRun.id,
        scope: runScope,
        flowName,
        startedAt: Date.now(),
        status: "running",
        mode: runMode,
        provider: runProvider,
        model: runModel,
        ...(runProfile ? { profile: runProfile } : {}),
        ...(runReasoning ? { reasoning: runReasoning } : {}),
        ...(defaultMaxTransitions
          ? { maxTransitions: defaultMaxTransitions }
          : {}),
        variableValues: runVariableValues,
        events: [],
      },
      ...current,
    ]);
    setLastRun(null);
    setEditorMode("run");
    setRunPanelTab("live");
    setMessage(`Ralph run \`${flowName}\` started in the background.`);

    void (async () => {
      try {
        const result = await runRalphFlow(workspaceRoot, {
          name: flowToRun.id,
          scope: runScope,
          taskId,
          mode: runMode,
          provider: runProvider,
          model: runModel,
          ...(runProfile ? { profile: runProfile } : {}),
          ...(runReasoning ? { reasoning: runReasoning } : {}),
          ...(defaultMaxTransitions
            ? { maxTransitions: defaultMaxTransitions }
            : {}),
          params: runVariableValues,
        });
        const currentDraft = draftFlowRef.current;
        const stillViewingSameSnapshot =
          selectedIdRef.current === flowToRun.id &&
          selectedScopeRef.current === runScope &&
          currentDraft?.id === flowToRun.id &&
          getFlowSnapshot(currentDraft) === flowSnapshotAtStart;

        if (stillViewingSameSnapshot) {
          setLastRun(result.run);
          setSelectedBlockId(
            [...result.run.events]
              .reverse()
              .find((event) => "blockId" in event)?.blockId ?? selectedBlockId,
          );
          setMessage(
            result.runLogPath
              ? `${formatRunMessage(result.run)} Run log: ${result.runLogPath}`
              : formatRunMessage(result.run),
          );
          if (result.run.runId) {
            void openRunDetail(result.run.runId, runScope, { selectTab: false });
          }
          void refreshRunHistory(flowToRun.id, runScope);
        } else if (
          selectedIdRef.current === flowToRun.id &&
          selectedScopeRef.current === runScope
        ) {
          setMessage(
            `Ralph run \`${flowName}\` finished for an older flow version.`,
          );
          if (result.run.runId) {
            void openRunDetail(result.run.runId, runScope, { selectTab: false });
          }
          void refreshRunHistory(flowToRun.id, runScope);
        }
      } catch (error) {
        const currentDraft = draftFlowRef.current;

        if (
          selectedIdRef.current === flowToRun.id &&
          selectedScopeRef.current === runScope &&
          currentDraft?.id === flowToRun.id &&
          getFlowSnapshot(currentDraft) === flowSnapshotAtStart
        ) {
          setMessage(error instanceof Error ? error.message : String(error));
        }
      } finally {
        setActiveRuns((current) =>
          current.filter((activeRun) => activeRun.id !== taskId),
        );
      }
    })();
  };

  const closeCanvasMenu = (): void => {
    setCanvasMenu(null);
  };

  const addBlock = (
    type: RalphBlockType,
    position?: RalphPosition,
  ): void => {
    if (!draftFlow) {
      void createLocalFlow();
      return;
    }

    if (type === "START" && draftFlow.blocks.some((block) => block.type === "START")) {
      setMessage("Only one START block is allowed.");
      return;
    }

    const createdBlock = createBlock(draftFlow, type);
    const nextBlock = position ? { ...createdBlock, position } : createdBlock;
    updateDraftFlow((flow) => ({
      ...flow,
      blocks: [...flow.blocks, nextBlock],
    }));
    setSelectedBlockId(nextBlock.id);
    setSelectedEdgeId(null);
    closeCanvasMenu();
  };

  const addBlockAfter = (
    sourceBlockId: string,
    type: RalphBlockType,
  ): void => {
    if (!draftFlow) {
      return;
    }

    if (type === "START" && draftFlow.blocks.some((block) => block.type === "START")) {
      setMessage("Only one START block is allowed.");
      return;
    }

    const sourceBlock = draftFlow.blocks.find((block) => block.id === sourceBlockId);
    if (!sourceBlock) {
      return;
    }

    const outputs = getBlockOutputs(sourceBlock);
    const output =
      outputs.find(
        (candidate) =>
          !draftFlow.edges.some(
            (edge) => edge.from === sourceBlock.id && edge.fromOutput === candidate,
          ),
      ) ?? outputs[0];

    if (!output) {
      setMessage(`${sourceBlock.title} has no outgoing route handles.`);
      return;
    }

    const nextPosition = {
      x: (sourceBlock.position?.x ?? 0) + RALPH_CANVAS_X_GAP,
      y: sourceBlock.position?.y ?? 0,
    };
    const nextBlock = {
      ...createBlock(draftFlow, type),
      position: nextPosition,
    };

    updateDraftFlow((flow) => {
      const nextEdges = flow.edges.filter(
        (edge) => !(edge.from === sourceBlock.id && edge.fromOutput === output),
      );

      return {
        ...flow,
        blocks: [...flow.blocks, nextBlock],
        edges: [
          ...nextEdges,
          {
            id: createEdgeId(
              { ...flow, edges: nextEdges },
              sourceBlock.id,
              output,
              nextBlock.id,
            ),
            from: sourceBlock.id,
            fromOutput: output,
            to: nextBlock.id,
          },
        ],
      };
    });
    setSelectedBlockId(nextBlock.id);
    setSelectedEdgeId(null);
    closeCanvasMenu();
  };

  const copyBlock = (blockId: string): void => {
    const block = draftFlow?.blocks.find((candidate) => candidate.id === blockId);

    if (!block) {
      return;
    }

    setCopiedBlock(JSON.parse(JSON.stringify(block)) as RalphFlowBlock);
    closeCanvasMenu();
  };

  const pasteCopiedBlock = (position?: RalphPosition): void => {
    if (!draftFlow || !copiedBlock) {
      return;
    }

    const nextBlock = createCopiedBlock(draftFlow, copiedBlock, position);
    if (!nextBlock) {
      setMessage("START block cannot be pasted into a flow that already has START.");
      return;
    }

    updateDraftFlow((flow) => ({
      ...flow,
      blocks: [...flow.blocks, nextBlock],
    }));
    setSelectedBlockId(nextBlock.id);
    setSelectedEdgeId(null);
    closeCanvasMenu();
  };

  const duplicateBlock = (blockId: string): void => {
    const block = draftFlow?.blocks.find((candidate) => candidate.id === blockId);

    if (!draftFlow || !block) {
      return;
    }

    const nextBlock = createCopiedBlock(draftFlow, block);
    if (!nextBlock) {
      setMessage("START block cannot be duplicated.");
      return;
    }

    updateDraftFlow((flow) => ({
      ...flow,
      blocks: [...flow.blocks, nextBlock],
    }));
    setSelectedBlockId(nextBlock.id);
    setSelectedEdgeId(null);
    closeCanvasMenu();
  };

  const cleanFlowLayout = (): void => {
    if (!draftFlow) {
      return;
    }

    updateDraftFlow(forceRalphFlowLayout);
    setMessage("Flow layout cleaned.");
    closeCanvasMenu();
  };

  const deleteBlocksById = (blockIds: readonly string[]): void => {
    if (!draftFlow || blockIds.length === 0) {
      return;
    }

    const uniqueBlockIds = [...new Set(blockIds)];
    const blocksById = new Map(draftFlow.blocks.map((block) => [block.id, block]));
    const includesStartBlock = uniqueBlockIds.some(
      (blockId) => blocksById.get(blockId)?.type === "START",
    );
    const removableBlockIds = uniqueBlockIds.filter((blockId) => {
      const block = blocksById.get(blockId);

      return block && block.type !== "START";
    });

    if (removableBlockIds.length === 0) {
      if (includesStartBlock) {
        setMessage("START block cannot be removed.");
      }
      return;
    }

    const removableBlockIdSet = new Set(removableBlockIds);
    updateDraftFlow((flow) => {
      const annotationLinks = flow.annotationLinks?.filter(
        (link) =>
          !removableBlockIdSet.has(link.from) && !removableBlockIdSet.has(link.to),
      );

      return {
        ...flow,
        blocks: flow.blocks.filter((block) => !removableBlockIdSet.has(block.id)),
        edges: flow.edges.filter(
          (edge) =>
            !removableBlockIdSet.has(edge.from) && !removableBlockIdSet.has(edge.to),
        ),
        ...(annotationLinks ? { annotationLinks } : {}),
      };
    });
    setSelectedBlockId(
      draftFlow.blocks.find((block) => !removableBlockIdSet.has(block.id))?.id ??
        null,
    );
    setSelectedEdgeId(null);
    closeCanvasMenu();

    if (includesStartBlock) {
      setMessage("START block cannot be removed; deleted other selected blocks.");
    }
  };

  const deleteSelectedBlock = (): void => {
    if (!selectedBlock) {
      return;
    }

    deleteBlocksById([selectedBlock.id]);
  };

  const deleteSelectedCanvasBlocks = (): void => {
    const selectedBlockIds =
      selectedCanvasBlockIds.length > 0
        ? selectedCanvasBlockIds
        : selectedBlock
          ? [selectedBlock.id]
          : [];

    if (selectedBlockIds.length === 0) {
      return;
    }

    if (selectedBlockIds.length === 1 && selectedBlock?.type === "START") {
      setMessage("START block cannot be removed.");
      return;
    }

    deleteBlocksById(selectedBlockIds);
  };

  const handleConnect = (connection: Connection): void => {
    if (!draftFlow || !connection.source || !connection.target) {
      return;
    }

    const sourceBlock = draftFlow.blocks.find(
      (block) => block.id === connection.source,
    );
    const targetBlock = draftFlow.blocks.find(
      (block) => block.id === connection.target,
    );

    if (
      !sourceBlock ||
      !targetBlock ||
      isVisualRalphCanvasBlock(sourceBlock) ||
      isVisualRalphCanvasBlock(targetBlock)
    ) {
      setMessage("Notes and groups cannot be connected with runtime routes.");
      return;
    }

    const output = connection.sourceHandle
      ? (connection.sourceHandle as RalphExecutionOutput)
      : sourceBlock
        ? getBlockOutputs(sourceBlock).find(
            (candidate) =>
              !draftFlow.edges.some(
                (edge) =>
                  edge.from === connection.source && edge.fromOutput === candidate,
              ),
          ) ?? getBlockOutputs(sourceBlock)[0]
        : undefined;

    if (!output) {
      return;
    }

    const nextEdges = draftFlow.edges.filter(
      (candidate) =>
        !(candidate.from === connection.source && candidate.fromOutput === output),
    );
    const edgeId = createEdgeId(
      { ...draftFlow, edges: nextEdges },
      connection.source,
      output,
      connection.target,
    );

    updateDraftFlow((flow) => ({
      ...flow,
      edges: [
        ...flow.edges.filter(
          (candidate) =>
            !(candidate.from === connection.source && candidate.fromOutput === output),
        ),
        {
          id: edgeId,
          from: connection.source,
          fromOutput: output,
          to: connection.target,
        },
      ],
    }));
    setSelectedEdgeId(edgeId);
    setSelectedBlockId(null);
    closeCanvasMenu();
  };

  const handleReconnect = (
    oldEdge: RalphCanvasEdge,
    connection: Connection,
  ): void => {
    if (!draftFlow || !connection.source || !connection.target) {
      return;
    }

    const sourceBlock = draftFlow.blocks.find(
      (block) => block.id === connection.source,
    );
    const targetBlock = draftFlow.blocks.find(
      (block) => block.id === connection.target,
    );

    if (
      !sourceBlock ||
      !targetBlock ||
      isVisualRalphCanvasBlock(sourceBlock) ||
      isVisualRalphCanvasBlock(targetBlock)
    ) {
      setMessage("Notes and groups cannot be connected with runtime routes.");
      return;
    }

    const output = connection.sourceHandle
      ? (connection.sourceHandle as RalphExecutionOutput)
      : oldEdge.sourceHandle
        ? (oldEdge.sourceHandle as RalphExecutionOutput)
        : sourceBlock
          ? getBlockOutputs(sourceBlock)[0]
          : undefined;

    if (!output) {
      return;
    }

    const nextEdges = draftFlow.edges.filter(
      (candidate) =>
        candidate.id !== oldEdge.id &&
        !(candidate.from === connection.source && candidate.fromOutput === output),
    );
    const edgeId = createEdgeId(
      { ...draftFlow, edges: nextEdges },
      connection.source,
      output,
      connection.target,
    );

    updateDraftFlow((flow) => ({
      ...flow,
      edges: [
        ...flow.edges.filter(
          (candidate) =>
            candidate.id !== oldEdge.id &&
            !(candidate.from === connection.source && candidate.fromOutput === output),
        ),
        {
          id: edgeId,
          from: connection.source,
          fromOutput: output,
          to: connection.target,
        },
      ],
    }));
    setSelectedEdgeId(edgeId);
    setSelectedBlockId(null);
    closeCanvasMenu();
  };

  const handleNodesChange = (changes: NodeChange<RalphCanvasNode>[]): void => {
    const selectedChange = changes.find(
      (change) => change.type === "select" && change.selected,
    );
    const dimensionChanges = new Map<string, { width: number; height: number }>();

    if (selectedChange) {
      setSelectedBlockId(selectedChange.id);
      setSelectedEdgeId(null);
      closeCanvasMenu();
    }

    for (const change of changes) {
      const dimensions = getNodeChangeDimensions(change);

      if (dimensions) {
        dimensionChanges.set(change.id, dimensions);
      }
    }

    setCanvasNodes((currentNodes) => applyNodeChanges(changes, currentNodes));

    if (dimensionChanges.size > 0) {
      updateDraftFlow((flow) => {
        let changed = false;
        const blocks = flow.blocks.map((block) => {
          const size = dimensionChanges.get(block.id);

          if (!size) {
            return block;
          }

          if (block.type === "GROUP" && block.locked) {
            return block;
          }

          if (block.size?.width === size.width && block.size.height === size.height) {
            return block;
          }

          changed = true;
          return { ...block, size };
        });

        return changed ? { ...flow, blocks } : flow;
      });
    }
  };

  const handleNodeDragStop: OnNodeDrag<RalphCanvasNode> = (
    event,
    node,
    draggedNodes,
  ): void => {
    const movedNodes = draggedNodes.length > 0 ? draggedNodes : [node];
    const movedPositionsById = getCanvasNodePositions(movedNodes);
    const suppressChildMove = isGroupChildMoveSuppressed(event);

    updateDraftFlow((flow) => {
      const childrenByGroupId = createDerivedGroupChildrenById(flow);
      const childMoveDeltas = new Map<string, RalphPosition>();
      const suppressedChildBlockIds = new Set<string>();

      if (suppressChildMove) {
        const primaryDraggedGroupId =
          flow.blocks.find(
            (block) => block.id === node.id && block.type === "GROUP",
          )?.id ?? null;
        const suppressGroupChildren = (groupId: string): void => {
          for (const childId of childrenByGroupId.get(groupId) ?? []) {
            if (suppressedChildBlockIds.has(childId)) {
              continue;
            }

            suppressedChildBlockIds.add(childId);
            suppressGroupChildren(childId);
          }
        };

        if (primaryDraggedGroupId) {
          suppressGroupChildren(primaryDraggedGroupId);
        }
      }

      for (const block of flow.blocks) {
        const nextPosition = movedPositionsById.get(block.id);

        if (block.type !== "GROUP" || !nextPosition || block.locked) {
          continue;
        }

        const currentPosition = block.position ?? nextPosition;
        const delta = {
          x: nextPosition.x - currentPosition.x,
          y: nextPosition.y - currentPosition.y,
        };

        if (
          suppressChildMove ||
          !block.moveChildren ||
          (delta.x === 0 && delta.y === 0)
        ) {
          continue;
        }

        for (const childId of childrenByGroupId.get(block.id) ?? []) {
          if (movedPositionsById.has(childId)) {
            continue;
          }

          const currentDelta = childMoveDeltas.get(childId) ?? { x: 0, y: 0 };
          childMoveDeltas.set(childId, {
            x: currentDelta.x + delta.x,
            y: currentDelta.y + delta.y,
          });
        }
      }

      let changed = false;
      const blocks = flow.blocks.map((block, index) => {
        const nextPosition = movedPositionsById.get(block.id);

        if (nextPosition) {
          if (suppressedChildBlockIds.has(block.id)) {
            return block;
          }

          if (block.type === "GROUP" && block.locked) {
            return block;
          }

          if (arePositionsEqual(block.position, nextPosition)) {
            return block;
          }

          changed = true;
          return { ...block, position: nextPosition };
        }

        const childDelta = childMoveDeltas.get(block.id);

        if (!childDelta || (!block.position && childDelta.x === 0 && childDelta.y === 0)) {
          return block;
        }

        const position = block.position ?? getDefaultCanvasPosition(index);

        changed = true;
        return {
          ...block,
          position: {
            x: Math.round(position.x + childDelta.x),
            y: Math.round(position.y + childDelta.y),
          },
        };
      });

      return changed ? { ...flow, blocks } : flow;
    });
  };

  const getFlowPositionFromPointer = (
    event: ReactMouseEvent,
  ): RalphPosition => {
    const point: XYPosition = { x: event.clientX, y: event.clientY };
    const position =
      reactFlowInstanceRef.current?.screenToFlowPosition(point) ?? point;

    return {
      x: Math.round(position.x),
      y: Math.round(position.y),
    };
  };

  const focusValidationIssueBlock = (blockId: string): void => {
    const flow = draftFlowRef.current;
    const blockIndex = flow?.blocks.findIndex((block) => block.id === blockId) ?? -1;

    if (!flow || blockIndex < 0) {
      return;
    }

    const block = flow.blocks[blockIndex];
    const instance = reactFlowInstanceRef.current;

    setSelectedBlockId(blockId);
    setSelectedEdgeId(null);
    closeCanvasMenu();

    if (!instance) {
      return;
    }

    const node = instance.getNode(blockId);
    const position =
      node?.position ?? block.position ?? getDefaultCanvasPosition(blockIndex);
    const width =
      node?.measured?.width ?? node?.width ?? getBlockFallbackWidth(block);
    const height =
      node?.measured?.height ?? node?.height ?? RALPH_BLOCK_FALLBACK_HEIGHT;

    void instance.setCenter(position.x + width / 2, position.y + height / 2, {
      duration: RALPH_VALIDATION_JUMP_DURATION_MS,
      zoom: instance.getZoom(),
    });
  };

  const openPaneMenu = (event: ReactMouseEvent): void => {
    event.preventDefault();
    setFlowListMenu(null);
    setSelectedBlockId(null);
    setSelectedEdgeId(null);
    setCanvasMenu({
      type: "pane",
      ...getCanvasMenuPlacement(event),
      position: getFlowPositionFromPointer(event),
    });
  };

  const openNodeMenu = (
    event: ReactMouseEvent,
    node: RalphCanvasNode,
  ): void => {
    event.preventDefault();
    setFlowListMenu(null);
    setSelectedBlockId(node.id);
    setSelectedEdgeId(null);
    setCanvasMenu({
      type: "node",
      ...getCanvasMenuPlacement(event),
      blockId: node.id,
    });
  };

  const openEdgeMenu = (
    event: ReactMouseEvent,
    edge: RalphCanvasEdge,
  ): void => {
    event.preventDefault();
    setFlowListMenu(null);
    setSelectedEdgeId(edge.id);
    setSelectedBlockId(null);
    setCanvasMenu({
      type: "edge",
      ...getCanvasMenuPlacement(event),
      edgeId: edge.id,
    });
  };

  const removeEdges = (edgeIds: string[]): void => {
    if (edgeIds.length === 0) {
      return;
    }

    const edgeIdSet = new Set(edgeIds);
    updateDraftFlow((flow) => ({
      ...flow,
      edges: flow.edges.filter((edge) => !edgeIdSet.has(edge.id)),
    }));
    setSelectedEdgeId((current) => (current && edgeIdSet.has(current) ? null : current));
    closeCanvasMenu();
  };

  const removeEdge = (edgeId: string): void => {
    removeEdges([edgeId]);
  };

  const setRouteTarget = (
    sourceBlockId: string,
    output: RalphExecutionOutput,
    targetBlockId: string,
  ): void => {
    updateDraftFlow((flow) => {
      const nextEdges = flow.edges.filter(
        (edge) => !(edge.from === sourceBlockId && edge.fromOutput === output),
      );

      if (!targetBlockId) {
        return {
          ...flow,
          edges: nextEdges,
        };
      }

      return {
        ...flow,
        edges: [
          ...nextEdges,
          {
            id: createEdgeId({ ...flow, edges: nextEdges }, sourceBlockId, output, targetBlockId),
            from: sourceBlockId,
            fromOutput: output,
            to: targetBlockId,
          },
        ],
      };
    });
    setSelectedEdgeId(null);
    closeCanvasMenu();
  };

  useEffect(() => {
    if (!flowListMenu) {
      return;
    }

    const closeMenu = (): void => {
      setFlowListMenu(null);
    };

    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("contextmenu", closeMenu);

    return () => {
      window.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("contextmenu", closeMenu);
    };
  }, [flowListMenu]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const handleEditorShortcut = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      const hasModifier = event.ctrlKey || event.metaKey;

      if (key === "escape" && (canvasMenu || flowListMenu)) {
        event.preventDefault();
        closeCanvasMenu();
        closeFlowListMenu();
        return;
      }

      if (hasModifier && key === "s") {
        event.preventDefault();
        if (canSaveFlow) {
          void saveFlow();
        }
        return;
      }

      if (isEditableShortcutTarget(event.target)) {
        return;
      }

      if (hasModifier && key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redoFlowEdit();
        } else {
          undoFlowEdit();
        }
        return;
      }

      if (hasModifier && key === "y") {
        event.preventDefault();
        redoFlowEdit();
        return;
      }

      if (hasModifier && key === "d") {
        event.preventDefault();
        if (selectedBlockId) {
          duplicateBlock(selectedBlockId);
        }
        return;
      }

      if (hasModifier && key === "l") {
        event.preventDefault();
        cleanFlowLayout();
        return;
      }

      if (hasModifier && key === "enter") {
        event.preventDefault();
        if (canRunFlow) {
          void runFlow();
        }
        return;
      }

      if (key === "delete" || key === "backspace") {
        if (selectedEdgeId) {
          event.preventDefault();
          removeEdge(selectedEdgeId);
          return;
        }

        if (selectedBlock || selectedCanvasBlockIds.length > 0) {
          event.preventDefault();
          deleteSelectedCanvasBlocks();
        }
      }
    };

    window.addEventListener("keydown", handleEditorShortcut);

    return () => {
      window.removeEventListener("keydown", handleEditorShortcut);
    };
  }, [
    canRunFlow,
    canSaveFlow,
    canvasMenu,
    flowListMenu,
    isActive,
    selectedBlock,
    selectedCanvasBlockIds,
    selectedBlockId,
    selectedEdgeId,
    undoStack,
    redoStack,
  ]);

  const renderCanvasMenuButton = (
    label: string,
    onClick: () => void,
    options: {
      disabled?: boolean;
      danger?: boolean;
      icon?: LucideIcon;
      iconClassName?: string;
      key?: string;
    } = {},
  ): JSX.Element => {
    const Icon = options.icon;

    return (
      <button
        key={options.key}
        type="button"
        role="menuitem"
        disabled={options.disabled}
        onClick={onClick}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs font-medium outline-none",
          options.disabled
            ? "cursor-not-allowed text-slate-600"
            : options.danger
              ? "text-rose-100 hover:bg-rose-500/10"
              : "text-slate-200 hover:bg-slate-800",
        )}
      >
        {Icon ? (
          <Icon className={cn("h-3.5 w-3.5 shrink-0", options.iconClassName)} />
        ) : null}
        <span className="min-w-0 truncate">{label}</span>
      </button>
    );
  };

  const renderAddBlockCanvasMenuButton = (
    label: string,
    type: RalphBlockType,
    onClick: () => void,
    options: { key?: string } = {},
  ): JSX.Element => {
    const tone = getBlockTone(type);

    return renderCanvasMenuButton(label, onClick, {
      ...options,
      icon: tone.icon,
      iconClassName: tone.badgeClassName,
    });
  };

  const renderFlowListContextMenu = (): JSX.Element | null => {
    if (!flowListMenu) {
      return null;
    }

    const flow = flowListMenu.flow;
    const flowScope = getFlowSummaryScope(flow);
    const activeFlowRuns = getFlowActiveRuns(flow);
    const baseDisabled = !workspaceRoot || !flow.path || loading;
    const mutationDisabled =
      baseDisabled || activeFlowRuns.length > 0 || isGenerationTargetingFlow(flow);
    const globalScope: RalphFlowScope = "user";
    const workspaceScope: RalphFlowScope = "workspace";

    return (
      <div
        role="menu"
        className="fixed z-[130] w-56 rounded-lg border border-slate-700 bg-slate-950 p-1.5 shadow-2xl shadow-black/45"
        style={{ left: flowListMenu.left, top: flowListMenu.top }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div className="min-w-0 px-2 pb-1 pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
          <span className="block truncate">{flow.name}</span>
        </div>
        {renderCanvasMenuButton(
          "Copy to global",
          () => void copyOrMoveFlowToScope(flow, globalScope, "copy"),
          {
            disabled: baseDisabled || flowScope === globalScope,
            icon: Copy,
            iconClassName: "text-sky-300",
          },
        )}
        {renderCanvasMenuButton(
          "Copy to workspace",
          () => void copyOrMoveFlowToScope(flow, workspaceScope, "copy"),
          {
            disabled: baseDisabled || flowScope === workspaceScope,
            icon: Copy,
            iconClassName: "text-emerald-300",
          },
        )}
        <div className="my-1 h-px bg-slate-800" />
        {renderCanvasMenuButton(
          "Move to global",
          () => void copyOrMoveFlowToScope(flow, globalScope, "move"),
          {
            disabled: mutationDisabled || flowScope === globalScope,
            icon: Route,
            iconClassName: "text-sky-300",
          },
        )}
        {renderCanvasMenuButton(
          "Move to workspace",
          () => void copyOrMoveFlowToScope(flow, workspaceScope, "move"),
          {
            disabled: mutationDisabled || flowScope === workspaceScope,
            icon: Route,
            iconClassName: "text-emerald-300",
          },
        )}
        <div className="my-1 h-px bg-slate-800" />
        {renderCanvasMenuButton("Delete", () => void deleteFlow(flow), {
          disabled: mutationDisabled,
          danger: true,
          icon: Trash2,
        })}
      </div>
    );
  };

  const renderCanvasContextMenu = (): JSX.Element | null => {
    if (!canvasMenu) {
      return null;
    }

    const menuBlock =
      canvasMenu.type === "node"
        ? draftFlow?.blocks.find((block) => block.id === canvasMenu.blockId) ?? null
        : null;
    const menuEdge =
      canvasMenu.type === "edge"
        ? draftFlow?.edges.find((edge) => edge.id === canvasMenu.edgeId) ?? null
        : null;

    return (
      <div
        role="menu"
        className="fixed z-[120] max-h-[min(32rem,calc(100vh-1rem))] w-56 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 p-1.5 shadow-2xl shadow-black/45"
        style={{ left: canvasMenu.left, top: canvasMenu.top }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {canvasMenu.type === "pane" ? (
          <>
            <div className="px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Add Block
            </div>
            {renderAddBlockCanvasMenuButton("Prompt", "PROMPT", () =>
              addBlock("PROMPT", canvasMenu.position),
            )}
            {renderAddBlockCanvasMenuButton("Validator", "VALIDATOR", () =>
              addBlock("VALIDATOR", canvasMenu.position),
            )}
            {renderAddBlockCanvasMenuButton("Decision", "DECISION", () =>
              addBlock("DECISION", canvasMenu.position),
            )}
            {renderAddBlockCanvasMenuButton("Pack", "PACK", () =>
              addBlock("PACK", canvasMenu.position),
            )}
            {renderAddBlockCanvasMenuButton("Utility", "UTILITY", () =>
              addBlock("UTILITY", canvasMenu.position),
            )}
            {renderAddBlockCanvasMenuButton("Note", "NOTE", () =>
              addBlock("NOTE", canvasMenu.position),
            )}
            {renderAddBlockCanvasMenuButton("Group", "GROUP", () =>
              addBlock("GROUP", canvasMenu.position),
            )}
            {MCP_BLOCK_ACTIONS.map((action) =>
              renderAddBlockCanvasMenuButton(`MCP ${action.label}`, action.type, () =>
                addBlock(action.type, canvasMenu.position),
                { key: action.type },
              ),
            )}
            {renderAddBlockCanvasMenuButton("End", "END", () =>
              addBlock("END", canvasMenu.position),
            )}
            <div className="my-1 border-t border-slate-800" />
            {renderCanvasMenuButton("Paste block", () =>
              pasteCopiedBlock(canvasMenu.position),
              { disabled: !copiedBlock, icon: ClipboardPaste },
            )}
            {renderCanvasMenuButton("Clean layout", cleanFlowLayout, {
              disabled: !draftFlow,
              icon: LayoutGrid,
            })}
          </>
        ) : null}

        {canvasMenu.type === "node" && menuBlock ? (
          <>
            <div className="px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
              {menuBlock.title}
            </div>
            {renderAddBlockCanvasMenuButton("Add prompt after", "PROMPT", () =>
              addBlockAfter(menuBlock.id, "PROMPT"),
            )}
            {renderAddBlockCanvasMenuButton("Add validator after", "VALIDATOR", () =>
              addBlockAfter(menuBlock.id, "VALIDATOR"),
            )}
            {renderAddBlockCanvasMenuButton("Add decision after", "DECISION", () =>
              addBlockAfter(menuBlock.id, "DECISION"),
            )}
            {renderAddBlockCanvasMenuButton("Add pack after", "PACK", () =>
              addBlockAfter(menuBlock.id, "PACK"),
            )}
            {renderAddBlockCanvasMenuButton("Add utility after", "UTILITY", () =>
              addBlockAfter(menuBlock.id, "UTILITY"),
            )}
            {renderAddBlockCanvasMenuButton("Add note nearby", "NOTE", () =>
              addBlock("NOTE", {
                x: (menuBlock.position?.x ?? 0) + RALPH_CANVAS_X_GAP,
                y: (menuBlock.position?.y ?? 0) + RALPH_CANVAS_Y_GAP,
              }),
            )}
            {renderAddBlockCanvasMenuButton("Add group nearby", "GROUP", () =>
              addBlock("GROUP", {
                x: menuBlock.position?.x ?? 0,
                y: (menuBlock.position?.y ?? 0) + RALPH_CANVAS_Y_GAP,
              }),
            )}
            {MCP_BLOCK_ACTIONS.map((action) =>
              renderAddBlockCanvasMenuButton(
                `Add MCP ${action.label.toLowerCase()} after`,
                action.type,
                () => addBlockAfter(menuBlock.id, action.type),
                { key: action.type },
              ),
            )}
            {renderAddBlockCanvasMenuButton("Add end after", "END", () =>
              addBlockAfter(menuBlock.id, "END"),
            )}
            <div className="my-1 border-t border-slate-800" />
            {renderCanvasMenuButton("Copy block", () => copyBlock(menuBlock.id), {
              icon: Copy,
            })}
            {renderCanvasMenuButton("Duplicate block", () =>
              duplicateBlock(menuBlock.id),
              {
                disabled: menuBlock.type === "START",
                icon: ClipboardPaste,
              },
            )}
            {renderCanvasMenuButton("Delete block", deleteSelectedBlock, {
              disabled: menuBlock.type === "START",
              danger: true,
              icon: Trash2,
            })}
          </>
        ) : null}

        {canvasMenu.type === "edge" && menuEdge ? (
          <>
            <div className="px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Route {menuEdge.fromOutput}
            </div>
            {renderCanvasMenuButton("Remove route", () => removeEdge(menuEdge.id), {
              danger: true,
              icon: Trash2,
            })}
            {renderCanvasMenuButton("Clean layout", cleanFlowLayout, {
              disabled: !draftFlow,
              icon: LayoutGrid,
            })}
          </>
        ) : null}
      </div>
    );
  };

  const renderInspectorSectionTabs = (): JSX.Element | null => {
    if (!selectedBlock || availableInspectorSections.length <= 1) {
      return null;
    }

    return (
      <div className="border-b border-slate-800/70 bg-slate-950/95 px-3 py-2">
        <div className="flex min-w-0 gap-1 overflow-x-auto rounded-lg bg-slate-900/45 p-1 [scrollbar-width:thin]">
          {availableInspectorSections.map((section) => {
            const isActive = activeInspectorSection === section.id;
            const routeBadge =
              section.id === "routes" && missingSelectedRouteCount > 0
                ? missingSelectedRouteCount
                : null;
            const sectionLabel =
              section.id === "routes" ? "Route map" : section.label;

            return (
              <button
                key={section.id}
                type="button"
                onClick={() => scrollInspectorSectionIntoView(section.id)}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs font-semibold transition",
                  isActive
                    ? "bg-slate-800 text-white shadow-sm ring-1 ring-cyan-400/25"
                    : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-100",
                )}
              >
                {sectionLabel}
                {routeBadge ? (
                  <span className="rounded-full bg-amber-500/20 px-1.5 text-[0.65rem] text-amber-100">
                    {routeBadge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const renderSelectedRouteSummary = (): JSX.Element | null => {
    if (!selectedBlock || selectedBlockOutputs.length === 0) {
      return null;
    }

    return (
      <button
        type="button"
        data-ralph-inspector-section="routes-summary"
        onClick={() => scrollInspectorSectionIntoView("routes")}
        className={cn(
          "grid gap-2 rounded-lg px-3 py-2 text-left text-xs ring-1 transition",
          missingSelectedRouteCount > 0
            ? "bg-amber-500/10 ring-amber-400/30 hover:bg-amber-500/15"
            : "bg-slate-950/70 ring-slate-800/70 hover:bg-slate-900/70",
        )}
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2 font-semibold text-slate-200">
            <Route className="h-3.5 w-3.5 shrink-0 text-sky-300" />
            <span className="truncate">Route summary</span>
          </span>
          <span
            className={cn(
              "shrink-0 font-medium",
              missingSelectedRouteCount > 0 ? "text-amber-100" : "text-slate-500",
            )}
          >
            {connectedSelectedRouteCount}/{selectedBlockOutputs.length} connected
          </span>
        </div>
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {selectedBlockOutputs.map((output) => {
            const edge = selectedRoutesByOutput.get(output);
            const targetBlock = edge
              ? draftFlow?.blocks.find((block) => block.id === edge.to) ?? null
              : null;

            return (
              <span
                key={output}
                className={cn(
                  "max-w-full truncate rounded border px-2 py-1 font-mono text-[0.68rem]",
                  edge
                    ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
                    : "border-amber-400/25 bg-amber-500/10 text-amber-100",
                )}
              >
                {output}
                {" -> "}
                {targetBlock ? targetBlock.title : edge ? "missing" : "unconnected"}
              </span>
            );
          })}
        </div>
      </button>
    );
  };

  const renderExpandFieldButton = (
    label: string,
    onClick: () => void,
  ): JSX.Element => {
    return (
      <Button
        type="button"
        variant="ghost"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        }}
        className="h-6 rounded-md px-1.5 text-[0.68rem] text-slate-400 hover:bg-slate-800 hover:text-white"
      >
        <Maximize2 className="h-3 w-3" />
        {label}
      </Button>
    );
  };

  const renderUtilityConditionFields = (
    condition: RalphUtilityCondition | undefined,
  ): JSX.Element => {
    const currentCondition: RalphUtilityCondition =
      condition ?? {
        style: "simple",
        expression: "status == 200",
      };
    const updateCondition = (patch: Partial<RalphUtilityCondition>): void => {
      updateSelectedUtility({
        condition: {
          ...currentCondition,
          ...patch,
        },
      });
    };

    return (
      <div className="grid gap-2 rounded-md border border-slate-800 bg-slate-950 p-2">
        <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
          <label className="grid gap-1.5 text-xs text-slate-300">
            <span className="font-medium">Condition</span>
            <select
              value={currentCondition.style}
              aria-label="Utility condition style"
              onChange={(event) =>
                updateCondition({
                  style: event.target.value as RalphUtilityConditionStyle,
                })
              }
              className="h-8 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
            >
              <option value="simple">Simple</option>
              <option value="json-path">JSON Path</option>
              <option value="javascript">JavaScript</option>
            </select>
          </label>
          {currentCondition.style === "json-path" ? (
            <label className="grid gap-1.5 text-xs text-slate-300">
              <span className="font-medium">Operator</span>
              <select
                value={currentCondition.operator ?? "truthy"}
                aria-label="Utility condition operator"
                onChange={(event) =>
                  updateCondition({
                    operator: event.target
                      .value as RalphUtilityCondition["operator"],
                  })
                }
                className="h-8 rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
              >
                {[
                  "exists",
                  "not-exists",
                  "truthy",
                  "falsy",
                  "equals",
                  "not-equals",
                  "contains",
                  "matches",
                  "gt",
                  "gte",
                  "lt",
                  "lte",
                ].map((operator) => (
                  <option key={operator} value={operator}>
                    {operator}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        {currentCondition.style === "json-path" ? (
          <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
            <RalphInspectorField
              label="JSON path"
              help="Result field to inspect."
              className="text-xs text-slate-300"
            >
              <Input
                value={currentCondition.path ?? ""}
                aria-label="Utility condition path"
                placeholder="body.state"
                onChange={(event) =>
                  updateCondition({ path: event.target.value })
                }
                className="h-8 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField
              label="Expected value"
              help="Used by equals, contains, matches, or range checks."
              className="text-xs text-slate-300"
            >
              <Input
                value={currentCondition.value ?? ""}
                aria-label="Utility condition value"
                placeholder="done"
                onChange={(event) =>
                  updateCondition({ value: event.target.value })
                }
                className="h-8 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
          </div>
        ) : (
          <RalphInspectorField
            label={
              currentCondition.style === "javascript"
                ? "JavaScript expression"
                : "Condition expression"
            }
            help={
              currentCondition.style === "javascript"
                ? "Evaluated against the utility result object."
                : "Simple status/body check expression."
            }
            className="text-xs text-slate-300"
          >
            <Textarea
              value={currentCondition.expression ?? ""}
              aria-label="Utility condition expression"
              placeholder={
                currentCondition.style === "javascript"
                  ? "result.status === 200 && result.body.state === 'done'"
                  : "status == 200"
              }
              onChange={(event) =>
                updateCondition({ expression: event.target.value })
              }
              className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100 placeholder:text-slate-600"
            />
          </RalphInspectorField>
        )}
      </div>
    );
  };

  const renderUtilitySettings = (): JSX.Element | null => {
    if (!selectedUtility) {
      return null;
    }

    const selectedUtilityVisual = getUtilityTone(selectedUtility.type);
    const SelectedUtilityIcon = selectedUtilityVisual.icon;

    return (
      <div
        data-ralph-inspector-section="execution"
        className="grid gap-3 rounded-lg bg-slate-900/25 p-3 ring-1 ring-slate-800/60"
      >
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <SelectedUtilityIcon
              className={cn("h-4 w-4 shrink-0", selectedUtilityVisual.badgeClassName)}
            />
            <span className="truncate">
              {formatUtilityTypeLabel(selectedUtility.type)} Utility
            </span>
          </div>
          <label className="grid gap-1 text-xs font-medium text-slate-300">
            <span>Type</span>
            <select
              value={selectedUtility.type}
              aria-label="Utility type"
              onChange={(event) => {
                const type = event.target.value as RalphUtilityType;
                replaceSelectedUtility(createDefaultUtilityConfig(type));
              }}
              className="h-8 max-w-44 rounded-md border border-cyan-500/30 bg-slate-950 px-2 text-xs font-semibold text-cyan-100"
            >
              {UTILITY_TYPE_OPTIONS.map((type) => (
                <option key={type} value={type}>
                  {formatUtilityTypeLabel(type)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {selectedUtility.type === "WAIT" ? (
          <div className="grid gap-2">
            <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
              <label className="grid gap-1.5 text-sm text-slate-200">
                <span className="font-medium">Mode</span>
                <select
                  value={selectedUtility.mode ?? "delay"}
                  aria-label="Wait mode"
                  onChange={(event) =>
                    updateSelectedUtility({
                      mode: event.target.value as RalphUtilityConfig["mode"],
                    })
                  }
                  className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                >
                  <option value="delay">Delay</option>
                  <option value="until-time">Until Time</option>
                  <option value="condition">Condition</option>
                  <option value="poll">Polling</option>
                </select>
              </label>
              {(selectedUtility.mode ?? "delay") === "delay" ? (
                <label className="grid gap-1.5 text-sm text-slate-200">
                  <span className="font-medium">Seconds</span>
                  <Input
                    type="number"
                    min={0}
                    value={selectedUtility.delaySeconds ?? 0}
                    aria-label="Wait delay seconds"
                    onChange={(event) =>
                      updateSelectedUtility({
                        delaySeconds:
                          Number.parseFloat(event.target.value) || 0,
                      })
                    }
                    className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                  />
                </label>
              ) : null}
            </div>

            {selectedUtility.mode === "until-time" ? (
              <label className="grid gap-1.5 text-sm text-slate-200">
                <span className="font-medium">Run At</span>
                <Input
                  value={selectedUtility.runAt ?? ""}
                  aria-label="Wait until time"
                  placeholder="2026-06-13T12:00:00.000Z"
                  onChange={(event) =>
                    updateSelectedUtility({ runAt: event.target.value })
                  }
                  className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                />
              </label>
            ) : null}

            {selectedUtility.mode === "condition" ||
            selectedUtility.mode === "poll" ? (
              <>
                {renderUtilityConditionFields(selectedUtility.condition)}
                <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
                  <RalphInspectorField label="Poll interval" help="Seconds between checks.">
                    <Input
                      type="number"
                      min={0}
                      value={selectedUtility.intervalSeconds ?? 30}
                      aria-label="Wait poll interval seconds"
                      onChange={(event) =>
                        updateSelectedUtility({
                          intervalSeconds:
                            Number.parseFloat(event.target.value) || 0,
                        })
                      }
                      className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                    />
                  </RalphInspectorField>
                  <RalphInspectorField label="Backoff" help="Optional interval multiplier.">
                    <Input
                      type="number"
                      min={1}
                      step={0.1}
                      value={selectedUtility.backoffMultiplier ?? ""}
                      aria-label="Wait backoff multiplier"
                      placeholder="Backoff"
                      onChange={(event) =>
                        updateSelectedUtility({
                          backoffMultiplier: event.target.value
                            ? Number.parseFloat(event.target.value)
                            : undefined,
                        })
                      }
                      className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                    />
                  </RalphInspectorField>
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {selectedUtility.type === "HTTP_FETCH" ||
        selectedUtility.type === "POLL" ? (
          <div className="grid gap-2">
            <div className={cn("grid gap-2", inspectorHttpGridClass)}>
              <RalphInspectorField label="Method">
                <Input
                  value={selectedUtility.method ?? "GET"}
                  aria-label="HTTP method"
                  placeholder="GET"
                  onChange={(event) =>
                    updateSelectedUtility({
                      method: event.target.value.toUpperCase(),
                    })
                  }
                  className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                />
              </RalphInspectorField>
              <RalphInspectorField label="URL" help="Endpoint to call. Supports {{variables}}.">
                <Input
                  value={selectedUtility.url ?? ""}
                  aria-label="HTTP URL"
                  placeholder="{{url:url}}"
                  onChange={(event) =>
                    updateSelectedUtility({ url: event.target.value })
                  }
                  className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                />
              </RalphInspectorField>
            </div>
            <RalphInspectorField label="Request body" help="Optional body for POST, PUT, or PATCH requests.">
              <Textarea
                value={selectedUtility.body ?? ""}
                aria-label="HTTP body"
                placeholder="Optional request body"
                onChange={(event) =>
                  updateSelectedUtility({ body: event.target.value })
                }
                className="min-h-16 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100 placeholder:text-slate-600"
              />
            </RalphInspectorField>
            <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
              <RalphInspectorField label="Output path" help="Optional file path for the response body.">
                <Input
                  value={selectedUtility.outputPath ?? ""}
                  aria-label="HTTP output path"
                  placeholder="Save body to path"
                  onChange={(event) =>
                    updateSelectedUtility({ outputPath: event.target.value })
                  }
                  className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                />
              </RalphInspectorField>
              <RalphInspectorField label="Timeout" help="Seconds before the request fails.">
                <Input
                  type="number"
                  min={1}
                  value={selectedUtility.timeoutSeconds ?? 30}
                  aria-label="HTTP timeout seconds"
                  onChange={(event) =>
                    updateSelectedUtility({
                      timeoutSeconds: Number.parseFloat(event.target.value) || 0,
                    })
                  }
                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                />
              </RalphInspectorField>
            </div>
            <RalphInspectorField label="Headers (JSON)" help="Key-value headers sent with the request.">
              <Textarea
                key={`${selectedBlockId}-headers-${selectedUtility.type}`}
                defaultValue={formatJsonDraft(selectedUtility.headers ?? {})}
                aria-label="HTTP headers JSON"
                onBlur={(event) => {
                  const headers = parseStringRecordDraft(event.target.value);
                  if (headers) {
                    updateSelectedUtility({ headers });
                  }
                }}
                className="min-h-16 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
              />
            </RalphInspectorField>
            {selectedUtility.type === "POLL" ? (
              <>
                {renderUtilityConditionFields(selectedUtility.condition)}
                <div className={cn("grid gap-2", inspectorThreeColumnClass)}>
                  <RalphInspectorField label="Interval" help="Seconds between attempts.">
                    <Input
                      type="number"
                      min={0}
                      value={selectedUtility.intervalSeconds ?? 30}
                      aria-label="Poll interval seconds"
                      onChange={(event) =>
                        updateSelectedUtility({
                          intervalSeconds:
                            Number.parseFloat(event.target.value) || 0,
                        })
                      }
                      className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                    />
                  </RalphInspectorField>
                  <RalphInspectorField label="Max attempts" help="Blank means keep polling.">
                    <Input
                      type="number"
                      min={1}
                      value={selectedUtility.maxAttempts ?? ""}
                      aria-label="Poll max attempts"
                      placeholder="Infinite"
                      onChange={(event) =>
                        updateSelectedUtility({
                          maxAttempts: event.target.value
                            ? Number.parseInt(event.target.value, 10)
                            : null,
                        })
                      }
                      className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                    />
                  </RalphInspectorField>
                  <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      checked={selectedUtility.ignoreErrors ?? true}
                      onChange={(event) =>
                        updateSelectedUtility({
                          ignoreErrors: event.target.checked,
                        })
                      }
                    />
                    Ignore errors
                  </label>
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {selectedUtility.type === "RUN_COMMAND" ||
        selectedUtility.type === "RUN_CHECK" ? (
          <div className="grid gap-2">
            <RalphInspectorField
              label="Command"
              help="Shell command to run. Supports {{variables}}."
              action={renderExpandFieldButton("Expand", () =>
                openExpandedEditor({
                  title: "Command",
                  description:
                    "Edit the shell command in a larger workspace. Variables are inserted literally.",
                  ariaLabel: "Expanded utility command",
                  mode: "code",
                  value: selectedUtility.command ?? "",
                  supportsVariables: true,
                  onApply: (command) => updateSelectedUtility({ command }),
                }),
              )}
            >
              <Textarea
                value={selectedUtility.command ?? ""}
                aria-label="Utility command"
                placeholder="npm test"
                onChange={(event) =>
                  updateSelectedUtility({ command: event.target.value })
                }
                className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
              />
            </RalphInspectorField>
            <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
              <RalphInspectorField label="Working directory" help="Leave blank to use the workspace root.">
                <Input
                  value={selectedUtility.cwd ?? ""}
                  aria-label="Command working directory"
                  placeholder="Workspace"
                  onChange={(event) =>
                    updateSelectedUtility({ cwd: event.target.value })
                  }
                  className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                />
              </RalphInspectorField>
              <RalphInspectorField label="Timeout" help="Seconds before the process is stopped.">
                <Input
                  type="number"
                  min={0}
                  value={selectedUtility.timeoutSeconds ?? 120}
                  aria-label="Command timeout seconds"
                  onChange={(event) =>
                    updateSelectedUtility({
                      timeoutSeconds: Number.parseFloat(event.target.value) || 0,
                    })
                  }
                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                />
              </RalphInspectorField>
            </div>
            {selectedUtility.type === "RUN_COMMAND" ? (
              <RalphInspectorField label="Accepted exit codes" help="Comma-separated exit codes treated as success.">
                <Input
                  value={(selectedUtility.acceptedExitCodes ?? [0]).join(", ")}
                  aria-label="Accepted exit codes"
                  placeholder="0"
                  onChange={(event) =>
                    updateSelectedUtility({
                      acceptedExitCodes:
                        parseNumberList(event.target.value) ?? [0],
                    })
                  }
                  className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                />
              </RalphInspectorField>
            ) : null}
            <RalphInspectorField label="Environment (JSON)" help="Extra environment variables for this command.">
              <Textarea
                key={`${selectedBlockId}-env-${selectedUtility.type}`}
                defaultValue={formatJsonDraft(selectedUtility.env ?? {})}
                aria-label="Command env JSON"
                onBlur={(event) => {
                  const env = parseStringRecordDraft(event.target.value);
                  if (env) {
                    updateSelectedUtility({ env });
                  }
                }}
                className="min-h-16 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
              />
            </RalphInspectorField>
          </div>
        ) : null}

        {selectedUtility.type === "UI_ANALYZE" ? (
          <div className="grid gap-2">
            <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
              <label className="grid gap-1.5 text-sm text-slate-200">
                <span className="font-medium">Adapter</span>
                <select
                  value={selectedUtility.adapter ?? "auto"}
                  aria-label="UI analysis adapter"
                  onChange={(event) =>
                    updateSelectedUtility({
                      adapter: event.target
                        .value as RalphUtilityConfig["adapter"],
                    })
                  }
                  className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                >
                  <option value="auto">Auto</option>
                  <option value="browser">Browser</option>
                  <option value="image">Image</option>
                  <option value="playwright-mcp">Playwright MCP</option>
                  <option value="tauri-mcp">Tauri MCP</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm text-slate-200">
                <span className="font-medium">Server Mode</span>
                <select
                  value={selectedUtility.server?.mode ?? "existing"}
                  aria-label="UI analysis server mode"
                  onChange={(event) =>
                    updateSelectedUtility({
                      server: {
                        ...(selectedUtility.server ?? {}),
                        mode: event.target
                          .value as NonNullable<
                          RalphUtilityConfig["server"]
                        >["mode"],
                      },
                    })
                  }
                  className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                >
                  <option value="existing">Existing</option>
                  <option value="none">None</option>
                  <option value="managed">Managed</option>
                </select>
              </label>
            </div>
            <RalphInspectorField label="Target URL" help="Page to inspect. Supports {{variables}}.">
              <Input
                value={selectedUtility.targetUrl ?? selectedUtility.url ?? ""}
                aria-label="UI analysis target URL"
                placeholder="{{targetUrl:url=http://localhost:1420}}"
                onChange={(event) =>
                  updateSelectedUtility({ targetUrl: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField label="Health URL" help="Optional readiness endpoint before capture.">
              <Input
                value={selectedUtility.server?.healthUrl ?? ""}
                aria-label="UI analysis health URL"
                placeholder="Health URL, defaults to target URL"
                onChange={(event) =>
                  updateSelectedUtility({
                    server: {
                      ...(selectedUtility.server ?? {}),
                      healthUrl: event.target.value,
                    },
                  })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField label="Screenshot path" help="Optional existing screenshot instead of live capture.">
              <Input
                value={selectedUtility.screenshotPath ?? ""}
                aria-label="UI analysis screenshot path"
                placeholder="Manual screenshot path"
                onChange={(event) =>
                  updateSelectedUtility({ screenshotPath: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
              <RalphInspectorField label="MCP server" help="Server id for MCP capture adapters.">
                <Input
                  value={selectedUtility.mcpServerId ?? ""}
                  aria-label="UI analysis MCP server"
                  placeholder="MCP server id"
                  onChange={(event) =>
                    updateSelectedUtility({ mcpServerId: event.target.value })
                  }
                  className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                />
              </RalphInspectorField>
              <RalphInspectorField label="MCP tool" help="Tool name used by the MCP adapter.">
                <Input
                  value={selectedUtility.mcpToolName ?? ""}
                  aria-label="UI analysis MCP tool"
                  placeholder="MCP tool name"
                  onChange={(event) =>
                    updateSelectedUtility({ mcpToolName: event.target.value })
                  }
                  className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                />
              </RalphInspectorField>
            </div>
            <div className={cn("grid gap-2", inspectorThreeColumnClass)}>
              <RalphInspectorField label="Timeout" help="Seconds before capture fails.">
                <Input
                  type="number"
                  min={0}
                  value={selectedUtility.timeoutSeconds ?? 30}
                  aria-label="UI analysis timeout seconds"
                  onChange={(event) =>
                    updateSelectedUtility({
                      timeoutSeconds:
                        Number.parseFloat(event.target.value) || 0,
                    })
                  }
                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                />
              </RalphInspectorField>
              <RalphInspectorField label="Wait until" help="Browser lifecycle event for capture.">
                <select
                  value={selectedUtility.waitUntil ?? "domcontentloaded"}
                  aria-label="UI analysis wait until"
                  onChange={(event) =>
                    updateSelectedUtility({
                      waitUntil: event.target
                        .value as RalphUtilityConfig["waitUntil"],
                    })
                  }
                  className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                >
                  <option value="domcontentloaded">DOM Ready</option>
                  <option value="load">Load</option>
                  <option value="networkidle">Network Idle</option>
                  <option value="commit">Commit</option>
                </select>
              </RalphInspectorField>
              <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  checked={selectedUtility.fullPage ?? true}
                  onChange={(event) =>
                    updateSelectedUtility({ fullPage: event.target.checked })
                  }
                />
                Full page
              </label>
            </div>
            <RalphInspectorField label="Viewports (JSON)" help="Array of viewport names and dimensions.">
              <Textarea
                key={`${selectedBlockId}-ui-viewports`}
                defaultValue={formatJsonDraft(
                  selectedUtility.viewports ?? [
                    { name: "desktop", width: 1280, height: 900 },
                    { name: "mobile", width: 390, height: 844 },
                  ],
                )}
                aria-label="UI analysis viewports JSON"
                onBlur={(event) => {
                  const viewports = parseJsonDraft(event.target.value);
                  if (Array.isArray(viewports)) {
                    updateSelectedUtility({
                      viewports:
                        viewports as NonNullable<RalphUtilityConfig["viewports"]>,
                    });
                  }
                }}
                className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField label="Checks (JSON)" help="Enable screenshots, accessibility, console, network, and responsive checks.">
              <Textarea
                key={`${selectedBlockId}-ui-checks`}
                defaultValue={formatJsonDraft(
                  selectedUtility.checks ?? {
                    screenshots: true,
                    accessibility: true,
                    console: true,
                    network: true,
                    responsive: true,
                  },
                )}
                aria-label="UI analysis checks JSON"
                onBlur={(event) => {
                  const checks = parseJsonDraft(event.target.value);
                  if (
                    checks &&
                    typeof checks === "object" &&
                    !Array.isArray(checks)
                  ) {
                    updateSelectedUtility({
                      checks: checks as RalphUtilityConfig["checks"],
                    });
                  }
                }}
                className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField label="MCP arguments (JSON)" help="Arguments passed to the selected MCP tool.">
              <Textarea
                key={`${selectedBlockId}-ui-mcp-arguments`}
                defaultValue={formatJsonDraft(selectedUtility.mcpArguments ?? {})}
                aria-label="UI analysis MCP arguments JSON"
                onBlur={(event) => {
                  const mcpArguments = parseJsonDraft(event.target.value);
                  if (
                    mcpArguments &&
                    typeof mcpArguments === "object" &&
                    !Array.isArray(mcpArguments)
                  ) {
                    updateSelectedUtility({
                      mcpArguments: mcpArguments as Record<string, unknown>,
                    });
                  }
                }}
                className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
              />
            </RalphInspectorField>
          </div>
        ) : null}

        {selectedUtility.type === "READ_FILE" ||
        selectedUtility.type === "WRITE_FILE" ? (
          <div className="grid gap-2">
            <RalphInspectorField label="File path" help="Workspace-relative path. Supports {{variables}}.">
              <Input
                value={selectedUtility.path ?? ""}
                aria-label="Utility file path"
                placeholder="{{file:path}}"
                onChange={(event) =>
                  updateSelectedUtility({ path: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            {selectedUtility.type === "WRITE_FILE" ? (
              <>
                <RalphInspectorField label="Content" help="Text to write. Supports {{variables}}.">
                  <Textarea
                    value={selectedUtility.content ?? ""}
                    aria-label="Utility file content"
                    placeholder="{{lastResult}}"
                    onChange={(event) =>
                      updateSelectedUtility({ content: event.target.value })
                    }
                    className="min-h-28 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
                  />
                </RalphInspectorField>
                <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={selectedUtility.append ?? false}
                    onChange={(event) =>
                      updateSelectedUtility({ append: event.target.checked })
                    }
                  />
                  Append
                </label>
              </>
            ) : null}
          </div>
        ) : null}

        {selectedUtility.type === "SEARCH_FILES" ? (
          <div className="grid gap-2">
            <RalphInspectorField label="Root path" help="Directory to search from.">
              <Input
                value={selectedUtility.rootPath ?? "."}
                aria-label="Search root path"
                placeholder="."
                onChange={(event) =>
                  updateSelectedUtility({ rootPath: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
              <RalphInspectorField label="Search pattern" help="Text or regex query. Supports {{variables}}.">
                <Input
                  value={selectedUtility.pattern ?? ""}
                  aria-label="Search pattern"
                  placeholder="{{query:string}}"
                  onChange={(event) =>
                    updateSelectedUtility({ pattern: event.target.value })
                  }
                  className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                />
              </RalphInspectorField>
              <RalphInspectorField label="File glob" help="Optional file filter.">
                <Input
                  value={selectedUtility.glob ?? ""}
                  aria-label="Search glob"
                  placeholder="*.ts"
                  onChange={(event) =>
                    updateSelectedUtility({ glob: event.target.value })
                  }
                  className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                />
              </RalphInspectorField>
            </div>
          </div>
        ) : null}

        {selectedUtility.type === "GIT_STATUS" ? (
          <RalphInspectorField label="Working directory" help="Repository path to inspect.">
            <Input
              value={selectedUtility.cwd ?? "."}
              aria-label="Git working directory"
              placeholder="Workspace"
              onChange={(event) =>
                updateSelectedUtility({ cwd: event.target.value })
              }
              className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
            />
          </RalphInspectorField>
        ) : null}

        {selectedUtility.type === "SET_VARIABLE" ? (
          <div className="grid gap-2">
            <RalphInspectorField label="Variable name" help="Name stored for later {{variable}} references.">
              <Input
                value={selectedUtility.variableName ?? ""}
                aria-label="Utility variable name"
                placeholder="scope"
                onChange={(event) =>
                  updateSelectedUtility({ variableName: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField label="Value" help="Value assigned to the variable. Supports {{variables}}.">
              <Textarea
                value={selectedUtility.value ?? ""}
                aria-label="Utility variable value"
                placeholder="{{lastResultSummary}}"
                onChange={(event) =>
                  updateSelectedUtility({ value: event.target.value })
                }
                className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
              />
            </RalphInspectorField>
          </div>
        ) : null}

        {selectedUtility.type === "TRANSFORM_JSON" ||
        selectedUtility.type === "VALIDATE_JSON" ? (
          <div className="grid gap-2">
            <RalphInspectorField label="Input JSON" help="Blank uses the previous utility result.">
              <Textarea
                value={selectedUtility.input ?? ""}
                aria-label="Utility JSON input"
                placeholder="Leave empty to use last utility data"
                onChange={(event) =>
                  updateSelectedUtility({ input: event.target.value })
                }
                className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
              />
            </RalphInspectorField>
            {selectedUtility.type === "TRANSFORM_JSON" ? (
              <RalphInspectorField label="Transform expression" help="Expression that returns the transformed value.">
                <Textarea
                  value={selectedUtility.expression ?? "input"}
                  aria-label="JSON transform expression"
                  placeholder="input"
                  onChange={(event) =>
                    updateSelectedUtility({ expression: event.target.value })
                  }
                  className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
                />
              </RalphInspectorField>
            ) : (
              <RalphInspectorField label="JSON schema" help="Schema used to validate the input JSON.">
                <Textarea
                  key={`${selectedBlockId}-schema`}
                  defaultValue={formatJsonDraft(selectedUtility.schema)}
                  aria-label="JSON schema"
                  onBlur={(event) => {
                    const schema = parseJsonDraft(event.target.value);
                    if (schema !== undefined) {
                      updateSelectedUtility({ schema });
                    }
                  }}
                  className="min-h-24 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
                />
              </RalphInspectorField>
            )}
          </div>
        ) : null}

        {selectedUtility.type === "NOTIFY" ? (
          <RalphInspectorField label="Message" help="Notification text. Supports {{variables}}.">
            <Textarea
              value={selectedUtility.message ?? ""}
              aria-label="Notification message"
              placeholder="{{lastResultSummary}}"
              onChange={(event) =>
                updateSelectedUtility({ message: event.target.value })
              }
              className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
            />
          </RalphInspectorField>
        ) : null}

        <div data-ralph-inspector-section="advanced">
          <RalphInspectorDetails
            title="Advanced JSON"
            help="Raw utility config for fields not exposed above."
          >
            <div className="flex min-w-0 items-center justify-between gap-2">
              {renderExpandFieldButton("Expand", () =>
                openExpandedEditor({
                  title: "Utility JSON",
                  description:
                    "Edit the raw utility configuration. Apply here, then use the JSON apply action in the inspector.",
                  ariaLabel: "Expanded utility advanced JSON",
                  mode: "json",
                  value: utilityJsonDraft,
                  onApply: setUtilityJsonDraft,
                }),
              )}
              <Button
              type="button"
              variant="outline"
              disabled={Boolean(utilityJsonDraftInlineError)}
              onClick={applyUtilityJsonDraft}
              className="h-7 rounded-md border-cyan-500/30 bg-cyan-500/10 px-2 text-xs text-cyan-100 hover:bg-cyan-500/15"
            >
                Apply
              </Button>
            </div>
            <Textarea
              value={utilityJsonDraft}
              aria-label="Utility advanced JSON"
              onChange={(event) => {
                setUtilityJsonDraft(event.target.value);
                setUtilityJsonError(null);
              }}
              className="min-h-32 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
            />
            {utilityJsonError || utilityJsonDraftInlineError ? (
              <div className="rounded border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-100">
                {utilityJsonError ?? utilityJsonDraftInlineError}
              </div>
            ) : null}
          </RalphInspectorDetails>
        </div>
      </div>
    );
  };

  const renderExpandedEditorDialog = (): JSX.Element => {
    const isJsonMode = expandedEditor?.mode === "json";

    return (
      <Dialog
        open={Boolean(expandedEditor)}
        onOpenChange={(open) => {
          if (!open) {
            setExpandedEditor(null);
          }
        }}
      >
        <DialogContent className="max-h-[calc(100vh-3rem)] max-w-[min(72rem,calc(100vw-3rem))] grid-rows-[auto_minmax(0,1fr)_auto] border-slate-700 bg-slate-950 p-0 text-slate-100">
          <DialogHeader className="border-b border-slate-800 px-5 py-4 pr-12">
            <DialogTitle className="text-base text-white">
              {expandedEditor?.title ?? "Expanded editor"}
            </DialogTitle>
            <DialogDescription className="text-slate-500">
              {expandedEditor?.description ?? "Edit the field in a larger workspace."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 gap-3 overflow-hidden px-5 py-4">
            {expandedEditor?.supportsVariables ? (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs font-medium text-slate-500">
                  Insert
                </span>
                {RALPH_VARIABLE_SNIPPETS.map((snippet) => (
                  <button
                    key={snippet}
                    type="button"
                    onClick={() => insertExpandedEditorSnippet(snippet)}
                    className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-[0.68rem] text-slate-300 hover:border-cyan-400/30 hover:bg-cyan-500/10 hover:text-cyan-100"
                  >
                    {snippet}
                  </button>
                ))}
              </div>
            ) : null}
            <textarea
              ref={expandedEditorTextareaRef}
              value={expandedEditorDraft}
              aria-label={expandedEditor?.ariaLabel ?? "Expanded editor"}
              wrap={expandedEditorWrap ? "soft" : "off"}
              spellCheck={expandedEditor?.mode === "text"}
              onChange={(event) => setExpandedEditorDraft(event.target.value)}
              className={cn(
                "min-h-[min(56vh,34rem)] resize-none overflow-auto rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/30",
                isJsonMode && "font-mono",
              )}
            />
          </div>
          <DialogFooter className="items-center justify-between border-t border-slate-800 px-5 py-3 sm:flex-row">
            <label className="flex items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={expandedEditorWrap}
                onChange={(event) => setExpandedEditorWrap(event.target.checked)}
              />
              Wrap lines
            </label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => void copyExpandedEditorDraft()}
                className="h-8 rounded-lg px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-white"
              >
                <Copy className="h-3.5 w-3.5" />
                Copy
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setExpandedEditor(null)}
                className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs text-slate-200 hover:bg-slate-800"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={applyExpandedEditor}
                className="h-8 rounded-lg bg-cyan-600 px-3 text-xs text-white hover:bg-cyan-500"
              >
                Apply
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  };

  const renderGenerationInterviewDialog = (): JSX.Element => {
    const state = generationInterview;
    const busy = state?.status === "loading" || state?.status === "generating";
    const targetLabel =
      state?.context.target === "prompt-block"
        ? "Prompt"
        : state?.context.target === "refactor"
          ? "Improve"
          : "Flow";
    const latestQuestionScope =
      [...(state?.session?.transcript ?? [])]
        .reverse()
        .find((turn) => turn.questions.length > 0)
        ?.questionScope?.trim() || "Questions";
    const statusTitle =
      state?.status === "generating"
        ? "Generating"
        : state?.status === "loading"
          ? "Preparing questions"
          : state?.status === "blocked"
            ? "Needs attention"
            : "Questions";
    const primaryActionLabel =
      state?.session && state.session.turn >= state.session.maxTurns
        ? "Generate"
        : "Continue";

    return (
      <Dialog
        open={Boolean(state)}
        onOpenChange={(open) => {
          if (!open) {
            setGenerationInterview(null);
          }
        }}
      >
        <DialogContent
          confirmOnInteractOutside={{
            title: "Close interview?",
            description: "Current answers will be discarded.",
            cancelLabel: "Keep open",
            confirmLabel: "Close",
          }}
          className="h-[min(720px,calc(100vh-28px))] w-[min(760px,calc(100vw-28px))] max-w-none gap-0 overflow-hidden rounded-xl border-slate-700/80 bg-slate-950 p-0 text-slate-100 shadow-[0_24px_80px_rgba(2,6,23,0.65)] sm:max-w-none"
        >
          <DialogHeader className="border-b border-slate-800 bg-slate-950 px-5 py-4 pr-12">
            <div className="flex min-w-0 items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-cyan-400/25 bg-cyan-400/10">
                  <Sparkles className="h-4 w-4 text-cyan-200" />
                </div>
                <DialogTitle className="min-w-0 truncate text-base font-semibold text-white">
                  Generation Interview
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Answer generation interview questions before Ralph creates or updates a flow.
                </DialogDescription>
              </div>
              {state ? (
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  <Badge
                    variant="outline"
                    className="border-cyan-400/30 bg-cyan-400/10 text-cyan-100"
                  >
                    {targetLabel}
                  </Badge>
                </div>
              ) : null}
            </div>
          </DialogHeader>

          {state ? (
            <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto] bg-slate-950">
              <ScrollArea className="min-h-0 bg-slate-950" type="always">
                <div className="grid gap-4 p-5">
                    {state.status === "loading" ? (
                      <div className="grid min-h-80 place-items-center">
                        <div className="grid justify-items-center gap-4">
                          <LoaderCircle className="h-7 w-7 animate-spin text-cyan-300" />
                          <div className="text-sm font-semibold text-slate-100">
                            {statusTitle}
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {state.status === "generating" ? (
                      <div className="grid min-h-80 place-items-center">
                        <div className="grid justify-items-center gap-4">
                          <LoaderCircle className="h-7 w-7 animate-spin text-emerald-300" />
                          <div className="text-sm font-semibold text-emerald-50">
                            {statusTitle}
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {state.status === "blocked" ? (
                      <div className="rounded-md border border-amber-400/25 bg-amber-400/10 p-4">
                        <div className="mb-1 text-sm font-semibold text-amber-100">
                          {statusTitle}
                        </div>
                        <p className="text-sm leading-6 text-amber-100/80">
                          {state.error ?? state.summary}
                        </p>
                      </div>
                    ) : null}

                    {state.status === "ready" ? (
                      <div className="grid gap-3">
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <h2 className="text-base font-semibold text-white">
                            {latestQuestionScope}
                          </h2>
                        </div>
                        {state.fields.map((field) => {
                          const error = state.validationErrors[field.id];
                          const skipped = state.skippedFieldIds.includes(field.id);
                          const answerComment =
                            state.answerComments[field.id] ?? "";
                          const commentOpen =
                            state.expandedCommentFieldIds.includes(field.id);
                          const hasComment =
                            answerComment.trim().length > 0;

                          return (
                            <div
                              key={field.id}
                              className={cn(
                                "grid gap-3 rounded-lg border border-slate-700/70 bg-slate-900/70 p-4 text-sm text-slate-100 shadow-sm shadow-black/15",
                                skipped && "border-slate-800 bg-slate-900/35",
                              )}
                            >
                              <span className="flex min-w-0 items-start justify-between gap-3">
                                <span className="min-w-0 font-semibold leading-5 text-slate-50">
                                  {field.label}
                                </span>
                                <span className="flex shrink-0 items-center gap-1.5">
                                  {skipped ? (
                                    <span className="text-xs font-medium text-slate-500">
                                      Skipped
                                    </span>
                                  ) : null}
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() =>
                                          toggleGenerationInterviewComment(field.id)
                                        }
                                        aria-label={`${commentOpen ? "Hide" : "Add"} comment for ${field.label}`}
                                        className={cn(
                                          "h-7 w-7 rounded-md hover:bg-slate-800 hover:text-slate-100",
                                          hasComment || commentOpen
                                            ? "text-cyan-200"
                                            : "text-slate-500",
                                        )}
                                      >
                                        <MessageSquare className="h-3.5 w-3.5" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      {commentOpen ? "Hide comment" : "Add comment"}
                                    </TooltipContent>
                                  </Tooltip>
                                </span>
                              </span>
                              {field.help ? (
                                <p className="rounded-md border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-medium leading-5 text-cyan-50">
                                  {field.help}
                                </p>
                              ) : null}
                              {renderRalphInputControl(
                                field,
                                state.values[field.id] ?? getDefaultRalphInputValue(field),
                                (value) => updateGenerationInterviewValue(field.id, value),
                              )}
                              {commentOpen ? (
                                <Textarea
                                  value={answerComment}
                                  aria-label={`Comment for ${field.label}`}
                                  placeholder="Add extra context for this answer"
                                  onChange={(event) =>
                                    updateGenerationInterviewComment(
                                      field.id,
                                      event.target.value,
                                    )
                                  }
                                  className="min-h-20 border-slate-700 bg-slate-950 text-sm text-slate-100"
                                />
                              ) : null}
                              <span className="flex min-w-0 items-start justify-between gap-3">
                                {error ? (
                                  <span className="min-w-0 text-xs leading-5 text-rose-200">
                                    {error}
                                  </span>
                                ) : (
                                  <span />
                                )}
                                {field.skippable ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="xs"
                                    onClick={() => skipGenerationInterviewField(field.id)}
                                    className={cn(
                                      "shrink-0 hover:bg-slate-800 hover:text-slate-100",
                                      skipped ? "text-slate-200" : "text-slate-400",
                                    )}
                                  >
                                    {skipped ? "Skipped" : "Skip"}
                                  </Button>
                                ) : null}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                </div>
              </ScrollArea>

                <DialogFooter className="justify-end border-t border-slate-800 bg-slate-950 px-5 py-3 sm:flex-row">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setGenerationInterview(null)}
                      className="text-slate-400 hover:bg-slate-900 hover:text-white"
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void generateFromInterviewNow()}
                      className="border-emerald-400/30 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/15"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Generate
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy || state.status !== "ready"}
                      onClick={() => void submitGenerationInterviewAnswers()}
                      className="bg-cyan-600 text-white hover:bg-cyan-500"
                    >
                      {state.status === "loading" ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      {primaryActionLabel}
                    </Button>
                  </div>
                </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    );
  };

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-2 text-left">
            <div className="flex min-w-0 items-center justify-between gap-4">
              <h1 className="flex min-w-0 items-center gap-2 text-base font-semibold text-white">
                <Workflow className="h-4 w-4 shrink-0 text-emerald-300" />
                <span className="truncate">Ralph Flow Editor</span>
                {dirty ? (
                  <span className="shrink-0 text-xs font-medium text-amber-200">
                    unsaved
                  </span>
                ) : null}
              </h1>
              <div className="grid shrink-0 grid-cols-4 gap-1 rounded-lg border border-slate-800 bg-slate-900/80 p-1">
                {EDITOR_MODES.map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => setEditorMode(mode.id)}
                    className={cn(
                      "h-7 rounded-md px-3 text-xs font-semibold",
                      editorMode === mode.id
                        ? "bg-slate-700 text-white"
                        : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                    )}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="sr-only">
              Edit and run saved Ralph prompt flow graphs.
            </p>
          </header>

          <div
            className={cn(
              "grid min-h-0 overflow-hidden",
              editorRowsClass,
            )}
            style={editorGridStyle}
          >
            {flowListOpen ? (
            <aside className="col-start-1 row-start-1 grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-slate-800 bg-slate-950/80">
              <div className="grid gap-3 border-b border-slate-800 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                    Flows
                  </span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={flowsLoading}
                      aria-label="Refresh Ralph flows"
                      title="Refresh Ralph flows"
                      onClick={() => void refreshFlows()}
                      className="h-8 w-8 rounded-lg text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                    >
                      <RefreshCw
                        className={cn("h-4 w-4", flowsLoading && "animate-spin")}
                      />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Collapse Ralph flows"
                      title="Collapse Ralph flows"
                      onClick={() => setFlowListOpen(false)}
                      className="h-8 w-8 rounded-lg text-slate-500 hover:bg-slate-900 hover:text-slate-100"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1">
                  {RALPH_FLOW_LIBRARY_MODES.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={flowLibraryMode === mode}
                      onClick={() => onFlowLibraryModeChange?.(mode)}
                      className={cn(
                        "h-7 min-w-0 rounded-md px-2 text-xs font-semibold",
                        flowLibraryMode === mode
                          ? mode === "user"
                            ? "bg-sky-500/20 text-sky-100"
                            : mode === "workspace"
                              ? "bg-emerald-500/20 text-emerald-100"
                              : "bg-slate-700 text-white"
                          : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                      )}
                    >
                      <span className="block truncate">
                        {RALPH_FLOW_LIBRARY_LABELS[mode]}
                      </span>
                    </button>
                  ))}
                </div>
                <Input
                  value={flowAliasDraft}
                  aria-label="Ralph flow alias"
                  placeholder="flow-alias"
                  onChange={(event) =>
                    setFlowAliasDraft(createFlowAlias(event.target.value))
                  }
                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100 placeholder:text-slate-600"
                />
                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
                      Save new to
                    </span>
                    <span className="text-[0.68rem] text-slate-500">
                      {creationScopeLabel}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1">
                    {RALPH_FLOW_SCOPES.map((scope) => (
                      <button
                        key={scope}
                        type="button"
                        onClick={() => setCreationScope(scope)}
                        className={cn(
                          "h-7 rounded-md px-2 text-xs font-semibold",
                          creationScope === scope
                            ? scope === "user"
                              ? "bg-sky-500/20 text-sky-100"
                              : "bg-emerald-500/20 text-emerald-100"
                            : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                        )}
                      >
                        {RALPH_FLOW_SCOPE_LABELS[scope]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!workspaceRoot}
                    onClick={() => void createLocalFlow()}
                    className="h-9 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs text-slate-100 hover:bg-slate-800"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    New
                  </Button>
                  <Button
                    type="button"
                    disabled={!canSaveFlow}
                    onClick={() => void saveFlow()}
                    className={cn(
                      "h-9 rounded-lg px-3 text-xs",
                      canSaveFlow
                        ? "bg-emerald-600 text-white hover:bg-emerald-500"
                        : "border border-slate-800 bg-slate-900 text-slate-500",
                    )}
                  >
                    {loading ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    Save
                  </Button>
                </div>
              </div>

              <ScrollArea className="min-h-0" type="always">
                <div className="grid p-2 pr-4">
                  {flowsLoading && displayFlows.length === 0 ? (
                    <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 px-3 py-4 text-sm text-slate-400">
                      <LoaderCircle className="h-4 w-4 animate-spin text-sky-300" />
                      Loading Ralph flows...
                    </div>
                  ) : displayFlows.length === 0 ? (
                    <div className="grid gap-3 rounded-lg border border-dashed border-slate-800 bg-slate-950 px-3 py-4 text-sm text-slate-500">
                      <div>
                        {workspaceRoot
                          ? `No ${RALPH_FLOW_LIBRARY_LABELS[flowLibraryMode].toLowerCase()} Ralph flows found.`
                          : "Choose a workspace before creating Ralph flows."}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          aria-label="Create blank Ralph flow"
                          disabled={!workspaceRoot}
                          onClick={() => void createLocalFlow()}
                          className="h-8 rounded-lg border-slate-700 bg-slate-900 px-2 text-xs text-slate-100 hover:bg-slate-800"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          New
                        </Button>
                        <Button
                          type="button"
                          aria-label="Open AI flow generator"
                          disabled={!workspaceRoot}
                          onClick={() => setEditorMode("generate")}
                          className="h-8 rounded-lg bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-500"
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                          AI
                        </Button>
                      </div>
                    </div>
                  ) : (
                    displayFlowRows.map((row) =>
                      row.type === "heading" ? (
                        <div
                          key={`heading-${row.scope}`}
                          className="flex min-w-0 items-center justify-between gap-2 px-2 pb-1 pt-3 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-slate-500 first:pt-1"
                        >
                          <span>{RALPH_FLOW_SCOPE_LABELS[row.scope]}</span>
                          <span>{row.count}</span>
                        </div>
                      ) : (
                      (() => {
                        const flow = row.flow;
                        const flowScope = getFlowSummaryScope(flow);
                        const flowKey = getFlowSummarySelectionKey(flow);
                        const isSelectedFlow =
                          selectedFlowKey === flowKey;
                        const isDraftSummary =
                          draftFlow?.id === flow.id &&
                          selectedScope === flowScope;
                        const isGeneratedSummary =
                          generationJob?.status === "created" &&
                          generationJob.scope === flowScope &&
                          generationJob.result?.flow?.id === flow.id;
                        const activeFlowRuns = activeRunsByFlowKey.get(flowKey) ?? [];
                        const runStatusLabel = getFlowRunStatusLabel(
                          activeFlowRuns,
                        );
                        const canLoadFlow =
                          Boolean(flow.path) ||
                          (draftFlow?.id === flow.id && selectedScope === flowScope);
                        const statusLabel =
                          runStatusLabel ??
                          (isGeneratedSummary
                            ? "Generated"
                            : isDraftSummary
                              ? dirty
                                ? "Unsaved"
                                : errorCount > 0
                                  ? "Errors"
                                  : warningCount > 0
                                    ? "Warnings"
                                    : "Ready"
                              : "Saved");
                        const statusPresentation =
                          getFlowStatusPresentation(statusLabel);
                        const StatusIcon = statusPresentation.icon;

                        return (
                          <div
                            key={flowKey}
                            onContextMenu={(event) =>
                              openFlowListMenu(event, flow)
                            }
                            className={cn(
                              "flex min-w-0 items-center gap-2 border-b border-slate-800/70 px-2 py-2 last:border-b-0",
                              isSelectedFlow
                                ? "bg-emerald-500/10"
                                : canLoadFlow
                                  ? "hover:bg-slate-900/70"
                                  : "cursor-default opacity-80",
                            )}
                          >
                            <button
                              type="button"
                              disabled={!canLoadFlow}
                              onClick={() => void selectFlow(flow)}
                              title={flow.name}
                              className="grid min-w-0 flex-1 gap-1 text-left disabled:cursor-default"
                            >
                              <span className="flex min-w-0 items-center justify-between gap-2">
                                <span className="truncate text-sm font-medium text-slate-100">
                                  {flow.name}
                                </span>
                                <span
                                  aria-label={`Flow status: ${statusLabel}`}
                                  title={statusLabel}
                                  className={cn(
                                    "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-slate-800 bg-slate-950",
                                    statusPresentation.className,
                                  )}
                                >
                                  <StatusIcon
                                    className={cn(
                                      "h-3.5 w-3.5",
                                      statusPresentation.spin && "animate-spin",
                                    )}
                                  />
                                </span>
                              </span>
                              <span className="truncate text-[0.68rem] leading-4 text-slate-500">
                                {formatFlowSubtitle(flow)}
                              </span>
                            </button>
                          </div>
                        );
                      })()
                    ))
                  )}
                </div>
              </ScrollArea>
            </aside>
            ) : (
              <aside className="col-start-1 row-start-1 flex min-h-0 flex-col items-center gap-3 border-r border-slate-800 bg-slate-950/80 px-1.5 py-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Open Ralph flows"
                  title="Open Ralph flows"
                  onClick={() => setFlowListOpen(true)}
                  className="h-8 w-8 rounded-lg text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                >
                  <Workflow className="h-4 w-4" />
                </Button>
                <span className="origin-center rotate-90 whitespace-nowrap text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-slate-600">
                  Flows
                </span>
              </aside>
            )}

            <main className="col-start-2 row-start-1 grid min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-slate-950">
              <div className="flex min-w-0 items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Route className="h-4 w-4 shrink-0 text-sky-300" />
                  <span className="truncate text-sm font-semibold text-white">
                    {flowTitle}
                  </span>
                  {draftFlow || selectedSummary ? (
                    <span
                      className={cn(
                        "shrink-0 rounded border px-1.5 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em]",
                        selectedScope === "user"
                          ? "border-sky-400/30 bg-sky-500/10 text-sky-100"
                          : "border-slate-700 bg-slate-900 text-slate-400",
                      )}
                    >
                      {selectedScopeLabel}
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label="Undo Ralph edit"
                        title="Undo Ralph edit"
                        disabled={!canUndo}
                        onClick={undoFlowEdit}
                        className="h-8 rounded-lg px-2 text-xs text-slate-300 hover:bg-slate-900 hover:text-white disabled:text-slate-700"
                      >
                        <Undo2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Undo</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label="Redo Ralph edit"
                        title="Redo Ralph edit"
                        disabled={!canRedo}
                        onClick={redoFlowEdit}
                        className="h-8 rounded-lg px-2 text-xs text-slate-300 hover:bg-slate-900 hover:text-white disabled:text-slate-700"
                      >
                        <Redo2 className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Redo</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label="Clean Ralph layout"
                        title="Clean Ralph layout"
                        disabled={!draftFlow}
                        onClick={cleanFlowLayout}
                        className="h-8 rounded-lg px-2 text-xs text-slate-300 hover:bg-slate-900 hover:text-white disabled:text-slate-700"
                      >
                        <LayoutGrid className="h-4 w-4 text-slate-300" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Clean layout</TooltipContent>
                  </Tooltip>
                  {editorMode === "design" && !showInspectorPanel ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          aria-label="Show block settings"
                          title="Show block settings"
                          onClick={() => setInspectorOpen(true)}
                          className="h-8 rounded-lg px-2 text-xs text-slate-300 hover:bg-slate-900 hover:text-white"
                        >
                          <SlidersHorizontal className="h-4 w-4 text-slate-300" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">Show settings</TooltipContent>
                    </Tooltip>
                  ) : null}
                  <div className="mx-1 h-5 w-px bg-slate-800" />
                  {BLOCK_ACTIONS.map((action) => {
                      const tone = getBlockTone(action.type);
                      const Icon = tone.icon;

                      return (
                        <Tooltip key={action.type}>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              aria-label={`Add ${action.type} block`}
                              title={`Add ${action.type} block`}
                              disabled={action.type === "START" && flowHasStart}
                              onClick={() => addBlock(action.type)}
                              className="h-8 w-8 rounded-lg p-0 text-slate-300 hover:bg-slate-900 hover:text-white disabled:text-slate-700"
                            >
                              <Icon className={cn("h-4 w-4", tone.badgeClassName)} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            {action.label}
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                  <DropdownMenu>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            aria-label="Add MCP block"
                            title="Add MCP block"
                            className="h-8 w-8 rounded-lg p-0 text-slate-300 hover:bg-slate-900 hover:text-white"
                          >
                            <Globe2 className="h-4 w-4 text-violet-300" />
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">MCP</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent
                      align="end"
                      sideOffset={5}
                      className="z-[90] min-w-36 rounded-md border border-slate-700 bg-slate-950 p-1 text-slate-100 shadow-xl shadow-black/30"
                    >
                      {MCP_BLOCK_ACTIONS.map((action) => (
                        <DropdownMenuItem
                          key={action.type}
                          onSelect={() => addBlock(action.type)}
                          className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs font-medium text-slate-300 outline-none focus:bg-violet-500/15 focus:text-violet-100"
                        >
                          <Globe2 className="h-3.5 w-3.5 shrink-0 text-violet-300" />
                          <span className="min-w-0 truncate">{action.label}</span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <div className="relative min-h-0">
                <ReactFlowProvider>
                  <ReactFlow
                    nodes={canvasNodes}
                    edges={edges}
                    nodeTypes={RALPH_NODE_TYPES}
                    edgeTypes={RALPH_EDGE_TYPES}
                    onInit={(instance) => {
                      reactFlowInstanceRef.current = instance;
                    }}
                    onNodesChange={handleNodesChange}
                    onNodeDragStop={handleNodeDragStop}
                    onConnect={handleConnect}
                    onReconnect={handleReconnect}
                    edgesReconnectable
                    deleteKeyCode={[]}
                    onNodeClick={(_, node) => {
                      setSelectedBlockId(node.id);
                      setSelectedEdgeId(null);
                      closeCanvasMenu();
                      closeFlowListMenu();
                    }}
                    onEdgeClick={(_, edge) => {
                      setSelectedEdgeId(edge.id);
                      setSelectedBlockId(null);
                      closeCanvasMenu();
                      closeFlowListMenu();
                    }}
                    onPaneClick={() => {
                      setSelectedBlockId(null);
                      setSelectedEdgeId(null);
                      closeCanvasMenu();
                      closeFlowListMenu();
                    }}
                    onPaneContextMenu={openPaneMenu}
                    onNodeContextMenu={openNodeMenu}
                    onEdgeContextMenu={openEdgeMenu}
                    onEdgesDelete={(deletedEdges) => {
                      removeEdges(deletedEdges.map((edge) => edge.id));
                    }}
                    fitView
                    minZoom={0.25}
                    maxZoom={1.8}
                    colorMode="dark"
                    proOptions={RALPH_REACT_FLOW_PRO_OPTIONS}
                    className="bg-slate-950"
                  >
                    <Background gap={22} size={1} color="#1e293b" />
                    {showMiniMap ? (
                      <MiniMap
                        pannable
                        zoomable
                        position="bottom-right"
                        nodeColor={(node) =>
                          getBlockVisual((node.data as RalphNodeData).block)
                            .miniMapColor
                        }
                        maskColor="rgba(2, 6, 23, 0.72)"
                        className="!border !border-slate-800 !bg-slate-950"
                        style={{
                          width: 132,
                          height: 88,
                          backgroundColor: "#020617",
                        }}
                      />
                    ) : null}
                    <Controls
                      position="bottom-left"
                      className="[&_.react-flow__controls-button]:!border-slate-800 [&_.react-flow__controls-button]:!bg-slate-900 [&_.react-flow__controls-button]:!text-slate-200 [&_.react-flow__controls-button:hover]:!bg-slate-800"
                    />
                  </ReactFlow>
                </ReactFlowProvider>
                {renderCanvasContextMenu()}
                {renderFlowListContextMenu()}
                {!draftFlow ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
                    <div className="pointer-events-auto grid max-w-md gap-3 rounded-lg border border-dashed border-slate-800 bg-slate-950/70 px-5 py-4 text-center">
                      <div className="text-sm font-semibold text-slate-100">
                        {workspaceRoot ? "Start a Ralph flow" : "Choose a workspace"}
                      </div>
                      <div className="text-sm text-slate-500">
                        {workspaceRoot
                          ? "Create a blank graph or use AI to generate the first flow from your current prompt."
                          : "Set the Ralph workspace in the header before creating, saving, or running flows."}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          aria-label="Create blank Ralph flow from canvas"
                          disabled={!workspaceRoot}
                          onClick={() => void createLocalFlow()}
                          className="h-9 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs text-slate-100 hover:bg-slate-800"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          New Flow
                        </Button>
                        <Button
                          type="button"
                          aria-label="Open AI flow generator from canvas"
                          disabled={!workspaceRoot}
                          onClick={() => setEditorMode("generate")}
                          className="h-9 rounded-lg bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-500"
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                          Generate
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </main>

            {showInspectorPanel ? (
            <aside className="relative col-start-3 row-start-1 grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] border-l border-slate-800 bg-slate-950/90 shadow-[-18px_0_36px_rgba(2,6,23,0.18)]">
              <button
                type="button"
                aria-label="Resize block settings"
                title="Drag to resize, double-click to reset"
                onPointerDown={handleInspectorResizePointerDown}
                onDoubleClick={resetInspectorWidth}
                className="group absolute inset-y-0 left-0 z-50 flex w-6 -translate-x-3 cursor-col-resize touch-none select-none items-center justify-center text-slate-500 hover:text-cyan-200 active:text-cyan-100"
                style={{ cursor: "col-resize" }}
              >
                <span className="absolute inset-y-3 left-1/2 w-px -translate-x-1/2 rounded-full bg-slate-700/70 transition group-hover:bg-cyan-400/70" />
                <span className="relative flex h-9 w-4 items-center justify-center rounded-full border border-slate-700/80 bg-slate-950/95 shadow-lg shadow-slate-950/40 transition group-hover:border-cyan-400/50 group-hover:bg-slate-900">
                  <GripVertical className="h-5 w-5" />
                </span>
              </button>
              <div className="border-b border-slate-800 px-4 py-3">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    {selectedBlock ? (
                      <SlidersHorizontal className="h-4 w-4 shrink-0 text-slate-400" />
                    ) : selectedEdge ? (
                      <Route className="h-4 w-4 shrink-0 text-sky-300" />
                    ) : (
                      <Workflow className="h-4 w-4 shrink-0 text-emerald-300" />
                    )}
                    <span className="truncate text-sm font-semibold text-white">
                      {selectedBlock?.title ??
                        (selectedEdge
                          ? `Route ${selectedEdge.fromOutput}`
                          : draftFlow
                            ? "Flow Settings"
                            : "Flow Settings")}
                    </span>
                    {selectedBlockIssueCounts.errors > 0 ? (
                      <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[0.65rem] font-semibold text-rose-100">
                        {selectedBlockIssueCounts.errors} error
                      </span>
                    ) : selectedBlockIssueCounts.warnings > 0 ? (
                      <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[0.65rem] font-semibold text-amber-100">
                        {selectedBlockIssueCounts.warnings} warning
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Hide block settings"
                      title="Hide block settings"
                      onClick={() => setInspectorOpen(false)}
                      className="h-8 w-8 rounded-lg text-slate-500 hover:bg-slate-900 hover:text-slate-100"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                    {selectedBlock || selectedEdge ? (
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label="Show flow settings"
                        title="Show flow settings"
                        onClick={() => {
                          setSelectedBlockId(null);
                          setSelectedEdgeId(null);
                        }}
                        className="h-8 rounded-lg px-2 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100"
                      >
                        <Workflow className="h-4 w-4" />
                        <span className="hidden xl:inline">Flow</span>
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={selectedEdge ? "Remove route" : "Remove block"}
                      title={selectedEdge ? "Remove route" : "Remove block"}
                      disabled={
                        selectedEdge
                          ? false
                          : !selectedBlock || selectedBlock.type === "START"
                      }
                      onClick={() => {
                        if (selectedEdge) {
                          removeEdge(selectedEdge.id);
                        } else {
                          deleteSelectedBlock();
                        }
                      }}
                      className="h-8 w-8 rounded-lg text-slate-400 hover:bg-red-500/10 hover:text-red-200"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>

              {renderInspectorSectionTabs()}

              <div className="relative min-h-0">
                <div
                  className={cn(
                    "pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-slate-950 to-transparent transition-opacity",
                    inspectorScrollState.atTop ? "opacity-0" : "opacity-100",
                  )}
                />
                <div
                  ref={inspectorScrollContainerRef}
                  onScroll={updateInspectorScrollState}
                  className="h-full overflow-y-scroll [scrollbar-gutter:stable] [scrollbar-width:thin]"
                >
                {selectedBlock ? (
                  <div
                    data-ralph-inspector-section="content"
                    className="grid gap-4 p-4 pr-5 pb-8"
                  >
                    <label className="grid gap-1.5 text-sm text-slate-200">
                      <span className="font-medium">Title</span>
                      <Input
                        value={selectedBlock.title}
                        aria-label="Block title"
                        onChange={(event) => {
                          const title = event.target.value;
                          updateBlock(selectedBlock.id, (block) => ({
                            ...block,
                            title,
                          }));
                        }}
                        className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                      />
                    </label>

                    {selectedBlock.type === "NOTE" ? (
                      <div className="grid gap-3 rounded-lg bg-slate-900/25 p-3 text-sm text-slate-100 ring-1 ring-slate-800/60">
                        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                          <FileText className="h-4 w-4 shrink-0 text-amber-200" />
                          <span className="truncate">Note</span>
                        </div>
                        <RalphInspectorField
                          label="Text"
                          action={renderExpandFieldButton("Expand", () =>
                            openExpandedEditor({
                              title: "Note text",
                              description:
                                "Edit the note content in a larger workspace.",
                              ariaLabel: "Expanded note text",
                              mode: "text",
                              value: selectedBlock.text,
                              supportsVariables: true,
                              onApply: (text) =>
                                updateBlock(selectedBlock.id, (block) =>
                                  block.type === "NOTE" ? { ...block, text } : block,
                                ),
                            }),
                          )}
                        >
                          <Textarea
                            value={selectedBlock.text}
                            aria-label="Note text"
                            onChange={(event) => {
                              const text = event.target.value;
                              updateBlock(selectedBlock.id, (block) =>
                                block.type === "NOTE" ? { ...block, text } : block,
                              );
                            }}
                            className="min-h-36 border-slate-700 bg-slate-950 text-sm leading-5 text-slate-100 placeholder:text-slate-600"
                            placeholder="Capture rationale, checklist items, risks, or review evidence."
                          />
                        </RalphInspectorField>
                        <label className="grid gap-1.5">
                          <span className="font-medium">Tone</span>
                          <select
                            value={selectedBlock.tone ?? "slate"}
                            aria-label="Note tone"
                            onChange={(event) => {
                              const tone = event.target.value as RalphAnnotationTone;
                              updateBlock(selectedBlock.id, (block) =>
                                block.type === "NOTE" ? { ...block, tone } : block,
                              );
                            }}
                            className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                          >
                            {ANNOTATION_TONES.map((tone) => (
                              <option key={tone} value={tone}>
                                {titleFromId(tone)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="grid gap-1.5">
                          <span className="font-medium">Tags</span>
                          <Input
                            value={(selectedBlock.tags ?? []).join(", ")}
                            aria-label="Note tags"
                            placeholder="manual QA, risk"
                            onChange={(event) => {
                              const tags = event.target.value
                                .split(",")
                                .map((entry) => entry.trim())
                                .filter(Boolean);
                              updateBlock(selectedBlock.id, (block) =>
                                block.type === "NOTE" ? { ...block, tags } : block,
                              );
                            }}
                            className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                          />
                        </label>
                        <label
                          data-ralph-inspector-section="behavior"
                          className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2"
                        >
                          <input
                            type="checkbox"
                            checked={selectedBlock.collapsed ?? false}
                            onChange={(event) => {
                              const collapsed = event.target.checked;
                              updateBlock(selectedBlock.id, (block) =>
                                block.type === "NOTE"
                                  ? { ...block, collapsed }
                                  : block,
                              );
                            }}
                          />
                          Collapsed
                        </label>
                      </div>
                    ) : null}

                    {selectedBlock.type === "GROUP" ? (
                      <div className="grid gap-3 rounded-lg bg-slate-900/25 p-3 text-sm text-slate-100 ring-1 ring-slate-800/60">
                        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                          <LayoutGrid className="h-4 w-4 shrink-0 text-slate-300" />
                          <span className="truncate">Group</span>
                        </div>
                        <RalphInspectorField
                          label="Description"
                          action={renderExpandFieldButton("Expand", () =>
                            openExpandedEditor({
                              title: "Group description",
                              description:
                                "Edit the group description in a larger workspace.",
                              ariaLabel: "Expanded group description",
                              mode: "text",
                              value: selectedBlock.description ?? "",
                              supportsVariables: true,
                              onApply: (description) =>
                                updateBlock(selectedBlock.id, (block) =>
                                  block.type === "GROUP"
                                    ? { ...block, description }
                                    : block,
                                ),
                            }),
                          )}
                        >
                          <Textarea
                            value={selectedBlock.description ?? ""}
                            aria-label="Group description"
                            onChange={(event) => {
                              const description = event.target.value;
                              updateBlock(selectedBlock.id, (block) =>
                                block.type === "GROUP"
                                  ? { ...block, description }
                                  : block,
                              );
                            }}
                            className="min-h-28 border-slate-700 bg-slate-950 text-sm leading-5 text-slate-100 placeholder:text-slate-600"
                            placeholder="Describe the phase, boundary, or intent of this group."
                          />
                        </RalphInspectorField>
                        <label className="grid gap-1.5">
                          <span className="font-medium">Tone</span>
                          <select
                            value={selectedBlock.tone ?? "slate"}
                            aria-label="Group tone"
                            onChange={(event) => {
                              const tone = event.target.value as RalphAnnotationTone;
                              updateBlock(selectedBlock.id, (block) =>
                                block.type === "GROUP" ? { ...block, tone } : block,
                              );
                            }}
                            className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                          >
                            {ANNOTATION_TONES.map((tone) => (
                              <option key={tone} value={tone}>
                                {titleFromId(tone)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div
                          data-ralph-inspector-section="behavior"
                          className="grid gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2"
                        >
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedBlock.collapsed ?? false}
                              onChange={(event) => {
                                const collapsed = event.target.checked;
                                updateBlock(selectedBlock.id, (block) =>
                                  block.type === "GROUP"
                                    ? { ...block, collapsed }
                                    : block,
                                );
                              }}
                            />
                            Collapsed
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedBlock.locked ?? false}
                              onChange={(event) => {
                                const locked = event.target.checked;
                                updateBlock(selectedBlock.id, (block) =>
                                  block.type === "GROUP" ? { ...block, locked } : block,
                                );
                              }}
                            />
                            Locked
                          </label>
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={selectedBlock.moveChildren ?? true}
                              onChange={(event) => {
                                const moveChildren = event.target.checked;
                                updateBlock(selectedBlock.id, (block) =>
                                  block.type === "GROUP"
                                    ? { ...block, moveChildren }
                                    : block,
                                );
                              }}
                            />
                            Move children
                          </label>
                        </div>
                      </div>
                    ) : null}

                    {selectedBlock.type === "END" ? (
                      <label className="grid gap-1.5 text-sm text-slate-200">
                        <span className="font-medium">End Status</span>
                        <select
                          value={selectedBlock.status ?? "success"}
                          aria-label="End status"
                          onChange={(event) => {
                            const status = event.target
                              .value as (typeof END_STATUS_OPTIONS)[number];
                            updateBlock(selectedBlock.id, (block) =>
                              block.type === "END" ? { ...block, status } : block,
                            );
                          }}
                          className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                        >
                          {END_STATUS_OPTIONS.map((status) => (
                            <option key={status} value={status}>
                              {titleFromId(status)}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    {selectedBlock.type === "PROMPT" ||
                    selectedBlock.type === "VALIDATOR" ||
                    selectedBlock.type === "DECISION" ||
                    selectedBlock.type === "INPUT" ||
                    selectedBlock.type === "INTERVIEW" ? (
                      <RalphInspectorField
                        label="Prompt"
                        action={renderExpandFieldButton("Expand", () =>
                          openExpandedEditor({
                            title: "Prompt",
                            description:
                              "Edit the prompt in a larger workspace. Variables are inserted literally.",
                            ariaLabel: "Expanded block prompt",
                            mode: "text",
                            value: getPromptLikeText(selectedBlock),
                            supportsVariables: true,
                            onApply: (prompt) =>
                              updateBlock(selectedBlock.id, (block) =>
                                updatePromptLikeText(block, prompt),
                              ),
                          }),
                        )}
                      >
                        <Textarea
                          value={getPromptLikeText(selectedBlock)}
                          aria-label="Block prompt"
                          onChange={(event) => {
                            const prompt = event.target.value;
                            updateBlock(selectedBlock.id, (block) =>
                              updatePromptLikeText(block, prompt),
                            );
                          }}
                          className="min-h-44 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100 placeholder:text-slate-600"
                          placeholder="Use {{scope:path=ALL}}, {{lastResult}}, {{result:block-id}}, or typed variables."
                        />
                        {getPromptLikeText(selectedBlock).includes("{{") ? (
                          <div className="max-h-28 overflow-auto rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap text-slate-300">
                            {renderPromptHighlight(getPromptLikeText(selectedBlock))}
                          </div>
                        ) : null}
                      </RalphInspectorField>
                    ) : null}

                    {selectedBlock.type === "INPUT" ? (
                      <div className="grid gap-3 rounded-lg bg-slate-900/25 p-3 text-sm text-slate-100 ring-1 ring-slate-800/60">
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="font-semibold">Fields</span>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={addSelectedInputField}
                            className="h-7 rounded-md px-2 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add
                          </Button>
                        </div>
                        <div className="grid gap-3">
                          {selectedBlock.fields.map((field, index) => (
                            <div
                              key={`${field.id}-${index}`}
                              className="grid gap-2 rounded-md border border-slate-800 bg-slate-950 p-3"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
                                  Field {index + 1}
                                </span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  disabled={selectedBlock.fields.length <= 1}
                                  aria-label={`Remove input field ${index + 1}`}
                                  onClick={() =>
                                    updateSelectedInputFields((fields) =>
                                      fields.filter((_, fieldIndex) => fieldIndex !== index),
                                    )
                                  }
                                  className="h-7 w-7 rounded-md text-slate-500 hover:bg-rose-500/10 hover:text-rose-200 disabled:text-slate-700"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                              <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
                                <RalphInspectorField label="ID">
                                  <Input
                                    value={field.id}
                                    aria-label={`Input field ${index + 1} id`}
                                    onChange={(event) =>
                                      updateSelectedInputField(field.id, {
                                        id: event.target.value,
                                      })
                                    }
                                    className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                                  />
                                </RalphInspectorField>
                                <RalphInspectorField label="Type">
                                  <select
                                    value={field.type}
                                    aria-label={`Input field ${index + 1} type`}
                                    onChange={(event) =>
                                      updateSelectedInputField(field.id, {
                                        type: event.target.value as RalphInputFieldType,
                                      })
                                    }
                                    className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                                  >
                                    {INPUT_FIELD_TYPE_OPTIONS.map((option) => (
                                      <option key={option.value} value={option.value}>
                                        {option.label}
                                      </option>
                                    ))}
                                  </select>
                                </RalphInspectorField>
                              </div>
                              <RalphInspectorField label="Label">
                                <Input
                                  value={field.label}
                                  aria-label={`Input field ${index + 1} label`}
                                  onChange={(event) =>
                                    updateSelectedInputField(field.id, {
                                      label: event.target.value,
                                    })
                                  }
                                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                                />
                              </RalphInspectorField>
                              <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
                                <RalphInspectorField label="Placeholder">
                                  <Input
                                    value={field.placeholder ?? ""}
                                    aria-label={`Input field ${index + 1} placeholder`}
                                    onChange={(event) =>
                                      updateSelectedInputField(field.id, {
                                        placeholder: event.target.value,
                                      })
                                    }
                                    className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                                  />
                                </RalphInspectorField>
                                <RalphInspectorField label="Variable">
                                  <Input
                                    value={field.variableName ?? ""}
                                    aria-label={`Input field ${index + 1} variable`}
                                    placeholder={field.id.replace(/-/gu, "_")}
                                    onChange={(event) =>
                                      updateSelectedInputField(field.id, {
                                        variableName: event.target.value,
                                      })
                                    }
                                    className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                                  />
                                </RalphInspectorField>
                              </div>
                              <RalphInspectorField label="Help">
                                <Input
                                  value={field.help ?? ""}
                                  aria-label={`Input field ${index + 1} help`}
                                  onChange={(event) =>
                                    updateSelectedInputField(field.id, {
                                      help: event.target.value,
                                    })
                                  }
                                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                                />
                              </RalphInspectorField>
                              {field.type === "select" ||
                              field.type === "multiselect" ? (
                                <RalphInspectorField label="Options" help="Comma-separated option values.">
                                  <Input
                                    value={(field.options ?? [])
                                      .map((option) => option.value)
                                      .join(", ")}
                                    aria-label={`Input field ${index + 1} options`}
                                    placeholder="low, medium, high"
                                    onChange={(event) =>
                                      updateSelectedInputField(field.id, {
                                        options: event.target.value
                                          .split(",")
                                          .map((entry) => entry.trim())
                                          .filter(Boolean)
                                          .map((value) => ({ value, label: titleFromId(value) })),
                                      })
                                    }
                                    className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                                  />
                                </RalphInspectorField>
                              ) : null}
                              <div className="grid grid-cols-2 gap-2 text-xs text-slate-300">
                                <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-900/40 px-2 py-2">
                                  <input
                                    type="checkbox"
                                    checked={field.required ?? false}
                                    onChange={(event) =>
                                      updateSelectedInputField(field.id, {
                                        required: event.target.checked,
                                      })
                                    }
                                  />
                                  Required
                                </label>
                                <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-900/40 px-2 py-2">
                                  <input
                                    type="checkbox"
                                    checked={field.skippable ?? false}
                                    onChange={(event) =>
                                      updateSelectedInputField(field.id, {
                                        skippable: event.target.checked,
                                      })
                                    }
                                  />
                                  Skippable
                                </label>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
                          <RalphInspectorField label="Submit Label">
                            <Input
                              value={selectedBlock.submitLabel ?? ""}
                              aria-label="Input submit label"
                              placeholder="Continue"
                              onChange={(event) =>
                                updateBlock(selectedBlock.id, (block) =>
                                  block.type === "INPUT"
                                    ? { ...block, submitLabel: event.target.value }
                                    : block,
                                )
                              }
                              className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                            />
                          </RalphInspectorField>
                          <RalphInspectorField label="Cancel Label">
                            <Input
                              value={selectedBlock.cancelLabel ?? ""}
                              aria-label="Input cancel label"
                              placeholder="Cancel"
                              onChange={(event) =>
                                updateBlock(selectedBlock.id, (block) =>
                                  block.type === "INPUT"
                                    ? { ...block, cancelLabel: event.target.value }
                                    : block,
                                )
                              }
                              className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                            />
                          </RalphInspectorField>
                        </div>
                      </div>
                    ) : null}

                    {selectedBlock.type === "INTERVIEW" ? (
                      <div className="grid gap-3 rounded-lg bg-slate-900/25 p-3 text-sm text-slate-100 ring-1 ring-slate-800/60">
                        <RalphInspectorField label="Completion Criteria">
                          <Textarea
                            value={selectedBlock.completionCriteria ?? ""}
                            aria-label="Interview completion criteria"
                            onChange={(event) =>
                              updateBlock(selectedBlock.id, (block) =>
                                block.type === "INTERVIEW"
                                  ? { ...block, completionCriteria: event.target.value }
                                  : block,
                              )
                            }
                            className="min-h-24 border-slate-700 bg-slate-950 text-sm leading-5 text-slate-100"
                          />
                        </RalphInspectorField>
                        <div className={cn("grid gap-2", inspectorThreeColumnClass)}>
                          <RalphInspectorField label="Max Turns">
                            <Input
                              type="number"
                              min={1}
                              max={50}
                              value={selectedBlock.maxTurns ?? 5}
                              aria-label="Interview max turns"
                              onChange={(event) =>
                                updateBlock(selectedBlock.id, (block) =>
                                  block.type === "INTERVIEW"
                                    ? {
                                        ...block,
                                        maxTurns:
                                          Number.parseInt(event.target.value, 10) || 1,
                                      }
                                    : block,
                                )
                              }
                              className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                            />
                          </RalphInspectorField>
                          <RalphInspectorField label="Questions">
                            <Input
                              type="number"
                              min={1}
                              max={10}
                              value={selectedBlock.questionsPerTurn ?? 3}
                              aria-label="Interview questions per turn"
                              onChange={(event) =>
                                updateBlock(selectedBlock.id, (block) =>
                                  block.type === "INTERVIEW"
                                    ? {
                                        ...block,
                                        questionsPerTurn:
                                          Number.parseInt(event.target.value, 10) || 1,
                                      }
                                    : block,
                                )
                              }
                              className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                            />
                          </RalphInspectorField>
                          <RalphInspectorField label="Output Variable">
                            <Input
                              value={selectedBlock.outputVariableName ?? ""}
                              aria-label="Interview output variable"
                              onChange={(event) =>
                                updateBlock(selectedBlock.id, (block) =>
                                  block.type === "INTERVIEW"
                                    ? { ...block, outputVariableName: event.target.value }
                                    : block,
                                )
                              }
                              className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                            />
                          </RalphInspectorField>
                        </div>
                      </div>
                    ) : null}

                    {selectedBlock.type === "DECISION" ? (
                      <div className="grid gap-2 text-sm text-slate-200">
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="font-medium">Decision Labels</span>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              updateSelectedDecisionLabels((labels) => [
                                ...labels,
                                `OPTION_${labels.length + 1}`,
                              ])
                            }
                            className="h-7 rounded-md px-2 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add
                          </Button>
                        </div>
                        <div className="grid gap-1.5">
                          {selectedBlock.labels.map((label, index) => (
                            <div
                              key={`${label}-${index}`}
                              className="flex min-w-0 items-center gap-2"
                            >
                              <Input
                                value={label}
                                aria-label={`Decision label ${index + 1}`}
                                onChange={(event) => {
                                  const nextLabel = event.target.value;
                                  updateSelectedDecisionLabels((labels) =>
                                    labels.map((entry, entryIndex) =>
                                      entryIndex === index ? nextLabel : entry,
                                    ),
                                  );
                                }}
                                className="h-8 min-w-0 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                disabled={selectedBlock.labels.length <= 1}
                                aria-label={`Remove decision label ${index + 1}`}
                                onClick={() =>
                                  updateSelectedDecisionLabels((labels) =>
                                    labels.filter((_, entryIndex) => entryIndex !== index),
                                  )
                                }
                                className="h-8 w-8 shrink-0 rounded-md text-slate-500 hover:bg-rose-500/10 hover:text-rose-200 disabled:text-slate-700"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ))}
                        </div>
                        <div className="text-xs text-slate-500">
                          ERROR is added automatically as a fallback route.
                        </div>
                      </div>
                    ) : null}

                    {selectedBlock.type === "PACK" ? (
                      <div className="grid gap-2 text-sm text-slate-200">
                        <label className="grid gap-1.5">
                          <span className="font-medium">Packs</span>
                          <Input
                            value={selectedBlock.packIds.join(", ")}
                            aria-label="Pack ids"
                            placeholder="pack-a, pack-b"
                            onChange={(event) => {
                              const packIds = event.target.value
                                .split(",")
                                .map((entry) => entry.trim())
                                .filter(Boolean);
                              updateBlock(selectedBlock.id, (block) =>
                                block.type === "PACK"
                                  ? { ...block, packIds }
                                  : block,
                              );
                            }}
                            className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                          />
                        </label>
                        <label className="grid gap-1.5">
                          <span className="font-medium">Propagation</span>
                          <select
                            value={selectedBlock.propagationMode ?? "untilOverridden"}
                            aria-label="Pack propagation"
                            onChange={(event) => {
                              const propagationMode = event.target.value as
                                | "nextBlockOnly"
                                | "untilOverridden";
                              updateBlock(selectedBlock.id, (block) =>
                                block.type === "PACK"
                                  ? { ...block, propagationMode }
                                  : block,
                              );
                            }}
                            className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                          >
                            <option value="untilOverridden">Until overridden</option>
                            <option value="nextBlockOnly">Next block only</option>
                          </select>
                        </label>
                      </div>
                    ) : null}

                    {selectedBlock.type === "MCP_TOOL" ||
                    selectedBlock.type === "MCP_RESOURCE" ||
                    selectedBlock.type === "MCP_PROMPT" ? (
                      <div className="grid gap-3 rounded-lg bg-slate-900/25 p-3 text-sm text-slate-100 ring-1 ring-slate-800/60">
                        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                          <Globe2 className="h-4 w-4 shrink-0 text-violet-300" />
                          <span className="truncate">
                            {selectedBlock.type === "MCP_TOOL"
                              ? "MCP Tool"
                              : selectedBlock.type === "MCP_RESOURCE"
                                ? "MCP Resource"
                                : "MCP Prompt"}
                          </span>
                        </div>
                        <label className="grid gap-1.5">
                          <span className="font-medium">Server</span>
                          <Input
                            value={selectedBlock.serverId}
                            aria-label="MCP server"
                            placeholder="server-id"
                            onChange={(event) => {
                              const serverId = event.target.value;
                              updateBlock(selectedBlock.id, (block) =>
                                block.type === "MCP_TOOL" ||
                                block.type === "MCP_RESOURCE" ||
                                block.type === "MCP_PROMPT"
                                  ? { ...block, serverId }
                                  : block,
                              );
                            }}
                            className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                          />
                        </label>

                        {selectedBlock.type === "MCP_TOOL" ? (
                          <label className="grid gap-1.5">
                            <span className="font-medium">Tool</span>
                            <Input
                              value={selectedBlock.toolName}
                              aria-label="MCP tool name"
                              placeholder="tool-name"
                              onChange={(event) => {
                                const toolName = event.target.value;
                                updateBlock(selectedBlock.id, (block) =>
                                  block.type === "MCP_TOOL"
                                    ? { ...block, toolName }
                                    : block,
                                );
                              }}
                              className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                            />
                          </label>
                        ) : null}

                        {selectedBlock.type === "MCP_RESOURCE" ? (
                          <label className="grid gap-1.5">
                            <span className="font-medium">Resource URI</span>
                            <Input
                              value={selectedBlock.uri}
                              aria-label="MCP resource URI"
                              placeholder="resource://name"
                              onChange={(event) => {
                                const uri = event.target.value;
                                updateBlock(selectedBlock.id, (block) =>
                                  block.type === "MCP_RESOURCE"
                                    ? { ...block, uri }
                                    : block,
                                );
                              }}
                              className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                            />
                          </label>
                        ) : null}

                        {selectedBlock.type === "MCP_PROMPT" ? (
                          <label className="grid gap-1.5">
                            <span className="font-medium">Prompt</span>
                            <Input
                              value={selectedBlock.promptName}
                              aria-label="MCP prompt name"
                              placeholder="prompt-name"
                              onChange={(event) => {
                                const promptName = event.target.value;
                                updateBlock(selectedBlock.id, (block) =>
                                  block.type === "MCP_PROMPT"
                                    ? { ...block, promptName }
                                    : block,
                                );
                              }}
                              className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                            />
                          </label>
                        ) : null}

                        {selectedBlock.type === "MCP_TOOL" ||
                        selectedBlock.type === "MCP_PROMPT" ? (
                          <label className="grid gap-1.5">
                            <span className="font-medium">Arguments JSON</span>
                            <Textarea
                              key={`${selectedBlock.id}-mcp-arguments`}
                              defaultValue={formatJsonDraft(
                                selectedBlock.arguments ?? {},
                              )}
                              aria-label="MCP arguments JSON"
                              onBlur={(event) =>
                                updateSelectedMcpArguments(event.target.value)
                              }
                              className="min-h-24 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
                            />
                          </label>
                        ) : null}
                      </div>
                    ) : null}

                    {selectedBlock.type === "VALIDATOR" ? (
                      <div className="grid gap-2 text-sm text-slate-200">
                        <label className="grid gap-1.5">
                          <span className="font-medium">Validation Scope</span>
                          <select
                            value={selectedBlock.validationScope?.mode ?? "sinceLastValidator"}
                            aria-label="Validation scope"
                            onChange={(event) => {
                              const mode = event.target
                                .value as RalphValidationScope["mode"];
                              updateSelectedValidatorScope((scope) => ({
                                ...scope,
                                mode,
                                blockIds:
                                  mode === "selectedBlocks"
                                    ? scope.blockIds ?? []
                                    : scope.blockIds,
                              }));
                            }}
                            className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                          >
                            {VALIDATION_SCOPE_OPTIONS.map((mode) => (
                              <option key={mode} value={mode}>
                                {formatValidationScopeLabel(mode)}
                              </option>
                            ))}
                          </select>
                        </label>

                        {selectedBlock.validationScope?.mode === "selectedBlocks" ? (
                          <div className="grid gap-1.5 rounded-md border border-slate-800 bg-slate-950 p-2">
                            {draftFlow?.blocks
                              .filter((block) => block.id !== selectedBlock.id)
                              .map((block) => {
                                const checked = (
                                  selectedBlock.validationScope?.blockIds ?? []
                                ).includes(block.id);

                                return (
                                  <label
                                    key={block.id}
                                    className="flex min-w-0 items-center gap-2 text-xs text-slate-300"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(event) => {
                                        const enabled = event.target.checked;
                                        updateSelectedValidatorScope((scope) => {
                                          const currentIds = scope.blockIds ?? [];
                                          const blockIds = enabled
                                            ? [...new Set([...currentIds, block.id])]
                                            : currentIds.filter((id) => id !== block.id);

                                          return {
                                            ...scope,
                                            mode: "selectedBlocks",
                                            blockIds,
                                          };
                                        });
                                      }}
                                    />
                                    <span className="min-w-0 truncate">
                                      {block.title} [{block.type}]
                                    </span>
                                  </label>
                                );
                              })}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {isExecutableRalphCanvasBlock(selectedBlock) ? (
                      <div
                        data-ralph-inspector-section="behavior"
                        className="grid gap-2 rounded-lg bg-slate-900/25 p-3 text-sm text-slate-100 ring-1 ring-slate-800/60"
                      >
                        <div className="text-xs font-semibold tracking-[0.12em] text-slate-400 uppercase">
                          Behavior
                        </div>
                        <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2">
                          <input
                            type="checkbox"
                            checked={selectedBlock.groupBoundary ?? false}
                            onChange={(event) => {
                              const groupBoundary = event.target.checked;
                              updateBlock(selectedBlock.id, (block) => ({
                                ...block,
                                groupBoundary,
                              }));
                            }}
                          />
                          Group boundary
                        </label>
                      </div>
                    ) : null}

                    {selectedBlock.type === "UTILITY" ? renderUtilitySettings() : null}

                    {selectedBlockUsesAgentSettings ? (
                      <div
                        data-ralph-inspector-section="execution"
                        className="grid gap-3 rounded-lg bg-slate-900/25 p-3 ring-1 ring-slate-800/60"
                      >
                        <div className="grid gap-3 md:grid-cols-3">
                          <label className="grid gap-1.5 text-sm text-slate-200">
                            <span className="font-medium">Provider</span>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  aria-label="Block provider"
                                  className="h-9 min-w-0 justify-between rounded-md border-slate-700 bg-slate-950 px-3 text-sm font-medium text-slate-100 shadow-none hover:border-slate-600 hover:bg-slate-900"
                                >
                                  <span className="min-w-0 truncate">
                                    {formatProviderOptionLabel(
                                      selectedBlockProviderOption,
                                    )}
                                  </span>
                                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="start"
                                sideOffset={5}
                                className="z-[90] min-w-[var(--radix-dropdown-menu-trigger-width)] rounded-md border border-slate-700 bg-slate-950 p-1 text-slate-100 shadow-xl shadow-black/30"
                              >
                                {selectedBlockProviderOptions.map((provider) => {
                                  const active =
                                    selectedBlockProviderOption === provider;

                                  return (
                                    <DropdownMenuItem
                                      key={provider}
                                      onSelect={() => {
                                        const providerModel =
                                          provider === "default"
                                            ? "default"
                                            : getPreferredModelForProvider(
                                                provider,
                                                modelCatalog,
                                              );
                                        const effectiveProvider =
                                          getEffectiveProvider(
                                            provider,
                                            activeProvider,
                                          );
                                        const effectiveModel =
                                          providerModel === "default"
                                            ? activeModel
                                            : providerModel;

                                        updateSelectedBlockSettings({
                                          provider,
                                          model: providerModel,
                                          reasoning:
                                            normalizeReasoningModeForProvider(
                                              selectedBlock.settings
                                                ?.reasoning ?? "default",
                                              effectiveProvider,
                                              effectiveModel,
                                            ),
                                        });
                                      }}
                                      className={cn(
                                        "flex min-w-0 cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 text-xs font-medium outline-none focus:bg-sky-500/15 focus:text-sky-100",
                                        active
                                          ? "bg-sky-500/10 text-sky-100"
                                          : "text-slate-300",
                                      )}
                                    >
                                      <span className="min-w-0 truncate">
                                        {formatProviderOptionLabel(provider)}
                                      </span>
                                      {active ? (
                                        <Check className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                                      ) : null}
                                    </DropdownMenuItem>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </label>
                          <label className="grid gap-1.5 text-sm text-slate-200">
                            <span className="font-medium">Model</span>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  aria-label="Block model"
                                  className="h-9 min-w-0 justify-between rounded-md border-slate-700 bg-slate-950 px-3 text-sm font-medium text-slate-100 shadow-none hover:border-slate-600 hover:bg-slate-900"
                                >
                                  <span className="min-w-0 truncate">
                                    {selectedBlockModelLabel}
                                  </span>
                                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="start"
                                sideOffset={5}
                                className="z-[90] min-w-[var(--radix-dropdown-menu-trigger-width)] rounded-md border border-slate-700 bg-slate-950 p-1 text-slate-100 shadow-xl shadow-black/30"
                              >
                                {selectedBlockProviderOption === "default" ? (
                                  <DropdownMenuItem
                                    onSelect={() => {
                                      updateSelectedBlockSettings({
                                        model: "default",
                                        reasoning:
                                          normalizeReasoningModeForProvider(
                                            selectedBlock.settings
                                              ?.reasoning ?? "default",
                                            selectedBlockEffectiveProvider,
                                            activeModel,
                                          ),
                                      });
                                    }}
                                    className={cn(
                                      "flex min-w-0 cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 text-xs font-medium outline-none focus:bg-sky-500/15 focus:text-sky-100",
                                      selectedBlockModelValue === "default"
                                        ? "bg-sky-500/10 text-sky-100"
                                        : "text-slate-300",
                                    )}
                                  >
                                    <span className="min-w-0 truncate">
                                      Default ({activeModelLabel})
                                    </span>
                                    {selectedBlockModelValue === "default" ? (
                                      <Check className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                                    ) : null}
                                  </DropdownMenuItem>
                                ) : null}
                                {selectedBlockModelOptions.map((model) => {
                                  const active =
                                    selectedBlockModelValue === model.id;

                                  return (
                                    <DropdownMenuItem
                                      key={model.id}
                                      onSelect={() => {
                                        updateSelectedBlockSettings({
                                          model: model.id,
                                          reasoning:
                                            normalizeReasoningModeForProvider(
                                              selectedBlock.settings
                                                ?.reasoning ?? "default",
                                              selectedBlockEffectiveProvider,
                                              model.id,
                                            ),
                                        });
                                      }}
                                      className={cn(
                                        "flex min-w-0 cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 text-xs font-medium outline-none focus:bg-sky-500/15 focus:text-sky-100",
                                        active
                                          ? "bg-sky-500/10 text-sky-100"
                                          : "text-slate-300",
                                      )}
                                    >
                                      <span className="min-w-0 truncate">
                                        {model.label}
                                      </span>
                                      {active ? (
                                        <Check className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                                      ) : null}
                                    </DropdownMenuItem>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </label>
                          <label className="grid gap-1.5 text-sm text-slate-200">
                            <span className="font-medium">Reasoning</span>
                            <select
                              value={selectedBlockReasoningValue}
                              aria-label="Block reasoning"
                              onChange={(event) =>
                                updateSelectedBlockSettings({
                                  reasoning: event.target.value as ReasoningMode,
                                })
                              }
                              className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none focus:border-slate-500"
                            >
                              {selectedBlockReasoningOptions.map((reasoning) => (
                                <option key={reasoning} value={reasoning}>
                                  {REASONING_LABELS[reasoning]}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>

                        <label className="grid gap-1.5 text-sm text-slate-200">
                          <span className="font-medium">Workspace</span>
                          <Input
                            value={
                              selectedBlock.settings?.workspace?.mode === "custom"
                                ? selectedBlock.settings.workspace.path ?? ""
                                : ""
                            }
                            aria-label="Block workspace"
                            placeholder="Default"
                            onChange={(event) => {
                              const path = event.target.value;
                              updateSelectedBlockSettings({
                                workspace: path.trim()
                                  ? { mode: "custom", path }
                                  : { mode: "default" },
                              });
                            }}
                            className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                          />
                        </label>

                        <div className="grid grid-cols-2 gap-2 text-sm text-slate-200">
                          <label className="flex items-center gap-2 px-1 py-1">
                            <input
                              type="checkbox"
                              checked={selectedBlock.settings?.webAccess ?? true}
                              onChange={(event) => {
                                updateSelectedBlockSettings({
                                  webAccess: event.target.checked,
                                });
                              }}
                            />
                            Web
                          </label>
                          <label className="flex items-center gap-2 px-1 py-1">
                            <input
                              type="checkbox"
                              checked={selectedBlock.settings?.fileAccess ?? true}
                              onChange={(event) => {
                                updateSelectedBlockSettings({
                                  fileAccess: event.target.checked,
                                });
                              }}
                            />
                            Files
                          </label>
                        </div>

                        <div className="grid gap-2 rounded-lg bg-slate-950/35 p-3 ring-1 ring-slate-800/55">
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm font-medium text-slate-200">
                              Attachments
                            </span>
                            <ContextAttachmentMenuButton
                              buttonLabel="Add block attachment"
                              buttonTitle="Add block attachment"
                              onSelectFiles={() =>
                                handleSelectBlockAttachments("files")
                              }
                              onSelectFolders={() =>
                                handleSelectBlockAttachments("folders")
                              }
                              onSelectImages={() =>
                                handleSelectBlockAttachments("images")
                              }
                              imageInputDisabled={!selectedBlockImageInputSupported}
                              imageInputDisabledReason={
                                selectedBlockImageInputDisabledReason
                              }
                              menuSide="bottom"
                              className="h-8 w-8 rounded-md border-slate-700 bg-slate-900 text-slate-300 shadow-none hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100"
                              iconClassName="h-3.5 w-3.5"
                            />
                          </div>

                          {selectedBlockPathAttachments.length > 0 ? (
                            <ContextAttachmentsList
                              attachments={selectedBlockPathAttachments}
                              onRemove={removeSelectedBlockPathAttachment}
                              onClearAll={clearSelectedBlockPathAttachments}
                              compact
                            />
                          ) : (
                            <div className="text-xs text-slate-500">
                              No files selected.
                            </div>
                          )}

                          <div className="grid gap-2 rounded-md bg-slate-950/50 p-2 ring-1 ring-slate-800/50">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
                                Variables
                              </span>
                              <Button
                                type="button"
                                variant="ghost"
                                onClick={addSelectedBlockVariableAttachment}
                                className="h-7 rounded-md px-2 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100"
                              >
                                <Plus className="h-3.5 w-3.5" />
                                Add
                              </Button>
                            </div>

                            {selectedBlockVariableAttachmentItems.length > 0 ? (
                              <div className="grid gap-1.5">
                                {selectedBlockVariableAttachmentItems.map(
                                  ({ attachment, key }, index) => (
                                    <div
                                      key={key}
                                      className="flex min-w-0 items-center gap-2"
                                    >
                                      <Input
                                        value={attachment.value}
                                        aria-label={`Variable attachment ${index + 1}`}
                                        placeholder="{{reference_image:image}}"
                                        onChange={(event) => {
                                          updateSelectedBlockVariableAttachment(
                                            key,
                                            event.target.value,
                                          );
                                        }}
                                        className="h-8 min-w-0 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                                      />
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        aria-label={`Remove variable attachment ${index + 1}`}
                                        onClick={() =>
                                          removeSelectedBlockVariableAttachment(key)
                                        }
                                        className="h-8 w-8 shrink-0 rounded-md p-0 text-slate-500 hover:bg-rose-500/10 hover:text-rose-200"
                                      >
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </Button>
                                    </div>
                                  ),
                                )}
                              </div>
                            ) : (
                              <div className="text-xs text-slate-500">
                                No variable attachments.
                              </div>
                            )}
                          </div>
                        </div>

                        <div data-ralph-inspector-section="advanced">
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              setShowAdvancedSettings((current) => !current)
                            }
                            className="h-8 justify-start rounded-lg px-2 text-xs text-slate-300 hover:bg-slate-800 hover:text-white"
                          >
                            <SlidersHorizontal className="h-3.5 w-3.5" />
                            {showAdvancedSettings ? "Hide More" : "Show More"}
                          </Button>
                        </div>

                        {showAdvancedSettings ? (
                          <div className="grid gap-3">
                            <div className="grid grid-cols-3 gap-2">
                              <label className="grid gap-1.5 text-sm text-slate-200">
                                <span className="font-medium">Iterations</span>
                                <Input
                                  type="number"
                                  min={1}
                                  max={100}
                                  value={selectedBlock.settings?.maxIterations ?? 1}
                                  aria-label="Max iterations"
                                  onChange={(event) => {
                                    updateSelectedBlockSettings({
                                      maxIterations:
                                        Number.parseInt(event.target.value, 10) || 1,
                                    });
                                  }}
                                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                                />
                              </label>
                              <label className="grid gap-1.5 text-sm text-slate-200">
                                <span className="font-medium">Timeout</span>
                                <Input
                                  type="number"
                                  min={0}
                                  value={selectedBlock.settings?.timeoutSeconds ?? ""}
                                  aria-label="Timeout seconds"
                                  onChange={(event) => {
                                    updateSelectedBlockSettings({
                                      timeoutSeconds: event.target.value
                                        ? Number.parseInt(event.target.value, 10)
                                        : null,
                                    });
                                  }}
                                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                                />
                              </label>
                              <label className="grid gap-1.5 text-sm text-slate-200">
                                <span className="font-medium">Temp</span>
                                <Input
                                  type="number"
                                  step="0.1"
                                  min={0}
                                  max={2}
                                  value={selectedBlock.settings?.temperature ?? ""}
                                  aria-label="Temperature"
                                  onChange={(event) => {
                                    updateSelectedBlockSettings({
                                      temperature: event.target.value
                                        ? Number.parseFloat(event.target.value)
                                        : null,
                                    });
                                  }}
                                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                                />
                              </label>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                              <label className="grid gap-1.5 text-sm text-slate-200">
                                <span className="font-medium">Retry</span>
                                <select
                                  value={selectedBlock.settings?.retry?.mode ?? "infinite"}
                                  aria-label="Retry mode"
                                  onChange={(event) => {
                                    updateSelectedBlockSettings({
                                      retry: {
                                        ...(selectedBlock.settings?.retry ?? {
                                          mode: "infinite",
                                        }),
                                        mode: event.target.value as
                                          | "infinite"
                                          | "finite",
                                      },
                                    });
                                  }}
                                  className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                                >
                                  <option value="infinite">infinite</option>
                                  <option value="finite">finite</option>
                                </select>
                              </label>
                              <label className="grid gap-1.5 text-sm text-slate-200">
                                <span className="font-medium">Max</span>
                                <Input
                                  type="number"
                                  min={0}
                                  value={selectedBlock.settings?.retry?.maxRetries ?? ""}
                                  aria-label="Max retries"
                                  onChange={(event) => {
                                    updateSelectedBlockSettings({
                                      retry: {
                                        ...(selectedBlock.settings?.retry ?? {
                                          mode: "finite",
                                        }),
                                        maxRetries: event.target.value
                                          ? Number.parseInt(event.target.value, 10)
                                          : null,
                                      },
                                    });
                                  }}
                                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                                />
                              </label>
                            </div>

                            <label className="flex items-center gap-2 px-1 py-1 text-sm text-slate-200">
                              <input
                                type="checkbox"
                                checked={
                                  selectedBlock.settings?.internalValidatorEnabled ??
                                  false
                                }
                                onChange={(event) => {
                                  updateSelectedBlockSettings({
                                    internalValidatorEnabled: event.target.checked,
                                  });
                                }}
                              />
                              Internal validator
                            </label>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div
                      data-ralph-inspector-section="routes"
                      className="grid gap-3 rounded-lg bg-slate-900/25 p-3 ring-1 ring-slate-800/60"
                    >
                      <div className="text-xs font-semibold tracking-[0.12em] text-slate-400 uppercase">
                        Routes
                      </div>
                      {renderSelectedRouteSummary()}
                      {selectedBlockOutputs.length === 0 ? (
                        <div className="text-xs text-slate-500">
                          END blocks do not route further.
                        </div>
                      ) : (
                        selectedBlockOutputs.map((output) => {
                          const edge = selectedRoutesByOutput.get(output);
                          const unconnectedLabel = formatUnconnectedRouteLabel(
                            selectedBlock,
                            output,
                          );
                          const selectedRouteTarget = edge
                            ? selectedRouteTargets.find(
                                (target) => target.id === edge.to,
                              ) ?? null
                            : null;
                          const routeTargetLabel = edge
                            ? selectedRouteTarget
                              ? formatRouteOptionTargetLabel(
                                  selectedBlock,
                                  selectedRouteTarget,
                                )
                              : `${edge.to} (missing)`
                            : unconnectedLabel;
                          const routeOptions = [
                            {
                              id: "",
                              label: unconnectedLabel,
                              type: "none" as const,
                            },
                            ...selectedRouteTargets.map((target) => ({
                              id: target.id,
                              label: formatRouteOptionTargetLabel(
                                selectedBlock,
                                target,
                              ),
                              type: target.type,
                            })),
                          ];

                          return (
                          <div
                            key={output}
                            className="grid gap-1.5 rounded-md bg-slate-950/55 p-2 text-xs text-slate-300 ring-1 ring-slate-800/55"
                          >
                            <div className="flex min-w-0 items-center justify-between gap-2">
                              <span className="min-w-0 truncate font-semibold text-slate-200">
                                {output}
                              </span>
                              {edge ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Remove ${output} route`}
                                  title={`Remove ${output} route`}
                                  onClick={() => removeEdge(edge.id)}
                                  className="h-6 w-6 rounded text-slate-500 hover:bg-red-500/10 hover:text-red-200"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              ) : null}
                            </div>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  aria-label={`${output} route target`}
                                  className={cn(
                                    "h-8 min-w-0 justify-between rounded-md border px-2 text-xs font-medium shadow-none",
                                    edge
                                      ? "border-slate-700 bg-slate-950 text-slate-100 hover:border-slate-600 hover:bg-slate-900"
                                      : "border-amber-400/35 bg-amber-500/10 text-amber-100 hover:border-amber-300/50 hover:bg-amber-500/15",
                                  )}
                                >
                                  <span className="min-w-0 truncate">
                                    {routeTargetLabel}
                                  </span>
                                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="start"
                                sideOffset={5}
                                className="z-[90] min-w-[var(--radix-dropdown-menu-trigger-width)] rounded-md border border-slate-700 bg-slate-950 p-1 text-slate-100 shadow-xl shadow-black/30"
                              >
                                {routeOptions.map((option) => {
                                  const active = (edge?.to ?? "") === option.id;

                                  return (
                                    <DropdownMenuItem
                                      key={option.id || "unconnected"}
                                      onSelect={() => {
                                        setRouteTarget(
                                          selectedBlock.id,
                                          output,
                                          option.id,
                                        );
                                      }}
                                      className={cn(
                                        "flex min-w-0 cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 text-xs outline-none focus:bg-emerald-500/15 focus:text-emerald-100",
                                        active
                                          ? "bg-emerald-500/10 text-emerald-100"
                                          : "text-slate-300",
                                        option.id
                                          ? "font-medium"
                                          : "text-amber-100",
                                      )}
                                    >
                                      <span className="min-w-0 truncate">
                                        {option.label}
                                      </span>
                                      {active ? (
                                        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                                      ) : null}
                                    </DropdownMenuItem>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                ) : selectedEdge ? (
                  <div className="grid gap-4 p-4 pr-5 pb-8">
                    {(() => {
                      const sourceBlock =
                        draftFlow?.blocks.find(
                          (block) => block.id === selectedEdge.from,
                        ) ?? null;
                      const targetBlock =
                        draftFlow?.blocks.find(
                          (block) => block.id === selectedEdge.to,
                        ) ?? null;
                      const routeTargets = draftFlow
                        ? getSelectableRouteTargets(draftFlow)
                        : [];

                      return (
                        <>
                          <div className="grid gap-2 text-sm">
                            <div className="text-xs font-semibold tracking-[0.12em] text-slate-400 uppercase">
                              Route
                            </div>
                            <div className="grid gap-1.5 rounded-lg bg-slate-950/60 px-3 py-2 text-xs ring-1 ring-slate-800/60">
                              <div className="flex min-w-0 justify-between gap-3">
                                <span className="text-slate-500">From</span>
                                <span className="min-w-0 truncate font-medium text-slate-200">
                                  {sourceBlock
                                    ? formatRouteTargetLabel(sourceBlock)
                                    : selectedEdge.from}
                                </span>
                              </div>
                              <div className="flex min-w-0 justify-between gap-3">
                                <span className="text-slate-500">Output</span>
                                <span className="min-w-0 truncate font-medium text-slate-200">
                                  {selectedEdge.fromOutput}
                                </span>
                              </div>
                            </div>
                          </div>

                          <label className="grid gap-1.5 text-sm text-slate-200">
                            <span className="font-medium">Target</span>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  type="button"
                                  variant="outline"
                                  aria-label="Selected route target"
                                  className="h-9 min-w-0 justify-between rounded-md border-slate-700 bg-slate-950 px-3 text-sm font-medium text-slate-100 shadow-none hover:border-slate-600 hover:bg-slate-900"
                                >
                                  <span className="min-w-0 truncate">
                                    {targetBlock
                                      ? formatRouteTargetLabel(targetBlock)
                                      : `${selectedEdge.to} (missing)`}
                                  </span>
                                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="start"
                                sideOffset={5}
                                className="z-[90] min-w-[var(--radix-dropdown-menu-trigger-width)] rounded-md border border-slate-700 bg-slate-950 p-1 text-slate-100 shadow-xl shadow-black/30"
                              >
                                {routeTargets.map((target) => {
                                  const active = target.id === selectedEdge.to;

                                  return (
                                    <DropdownMenuItem
                                      key={target.id}
                                      onSelect={() =>
                                        setRouteTarget(
                                          selectedEdge.from,
                                          selectedEdge.fromOutput,
                                          target.id,
                                        )
                                      }
                                      className={cn(
                                        "flex min-w-0 cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 text-xs font-medium outline-none focus:bg-emerald-500/15 focus:text-emerald-100",
                                        active
                                          ? "bg-emerald-500/10 text-emerald-100"
                                          : "text-slate-300",
                                      )}
                                    >
                                      <span className="min-w-0 truncate">
                                        {sourceBlock
                                          ? formatRouteOptionTargetLabel(
                                              sourceBlock,
                                              target,
                                            )
                                          : formatRouteTargetLabel(target)}
                                      </span>
                                      {active ? (
                                        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                                      ) : null}
                                    </DropdownMenuItem>
                                  );
                                })}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </label>

                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => removeEdge(selectedEdge.id)}
                            className="h-9 justify-self-start rounded-lg border-rose-400/30 bg-rose-500/10 px-3 text-xs text-rose-100 hover:bg-rose-500/15 hover:text-white"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Remove route
                          </Button>
                        </>
                      );
                    })()}
                  </div>
                ) : (
                  <div className="grid gap-4 p-4 pr-5 pb-8">
                    {draftFlow ? (
                      <>
                        <div className="grid gap-3">
                          <div className="text-xs font-semibold tracking-[0.12em] text-slate-400 uppercase">
                            Flow
                          </div>
                          <label className="grid gap-1.5 text-sm text-slate-200">
                            <span className="font-medium">Alias</span>
                            <Input
                              value={draftFlow.alias ?? ""}
                              aria-label="Flow alias"
                              placeholder="flow-alias"
                              onChange={(event) => {
                                const alias = createFlowAlias(event.target.value);
                                updateDraftFlow((flow) => ({
                                  ...flow,
                                  ...(alias ? { alias } : { alias: undefined }),
                                }));
                              }}
                              className="h-9 border-slate-700 bg-slate-950 font-mono text-sm text-slate-100"
                            />
                          </label>
                          <label className="grid gap-1.5 text-sm text-slate-200">
                            <span className="font-medium">Name</span>
                            <Input
                              value={draftFlow.name}
                              aria-label="Flow name"
                              onChange={(event) => {
                                const name = event.target.value;
                                updateDraftFlow((flow) => ({
                                  ...flow,
                                  name,
                                }));
                              }}
                              className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                            />
                          </label>
                          <label className="grid gap-1.5 text-sm text-slate-200">
                            <span className="font-medium">Description</span>
                            <Textarea
                              value={draftFlow.description ?? ""}
                              aria-label="Flow description"
                              onChange={(event) => {
                                const description = event.target.value;
                                updateDraftFlow((flow) => ({
                                  ...flow,
                                  description,
                                }));
                              }}
                              className="min-h-20 border-slate-700 bg-slate-950 text-sm text-slate-100"
                            />
                          </label>
                          <label className="grid gap-1.5 text-sm text-slate-200">
                            <span className="font-medium">Max Transitions</span>
                            <Input
                              type="number"
                              min={1}
                              step={1}
                              value={draftFlow.settings?.maxTransitions ?? ""}
                              aria-label="Flow max transitions"
                              placeholder="Unlimited"
                              onChange={(event) => {
                                const rawValue = event.target.value.trim();
                                updateDraftFlow((flow) => {
                                  const settings = { ...(flow.settings ?? {}) };

                                  if (rawValue) {
                                    settings.maxTransitions = Number.parseInt(
                                      rawValue,
                                      10,
                                    );
                                  } else {
                                    delete settings.maxTransitions;
                                  }

                                  if (Object.keys(settings).length > 0) {
                                    return { ...flow, settings };
                                  }

                                  const flowWithoutSettings: RalphFlow = { ...flow };
                                  delete flowWithoutSettings.settings;
                                  return flowWithoutSettings;
                                });
                              }}
                              className="h-9 border-slate-700 bg-slate-950 font-mono text-sm text-slate-100"
                            />
                          </label>
                        </div>

                        <div className="grid gap-2 rounded-lg bg-slate-900/25 p-3 ring-1 ring-slate-800/60">
                          <div className="text-xs font-semibold tracking-[0.12em] text-slate-400 uppercase">
                            Variables
                          </div>
                          {(draftFlow.variables ?? []).length > 0 ? (
                            <div className="grid gap-1">
                              {(draftFlow.variables ?? []).map((variable) => (
                                <div
                                  key={variable.name}
                                  className="flex min-w-0 items-center justify-between gap-2 border-b border-slate-800/70 py-1.5 text-xs last:border-b-0"
                                >
                                  <span className="min-w-0 truncate font-medium text-slate-200">
                                    {variable.name}
                                  </span>
                                  <span className="shrink-0 text-slate-500">
                                    {variable.type}
                                    {variable.required ? " required" : ""}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-xs text-slate-500">
                              Add variables with placeholders like {"{{scope:path=ALL}}"}.
                            </div>
                          )}
                        </div>

                        <div className="grid gap-2 rounded-lg bg-slate-900/25 p-3 ring-1 ring-slate-800/60">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-xs font-semibold tracking-[0.12em] text-slate-400 uppercase">
                              <History className="h-3.5 w-3.5 text-slate-400" />
                              History
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              disabled={
                                revisionsLoading ||
                                loading ||
                                !selectedId ||
                                selectedFlowUnsaved
                              }
                              aria-label="Refresh Ralph revisions"
                              title="Refresh Ralph revisions"
                              onClick={() =>
                                void refreshRevisions(selectedId, selectedScope)
                              }
                              className="h-7 w-7 rounded-lg text-slate-500 hover:bg-slate-900 hover:text-slate-100"
                            >
                              <RefreshCw
                                className={cn(
                                  "h-3.5 w-3.5",
                                  revisionsLoading && "animate-spin",
                                )}
                              />
                            </Button>
                          </div>
                          {selectedFlowUnsaved ? (
                            <div className="text-xs text-slate-500">
                              Save this draft to start history.
                            </div>
                          ) : revisionsLoading ? (
                            <div className="flex items-center gap-2 text-xs text-slate-400">
                              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                              Loading revisions.
                            </div>
                          ) : revisions.length === 0 ? (
                            <div className="text-xs text-slate-500">
                              No revisions yet.
                            </div>
                          ) : (
                            <div className="grid gap-2">
                              {revisions.slice(0, 6).map((revision) => (
                                <div
                                  key={revision.id}
                                  className="flex min-w-0 items-center justify-between gap-2 border-b border-slate-800/70 py-2 text-xs last:border-b-0"
                                >
                                  <div className="min-w-0">
                                    <div className="truncate font-semibold text-slate-200">
                                      {formatRevisionDate(revision.createdAt)}
                                    </div>
                                    <div className="truncate text-slate-500">
                                      {revision.blockCount} blocks / {revision.edgeCount} routes
                                    </div>
                                  </div>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    disabled={loading || dirty}
                                    aria-label={`Restore revision ${revision.id}`}
                                    title={
                                      dirty
                                        ? "Save or discard changes first"
                                        : `Restore ${revision.id}`
                                    }
                                    onClick={() => void restoreRevision(revision.id)}
                                    className="h-7 w-7 shrink-0 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
                                  >
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="grid gap-2 text-sm text-slate-500">
                        <div>No flow selected.</div>
                        <div className="text-xs text-slate-600">
                          New and generated flows will show editable settings here.
                        </div>
                      </div>
                    )}
                  </div>
                )}
                </div>
                <div
                  className={cn(
                    "pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-slate-950 to-transparent transition-opacity",
                    inspectorScrollState.atBottom ? "opacity-0" : "opacity-100",
                  )}
                />
              </div>
              <div className="border-t border-slate-800 bg-slate-950/95 px-4 py-3">
                <div className="flex min-w-0 items-center justify-between gap-3">
                  <div className="min-w-0 text-xs">
                    <div
                      className={cn(
                        "truncate font-medium",
                        dirty
                          ? "text-amber-100"
                          : hasBlockingIssues
                            ? "text-rose-100"
                            : "text-slate-400",
                      )}
                    >
                      {dirty
                        ? "Unsaved changes"
                        : hasBlockingIssues
                          ? `${errorCount} validation error${errorCount === 1 ? "" : "s"}`
                          : runBlockedReason
                            ? "Run blocked"
                            : "Ready"}
                    </div>
                    <div className="truncate text-slate-600">
                      {selectedBlock && selectedBlockOutputs.length > 0
                        ? `${connectedSelectedRouteCount}/${selectedBlockOutputs.length} routes connected`
                        : selectedBlock
                          ? selectedBlock.type
                          : selectedEdge
                            ? "Route selected"
                            : draftFlow
                              ? `${draftFlow.blocks.length} blocks`
                              : "No flow selected"}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      disabled={!canSaveFlow}
                      onClick={() => void saveFlow()}
                      className="h-8 rounded-lg bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-500 disabled:border disabled:border-slate-800 disabled:bg-slate-900 disabled:text-slate-500"
                    >
                      <Save className="h-3.5 w-3.5" />
                      Save
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!canRunFlow}
                      aria-label="Run Ralph flow"
                      onClick={() => void runFlow()}
                      className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs text-slate-100 hover:bg-slate-800 hover:text-white"
                    >
                      <Play className="h-3.5 w-3.5" />
                      Run
                    </Button>
                  </div>
                </div>
              </div>
            </aside>
            ) : null}

            {editorMode === "design" ? (
              <section
                className={cn(
                  "row-start-2 grid min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] border-t border-slate-800 bg-slate-950",
                  bottomPanelSpanClass,
                )}
              >
                <button
                  type="button"
                  onClick={() => setEditorMode("generate")}
                  className="grid min-h-0 gap-1 border-r border-slate-800 px-4 py-2 text-left hover:bg-slate-900/60"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-white">
                    <Sparkles className="h-4 w-4 text-emerald-300" />
                    AI Flow Changes
                  </span>
                  <span className="truncate text-xs text-slate-500">
                    Flow / Improve / Prompt
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditorMode("review")}
                  className="grid min-h-0 gap-1 border-r border-slate-800 px-4 py-2 text-left hover:bg-slate-900/60"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-white">
                    <AlertTriangle className="h-4 w-4 text-amber-300" />
                    Validation
                  </span>
                  <span
                    className={cn(
                      "truncate text-xs",
                      issues.length > 0 ? "text-amber-200" : "text-slate-500",
                    )}
                  >
                    {issues.length > 0
                      ? `${errorCount} error${errorCount === 1 ? "" : "s"} / ${warningCount} warning${warningCount === 1 ? "" : "s"}`
                      : "No local warnings."}
                  </span>
                </button>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setEditorMode("run")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setEditorMode("run");
                    }
                  }}
                  className="grid min-h-0 cursor-pointer gap-1 px-4 py-2 hover:bg-slate-900/60"
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2 text-left text-sm font-semibold text-white">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-lime-300" />
                      <span className="truncate">Run</span>
                    </div>
                    {runBlockedReason === "Save flow before running." && canSaveFlow ? (
                      <Button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void saveFlow();
                        }}
                        className="h-7 rounded-lg bg-emerald-600 px-2 text-xs text-white hover:bg-emerald-500"
                      >
                        <Save className="h-3.5 w-3.5" />
                        Save
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!canRunFlow}
                        aria-label="Run Ralph flow"
                        onClick={(event) => {
                          event.stopPropagation();
                          void runFlow();
                        }}
                        className="h-7 rounded-lg border-slate-700 bg-slate-900 px-2 text-xs text-slate-100 hover:bg-slate-800 hover:text-white"
                      >
                        <Play className="h-3.5 w-3.5" />
                        {runButtonLabel}
                      </Button>
                    )}
                  </div>
                  <span
                    className={cn(
                      "truncate text-xs",
                      runBlockedReason ? "text-amber-200" : "text-slate-500",
                    )}
                  >
                    {runBlockedReason ?? runReadyMessage}
                  </span>
                </div>
              </section>
            ) : (
            <section
              className={cn(
                "row-start-2 grid min-h-0 grid-cols-1 border-t border-slate-800 bg-slate-950",
                bottomPanelSpanClass,
              )}
            >
              {editorMode === "generate" ? (
              <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditorMode("generate")}
                  className={cn(
                    "flex items-center gap-2 border-b border-slate-800 px-4 py-2 text-left text-sm font-semibold text-white",
                    editorMode === "generate" && "bg-emerald-500/10",
                  )}
                >
                  <Sparkles className="h-4 w-4 text-emerald-300" />
                  AI Flow Changes
                </button>
                <ScrollArea className="min-h-0" type="always">
                  {editorMode === "generate" ? (
                  <div className="grid min-h-0 gap-3 p-3 xl:grid-cols-[minmax(0,1fr)_20rem]">
                    <div className="grid min-h-0 content-start gap-2">
                    <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1">
                      {aiTargetOptions.map(({ target, label, disabled, title }) => (
                        <button
                          key={target}
                          type="button"
                          disabled={disabled}
                          aria-disabled={disabled}
                          title={title}
                          onClick={() => {
                            if (!disabled) {
                              setAiTarget(target);
                            }
                          }}
                          className={cn(
                            "h-7 rounded-md px-2 text-xs font-semibold",
                            disabled
                              ? "cursor-not-allowed text-slate-700 opacity-60"
                              : aiTarget === target
                              ? "bg-emerald-500/20 text-emerald-100"
                              : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                      <div className="grid grid-cols-2 gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1">
                        {[
                        ["do-it", "No questions"],
                        ["interview", "Interview"],
                      ].map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() =>
                            setAiGenerationMode(mode as RalphAiGenerationMode)
                          }
                          className={cn(
                            "flex h-7 min-w-0 items-center justify-center rounded-md px-2 text-xs font-semibold",
                            aiGenerationMode === mode
                              ? "bg-sky-500/20 text-sky-100"
                              : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                          )}
                        >
                          <span className="min-w-0 truncate">{label}</span>
                        </button>
                      ))}
                    </div>
                    <div className="grid gap-1.5 rounded-lg border border-slate-800 bg-slate-950/60 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Save to
                        </span>
                        <span className="text-[0.68rem] text-slate-500">
                          {aiTarget === "flow"
                            ? creationScopeLabel
                            : selectedScopeLabel}
                        </span>
                      </div>
                      {aiTarget === "flow" ? (
                        <div className="grid grid-cols-2 gap-1 rounded-md bg-slate-900/70 p-1">
                          {RALPH_FLOW_SCOPES.map((scope) => (
                            <button
                              key={scope}
                              type="button"
                              onClick={() => setCreationScope(scope)}
                              className={cn(
                                "h-7 rounded px-2 text-xs font-semibold",
                                creationScope === scope
                                  ? scope === "user"
                                    ? "bg-sky-500/20 text-sky-100"
                                    : "bg-emerald-500/20 text-emerald-100"
                                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                              )}
                            >
                              {RALPH_FLOW_SCOPE_LABELS[scope]}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <div className="text-xs leading-4 text-slate-500">
                          Changes save back to the selected {selectedScopeLabel.toLowerCase()} flow.
                          {aiTarget === "prompt-block" && aiPromptBlock ? (
                            <span className="mt-1 block truncate text-slate-400">
                              Prompt block: {aiPromptBlockLabel}
                            </span>
                          ) : null}
                        </div>
                      )}
                    </div>
                    <Textarea
                      value={aiPromptDraft}
                      aria-label="AI flow generation prompt"
                      placeholder={
                        aiTarget === "flow"
                          ? "Describe a complete Ralph flow."
                          : aiTarget === "prompt-block"
                            ? "Describe how to improve the selected prompt block."
                            : "Describe the changes to apply to this flow."
                      }
                      onChange={(event) =>
                        handleAiPromptDraftChange(event.target.value)
                      }
                      onKeyDown={handleAiPromptHistoryNavigation}
                      className="min-h-14 border-slate-700 bg-slate-950 text-sm text-slate-100 placeholder:text-slate-600"
                    />
                    {aiTarget !== "flow" && !draftFlow ? (
                      <div className="text-xs text-amber-100">
                        Select or create a flow first.
                      </div>
                    ) : null}
                    <Button
                      type="button"
                      disabled={!canGenerateWithAgent}
                      onClick={() => void createFlowWithAgent()}
                      className="h-8 justify-self-end rounded-lg bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-500"
                    >
                      {generationRunning || generationInterviewRunning ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      {generationRunning || generationInterviewRunning
                        ? "Working"
                        : aiTarget === "flow"
                          ? "Generate"
                          : "Apply"}
                    </Button>
                    </div>
                    <div className="grid min-h-0 content-start gap-2 border-t border-slate-800 pt-3 xl:border-l xl:border-t-0 xl:pl-3 xl:pt-0">
                      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                        Result
                      </div>
                    {generationJob ? (
                      <div
                        className={cn(
                          "grid gap-2 text-sm",
                          generationJob.status === "failed"
                            ? "text-red-100"
                            : generationJob.status === "blocked"
                              ? "text-amber-100"
                              : "text-slate-300",
                        )}
                      >
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2 font-medium">
                            {generationJob.status === "running" ||
                            generationJob.status === "stopping" ? (
                              <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-300" />
                            ) : generationJob.status === "created" ? (
                              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                            ) : (
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-300" />
                            )}
                            <span className="truncate">
                              {generationJobStatusLabel}
                            </span>
                          </span>
                          <div className="flex shrink-0 items-center gap-2">
                            {canCopyGenerationError(generationJob) ? (
                              <Button
                                type="button"
                                variant="outline"
                                aria-label="Copy Ralph generation error"
                                title="Copy Ralph generation error"
                                onClick={() => void copyGenerationError()}
                                className="h-7 rounded-lg border-amber-400/30 bg-amber-500/10 px-2 text-xs text-amber-100 hover:bg-amber-500/15 hover:text-white"
                              >
                                <Copy className="h-3.5 w-3.5" />
                                {generationErrorCopyState === "copied"
                                  ? "Copied"
                                  : generationErrorCopyState === "failed"
                                    ? "Copy failed"
                                    : "Copy error"}
                              </Button>
                            ) : null}
                            {generationJob.status === "running" ? (
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void stopGeneration()}
                                className="h-7 rounded-lg border-rose-400/30 bg-rose-500/10 px-2 text-xs text-rose-100 hover:bg-rose-500/15 hover:text-white"
                              >
                                <Octagon className="h-3.5 w-3.5" />
                                Stop
                              </Button>
                            ) : generationJob.result?.flow ? (
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void openGeneratedFlow()}
                                className="h-7 rounded-lg border-slate-700 bg-slate-900 px-2 text-xs text-slate-100 hover:bg-slate-800 hover:text-white"
                              >
                                Open
                              </Button>
                            ) : null}
                          </div>
                        </div>
                        <div className="max-h-12 overflow-hidden text-xs text-slate-500">
                          {generationJob.summary}
                        </div>
                        {getGenerationPhaseLabel(generationJob) ? (
                          <div className="text-xs text-sky-200">
                            {getGenerationPhaseLabel(generationJob)}
                          </div>
                        ) : null}
                        <div className="grid gap-1 rounded-lg border border-slate-800 bg-slate-950/60 p-2 text-[11px] text-slate-400 sm:grid-cols-2">
                          {generationJob.provider || generationJob.model ? (
                            <div className="min-w-0 truncate">
                              Model: {[generationJob.provider, generationJob.model]
                                .filter(Boolean)
                                .join(" / ")}
                            </div>
                          ) : null}
                          {generationJob.blockCount !== undefined ||
                          generationJob.edgeCount !== undefined ? (
                            <div className="min-w-0 truncate">
                              Artifact: {generationJob.blockCount ?? 0} blocks /{" "}
                              {generationJob.edgeCount ?? 0} edges
                            </div>
                          ) : null}
                          {generationJob.validationErrorCount !== undefined ||
                          generationJob.validationWarningCount !== undefined ? (
                            <div className="min-w-0 truncate">
                              Validation: {generationJob.validationErrorCount ?? 0} errors /{" "}
                              {generationJob.validationWarningCount ?? 0} warnings
                            </div>
                          ) : null}
                          {generationJob.validatorDecision ? (
                            <div className="min-w-0 truncate">
                              Decision: {generationJob.validatorDecision}
                            </div>
                          ) : null}
                          {generationJob.tempFlowPath ? (
                            <div
                              className="min-w-0 truncate sm:col-span-2"
                              title={generationJob.tempFlowPath}
                            >
                              Temp: {generationJob.tempFlowPath}
                            </div>
                          ) : null}
                          {generationJob.generationLogPath ? (
                            <div
                              className="min-w-0 truncate sm:col-span-2"
                              title={generationJob.generationLogPath}
                            >
                              Log: {generationJob.generationLogPath}
                            </div>
                          ) : null}
                        </div>
                        {generationJob.activity.length > 0 ? (
                          <div className="grid max-h-36 gap-1 overflow-auto border-t border-slate-800 pt-2 text-[11px] leading-4 text-slate-400">
                            {generationJob.activity.slice(-8).map((event) => (
                              <div
                                key={event.id}
                                className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2"
                              >
                                <span className="text-slate-600">
                                  {formatGenerationActivityTime(event.timestamp)}
                                </span>
                                <span className="min-w-0">
                                  <span className="text-slate-300">{event.label}</span>
                                  {event.round ? (
                                    <span className="ml-1 text-slate-600">
                                      r{event.round}
                                      {event.maxRounds ? `/${event.maxRounds}` : ""}
                                    </span>
                                  ) : null}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs text-slate-500">
                            Waiting for structured generation activity.
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-xs leading-5 text-slate-500">
                        Generated flows, blocked results, and stop controls appear here.
                      </div>
                    )}
                    </div>
                  </div>
                  ) : (
                    <div className="grid gap-2 p-3">
                      <button
                        type="button"
                        onClick={() => setEditorMode("generate")}
                        className="text-left text-sm text-slate-300 hover:text-slate-100"
                      >
                        Flow / Improve / Prompt
                      </button>
                    </div>
                  )}
                </ScrollArea>
              </div>
              ) : null}

              {editorMode === "review" ? (
              <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditorMode("review")}
                  className={cn(
                    "flex items-center gap-2 border-b border-slate-800 px-4 py-2 text-left text-sm font-semibold text-white",
                    editorMode === "review" && "bg-amber-500/10",
                  )}
                >
                  <AlertTriangle className="h-4 w-4 text-amber-300" />
                  Validation
                </button>
                <ScrollArea className="min-h-0" type="always">
                  {editorMode === "review" ? (
                  <div className="grid gap-2 p-3">
                    {issues.length === 0 ? (
                      <div className="text-sm text-slate-500">
                        No local warnings.
                      </div>
                    ) : (
                      issues.map((issue, index) => (
                        <button
                          key={`${issue.message}-${index}`}
                          type="button"
                          disabled={!issue.blockId}
                          onClick={() => {
                            if (issue.blockId) {
                              focusValidationIssueBlock(issue.blockId);
                            }
                          }}
                          className={cn(
                            "flex min-w-0 items-center justify-between gap-3 border-b border-slate-800/70 py-2 text-left text-sm last:border-b-0 disabled:cursor-default",
                            issue.blockId &&
                              "cursor-pointer rounded-sm hover:bg-slate-900/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-300/70",
                            issue.level === "error"
                              ? "text-red-100"
                              : "text-amber-100",
                          )}
                        >
                          <span className="min-w-0 truncate">{issue.message}</span>
                          {issue.blockId ? (
                            <span className="shrink-0 text-xs opacity-70">
                              {issue.blockId}
                            </span>
                          ) : null}
                        </button>
                      ))
                    )}
                  </div>
                  ) : (
                    <div className="grid gap-2 p-3">
                      <button
                        type="button"
                        onClick={() => setEditorMode("review")}
                        className={cn(
                          "text-left text-sm",
                          issues.length > 0
                            ? "text-amber-100"
                            : "text-slate-500 hover:text-slate-300",
                        )}
                      >
                        {issues.length > 0
                          ? `${issues.length} validation issue${issues.length === 1 ? "" : "s"}`
                          : "No local warnings."}
                      </button>
                    </div>
                  )}
                </ScrollArea>
              </div>
              ) : null}

              {editorMode === "run" ? (
              <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setEditorMode("run")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setEditorMode("run");
                    }
                  }}
                  className={cn(
                    "flex cursor-pointer items-center justify-between gap-2 border-b border-slate-800 px-4 py-2",
                    editorMode === "run" && "bg-slate-900/35",
                  )}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold text-white">
                    <CheckCircle2 className="h-4 w-4 text-lime-300" />
                    Run
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {activeRunCount > 0 ? (
                      <span className="inline-flex h-7 items-center gap-1 rounded-full border border-sky-400/30 bg-sky-500/10 px-2 text-[0.68rem] font-semibold text-sky-100">
                        <LoaderCircle className="h-3 w-3 animate-spin" />
                        {activeRunCount} live
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!canRunFlow}
                      aria-label="Run Ralph flow"
                      onClick={(event) => {
                        event.stopPropagation();
                        void runFlow();
                      }}
                      className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs text-slate-100 hover:bg-slate-800 hover:text-white"
                    >
                      {loading ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                      {runButtonLabel}
                    </Button>
                  </div>
                </div>
                <ScrollArea className="min-h-0" type="always">
                  <div className="grid gap-3 p-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/60 p-1">
                      {([
                        ["setup", "Setup"],
                        ["live", activeRuns.length > 0 ? `Live (${activeRuns.length})` : "Live"],
                        ["history", "History"],
                        ["details", "Details"],
                        ["logs", selectedRunLog ? (selectedRunLog.kind === "trace" ? "Trace" : "Log") : "Logs"],
                      ] as const).map(([tab, label]) => (
                        <button
                          key={tab}
                          type="button"
                          onClick={() => setRunPanelTab(tab)}
                          className={cn(
                            "h-7 rounded-md px-3 text-xs font-semibold",
                            runPanelTab === tab
                              ? "bg-lime-500/15 text-lime-100"
                              : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {pendingInput ? (
                      <div className="grid gap-3 rounded-lg border border-teal-400/30 bg-teal-950/20 p-3">
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="grid min-w-0 gap-1">
                            <div className="text-sm font-semibold text-teal-50">
                              {pendingInput.title}
                            </div>
                            {pendingInput.prompt ? (
                              <div className="text-xs leading-5 text-teal-100/80">
                                {pendingInput.prompt}
                              </div>
                            ) : null}
                            {pendingInput.interview ? (
                              <div className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-teal-200/75">
                                Interview turn {pendingInput.interview.turn} / {pendingInput.interview.maxTurns}
                              </div>
                            ) : null}
                          </div>
                          <span className="shrink-0 rounded-full border border-teal-300/30 bg-teal-400/10 px-2 py-1 text-[0.68rem] font-semibold text-teal-100">
                            Waiting
                          </span>
                        </div>
                        <div className="grid gap-3">
                          {pendingInput.fields.map((field) => (
                            <label
                              key={field.id}
                              className="grid gap-1.5 text-sm text-slate-100"
                            >
                              <span className="flex min-w-0 items-center justify-between gap-3">
                                <span className="min-w-0 truncate font-medium">
                                  {field.label}
                                </span>
                                <span className="shrink-0 text-[0.68rem] text-slate-400">
                                  {field.type}
                                  {field.required ? " required" : ""}
                                  {field.skippable ? " skippable" : ""}
                                </span>
                              </span>
                              {renderPendingInputControl(field)}
                              <span className="flex min-w-0 items-center justify-between gap-3">
                                <span className="min-w-0 text-xs text-slate-400">
                                  {field.help ?? ""}
                                </span>
                                {field.skippable ? (
                                  <button
                                    type="button"
                                    onClick={() => updatePendingInputValue(field.id, null)}
                                    className="shrink-0 text-xs font-medium text-teal-200 hover:text-teal-100"
                                  >
                                    Skip
                                  </button>
                                ) : null}
                              </span>
                            </label>
                          ))}
                        </div>
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            disabled={inputSubmitting}
                            onClick={() => void submitPendingInput("cancel")}
                            className="h-8 rounded-lg border-slate-700 bg-slate-950 px-3 text-xs text-slate-200 hover:bg-slate-900 hover:text-white"
                          >
                            {pendingInput.cancelLabel ?? "Cancel"}
                          </Button>
                          <Button
                            type="button"
                            disabled={inputSubmitting}
                            onClick={() => void submitPendingInput("submit")}
                            className="h-8 rounded-lg bg-teal-600 px-3 text-xs text-white hover:bg-teal-500"
                          >
                            {inputSubmitting ? (
                              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                            {pendingInput.submitLabel ?? "Continue"}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {runPanelTab === "setup" ? (
                      <div className="grid gap-3">
                        <div
                          className={cn(
                            "text-sm",
                            runBlockedReason ? "text-amber-100" : "text-lime-100",
                          )}
                        >
                          <div className="flex min-w-0 items-center justify-between gap-3">
                            <span className="min-w-0 break-words">
                              {runBlockedReason ?? runReadyMessage}
                            </span>
                            {runBlockedReason === "Save flow before running." &&
                            canSaveFlow ? (
                              <Button
                                type="button"
                                onClick={() => void saveFlow()}
                                className="h-8 shrink-0 rounded-lg bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-500"
                              >
                                <Save className="h-3.5 w-3.5" />
                                Save
                              </Button>
                            ) : null}
                          </div>
                        </div>

                        <div className="grid gap-2 md:grid-cols-4">
                          <div className="grid gap-1 rounded border border-slate-800 bg-slate-950/70 p-2">
                            <span className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                              Scope
                            </span>
                            <span className="truncate text-xs text-slate-200">
                              {selectedScopeLabel}
                            </span>
                          </div>
                          <div className="grid gap-1 rounded border border-slate-800 bg-slate-950/70 p-2">
                            <span className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                              Runtime
                            </span>
                            <span className="truncate text-xs text-slate-200">
                              {runProvider} / {runModel}
                            </span>
                          </div>
                          <div className="grid gap-1 rounded border border-slate-800 bg-slate-950/70 p-2">
                            <span className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                              Variables
                            </span>
                            <span className="truncate text-xs text-slate-200">
                              {(draftFlow?.variables ?? []).length} total
                              {requiredMissingVariables.length > 0
                                ? `, ${requiredMissingVariables.length} missing`
                                : ""}
                            </span>
                          </div>
                          <div className="grid gap-1 rounded border border-slate-800 bg-slate-950/70 p-2">
                            <span className="text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                              Selected flow
                            </span>
                            <span className="truncate text-xs text-slate-200">
                              {selectedFlowActiveRunCount > 0
                                ? `${selectedFlowActiveRunCount} active run${selectedFlowActiveRunCount === 1 ? "" : "s"}`
                                : warningCount > 0
                                  ? `${warningCount} warning${warningCount === 1 ? "" : "s"}`
                                  : "Ready"}
                            </span>
                          </div>
                        </div>

                        {draftFlow && (draftFlow.variables ?? []).length > 0 ? (
                          <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
                            {(draftFlow.variables ?? []).map((variable) => (
                              <label
                                key={variable.name}
                                className="grid gap-1.5 text-sm text-slate-200"
                              >
                                <span className="flex min-w-0 items-center justify-between gap-3">
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span className="truncate font-medium">
                                      {variable.name}
                                    </span>
                                    {variable.required ? (
                                      <span className="rounded border border-amber-400/30 bg-amber-500/10 px-1.5 py-0.5 text-[0.62rem] font-semibold text-amber-100">
                                        required
                                      </span>
                                    ) : null}
                                    {variable.default !== undefined ? (
                                      <span className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[0.62rem] text-slate-400">
                                        default
                                      </span>
                                    ) : null}
                                  </span>
                                  <select
                                    value={variable.type}
                                    aria-label={`Variable type ${variable.name}`}
                                    disabled
                                    className="h-7 rounded border border-slate-800 bg-slate-950 px-2 text-[0.7rem] text-slate-500"
                                  >
                                    {VARIABLE_TYPES.map((type) => (
                                      <option key={type} value={type}>
                                        {type}
                                      </option>
                                    ))}
                                  </select>
                                </span>
                                <Input
                                  value={variableValues[variable.name] ?? ""}
                                  aria-label={`Ralph variable ${variable.name}`}
                                  placeholder={variable.default ?? variable.name}
                                  onChange={(event) => {
                                    const nextValue = event.target.value;
                                    setVariableValues((current) => ({
                                      ...current,
                                      [variable.name]: nextValue,
                                    }));
                                  }}
                                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100 placeholder:text-slate-600"
                                />
                                {variable.default !== undefined ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setVariableValues((current) => ({
                                        ...current,
                                        [variable.name]: variable.default ?? "",
                                      }))
                                    }
                                    className="justify-self-start text-[0.68rem] font-medium text-slate-500 hover:text-slate-200"
                                  >
                                    Reset to default
                                  </button>
                                ) : null}
                              </label>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs text-slate-500">
                            No variables required.
                          </div>
                        )}

                        {requiredMissingVariables.length > 0 ? (
                          <div className="break-words text-sm text-amber-100">
                            Missing required variable(s):{" "}
                            {requiredMissingVariables.join(", ")}.
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {runPanelTab === "live" ? (
                      <div className="grid gap-3">
                        {activeRuns.length > 0 ? (
                          <div className="grid gap-3 xl:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.1fr)]">
                            <div className="grid gap-2">
                              <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-slate-500">
                                <span className="font-medium text-slate-400">
                                  Background Ralph runs
                                </span>
                                <span>{activeRuns.length}</span>
                              </div>
                              <div className="grid gap-2">
                                {activeRuns.map((activeRun) => {
                                  const status = getRunStatusPresentation(
                                    activeRun.status,
                                  );
                                  const StatusIcon = status.icon;
                                  const isSelected = liveRunForPanel?.id === activeRun.id;

                                  return (
                                    <button
                                      key={activeRun.id}
                                      type="button"
                                      onClick={() => {
                                        setSelectedRunId(activeRun.id);
                                        setSelectedRunDetail(null);
                                        setRunDetailError(null);
                                      }}
                                      className={cn(
                                        "grid min-w-0 gap-2 rounded border p-2 text-left transition-colors",
                                        isSelected
                                          ? "border-sky-400/40 bg-sky-500/10"
                                          : "border-slate-800 bg-slate-950/70 hover:border-slate-700 hover:bg-slate-900/60",
                                      )}
                                    >
                                      <span className="flex min-w-0 items-center justify-between gap-2">
                                        <span className="flex min-w-0 items-center gap-2">
                                          <span
                                            className={cn(
                                              "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border",
                                              status.chipClassName,
                                            )}
                                          >
                                            <StatusIcon
                                              className={cn(
                                                "h-3.5 w-3.5",
                                                status.spin && "animate-spin",
                                              )}
                                            />
                                          </span>
                                          <span className="min-w-0">
                                            <span className="block truncate text-sm font-semibold text-slate-100">
                                              {activeRun.flowName}
                                            </span>
                                            <span className="block truncate text-[0.68rem] text-slate-500">
                                              {RALPH_FLOW_SCOPE_LABELS[activeRun.scope]} / {formatDurationMs(Date.now() - activeRun.startedAt)}
                                            </span>
                                          </span>
                                        </span>
                                        {activeRun.lastOutput ? (
                                          <span
                                            className={cn(
                                              "shrink-0 rounded border px-1.5 py-0.5 text-[0.62rem] font-semibold",
                                              getOutputChipClassName(activeRun.lastOutput),
                                            )}
                                          >
                                            {activeRun.lastOutput}
                                          </span>
                                        ) : null}
                                      </span>
                                      <span className="truncate text-xs text-slate-400">
                                        {activeRun.status === "stopping"
                                          ? "Stopping run."
                                          : activeRun.currentBlockTitle
                                            ? `Active: ${activeRun.currentBlockTitle}`
                                            : activeRun.lastMessage ?? "Waiting for first progress event."}
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>

                            {liveRunForPanel ? (
                              <div className="grid gap-3 rounded border border-slate-800 bg-slate-950/70 p-3">
                                <div className="flex min-w-0 items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="truncate text-sm font-semibold text-slate-100">
                                      {liveRunForPanel.flowName}
                                    </div>
                                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                                      {(() => {
                                        const status = getRunStatusPresentation(
                                          liveRunForPanel.status,
                                        );
                                        const StatusIcon = status.icon;

                                        return (
                                          <span
                                            className={cn(
                                              "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.68rem] font-semibold",
                                              status.chipClassName,
                                            )}
                                          >
                                            <StatusIcon
                                              className={cn(
                                                "h-3 w-3",
                                                status.spin && "animate-spin",
                                              )}
                                            />
                                            {status.label}
                                          </span>
                                        );
                                      })()}
                                      <span className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[0.68rem] text-slate-400">
                                        {liveRunForPanel.provider} / {liveRunForPanel.model}
                                      </span>
                                      <span className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[0.68rem] text-slate-400">
                                        started {formatRevisionDate(new Date(liveRunForPanel.startedAt).toISOString())}
                                      </span>
                                    </div>
                                  </div>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    disabled={liveRunForPanel.status === "stopping"}
                                    aria-label={`Stop Ralph run ${liveRunForPanel.flowName}`}
                                    onClick={() => void stopRalphRun(liveRunForPanel.id)}
                                    className="h-8 shrink-0 rounded-lg border-rose-400/30 bg-rose-500/10 px-2 text-xs text-rose-100 hover:bg-rose-500/15 hover:text-white disabled:opacity-60"
                                  >
                                    {liveRunForPanel.status === "stopping" ? (
                                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <Octagon className="h-3.5 w-3.5" />
                                    )}
                                    Stop
                                  </Button>
                                </div>

                                <div className="grid gap-2 md:grid-cols-2">
                                  <div className="rounded border border-slate-800 bg-slate-950 p-2">
                                    <div className="mb-1 flex items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                                      <Workflow className="h-3 w-3" />
                                      Current block
                                    </div>
                                    <div className="truncate text-sm text-slate-200">
                                      {liveRunForPanel.currentBlockTitle ??
                                        liveRunForPanel.currentBlockId ??
                                        "Waiting for block start"}
                                    </div>
                                  </div>
                                  <div className="rounded border border-slate-800 bg-slate-950 p-2">
                                    <div className="mb-1 flex items-center gap-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                                      <Variable className="h-3 w-3" />
                                      Variables
                                    </div>
                                    <div className="truncate text-sm text-slate-200">
                                      {Object.keys(liveRunForPanel.variableValues).length > 0
                                        ? `${Object.keys(liveRunForPanel.variableValues).length} captured`
                                        : "No supplied variables"}
                                    </div>
                                  </div>
                                </div>

                                {Object.keys(liveRunForPanel.variableValues).length > 0 ? (
                                  <div className="grid gap-1">
                                    {Object.entries(liveRunForPanel.variableValues).map(
                                      ([name, value]) => (
                                        <div
                                          key={name}
                                          className="grid grid-cols-[10rem_minmax(0,1fr)] gap-2 rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs"
                                        >
                                          <span className="truncate font-medium text-slate-300">
                                            {name}
                                          </span>
                                          <span className="truncate text-slate-500" title={value}>
                                            {value || "(empty)"}
                                          </span>
                                        </div>
                                      ),
                                    )}
                                  </div>
                                ) : null}

                                <div className="grid gap-2">
                                  <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-400">
                                    <span>Live timeline</span>
                                    <span>{liveRunForPanel.events.length}</span>
                                  </div>
                                  {liveRunForPanel.events.length > 0 ? (
                                    <div className="grid gap-1.5">
                                      {liveRunForPanel.events.slice(-8).map((event) => (
                                        <div
                                          key={event.id}
                                          className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 text-xs"
                                        >
                                          <span className="font-mono text-slate-600">
                                            +{formatDurationMs(event.timestamp - liveRunForPanel.startedAt)}
                                          </span>
                                          <span className="min-w-0">
                                            <span
                                              className={cn(
                                                "mr-1 inline-flex rounded border px-1 py-0.5 text-[0.62rem] font-semibold",
                                                getRunEventToneClassName(event.tone),
                                              )}
                                            >
                                              {event.eventType}
                                            </span>
                                            <span className="text-slate-300">
                                              {event.label}
                                            </span>
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="text-xs text-slate-500">
                                      Waiting for progress events.
                                    </div>
                                  )}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <div className="text-sm text-slate-500">
                            No active Ralph runs.
                          </div>
                        )}

                        {lastRun ? (
                          <div className="grid gap-2 border-t border-slate-800 pt-3">
                            <div className="text-sm font-medium text-slate-100">
                              Last result: {lastRun.status}
                            </div>
                            <p className="break-words text-sm text-slate-400">
                              {lastRun.summary}
                            </p>
                            <div className="grid gap-1 md:grid-cols-2">
                              {lastRun.events.slice(-10).map((event, index) => (
                                <div
                                  key={`${event.type}-${index}`}
                                  className="truncate text-xs text-slate-500"
                                >
                                  {event.type}
                                  {"blockId" in event ? ` ${event.blockId}` : ""}
                                  {"output" in event ? ` ${event.output}` : ""}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    {runPanelTab === "history" ? (
                      <div className="grid gap-2">
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
                            <History className="h-3.5 w-3.5" />
                            Run history
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={runHistoryLoading || !selectedId}
                            aria-label="Refresh Ralph run history"
                            title="Refresh Ralph run history"
                            onClick={() => void refreshRunHistory(selectedId, selectedScope)}
                            className="h-7 w-7 rounded-lg text-slate-500 hover:bg-slate-900 hover:text-slate-100"
                          >
                            <RefreshCw
                              className={cn(
                                "h-3.5 w-3.5",
                                runHistoryLoading && "animate-spin",
                              )}
                            />
                          </Button>
                        </div>

                        {runHistoryLoading ? (
                          <div className="flex items-center gap-2 text-xs text-slate-500">
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                            Loading runs.
                          </div>
                        ) : runHistory.length === 0 ? (
                          <div className="text-xs text-slate-500">
                            No runs recorded for this flow.
                          </div>
                        ) : (
                          <div className="grid gap-2">
                            {runHistory.map((run) => {
                              const status = getRunStatusPresentation(run.status);
                              const StatusIcon = status.icon;
                              const isSelected = selectedRunId === run.id;
                              const duration =
                                run.finishedAt && getTimestampMs(run.createdAt) !== null
                                  ? formatDurationMs(
                                      (getTimestampMs(run.finishedAt) ?? 0) -
                                        (getTimestampMs(run.createdAt) ?? 0),
                                    )
                                  : null;

                              return (
                                <div
                                  key={run.id}
                                  className={cn(
                                    "grid gap-2 rounded border p-2",
                                    isSelected
                                      ? "border-sky-400/40 bg-sky-500/10"
                                      : "border-slate-800 bg-slate-950/70",
                                  )}
                                >
                                  <div className="flex min-w-0 items-start justify-between gap-3">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        void openRunDetail(run.id, selectedScope)
                                      }
                                      className="min-w-0 flex-1 text-left"
                                    >
                                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                        <span
                                          className={cn(
                                            "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.68rem] font-semibold",
                                            status.chipClassName,
                                          )}
                                        >
                                          <StatusIcon className="h-3 w-3" />
                                          {status.label}
                                        </span>
                                        <span className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[0.68rem] text-slate-400">
                                          {formatRevisionDate(run.createdAt)}
                                        </span>
                                        {duration ? (
                                          <span className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[0.68rem] text-slate-400">
                                            {duration}
                                          </span>
                                        ) : null}
                                        <span className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[0.68rem] text-slate-400">
                                          {run.blockCount} blocks
                                        </span>
                                        <span className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[0.68rem] text-slate-400">
                                          {run.eventCount} events
                                        </span>
                                      </div>
                                      <div className="mt-1 truncate text-sm font-medium text-slate-200">
                                        {run.summary}
                                      </div>
                                      <div className="mt-0.5 truncate text-[0.68rem] text-slate-600">
                                        {run.id}
                                      </div>
                                    </button>
                                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        disabled={runDetailLoading}
                                        onClick={() =>
                                          void openRunDetail(run.id, selectedScope)
                                        }
                                        className="h-7 rounded-lg px-2 text-xs text-slate-300 hover:bg-slate-900 hover:text-white"
                                      >
                                        <FileJson className="h-3.5 w-3.5" />
                                        Details
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        disabled={runLogLoading}
                                        onClick={() =>
                                          void openRunLog(run.id, "simple", selectedScope)
                                        }
                                        className="h-7 rounded-lg px-2 text-xs text-slate-300 hover:bg-slate-900 hover:text-white"
                                      >
                                        <FileText className="h-3.5 w-3.5" />
                                        Log
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        disabled={runLogLoading}
                                        onClick={() =>
                                          void openRunLog(run.id, "trace", selectedScope)
                                        }
                                        className="h-7 rounded-lg px-2 text-xs text-slate-400 hover:bg-slate-900 hover:text-white"
                                      >
                                        <Terminal className="h-3.5 w-3.5" />
                                        Trace
                                      </Button>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : null}

                    {runPanelTab === "details" ? (
                      <div className="grid gap-3">
                        {runDetailLoading && !selectedActiveRun ? (
                          <div className="flex items-center gap-2 text-sm text-slate-500">
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                            Loading run details.
                          </div>
                        ) : selectedActiveRun ? (
                          <div className="grid gap-3 rounded border border-sky-400/30 bg-sky-500/10 p-3">
                            <div className="flex min-w-0 items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-sm font-semibold text-slate-100">
                                  {selectedActiveRun.flowName}
                                </div>
                                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                                  {(() => {
                                    const status = getRunStatusPresentation(
                                      selectedActiveRun.status,
                                    );
                                    const StatusIcon = status.icon;

                                    return (
                                      <span
                                        className={cn(
                                          "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.68rem] font-semibold",
                                          status.chipClassName,
                                        )}
                                      >
                                        <StatusIcon
                                          className={cn(
                                            "h-3 w-3",
                                            status.spin && "animate-spin",
                                          )}
                                        />
                                        {status.label}
                                      </span>
                                    );
                                  })()}
                                  <span className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[0.68rem] text-slate-400">
                                    {selectedActiveRun.provider} / {selectedActiveRun.model}
                                  </span>
                                  <span className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[0.68rem] text-slate-400">
                                    {formatDurationMs(Date.now() - selectedActiveRun.startedAt)}
                                  </span>
                                </div>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                disabled={selectedActiveRun.status === "stopping"}
                                aria-label={`Stop Ralph run ${selectedActiveRun.flowName}`}
                                onClick={() => void stopRalphRun(selectedActiveRun.id)}
                                className="h-8 shrink-0 rounded-lg border-rose-400/30 bg-rose-500/10 px-2 text-xs text-rose-100 hover:bg-rose-500/15 hover:text-white disabled:opacity-60"
                              >
                                <Octagon className="h-3.5 w-3.5" />
                                Stop
                              </Button>
                            </div>
                            <div className="grid gap-2 md:grid-cols-2">
                              <div className="rounded border border-slate-800 bg-slate-950/80 p-2">
                                <div className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                                  Current block
                                </div>
                                <div className="mt-1 truncate text-sm text-slate-200">
                                  {selectedActiveRun.currentBlockTitle ??
                                    selectedActiveRun.currentBlockId ??
                                    "Waiting for progress"}
                                </div>
                              </div>
                              <div className="rounded border border-slate-800 bg-slate-950/80 p-2">
                                <div className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                                  Last output
                                </div>
                                <div className="mt-1">
                                  <span
                                    className={cn(
                                      "rounded border px-1.5 py-0.5 text-xs font-semibold",
                                      getOutputChipClassName(selectedActiveRun.lastOutput),
                                    )}
                                  >
                                    {selectedActiveRun.lastOutput ?? "Pending"}
                                  </span>
                                </div>
                              </div>
                            </div>
                            <div className="grid gap-2">
                              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                                <Variable className="h-3.5 w-3.5 text-slate-500" />
                                Run variables
                              </div>
                              {Object.keys(selectedActiveRun.variableValues).length > 0 ? (
                                <div className="grid gap-1 md:grid-cols-2">
                                  {Object.entries(selectedActiveRun.variableValues).map(
                                    ([name, value]) => (
                                      <div
                                        key={name}
                                        className="grid gap-1 rounded border border-slate-800 bg-slate-950/80 p-2"
                                      >
                                        <span className="truncate text-xs font-medium text-slate-300">
                                          {name}
                                        </span>
                                        <span className="truncate text-xs text-slate-500" title={value}>
                                          {value || "(empty)"}
                                        </span>
                                      </div>
                                    ),
                                  )}
                                </div>
                              ) : (
                                <div className="text-xs text-slate-500">
                                  No variables were supplied for this run.
                                </div>
                              )}
                            </div>
                            <div className="grid gap-1.5">
                              <div className="text-xs font-semibold text-slate-300">
                                Live events
                              </div>
                              {selectedActiveRun.events.length > 0 ? (
                                selectedActiveRun.events.slice(-12).map((event) => (
                                  <div
                                    key={event.id}
                                    className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2 rounded border border-slate-800 bg-slate-950/70 px-2 py-1.5 text-xs"
                                  >
                                    <span className="font-mono text-slate-600">
                                      +{formatDurationMs(event.timestamp - selectedActiveRun.startedAt)}
                                    </span>
                                    <span className="min-w-0 truncate text-slate-300">
                                      {event.label}
                                    </span>
                                  </div>
                                ))
                              ) : (
                                <div className="text-xs text-slate-500">
                                  No progress events yet.
                                </div>
                              )}
                            </div>
                          </div>
                        ) : selectedRunRecord ? (
                          (() => {
                            const status = getRunStatusPresentation(selectedRunRecord.status);
                            const StatusIcon = status.icon;
                            const duration = formatRunRecordDuration(selectedRunRecord);

                            return (
                              <div className="grid gap-3">
                                <div className="grid gap-3 rounded border border-slate-800 bg-slate-950/70 p-3">
                                  <div className="flex min-w-0 items-start justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="truncate text-sm font-semibold text-slate-100">
                                        {selectedRunRecord.flowName}
                                      </div>
                                      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                                        <span
                                          className={cn(
                                            "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[0.68rem] font-semibold",
                                            status.chipClassName,
                                          )}
                                        >
                                          <StatusIcon className="h-3 w-3" />
                                          {status.label}
                                        </span>
                                        <span className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[0.68rem] text-slate-400">
                                          {formatRevisionDate(selectedRunRecord.createdAt)}
                                        </span>
                                        {duration ? (
                                          <span className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[0.68rem] text-slate-400">
                                            {duration}
                                          </span>
                                        ) : null}
                                        <span className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 text-[0.68rem] text-slate-400">
                                          {selectedRunRecord.id}
                                        </span>
                                      </div>
                                    </div>
                                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        disabled={runLogLoading}
                                        onClick={() =>
                                          void openRunLog(
                                            selectedRunRecord.id,
                                            "simple",
                                            selectedScope,
                                          )
                                        }
                                        className="h-7 rounded-lg px-2 text-xs text-slate-300 hover:bg-slate-900 hover:text-white"
                                      >
                                        <FileText className="h-3.5 w-3.5" />
                                        Log
                                      </Button>
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        disabled={runLogLoading}
                                        onClick={() =>
                                          void openRunLog(
                                            selectedRunRecord.id,
                                            "trace",
                                            selectedScope,
                                          )
                                        }
                                        className="h-7 rounded-lg px-2 text-xs text-slate-400 hover:bg-slate-900 hover:text-white"
                                      >
                                        <Terminal className="h-3.5 w-3.5" />
                                        Trace
                                      </Button>
                                    </div>
                                  </div>
                                  <p className="break-words text-sm text-slate-300">
                                    {selectedRunRecord.summary}
                                  </p>
                                  <div className="grid gap-2 md:grid-cols-4">
                                    <div className="rounded border border-slate-800 bg-slate-950 p-2">
                                      <div className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                                        Variables
                                      </div>
                                      <div className="mt-1 text-sm text-slate-200">
                                        {Object.keys(selectedRunRecord.variableValues).length}
                                      </div>
                                    </div>
                                    <div className="rounded border border-slate-800 bg-slate-950 p-2">
                                      <div className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                                        Blocks
                                      </div>
                                      <div className="mt-1 text-sm text-slate-200">
                                        {selectedRunRecord.blockResults.length}
                                      </div>
                                    </div>
                                    <div className="rounded border border-slate-800 bg-slate-950 p-2">
                                      <div className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                                        Events
                                      </div>
                                      <div className="mt-1 text-sm text-slate-200">
                                        {selectedRunRecord.events.length}
                                      </div>
                                    </div>
                                    <div className="rounded border border-slate-800 bg-slate-950 p-2">
                                      <div className="text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
                                        Validation
                                      </div>
                                      <div className="mt-1 text-sm text-slate-200">
                                        {selectedRunRecord.validation.valid
                                          ? "Valid"
                                          : `${selectedRunRecord.validation.errors.length} errors`}
                                      </div>
                                    </div>
                                  </div>
                                </div>

                                <div className="grid gap-2 md:grid-cols-2">
                                  <div className="grid gap-2 rounded border border-slate-800 bg-slate-950/70 p-3">
                                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                                      <Variable className="h-3.5 w-3.5 text-slate-500" />
                                      Resolved variables
                                    </div>
                                    {Object.keys(selectedRunRecord.variableValues).length > 0 ? (
                                      <div className="grid gap-1">
                                        {Object.entries(selectedRunRecord.variableValues).map(
                                          ([name, value]) => (
                                            <div
                                              key={name}
                                              className="grid grid-cols-[9rem_minmax(0,1fr)] gap-2 rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs"
                                            >
                                              <span className="truncate font-medium text-slate-300">
                                                {name}
                                              </span>
                                              <span className="truncate text-slate-500" title={value}>
                                                {value || "(empty)"}
                                              </span>
                                            </div>
                                          ),
                                        )}
                                      </div>
                                    ) : (
                                      <div className="text-xs text-slate-500">
                                        No variables were supplied.
                                      </div>
                                    )}
                                  </div>

                                  <div className="grid gap-2 rounded border border-slate-800 bg-slate-950/70 p-3">
                                    <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                                      <Route className="h-3.5 w-3.5 text-slate-500" />
                                      Run events
                                    </div>
                                    {selectedRunRecord.events.length > 0 ? (
                                      <div className="grid gap-1">
                                        {selectedRunRecord.events.slice(-12).map((event, index) => (
                                          <div
                                            key={`${event.type}-${index}`}
                                            className="rounded border border-slate-800 bg-slate-950 px-2 py-1.5 text-xs text-slate-300"
                                          >
                                            {getRalphRecordEventLabel(event)}
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <div className="text-xs text-slate-500">
                                        No events were recorded.
                                      </div>
                                    )}
                                  </div>
                                </div>

                                <div className="grid gap-2 rounded border border-slate-800 bg-slate-950/70 p-3">
                                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                                    <Workflow className="h-3.5 w-3.5 text-slate-500" />
                                    Block results
                                  </div>
                                  {selectedRunRecord.blockResults.length > 0 ? (
                                    <div className="grid gap-2">
                                      {selectedRunRecord.blockResults.map((block) => (
                                        <div
                                          key={`${block.blockId}-${block.attempt}`}
                                          className="grid gap-1 rounded border border-slate-800 bg-slate-950 p-2"
                                        >
                                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                            <span className="truncate text-xs font-semibold text-slate-200">
                                              {block.blockId}
                                            </span>
                                            <span
                                              className={cn(
                                                "rounded border px-1.5 py-0.5 text-[0.62rem] font-semibold",
                                                getOutputChipClassName(block.output),
                                              )}
                                            >
                                              {block.output}
                                            </span>
                                            <span className="rounded border border-slate-800 px-1.5 py-0.5 text-[0.62rem] text-slate-400">
                                              {block.status}
                                            </span>
                                            <span className="rounded border border-slate-800 px-1.5 py-0.5 text-[0.62rem] text-slate-400">
                                              attempt {block.attempt}
                                            </span>
                                          </div>
                                          <div className="break-words text-xs text-slate-400">
                                            {block.summary}
                                          </div>
                                          {block.error ? (
                                            <div className="break-words rounded border border-rose-400/30 bg-rose-500/10 p-2 text-xs text-rose-100">
                                              {block.error}
                                            </div>
                                          ) : null}
                                        </div>
                                      ))}
                                    </div>
                                  ) : (
                                    <div className="text-xs text-slate-500">
                                      No block results were recorded.
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })()
                        ) : runDetailError ? (
                          <div className="rounded border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
                            {runDetailError}
                          </div>
                        ) : selectedRunSummary ? (
                          <div className="grid gap-2 rounded border border-slate-800 bg-slate-950/70 p-3">
                            <div className="text-sm font-semibold text-slate-100">
                              {selectedRunSummary.summary}
                            </div>
                            <div className="text-xs text-slate-500">
                              Details have not been loaded for {selectedRunSummary.id}.
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() =>
                                void openRunDetail(selectedRunSummary.id, selectedScope)
                              }
                              className="h-8 justify-self-start rounded-lg border-slate-700 bg-slate-900 px-3 text-xs text-slate-100 hover:bg-slate-800 hover:text-white"
                            >
                              <FileJson className="h-3.5 w-3.5" />
                              Load details
                            </Button>
                          </div>
                        ) : (
                          <div className="text-sm text-slate-500">
                            Select a live run or history entry to inspect variables, block results, events, and logs.
                          </div>
                        )}
                      </div>
                    ) : null}

                    {runPanelTab === "logs" ? (
                      <div className="grid gap-2">
                        {runLogLoading ? (
                          <div className="flex items-center gap-2 text-sm text-slate-500">
                            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                            Loading log.
                          </div>
                        ) : selectedRunLog ? (
                          <>
                            <div className="flex min-w-0 items-center justify-between gap-2">
                              <div className="min-w-0">
                                <div className="truncate text-xs font-medium text-slate-300">
                                  {selectedRunLog.kind === "trace" ? "Trace" : "Log"} /{" "}
                                  {selectedRunLog.runId}
                                </div>
                                <div className="truncate text-[0.68rem] text-slate-600">
                                  {selectedRunLog.path}
                                </div>
                              </div>
                              <div className="flex shrink-0 flex-wrap justify-end gap-1">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  disabled={runLogLoading}
                                  onClick={() =>
                                    void openRunLog(
                                      selectedRunLog.runId,
                                      "simple",
                                      selectedScope,
                                    )
                                  }
                                  className={cn(
                                    "h-7 rounded-lg px-2 text-xs hover:bg-slate-900 hover:text-white",
                                    selectedRunLog.kind === "simple"
                                      ? "text-slate-100"
                                      : "text-slate-500",
                                  )}
                                >
                                  <FileText className="h-3.5 w-3.5" />
                                  Log
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  disabled={runLogLoading}
                                  onClick={() =>
                                    void openRunLog(
                                      selectedRunLog.runId,
                                      "trace",
                                      selectedScope,
                                    )
                                  }
                                  className={cn(
                                    "h-7 rounded-lg px-2 text-xs hover:bg-slate-900 hover:text-white",
                                    selectedRunLog.kind === "trace"
                                      ? "text-slate-100"
                                      : "text-slate-500",
                                  )}
                                >
                                  <Terminal className="h-3.5 w-3.5" />
                                  Trace
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  disabled={runDetailLoading}
                                  onClick={() =>
                                    void openRunDetail(
                                      selectedRunLog.runId,
                                      selectedScope,
                                    )
                                  }
                                  className="h-7 rounded-lg px-2 text-xs text-slate-400 hover:bg-slate-900 hover:text-white"
                                >
                                  <FileJson className="h-3.5 w-3.5" />
                                  Details
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  aria-label="Close Ralph run log"
                                  title="Close Ralph run log"
                                  onClick={() => setSelectedRunLog(null)}
                                  className="h-7 w-7 rounded-lg text-slate-500 hover:bg-slate-900 hover:text-slate-100"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                            <pre
                              className={cn(
                                "max-h-[min(52vh,34rem)] overflow-auto rounded border border-slate-800 bg-slate-950 p-3 font-mono text-[0.72rem] leading-5 text-slate-300",
                                selectedRunLog.kind === "trace"
                                  ? "whitespace-pre"
                                  : "whitespace-pre-wrap",
                              )}
                            >
                              {selectedRunLog.content}
                            </pre>
                          </>
                        ) : (
                          <div className="text-sm text-slate-500">
                            Open a run from History or Details to inspect its readable log or detailed trace.
                          </div>
                        )}
                      </div>
                    ) : null}

                    {message ? (
                      <div
                        className={cn(
                          "break-words border-t border-slate-800 pt-2 text-sm",
                          staleRunMessage ? "text-amber-100" : "text-slate-300",
                        )}
                      >
                        {staleRunMessage ? (
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" />
                            <span className="min-w-0 flex-1">
                              This run references a flow file that no longer exists. Refresh the flow list, then select or save the flow again.
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => {
                                setMessage(null);
                                void refreshFlows();
                              }}
                              className="h-7 rounded-lg border-amber-400/30 bg-amber-500/10 px-2 text-xs text-amber-100 hover:bg-amber-500/15 hover:text-white"
                            >
                              <RefreshCw className="h-3.5 w-3.5" />
                              Refresh
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => setMessage(null)}
                              className="h-7 rounded-lg px-2 text-xs text-slate-400 hover:bg-slate-900 hover:text-white"
                            >
                              Dismiss
                            </Button>
                          </div>
                        ) : (
                          message
                        )}
                      </div>
                    ) : null}
                  </div>
                </ScrollArea>
              </div>
              ) : null}
            </section>
            )}
          </div>
          {renderGenerationInterviewDialog()}
          {renderExpandedEditorDialog()}
    </section>
  );
};
