import {
  applyNodeChanges,
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type OnNodeDrag,
  type ReactFlowInstance,
  type XYPosition,
  getSmoothStepPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  Bell,
  Braces,
  Check,
  ChevronDown,
  CheckCircle2,
  ClipboardCheck,
  ClipboardPaste,
  Copy,
  Download,
  FileJson,
  FilePlus,
  FileSearch,
  FileText,
  GitBranch,
  Globe2,
  History,
  Hourglass,
  LayoutGrid,
  LoaderCircle,
  MessageSquareText,
  Octagon,
  Package,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  RotateCcw,
  Route,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Undo2,
  Variable,
  Wrench,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  createImageInputUnsupportedModelMessage,
  getImageInputMediaTypeForPath,
  getSupportedImageInputExtensions,
  modelSupportsImageInput,
} from "../../../core/model-capabilities.js";
import { normalizeRalphFlowLayout } from "../../../core/ralph-layout.js";
import type {
  RalphAttachmentReference,
  RalphBlockSettings,
  RalphBlockType,
  RalphExecutionOutput,
  RalphFlow,
  RalphFlowBlock,
  RalphFlowEdge,
  RalphFlowRevisionSummary,
  RalphFlowSummary,
  RalphPosition,
  RalphRunResult,
  RalphUtilityCondition,
  RalphUtilityConfig,
  RalphUtilityConditionStyle,
  RalphUtilityType,
  RalphValidationScope,
  RalphVariableType,
} from "../../../core/ralph.js";
import type {
  ReasoningMode,
  RunMode,
  TaskExecutionProgress,
} from "../../../core/types.js";
import {
  getCatalogModelsForProvider,
  getDefaultModelForProvider,
  getProviderLabel,
  type CatalogModel,
  type ProviderModelCatalogSnapshot,
  type RuntimeProvider,
} from "../model-catalog";
import {
  cancelDesktopTask,
  createRalphFlow,
  deleteRalphFlow,
  listRalphFlowRevisions,
  listRalphFlows,
  loadActiveDesktopTasks,
  loadProviderModelCatalog,
  resolveDroppedPaths,
  restoreRalphFlowRevision,
  runRalphFlow,
  saveRalphFlow,
  showRalphFlow,
  subscribeToDesktopTaskProgress,
  type ActiveDesktopTaskSummary,
  type DroppedPathEntry,
  type RalphCreateFlowResult,
} from "../runtime";
import type { ChatSessionContextAttachment } from "../chat-session.model";
import { Button } from "../components/ui/button";
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

export interface RalphFlowEditorProps {
  workspaceRoot: string | null;
  initialPrompt?: string;
  isActive?: boolean;
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
}

type RalphNodeData = {
  block: RalphFlowBlock;
  outputs: RalphExecutionOutput[];
  issueCount: number;
  active: boolean;
  selected: boolean;
};

type RalphCanvasNode = Node<RalphNodeData, "ralphBlock">;
type RalphEdgeData = {
  output: RalphExecutionOutput;
};
type RalphCanvasEdge = Edge<RalphEdgeData, "ralphRoute">;

type LocalIssue = {
  level: "error" | "warning";
  message: string;
  blockId?: string;
  output?: RalphExecutionOutput;
};
type RalphEditorMode = "design" | "generate" | "run" | "review";
type RalphAiTarget = "flow" | "prompt-block" | "refactor";
type RalphAiGenerationMode = "do-it" | "interview";
type ActiveRalphRunStatus = "running" | "stopping";
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

interface ActiveRalphRun {
  id: string;
  flowId: string;
  flowName: string;
  startedAt: number;
  status: ActiveRalphRunStatus;
  currentBlockId?: string;
  currentBlockTitle?: string;
  lastEventType?: string;
  lastOutput?: string;
}

interface RalphGenerationJob {
  id: string;
  target: RalphAiTarget;
  mode: RalphAiGenerationMode;
  targetFlowId: string | null;
  targetAlias: string;
  startedAt: number;
  status: RalphGenerationStatus;
  summary: string;
  result?: RalphCreateFlowResult;
  error?: string;
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
  { type: "UTILITY", label: "Utility" },
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
  "GIT_STATUS",
  "SET_VARIABLE",
  "TRANSFORM_JSON",
  "VALIDATE_JSON",
  "NOTIFY",
];

const UTILITY_TYPE_LABELS: Record<RalphUtilityType, string> = {
  WAIT: "Wait",
  HTTP_FETCH: "HTTP Fetch",
  POLL: "Poll",
  RUN_COMMAND: "Run Command",
  READ_FILE: "Read File",
  WRITE_FILE: "Write File",
  SEARCH_FILES: "Search Files",
  RUN_CHECK: "Run Check",
  GIT_STATUS: "Git Status",
  SET_VARIABLE: "Set Variable",
  TRANSFORM_JSON: "Transform JSON",
  VALIDATE_JSON: "Validate JSON",
  NOTIFY: "Notify",
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

type RalphProviderOption = (typeof PROVIDER_OPTIONS)[number];

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

const RALPH_CANVAS_COLUMNS = 2;
const RALPH_CANVAS_X_START = 80;
const RALPH_CANVAS_Y_START = 120;
const RALPH_CANVAS_X_GAP = 420;
const RALPH_CANVAS_Y_GAP = 160;
const PLACEHOLDER_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/gu;
const MAX_RALPH_HISTORY_ENTRIES = 80;
const RALPH_CONTEXT_MENU_WIDTH = 224;
const RALPH_CONTEXT_MENU_HEIGHT = 360;
const RALPH_BLOCK_DUPLICATE_OFFSET = 36;

const getDefaultCanvasPosition = (
  index: number,
): { x: number; y: number } => ({
  x: RALPH_CANVAS_X_START + (index % RALPH_CANVAS_COLUMNS) * RALPH_CANVAS_X_GAP,
  y: RALPH_CANVAS_Y_START + Math.floor(index / RALPH_CANVAS_COLUMNS) * RALPH_CANVAS_Y_GAP,
});

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

const createFlowId = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
};

const createFlowUuid = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `flow-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
};

const createFlowAlias = createFlowId;

const getFlowAlias = (flow: Pick<RalphFlow, "id" | "alias">): string => {
  return flow.alias?.trim() || flow.id;
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

const forceRalphFlowLayout = (flow: RalphFlow): RalphFlow => {
  const withoutPositions: RalphFlow = {
    ...flow,
    blocks: flow.blocks.map((block) => {
      const copy = { ...block } as RalphFlowBlock;
      delete copy.position;
      return copy;
    }),
  };

  return normalizeRalphFlowLayout(withoutPositions);
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

const formatFlowSubtitle = (flow: RalphFlowSummary): string => {
  return flow.alias ?? flow.id;
};

const formatRouteTargetLabel = (block: RalphFlowBlock): string => {
  return `${block.title} [${block.type}]`;
};

const formatRouteOptionTargetLabel = (
  sourceBlock: RalphFlowBlock,
  targetBlock: RalphFlowBlock,
): string => {
  const targetLabel = formatRouteTargetLabel(targetBlock);

  return sourceBlock.id === targetBlock.id ? `Self (${targetLabel})` : targetLabel;
};

const formatProviderOptionLabel = (provider: RalphProviderOption): string => {
  return provider === "default" ? "Default" : getProviderLabel(provider);
};

const formatUtilityTypeLabel = (type: RalphUtilityType): string => {
  return UTILITY_TYPE_LABELS[type];
};

const formatValidationScopeLabel = (
  mode: RalphValidationScope["mode"],
): string => {
  switch (mode) {
    case "sinceLastValidator":
      return "Since last validator";
    case "previousBlock":
      return "Previous block";
    case "selectedBlocks":
      return "Selected blocks";
    case "wholeFlow":
      return "Whole flow";
  }
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

const getUtilityOutputs = (
  utility: RalphUtilityConfig,
): RalphExecutionOutput[] => {
  switch (utility.type) {
    case "WAIT":
    case "SET_VARIABLE":
    case "NOTIFY":
      return ["SUCCESS"];
    case "HTTP_FETCH":
      return ["SUCCESS", "HTTP_ERROR", "TIMEOUT", "ERROR"];
    case "POLL":
      return utility.maxAttempts === null || utility.maxAttempts === undefined
        ? ["SUCCESS", "ERROR"]
        : ["SUCCESS", "TIMEOUT", "ERROR"];
    case "RUN_COMMAND":
    case "READ_FILE":
    case "WRITE_FILE":
    case "GIT_STATUS":
    case "TRANSFORM_JSON":
      return ["SUCCESS", "ERROR"];
    case "SEARCH_FILES":
      return ["SUCCESS", "EMPTY", "ERROR"];
    case "RUN_CHECK":
      return ["SUCCESS", "FAILED", "ERROR"];
    case "VALIDATE_JSON":
      return ["SUCCESS", "INVALID", "ERROR"];
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

const formatCatalogModelLabel = (
  models: CatalogModel[],
  modelId: string,
): string => {
  return models.find((model) => model.id === modelId)?.label ?? modelId;
};

const formatUnconnectedRouteLabel = (
  block: RalphFlowBlock,
  output: RalphExecutionOutput,
): string => {
  return block.type === "VALIDATOR" && output === "RETRY"
    ? "Auto retry group"
    : "Unconnected";
};

const titleFromId = (id: string): string => {
  const words = id
    .replace(/-/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);

  return words.length > 0
    ? words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ")
    : "Ralph Flow";
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

const formatRunMessage = (run: RalphRunResult): string => {
  return `${run.summary} Status: ${run.status}. ${run.blockResults.length} block result${run.blockResults.length === 1 ? "" : "s"}.`;
};

const createRalphRunTaskId = (flowId: string): string => {
  const safeFlowId = createFlowId(flowId) || "flow";

  return `ralph-${safeFlowId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

const parseRalphRunTaskId = (
  taskId: string,
): { flowId: string; startedAt: number } | null => {
  const match = /^ralph-(.+)-(\d+)-[a-z0-9]+$/u.exec(taskId.trim());

  if (!match) {
    return null;
  }

  const flowId = match[1];
  const startedAt = Number(match[2]);

  if (!flowId || !Number.isFinite(startedAt)) {
    return null;
  }

  return { flowId, startedAt };
};

const normalizeWorkspaceForTaskComparison = (workspaceRoot: string | null): string => {
  return (workspaceRoot ?? "")
    .trim()
    .replace(/\\/gu, "/")
    .replace(/\/{2,}/gu, "/")
    .toLowerCase();
};

const getRalphArgumentValue = (
  argumentsList: string[],
  flag: string,
): string | null => {
  const index = argumentsList.indexOf(flag);

  return index >= 0 ? argumentsList[index + 1]?.trim() || null : null;
};

const getRalphTaskAction = (task: ActiveDesktopTaskSummary): string | null => {
  return task.arguments[0]?.trim() || null;
};

const getRalphTaskFlowReference = (
  task: ActiveDesktopTaskSummary,
): string | null => {
  const action = getRalphTaskAction(task);

  if (action === "run") {
    return task.arguments[1]?.trim() || null;
  }

  if (action === "create") {
    return getRalphArgumentValue(task.arguments, "--name");
  }

  return null;
};

const ACTIVE_TASK_REGISTRATION_GRACE_MS = 5_000;

type RalphProgressMetadata =
  NonNullable<TaskExecutionProgress["timelineEvent"]>["metadata"];

interface RalphProgressSnapshot {
  eventType: string;
  activeBlockId?: string;
  activeBlockTitle?: string;
  output?: string;
}

const RALPH_PROGRESS_EVENT_TYPES = new Set([
  "block-start",
  "block-output",
  "edge-route",
  "retry",
  "crash",
  "end",
]);

const getProgressMetadataString = (
  metadata: RalphProgressMetadata | undefined,
  key: string,
): string | undefined => {
  const value = metadata?.[key];

  return typeof value === "string" && value.trim() ? value : undefined;
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
  const activeBlockTitle =
    getProgressMetadataString(metadata, "ralphActiveBlockTitle") ??
    getProgressMetadataString(metadata, "ralphBlockTitle") ??
    activeBlockId;

  return {
    eventType,
    ...(activeBlockId ? { activeBlockId } : {}),
    ...(activeBlockTitle ? { activeBlockTitle } : {}),
    ...(getProgressMetadataString(metadata, "ralphOutput")
      ? { output: getProgressMetadataString(metadata, "ralphOutput") }
      : {}),
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

interface RalphBlockVisual {
  icon: LucideIcon;
  nodeClassName: string;
  badgeClassName: string;
  miniMapColor: string;
  badgeLabel: string;
}

interface RalphNodePreview {
  primary: string;
  secondary?: string;
  chips: string[];
}

const getBlockTone = (type: RalphBlockType): RalphBlockVisual => {
  switch (type) {
    case "START":
      return {
        icon: Play,
        nodeClassName: "border-emerald-400/55 bg-emerald-950 text-emerald-50",
        badgeClassName: "text-emerald-300",
        miniMapColor: "#34d399",
        badgeLabel: "START",
      };
    case "PROMPT":
      return {
        icon: MessageSquareText,
        nodeClassName: "border-sky-400/55 bg-sky-950 text-sky-50",
        badgeClassName: "text-sky-300",
        miniMapColor: "#38bdf8",
        badgeLabel: "PROMPT",
      };
    case "VALIDATOR":
      return {
        icon: ShieldCheck,
        nodeClassName: "border-lime-400/55 bg-lime-950 text-lime-50",
        badgeClassName: "text-lime-300",
        miniMapColor: "#a3e635",
        badgeLabel: "VALIDATE",
      };
    case "DECISION":
      return {
        icon: GitBranch,
        nodeClassName: "border-fuchsia-400/55 bg-fuchsia-950 text-fuchsia-50",
        badgeClassName: "text-fuchsia-300",
        miniMapColor: "#e879f9",
        badgeLabel: "DECIDE",
      };
    case "PACK":
      return {
        icon: Package,
        nodeClassName: "border-amber-400/55 bg-amber-950 text-amber-50",
        badgeClassName: "text-amber-300",
        miniMapColor: "#fbbf24",
        badgeLabel: "PACK",
      };
    case "UTILITY":
      return {
        icon: Wrench,
        nodeClassName: "border-cyan-400/55 bg-cyan-950 text-cyan-50",
        badgeClassName: "text-cyan-300",
        miniMapColor: "#22d3ee",
        badgeLabel: "UTILITY",
      };
    case "MCP_TOOL":
    case "MCP_RESOURCE":
    case "MCP_PROMPT":
      return {
        icon: Globe2,
        nodeClassName: "border-violet-400/55 bg-violet-950 text-violet-50",
        badgeClassName: "text-violet-300",
        miniMapColor: "#a78bfa",
        badgeLabel: "MCP",
      };
    case "END":
      return {
        icon: Octagon,
        nodeClassName: "border-slate-600 bg-slate-900 text-slate-100",
        badgeClassName: "text-slate-400",
        miniMapColor: "#64748b",
        badgeLabel: "END",
      };
  }
};

const getUtilityTone = (type: RalphUtilityType): RalphBlockVisual => {
  switch (type) {
    case "WAIT":
      return {
        icon: Hourglass,
        nodeClassName: "border-teal-400/60 bg-teal-950 text-teal-50",
        badgeClassName: "text-teal-200",
        miniMapColor: "#2dd4bf",
        badgeLabel: "WAIT",
      };
    case "HTTP_FETCH":
      return {
        icon: Download,
        nodeClassName: "border-blue-400/60 bg-blue-950 text-blue-50",
        badgeClassName: "text-blue-200",
        miniMapColor: "#60a5fa",
        badgeLabel: "FETCH",
      };
    case "POLL":
      return {
        icon: RefreshCw,
        nodeClassName: "border-cyan-400/60 bg-cyan-950 text-cyan-50",
        badgeClassName: "text-cyan-200",
        miniMapColor: "#22d3ee",
        badgeLabel: "POLL",
      };
    case "RUN_COMMAND":
      return {
        icon: Terminal,
        nodeClassName: "border-zinc-400/60 bg-zinc-900 text-zinc-50",
        badgeClassName: "text-zinc-200",
        miniMapColor: "#a1a1aa",
        badgeLabel: "COMMAND",
      };
    case "READ_FILE":
      return {
        icon: FileText,
        nodeClassName: "border-sky-400/60 bg-sky-950 text-sky-50",
        badgeClassName: "text-sky-200",
        miniMapColor: "#38bdf8",
        badgeLabel: "READ",
      };
    case "WRITE_FILE":
      return {
        icon: FilePlus,
        nodeClassName: "border-orange-400/60 bg-orange-950 text-orange-50",
        badgeClassName: "text-orange-200",
        miniMapColor: "#fb923c",
        badgeLabel: "WRITE",
      };
    case "SEARCH_FILES":
      return {
        icon: FileSearch,
        nodeClassName: "border-purple-400/60 bg-purple-950 text-purple-50",
        badgeClassName: "text-purple-200",
        miniMapColor: "#c084fc",
        badgeLabel: "SEARCH",
      };
    case "RUN_CHECK":
      return {
        icon: ClipboardCheck,
        nodeClassName: "border-lime-400/60 bg-lime-950 text-lime-50",
        badgeClassName: "text-lime-200",
        miniMapColor: "#a3e635",
        badgeLabel: "CHECK",
      };
    case "GIT_STATUS":
      return {
        icon: GitBranch,
        nodeClassName: "border-amber-400/60 bg-amber-950 text-amber-50",
        badgeClassName: "text-amber-200",
        miniMapColor: "#f59e0b",
        badgeLabel: "GIT",
      };
    case "SET_VARIABLE":
      return {
        icon: Variable,
        nodeClassName: "border-pink-400/60 bg-pink-950 text-pink-50",
        badgeClassName: "text-pink-200",
        miniMapColor: "#f472b6",
        badgeLabel: "SET VAR",
      };
    case "TRANSFORM_JSON":
      return {
        icon: Braces,
        nodeClassName: "border-violet-400/60 bg-violet-950 text-violet-50",
        badgeClassName: "text-violet-200",
        miniMapColor: "#a78bfa",
        badgeLabel: "JSON MAP",
      };
    case "VALIDATE_JSON":
      return {
        icon: FileJson,
        nodeClassName: "border-green-400/60 bg-green-950 text-green-50",
        badgeClassName: "text-green-200",
        miniMapColor: "#4ade80",
        badgeLabel: "SCHEMA",
      };
    case "NOTIFY":
      return {
        icon: Bell,
        nodeClassName: "border-rose-400/60 bg-rose-950 text-rose-50",
        badgeClassName: "text-rose-200",
        miniMapColor: "#fb7185",
        badgeLabel: "NOTIFY",
      };
  }
};

const getBlockVisual = (block: RalphFlowBlock): RalphBlockVisual => {
  return block.type === "UTILITY"
    ? getUtilityTone(block.utility.type)
    : getBlockTone(block.type);
};

const getBlockOutputs = (block: RalphFlowBlock): RalphExecutionOutput[] => {
  switch (block.type) {
    case "START":
      return ["SUCCESS"];
    case "PROMPT":
    case "PACK":
    case "MCP_TOOL":
    case "MCP_RESOURCE":
    case "MCP_PROMPT":
      return ["SUCCESS", "ERROR"];
    case "UTILITY":
      return getUtilityOutputs(block.utility);
    case "VALIDATOR":
      return ["DONE", "CONTINUE", "RETRY", "ERROR"];
    case "DECISION":
      return [...new Set([...block.labels, "ERROR"])];
    case "END":
      return [];
  }
};

const getPromptLikeText = (block: RalphFlowBlock): string => {
  switch (block.type) {
    case "PROMPT":
    case "VALIDATOR":
    case "DECISION":
      return block.prompt;
    case "START":
    case "PACK":
    case "END":
      return "";
    case "UTILITY":
      return formatUtilityTypeLabel(block.utility.type);
    case "MCP_TOOL":
      return [block.serverId, block.toolName].filter(Boolean).join(".");
    case "MCP_RESOURCE":
      return block.uri;
    case "MCP_PROMPT":
      return [block.serverId, block.promptName].filter(Boolean).join(".");
  }
};

const compactPreviewText = (
  value: string | undefined | null,
  fallback: string,
): string => {
  const normalized = value?.replace(/\s+/gu, " ").trim();

  return normalized ? normalized : fallback;
};

const formatSeconds = (value: number | null | undefined): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "not set";
  }

  if (value >= 60 && value % 60 === 0) {
    return `${value / 60}m`;
  }

  return `${value}s`;
};

const formatMaxBytes = (value: number | null | undefined): string => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "unlimited output";
  }

  if (value >= 1_000_000) {
    return `${Math.round(value / 100_000) / 10} MB output`;
  }

  if (value >= 1_000) {
    return `${Math.round(value / 100) / 10} KB output`;
  }

  return `${value} B output`;
};

const formatUtilityConditionSummary = (
  condition: RalphUtilityCondition | undefined,
): string => {
  if (!condition) {
    return "No condition configured";
  }

  if (condition.style === "json-path") {
    const path = compactPreviewText(condition.path, "$");
    const operator = condition.operator
      ? titleFromId(condition.operator)
      : "Matches";
    const value = compactPreviewText(condition.value, "");

    return value ? `JSON ${path} ${operator} ${value}` : `JSON ${path} ${operator}`;
  }

  const expression = compactPreviewText(condition.expression, "No expression");

  return condition.style === "javascript"
    ? `JS ${expression}`
    : `When ${expression}`;
};

const getUtilityNodePreview = (
  utility: RalphUtilityConfig,
): RalphNodePreview => {
  switch (utility.type) {
    case "WAIT": {
      const mode = utility.mode ?? "delay";
      if (mode === "until-time") {
        return {
          primary: `Wait until ${compactPreviewText(utility.runAt, "a configured time")}`,
          secondary: "Schedules the next block after the target time.",
          chips: ["single success route"],
        };
      }

      if (mode === "condition" || mode === "poll") {
        return {
          primary:
            mode === "poll" ? "Poll until condition passes" : "Wait for condition",
          secondary: formatUtilityConditionSummary(utility.condition),
          chips: [`every ${formatSeconds(utility.intervalSeconds ?? 30)}`],
        };
      }

      return {
        primary: `Delay for ${formatSeconds(utility.delaySeconds ?? 0)}`,
        secondary: "Pauses the flow, then continues.",
        chips: ["single success route"],
      };
    }
    case "HTTP_FETCH":
      return {
        primary: `${utility.method ?? "GET"} ${compactPreviewText(utility.url, "URL not set")}`,
        secondary: utility.outputPath
          ? `Stores response in ${utility.outputPath}`
          : "Returns status, headers, and body.",
        chips: [
          `${formatSeconds(utility.timeoutSeconds ?? 30)} timeout`,
          formatMaxBytes(utility.maxOutputBytes),
        ],
      };
    case "POLL":
      return {
        primary: `${utility.method ?? "GET"} ${compactPreviewText(utility.url, "URL not set")}`,
        secondary: formatUtilityConditionSummary(utility.condition),
        chips: [
          `every ${formatSeconds(utility.intervalSeconds ?? 30)}`,
          utility.maxAttempts === null || utility.maxAttempts === undefined
            ? "endless"
            : `${utility.maxAttempts} attempts`,
        ],
      };
    case "RUN_COMMAND":
      return {
        primary: compactPreviewText(utility.command, "Command not set"),
        secondary: utility.cwd ? `Working dir: ${utility.cwd}` : "Runs in the block workspace.",
        chips: [`${formatSeconds(utility.timeoutSeconds ?? 120)} timeout`],
      };
    case "RUN_CHECK":
      return {
        primary: compactPreviewText(utility.command, "Check command not set"),
        secondary: "Failed exit codes route to FAILED.",
        chips: [`${formatSeconds(utility.timeoutSeconds ?? 120)} timeout`],
      };
    case "READ_FILE":
      return {
        primary: `Read ${compactPreviewText(utility.path, "file path not set")}`,
        secondary: "Makes file content available to later blocks.",
        chips: utility.encoding ? [utility.encoding] : [],
      };
    case "WRITE_FILE":
      return {
        primary: `${utility.append ? "Append" : "Write"} ${compactPreviewText(
          utility.path,
          "file path not set",
        )}`,
        secondary: compactPreviewText(utility.content, "Content not set"),
        chips: utility.encoding ? [utility.encoding] : [],
      };
    case "SEARCH_FILES":
      return {
        primary: utility.glob
          ? `Glob ${utility.glob}`
          : `Find ${compactPreviewText(utility.pattern, "pattern not set")}`,
        secondary: `Root: ${compactPreviewText(utility.rootPath, ".")}`,
        chips: utility.maxResults ? [`max ${utility.maxResults}`] : [],
      };
    case "GIT_STATUS":
      return {
        primary: "git status --short",
        secondary: `Repository: ${compactPreviewText(utility.cwd, ".")}`,
        chips: [],
      };
    case "SET_VARIABLE":
      return {
        primary: `Set ${compactPreviewText(utility.variableName, "variable name")}`,
        secondary: compactPreviewText(utility.value, "Value not set"),
        chips: [],
      };
    case "TRANSFORM_JSON":
      return {
        primary: "Transform JSON",
        secondary: compactPreviewText(utility.expression, "Expression not set"),
        chips: utility.input ? [`input ${utility.input}`] : [],
      };
    case "VALIDATE_JSON":
      return {
        primary: "Validate JSON schema",
        secondary:
          utility.schema === undefined ? "Schema not set" : "Schema configured",
        chips: utility.input ? [`input ${utility.input}`] : [],
      };
    case "NOTIFY":
      return {
        primary: compactPreviewText(utility.message, "Notification message not set"),
        secondary: "Shows an execution notification.",
        chips: [],
      };
  }
};

const getBlockSettingsPreviewChips = (
  settings: RalphBlockSettings | undefined,
): string[] => {
  const chips: string[] = [];

  if (settings?.provider && settings.provider !== "default") {
    chips.push(getProviderLabel(settings.provider));
  }

  if (settings?.model && settings.model !== "default") {
    chips.push(settings.model);
  }

  if (settings?.reasoning && settings.reasoning !== "default") {
    chips.push(`${REASONING_LABELS[settings.reasoning]} reasoning`);
  }

  if (settings?.webAccess === false) {
    chips.push("no web");
  }

  if (settings?.fileAccess === false) {
    chips.push("no files");
  }

  const attachments = settings?.attachments?.length ?? 0;
  if (attachments > 0) {
    chips.push(`${attachments} attachment${attachments === 1 ? "" : "s"}`);
  }

  return chips;
};

const getBlockNodePreview = (block: RalphFlowBlock): RalphNodePreview => {
  if (block.type === "UTILITY") {
    return getUtilityNodePreview(block.utility);
  }

  if (block.type === "START") {
    return {
      primary: "Start execution",
      secondary: "Entry point for this flow.",
      chips: ["single start"],
    };
  }

  if (block.type === "PACK") {
    return {
      primary:
        block.packIds.length > 0
          ? block.packIds.join(", ")
          : "No packs selected",
      secondary: titleFromId(block.propagationMode),
      chips: [],
    };
  }

  if (block.type === "END") {
    return {
      primary: `${titleFromId(block.status ?? "success")} end`,
      secondary: "Stops the current flow run.",
      chips: [],
    };
  }

  const promptText = getPromptLikeText(block);

  if (block.type === "VALIDATOR") {
    return {
      primary: compactPreviewText(promptText, block.id),
      secondary: `Scope: ${titleFromId(block.validationScope?.mode ?? "sinceLastValidator")}`,
      chips: ["DONE", "CONTINUE", "RETRY", "ERROR", ...getBlockSettingsPreviewChips(block.settings)],
    };
  }

  if (block.type === "DECISION") {
    return {
      primary: compactPreviewText(promptText, block.id),
      secondary: "Routes by decision label.",
      chips: [...block.labels, "ERROR", ...getBlockSettingsPreviewChips(block.settings)],
    };
  }

  if (block.type === "MCP_TOOL") {
    return {
      primary: compactPreviewText(promptText, "MCP tool not selected"),
      secondary: "Calls an MCP server tool.",
      chips: block.arguments ? ["arguments"] : [],
    };
  }

  if (block.type === "MCP_RESOURCE") {
    return {
      primary: compactPreviewText(promptText, "MCP resource not selected"),
      secondary: compactPreviewText(block.serverId, "Server not set"),
      chips: [],
    };
  }

  if (block.type === "MCP_PROMPT") {
    return {
      primary: compactPreviewText(promptText, "MCP prompt not selected"),
      secondary: "Fetches a reusable MCP prompt.",
      chips: block.arguments ? ["arguments"] : [],
    };
  }

  return {
    primary: compactPreviewText(promptText, block.id),
    chips: getBlockSettingsPreviewChips(block.settings),
  };
};

const updatePromptLikeText = (
  block: RalphFlowBlock,
  prompt: string,
): RalphFlowBlock => {
  switch (block.type) {
    case "PROMPT":
    case "VALIDATOR":
    case "DECISION":
      return { ...block, prompt };
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

const createBlankFlow = (alias: string): RalphFlow => {
  const flowAlias = createFlowAlias(alias);
  const flowId = createFlowUuid();
  const now = new Date().toISOString();

  return {
    schemaVersion: 1,
    id: flowId,
    ...(flowAlias ? { alias: flowAlias } : {}),
    name: titleFromId(flowAlias || "ralph-flow"),
    description: "",
    createdAt: now,
    updatedAt: now,
    variables: [],
    blocks: [
      {
        id: "start",
        type: "START",
        title: "Start",
        position: getDefaultCanvasPosition(0),
      },
      {
        id: "end",
        type: "END",
        title: "End",
        position: getDefaultCanvasPosition(1),
        status: "success",
      },
    ],
    edges: [
      {
        id: "start-success-end",
        from: "start",
        fromOutput: "SUCCESS",
        to: "end",
      },
    ],
  };
};

const flowToSummary = (flow: RalphFlow, path = ""): RalphFlowSummary => {
  return {
    id: flow.id,
    alias: flow.alias,
    name: flow.name,
    path,
    description: flow.description,
    blockCount: flow.blocks.length,
    edgeCount: flow.edges.length,
    variableCount: flow.variables?.length ?? 0,
  };
};

const upsertFlowSummary = (
  flows: RalphFlowSummary[],
  summary: RalphFlowSummary,
): RalphFlowSummary[] => {
  const withoutExisting = flows.filter((flow) => flow.id !== summary.id);

  return [summary, ...withoutExisting].sort((left, right) =>
    (left.alias ?? left.name ?? left.id).localeCompare(
      right.alias ?? right.name ?? right.id,
    ),
  );
};

const isFlowAliasUsed = (
  flows: RalphFlowSummary[],
  alias: string,
  currentFlowId?: string,
): boolean => {
  const normalizedAlias = createFlowAlias(alias);

  if (!normalizedAlias) {
    return false;
  }

  return flows.some((flow) => {
    if (flow.id === currentFlowId) {
      return false;
    }

    return (
      createFlowAlias(flow.alias ?? "") === normalizedAlias ||
      createFlowAlias(flow.id) === normalizedAlias
    );
  });
};

const createUniqueFlowAlias = (
  baseAlias: string,
  flows: RalphFlowSummary[],
): string => {
  const base = createFlowAlias(baseAlias) || "ralph-flow";

  if (!isFlowAliasUsed(flows, base)) {
    return base;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = createFlowAlias(`${base}-${index}`);

    if (!isFlowAliasUsed(flows, candidate)) {
      return candidate;
    }
  }

  return createFlowAlias(`${base}-${Date.now()}`);
};

const getReachableBlockIds = (flow: RalphFlow): Set<string> => {
  const reachable = new Set<string>();
  const starts = flow.blocks.filter((block) => block.type === "START");
  const pending = starts.map((block) => block.id);

  while (pending.length > 0) {
    const current = pending.shift();

    if (!current || reachable.has(current)) {
      continue;
    }

    reachable.add(current);
    for (const edge of flow.edges.filter((candidate) => candidate.from === current)) {
      pending.push(edge.to);
    }
  }

  return reachable;
};

const validateFlowLocally = (
  flow: RalphFlow,
  modelCatalog: ProviderModelCatalogSnapshot | null,
  flowSummaries: RalphFlowSummary[],
): LocalIssue[] => {
  const issues: LocalIssue[] = [];
  const blockIds = new Set<string>();
  const startBlocks = flow.blocks.filter((block) => block.type === "START");
  const endBlocks = flow.blocks.filter((block) => block.type === "END");
  const alias = createFlowAlias(flow.alias ?? "");

  if (flow.alias && !alias) {
    issues.push({
      level: "error",
      message: "Flow alias cannot be empty.",
    });
  } else if (alias && isFlowAliasUsed(flowSummaries, alias, flow.id)) {
    issues.push({
      level: "error",
      message: `Flow alias ${alias} is already used by another flow.`,
    });
  }

  if (startBlocks.length !== 1) {
    issues.push({
      level: "error",
      message: "Flow must contain exactly one START block.",
    });
  }

  if (endBlocks.length === 0) {
    issues.push({
      level: "warning",
      message: "Flow has no END block.",
    });
  }

  for (const block of flow.blocks) {
    if (blockIds.has(block.id)) {
      issues.push({
        level: "error",
        message: `Block id ${block.id} is duplicated.`,
        blockId: block.id,
      });
    }

    blockIds.add(block.id);

    if (
      (block.type === "PROMPT" ||
        block.type === "VALIDATOR" ||
        block.type === "DECISION") &&
      !block.prompt.trim()
    ) {
      issues.push({
        level: "error",
        message: `${block.title} has an empty prompt.`,
        blockId: block.id,
      });
    }

    if (block.type === "DECISION" && block.labels.length === 0) {
      issues.push({
        level: "error",
        message: `${block.title} needs at least one decision label.`,
        blockId: block.id,
      });
    }

    if (block.type === "PACK" && block.packIds.length === 0) {
      issues.push({
        level: "warning",
        message: `${block.title} has no packs selected.`,
        blockId: block.id,
      });
    }

    if (
      block.type === "VALIDATOR" &&
      block.validationScope?.mode === "selectedBlocks" &&
      (block.validationScope.blockIds ?? []).length === 0
    ) {
      issues.push({
        level: "warning",
        message: `${block.title} validates selected blocks but none are selected.`,
        blockId: block.id,
      });
    }

    if (block.type === "MCP_TOOL") {
      if (!block.serverId.trim()) {
        issues.push({
          level: "error",
          message: `${block.title} requires an MCP server.`,
          blockId: block.id,
        });
      }

      if (!block.toolName.trim()) {
        issues.push({
          level: "error",
          message: `${block.title} requires an MCP tool name.`,
          blockId: block.id,
        });
      }
    }

    if (block.type === "MCP_RESOURCE") {
      if (!block.serverId.trim()) {
        issues.push({
          level: "error",
          message: `${block.title} requires an MCP server.`,
          blockId: block.id,
        });
      }

      if (!block.uri.trim()) {
        issues.push({
          level: "error",
          message: `${block.title} requires a resource URI.`,
          blockId: block.id,
        });
      }
    }

    if (block.type === "MCP_PROMPT") {
      if (!block.serverId.trim()) {
        issues.push({
          level: "error",
          message: `${block.title} requires an MCP server.`,
          blockId: block.id,
        });
      }

      if (!block.promptName.trim()) {
        issues.push({
          level: "error",
          message: `${block.title} requires an MCP prompt name.`,
          blockId: block.id,
        });
      }
    }

    if (block.settings?.model) {
      const provider =
        block.settings.provider && block.settings.provider !== "default"
          ? block.settings.provider
          : null;
      const providerCatalog = provider
        ? modelCatalog?.providers.find((entry) => entry.provider === provider)
        : null;

      if (provider && providerCatalog && !providerCatalog.available) {
        issues.push({
          level: "warning",
          message: `${block.title} uses unavailable provider ${provider}.`,
          blockId: block.id,
        });
      } else if (
        providerCatalog &&
        providerCatalog.models.length > 0 &&
        !providerCatalog.models.some((model) => model.id === block.settings?.model)
      ) {
        issues.push({
          level: "warning",
          message: `${block.title} uses unavailable model ${block.settings.model}.`,
          blockId: block.id,
        });
      }
    }

    for (const output of getBlockOutputs(block)) {
      if (block.type === "VALIDATOR" && output === "RETRY") {
        continue;
      }

      if (
        !flow.edges.some(
          (edge) => edge.from === block.id && edge.fromOutput === output,
        )
      ) {
        issues.push({
          level: "warning",
          message: `${block.title} does not route ${output}.`,
          blockId: block.id,
          output,
        });
      }
    }
  }

  for (const edge of flow.edges) {
    if (!blockIds.has(edge.from)) {
      issues.push({
        level: "error",
        message: `Edge ${edge.id} references missing source ${edge.from}.`,
        blockId: edge.from,
      });
    }

    if (!blockIds.has(edge.to)) {
      issues.push({
        level: "error",
        message: `Edge ${edge.id} references missing target ${edge.to}.`,
        blockId: edge.to,
      });
    }
  }

  const reachable = getReachableBlockIds(flow);

  for (const block of flow.blocks) {
    if (startBlocks.length === 1 && !reachable.has(block.id)) {
      issues.push({
        level: "warning",
        message: `${block.title} is unreachable from START.`,
        blockId: block.id,
      });
    }
  }

  return issues;
};

const flowToNodes = (
  flow: RalphFlow,
  issues: LocalIssue[],
  selectedBlockId: string | null,
  activeBlockId: string | null,
): RalphCanvasNode[] => {
  return flow.blocks.map((block, index) => ({
    id: block.id,
    type: "ralphBlock",
    position: block.position ?? getDefaultCanvasPosition(index),
    data: {
      block,
      outputs: getBlockOutputs(block),
      issueCount: issues.filter((issue) => issue.blockId === block.id).length,
      active: block.id === activeBlockId,
      selected: block.id === selectedBlockId,
    },
  }));
};

const flowToEdges = (
  flow: RalphFlow,
  selectedEdgeId: string | null,
): RalphCanvasEdge[] => {
  return flow.edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    sourceHandle: edge.fromOutput,
    target: edge.to,
    type: "ralphRoute",
    data: {
      output: edge.fromOutput,
    },
    markerEnd: {
      type: "arrowclosed",
      color: "#94a3b8",
    },
    style: {
      stroke: edge.fromOutput === "ERROR" ? "#f87171" : "#94a3b8",
      strokeWidth: edge.id === selectedEdgeId ? 2.4 : 1.6,
    },
    selected: edge.id === selectedEdgeId,
  }));
};

const getPathName = (path: string): string => {
  const name = path.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1);

  return name?.trim() || path;
};

const getPathParent = (path: string): string | undefined => {
  const lastSeparatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));

  if (lastSeparatorIndex <= 0) {
    return undefined;
  }

  return path.slice(0, lastSeparatorIndex);
};

const normalizeRalphAttachmentKind = (
  value: DroppedPathEntry["kind"] | RalphAttachmentReference["kind"] | undefined,
  path: string,
): RalphAttachmentReference["kind"] => {
  if (value === "directory" || value === "file" || value === "image") {
    return value;
  }

  if (getImageInputMediaTypeForPath(path)) {
    return "image";
  }

  return value === "other" ? "other" : "file";
};

const createRalphPathAttachment = (
  entry: DroppedPathEntry,
): RalphAttachmentReference => {
  const kind = normalizeRalphAttachmentKind(entry.kind, entry.path);
  const mediaType = getImageInputMediaTypeForPath(entry.path);

  return {
    id: crypto.randomUUID(),
    source: "path",
    value: entry.path,
    kind,
    ...(mediaType ? { mediaType } : {}),
  };
};

const createRalphPathAttachmentPreview = (
  attachment: RalphAttachmentReference,
  index: number,
): ChatSessionContextAttachment => {
  const kind = normalizeRalphAttachmentKind(attachment.kind, attachment.value);
  const parent = getPathParent(attachment.value);

  return {
    id: attachment.id ?? `ralph-path-${index}`,
    path: attachment.value,
    kind,
    name: getPathName(attachment.value),
    ...(parent ? { parent } : {}),
  };
};

const getRalphPathAttachmentPreviews = (
  attachments: RalphAttachmentReference[] | undefined,
): ChatSessionContextAttachment[] => {
  return (attachments ?? [])
    .filter((attachment) => attachment.source === "path")
    .map(createRalphPathAttachmentPreview);
};

const getRalphVariableAttachmentItems = (
  attachments: RalphAttachmentReference[] | undefined,
): Array<{ attachment: RalphAttachmentReference; key: string }> => {
  return (attachments ?? []).flatMap((attachment, index) =>
    attachment.source === "variable"
      ? [
          {
            attachment,
            key: attachment.id ?? `ralph-variable-${index}`,
          },
        ]
      : [],
  );
};

const mergeRalphAttachments = (
  existing: RalphAttachmentReference[],
  incoming: RalphAttachmentReference[],
): RalphAttachmentReference[] => {
  const seen = new Set(
    existing.map((attachment) =>
      `${attachment.source}:${attachment.value.trim().toLowerCase()}`,
    ),
  );
  const merged = [...existing];

  for (const attachment of incoming) {
    const key = `${attachment.source}:${attachment.value.trim().toLowerCase()}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(attachment);
  }

  return merged;
};

const getSelectableRouteTargets = (flow: RalphFlow): RalphFlowBlock[] => {
  return flow.blocks;
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

const RalphBlockNode = ({
  data,
  selected,
}: NodeProps<RalphCanvasNode>): JSX.Element => {
  const visual = getBlockVisual(data.block);
  const preview = getBlockNodePreview(data.block);
  const Icon = visual.icon;

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-3 shadow-lg shadow-black/25",
        data.block.type === "UTILITY" ? "w-72" : "w-64",
        visual.nodeClassName,
        (selected || data.selected) && "ring-1 ring-emerald-200/60",
        data.active &&
          "ring-2 ring-lime-300/70 shadow-[0_0_20px_rgba(132,204,22,0.22)]",
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-slate-950 !bg-slate-300"
        style={{ left: 0, transform: "translateY(-50%)" }}
      />
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn("h-4 w-4 shrink-0", visual.badgeClassName)} />
          <span className="truncate text-sm font-semibold">{data.block.title}</span>
        </div>
      </div>
      <div className="mt-2 grid min-h-12 gap-1 text-xs">
        <div className="truncate font-medium text-white/75">
          {preview.primary}
        </div>
        {preview.secondary ? (
          <div className="truncate text-white/50">{preview.secondary}</div>
        ) : null}
      </div>
      {data.issueCount > 0 ? (
        <div className="mt-2 flex items-center gap-1 text-xs font-semibold text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5" />
          {data.issueCount}
        </div>
      ) : null}
      {preview.chips.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {preview.chips.slice(0, 3).map((chip) => (
            <span
              key={chip}
              className="max-w-full truncate rounded border border-white/10 bg-black/20 px-1.5 py-0.5 text-[0.6rem] font-medium leading-3 text-white/60"
            >
              {chip}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-3 grid gap-1.5">
        {data.outputs.map((output) => (
          <div
            key={output}
            className="relative flex min-h-5 items-center justify-end pr-4 text-[0.65rem] font-bold leading-4 tracking-wide text-white/65"
          >
            <span className="min-w-0 truncate">{output}</span>
            <Handle
              id={String(output)}
              type="source"
              position={Position.Right}
              className="!h-2.5 !w-2.5 !border-slate-950"
              style={{
                background: output === "ERROR" ? "#f87171" : "#cbd5e1",
                borderColor: "#020617",
                right: -6,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

const RALPH_NODE_TYPES = {
  ralphBlock: RalphBlockNode,
} satisfies NodeTypes;

const RALPH_EDGE_LABEL_X_OFFSET = 18;

const RalphRouteEdge = ({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  style,
  selected,
  data,
}: EdgeProps<RalphCanvasEdge>): JSX.Element => {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
    offset: 18,
  });
  const output = data?.output ? String(data.output) : "";
  const labelX =
    sourcePosition === Position.Left
      ? sourceX - RALPH_EDGE_LABEL_X_OFFSET
      : sourceX + RALPH_EDGE_LABEL_X_OFFSET;
  const labelAnchor =
    sourcePosition === Position.Left
      ? "translate(-100%, -50%)"
      : "translate(0, -50%)";

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={18}
      />
      {output ? (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "nodrag nopan pointer-events-none absolute max-w-28 rounded border px-1.5 py-0.5 text-[0.625rem] font-bold leading-4 tracking-wide shadow-sm shadow-black/30",
              output === "ERROR"
                ? "border-rose-400/35 bg-rose-950/95 text-rose-100"
                : "border-slate-700 bg-slate-950/95 text-slate-100",
              selected && "ring-1 ring-emerald-300/50",
            )}
            style={{
              transform: `${labelAnchor} translate(${labelX}px, ${sourceY}px)`,
            }}
          >
            <span className="block truncate">{output}</span>
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
};

const RALPH_EDGE_TYPES = {
  ralphRoute: RalphRouteEdge,
} satisfies EdgeTypes;

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

export const RalphFlowEditor = ({
  workspaceRoot,
  initialPrompt = "",
  isActive = true,
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
}: RalphFlowEditorProps): JSX.Element => {
  const [flows, setFlows] = useState<RalphFlowSummary[]>([]);
  const [revisions, setRevisions] = useState<RalphFlowRevisionSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draftFlow, setDraftFlow] = useState<RalphFlow | null>(null);
  const [canvasNodes, setCanvasNodes] = useState<RalphCanvasNode[]>([]);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [unsavedFlowId, setUnsavedFlowId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [flowAliasDraft, setFlowAliasDraft] = useState("");
  const [aiPromptDraft, setAiPromptDraft] = useState("");
  const [editorMode, setEditorMode] = useState<RalphEditorMode>("design");
  const [aiTarget, setAiTarget] = useState<RalphAiTarget>("flow");
  const [aiGenerationMode, setAiGenerationMode] =
    useState<RalphAiGenerationMode>("do-it");
  const [modelCatalog, setModelCatalog] =
    useState<ProviderModelCatalogSnapshot | null>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>({});
  const [lastRun, setLastRun] = useState<RalphRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [flowsLoading, setFlowsLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeRuns, setActiveRuns] = useState<ActiveRalphRun[]>([]);
  const [generationJob, setGenerationJob] = useState<RalphGenerationJob | null>(
    null,
  );
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [copiedBlock, setCopiedBlock] = useState<RalphFlowBlock | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [canvasMenu, setCanvasMenu] = useState<RalphCanvasMenu | null>(null);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [utilityJsonDraft, setUtilityJsonDraft] = useState("");
  const [utilityJsonError, setUtilityJsonError] = useState<string | null>(null);
  const previousFlowLayoutKeyRef = useRef("");
  const reactFlowInstanceRef =
    useRef<ReactFlowInstance<RalphCanvasNode, RalphCanvasEdge> | null>(null);
  const selectedIdRef = useRef(selectedId);
  const draftFlowRef = useRef<RalphFlow | null>(draftFlow);
  const savedSnapshotRef = useRef(savedSnapshot);
  const flowListRequestRef = useRef(0);
  const saveRequestRef = useRef(0);
  const restoreRequestRef = useRef(0);
  const generationRequestRef = useRef<string | null>(null);
  const initialPromptAppliedRef = useRef(false);
  const activeProvider = runProvider;
  const activeModel = runModel;
  const hasDraftFlow = Boolean(draftFlow);
  const replaceSelectedId = (nextSelectedId: string): void => {
    selectedIdRef.current = nextSelectedId;
    setSelectedId(nextSelectedId);
  };
  const replaceDraftFlow = (nextDraftFlow: RalphFlow | null): void => {
    draftFlowRef.current = nextDraftFlow;
    setDraftFlow(nextDraftFlow);
    setUndoStack([]);
    setRedoStack([]);
    setSelectedEdgeId(null);
    setCanvasMenu(null);
  };
  const replaceSavedSnapshot = (nextSavedSnapshot: string): void => {
    savedSnapshotRef.current = nextSavedSnapshot;
    setSavedSnapshot(nextSavedSnapshot);
  };
  const issues = useMemo(
    () => (draftFlow ? validateFlowLocally(draftFlow, modelCatalog, flows) : []),
    [draftFlow, flows, modelCatalog],
  );
  const dirty = draftFlow ? savedSnapshot !== getFlowSnapshot(draftFlow) : false;
  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;
  const selectedBlock = useMemo(
    () => draftFlow?.blocks.find((block) => block.id === selectedBlockId) ?? null,
    [draftFlow, selectedBlockId],
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
  const selectedBlockUsesAgentSettings =
    selectedBlock?.type === "PROMPT" ||
    selectedBlock?.type === "VALIDATOR" ||
    selectedBlock?.type === "DECISION";

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    draftFlowRef.current = draftFlow;
  }, [draftFlow]);

  useEffect(() => {
    savedSnapshotRef.current = savedSnapshot;
  }, [savedSnapshot]);
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
  const selectedSummary = useMemo(
    () => flows.find((flow) => flow.id === selectedId) ?? null,
    [flows, selectedId],
  );
  const displayFlows = useMemo(() => {
    const visibleFlows = [...flows];

    if (draftFlow && !visibleFlows.some((flow) => flow.id === draftFlow.id)) {
      visibleFlows.unshift(flowToSummary(draftFlow));
    }

    for (const run of activeRuns) {
      if (visibleFlows.some((flow) => flow.id === run.flowId)) {
        continue;
      }

      visibleFlows.push({
        id: run.flowId,
        name: run.flowName,
        path: "",
        blockCount: 0,
        edgeCount: 0,
        variableCount: 0,
      });
    }

    return visibleFlows;
  }, [activeRuns, draftFlow, flows]);
  const activeRunsByFlowId = useMemo(() => {
    const runsByFlowId = new Map<string, ActiveRalphRun[]>();

    for (const run of activeRuns) {
      const existingRuns = runsByFlowId.get(run.flowId);

      if (existingRuns) {
        existingRuns.push(run);
      } else {
        runsByFlowId.set(run.flowId, [run]);
      }
    }

    return runsByFlowId;
  }, [activeRuns]);
  const activeCanvasRun = useMemo(
    () =>
      draftFlow
        ? activeRuns.find(
            (run) => run.flowId === draftFlow.id && run.currentBlockId,
          ) ?? null
        : null,
    [activeRuns, draftFlow],
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
    () => (draftFlow ? flowToEdges(draftFlow, selectedEdgeId) : []),
    [draftFlow, selectedEdgeId],
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
  const showMiniMap = canvasNodes.length >= 4;
  const activeRunCount = activeRuns.length;
  const flowHasStart = Boolean(
    draftFlow?.blocks.some((block) => block.type === "START"),
  );
  const generationRunning =
    generationJob?.status === "running" || generationJob?.status === "stopping";
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
  const canGenerateWithAgent =
    Boolean(workspaceRoot && aiPromptDraft.trim() && !loading && !generationRunning) &&
    (aiTarget === "flow" || canUseCurrentFlowForAi);
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

    if (!selectedId || dirty || unsavedFlowId === selectedId) {
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
    selectedMatchesDraft,
    unsavedFlowId,
    workspaceRoot,
  ]);
  const runReadyMessage =
    warningCount > 0
      ? `Ready to run with ${warningCount} warning${warningCount === 1 ? "" : "s"}.`
      : "Ready to run.";

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
      const snapshot = getRalphProgressSnapshot(event.progress);

      if (!snapshot) {
        return;
      }

      setActiveRuns((current) =>
        current.map((run) =>
          run.id === event.taskId
            ? {
                ...run,
                ...(snapshot.activeBlockId
                  ? { currentBlockId: snapshot.activeBlockId }
                  : {}),
                ...(snapshot.activeBlockTitle
                  ? { currentBlockTitle: snapshot.activeBlockTitle }
                  : {}),
                lastEventType: snapshot.eventType,
                ...(snapshot.output ? { lastOutput: snapshot.output } : {}),
              }
            : run,
        ),
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
      const result = await listRalphFlows(workspaceRoot);
      if (requestId !== flowListRequestRef.current) {
        return;
      }

      setFlows(result.flows);
      setSelectedId((current) => {
        const currentDraft = draftFlowRef.current;
        const currentDraftDirty = Boolean(
          currentDraft && getFlowSnapshot(currentDraft) !== savedSnapshotRef.current,
        );
        const nextSelectedId = (() => {
          if (!current) {
            return result.flows[0]?.id || currentDraft?.id || "";
          }

          if (
            currentDraft?.id === current &&
            (unsavedFlowId === current || currentDraftDirty)
          ) {
            return current;
          }

          if (result.flows.some((flow) => flow.id === current)) {
            return current;
          }

          return result.flows[0]?.id || draftFlowRef.current?.id || "";
        })();

        selectedIdRef.current = nextSelectedId;
        return nextSelectedId;
      });
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

  const refreshRevisions = async (flowId: string): Promise<void> => {
    if (!workspaceRoot || !flowId) {
      setRevisions([]);
      setRevisionsLoading(false);
      return;
    }

    setRevisionsLoading(true);

    try {
      const result = await listRalphFlowRevisions(workspaceRoot, flowId);
      setRevisions(result.revisions);
    } catch (error) {
      setRevisions([]);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRevisionsLoading(false);
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
    const flowNameById = new Map(flows.map((flow) => [flow.id, flow.name] as const));
    const flowIdByReference = new Map<string, string>();

    for (const flow of flows) {
      flowIdByReference.set(flow.id, flow.id);

      if (flow.alias) {
        flowIdByReference.set(flow.alias, flow.id);
      }
    }

    if (draftFlow) {
      flowNameById.set(draftFlow.id, draftFlow.name || draftFlow.id);
      flowIdByReference.set(draftFlow.id, draftFlow.id);

      if (draftFlow.alias) {
        flowIdByReference.set(draftFlow.alias, draftFlow.id);
      }
    }

    const activeRalphRunTasks = activeRalphTasks
      .filter((task) => getRalphTaskAction(task) === "run")
      .map((task) => {
        const flowReference = getRalphTaskFlowReference(task);
        const parsed = parseRalphRunTaskId(task.id);
        const flowId =
          (flowReference ? flowIdByReference.get(flowReference) : undefined) ??
          flowReference ??
          parsed?.flowId;

        return flowId
          ? {
              id: task.id,
              flowId,
              startedAt: task.startedAt || parsed?.startedAt || Date.now(),
            }
          : null;
      })
      .filter((task): task is { id: string; flowId: string; startedAt: number } =>
        Boolean(task),
      );
    const activeIds = new Set(activeRalphRunTasks.map((task) => task.id));
    const now = Date.now();

    setActiveRuns((current) => {
      const currentById = new Map(current.map((run) => [run.id, run] as const));
      const next = current
        .filter((run) => activeIds.has(run.id) || now - run.startedAt < 5_000)
        .map((run) => ({
          ...run,
          flowName: flowNameById.get(run.flowId) ?? run.flowName,
        }));

      for (const task of activeRalphRunTasks) {
        if (currentById.has(task.id)) {
          continue;
        }

        next.push({
          id: task.id,
          flowId: task.flowId,
          flowName: flowNameById.get(task.flowId) ?? titleFromId(task.flowId),
          startedAt: task.startedAt,
          status: "running",
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
          targetFlowId: null,
          targetAlias: alias,
          startedAt: newestGenerationTask.startedAt,
          status: "running",
          summary: `AI flow generation \`${alias}\` is running in the background.`,
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
  }, [isActive, workspaceRoot]);

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
    workspaceRoot,
  ]);

  useEffect(() => {
    if (!isActive || !workspaceRoot || !selectedId || unsavedFlowId === selectedId) {
      setRevisions([]);
      setRevisionsLoading(false);
      return;
    }

    void refreshRevisions(selectedId);
  }, [isActive, selectedId, unsavedFlowId, workspaceRoot]);

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
      replaceDraftFlow(null);
      replaceSavedSnapshot("");
      setVariableValues({});
      setSelectedBlockId(null);
      setLastRun(null);
      return;
    }

    if (unsavedFlowId === selectedId && draftFlow?.id === selectedId) {
      setDetailsLoading(false);
      return;
    }

    let cancelled = false;

    setDetailsLoading(true);
    void showRalphFlow(workspaceRoot, selectedId)
      .then((result) => {
        if (cancelled) {
          return;
        }

        replaceDraftFlow(result.flow);
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
          replaceDraftFlow(null);
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
  }, [draftFlow?.id, isActive, selectedId, unsavedFlowId, workspaceRoot]);

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
    );
    const nextFlow = createBlankFlow(nextAlias);

    setDetailsLoading(false);
    replaceDraftFlow(nextFlow);
    replaceSavedSnapshot("");
    replaceSelectedId(nextFlow.id);
    setUnsavedFlowId(nextFlow.id);
    setFlowAliasDraft(nextAlias);
    setSelectedBlockId("start");
    setVariableValues({});
    setRevisions([]);
    setLastRun(null);
    setEditorMode("design");
    setMessage("Draft flow created. Save it before running.");
  };

  const applyGeneratedFlow = (generatedFlow: RalphFlow): void => {
    replaceDraftFlow(generatedFlow);
    replaceSavedSnapshot(getFlowSnapshot(generatedFlow));
    replaceSelectedId(generatedFlow.id);
    setUnsavedFlowId((current) => (current === generatedFlow.id ? null : current));
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

  const createFlowWithAgent = async (): Promise<void> => {
    if (!workspaceRoot || !aiPromptDraft.trim()) {
      return;
    }

    const targetFlowName =
      aiTarget === "flow"
        ? createUniqueFlowAlias(normalizedFlowAliasDraft || "ralph-flow", displayFlows)
        : draftFlow
          ? getFlowAlias(draftFlow)
          : "";
    const existingFlow = aiTarget === "flow" ? undefined : draftFlow ?? undefined;

    if (!targetFlowName) {
      setMessage("Expected a Ralph flow alias before generating a flow.");
      return;
    }

    const jobId = `generation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const selectedIdAtStart = selectedIdRef.current;
    const targetFlowId = existingFlow?.id ?? null;
    const draftSnapshotAtStart = draftFlowRef.current
      ? getFlowSnapshot(draftFlowRef.current)
      : "";
    const savedSnapshotAtStart = savedSnapshotRef.current;
    const draftWasDirtyAtStart = Boolean(
      draftFlowRef.current && draftSnapshotAtStart !== savedSnapshotAtStart,
    );

    generationRequestRef.current = jobId;
    setGenerationJob({
      id: jobId,
      target: aiTarget,
      mode: aiGenerationMode,
      targetFlowId,
      targetAlias: targetFlowName,
      startedAt: Date.now(),
      status: "running",
      summary:
        aiTarget === "flow"
          ? `Generating new Ralph flow \`${targetFlowName}\`.`
          : `Applying AI flow changes to \`${targetFlowName}\`.`,
    });
    setMessage(null);

    try {
      const result = await createRalphFlow(workspaceRoot, {
        prompt: aiPromptDraft,
        mode: runMode,
        provider: generationProvider,
        model: generationModel,
        ...(generationProfile ? { profile: generationProfile } : {}),
        ...(generationReasoning ? { reasoning: generationReasoning } : {}),
        name: targetFlowName,
        ...(existingFlow ? { existingFlow } : {}),
        target: aiTarget,
        generationMode: aiGenerationMode,
        taskId: jobId,
      });
      if (generationRequestRef.current !== jobId) {
        return;
      }

      const formattedMessage = formatCreateFlowMessage(result);
      setGenerationJob((current) =>
        current?.id === jobId
          ? {
              ...current,
              status: result.status,
              summary: formattedMessage,
              result,
            }
          : current,
      );
      setMessage(formattedMessage);

      if (result.flow?.id) {
        setFlows((current) =>
          upsertFlowSummary(current, flowToSummary(result.flow, result.flowPath)),
        );
        const currentDraft = draftFlowRef.current;
        const currentDraftSnapshot = currentDraft
          ? getFlowSnapshot(currentDraft)
          : "";
        const canAdoptGeneratedFlow =
          selectedIdRef.current === selectedIdAtStart &&
          (aiTarget === "flow"
            ? !draftWasDirtyAtStart
            : currentDraft?.id === targetFlowId &&
              currentDraftSnapshot === draftSnapshotAtStart);

        if (canAdoptGeneratedFlow) {
          replaceDraftFlow(result.flow);
          replaceSavedSnapshot(getFlowSnapshot(result.flow));
          replaceSelectedId(result.flow.id);
          setUnsavedFlowId((current) =>
            current === result.flow?.id ? null : current,
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

  const persistFlow = async (
    formatMessage: (result: RalphPersistedFlowResult) => string,
  ): Promise<boolean> => {
    if (!workspaceRoot || !draftFlow) {
      return false;
    }

    if (selectedId && draftFlow.id !== selectedId) {
      setMessage(
        "The selected flow changed while details were loading. Reopen the flow before saving.",
      );
      return false;
    }

    const requestId = saveRequestRef.current + 1;
    saveRequestRef.current = requestId;
    const flowToSave = draftFlow;
    setLoading(true);
    setMessage(null);

    try {
      const result = await saveRalphFlow(workspaceRoot, {
        flow: flowToSave,
      });
      if (requestId !== saveRequestRef.current) {
        return false;
      }

      replaceDraftFlow(result.flow);
      replaceSavedSnapshot(getFlowSnapshot(result.flow));
      replaceSelectedId(result.flow.id);
      setUnsavedFlowId((current) => (current === result.flow.id ? null : current));
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
        upsertFlowSummary(current, flowToSummary(result.flow, result.path)),
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

    if (!generatedFlow) {
      return;
    }

    if (!(await saveDirtyDraftBeforeReplacement("opening the generated flow"))) {
      return;
    }

    applyGeneratedFlow(generatedFlow);
  };

  const selectFlow = async (flow: RalphFlowSummary): Promise<void> => {
    if (flow.id === selectedId) {
      return;
    }

    const canLoadFlow = Boolean(flow.path) || draftFlow?.id === flow.id;

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

    replaceSelectedId(flow.id);
  };

  const deleteFlow = async (flow: RalphFlowSummary): Promise<void> => {
    if (!workspaceRoot || !flow.path) {
      return;
    }

    const activeFlowRuns = activeRunsByFlowId.get(flow.id) ?? [];

    if (activeFlowRuns.length > 0) {
      setMessage(`Stop Ralph run \`${flow.name}\` before deleting this flow.`);
      setEditorMode("run");
      return;
    }

    if (generationRunning && generationJob?.targetFlowId === flow.id) {
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
      const result = await deleteRalphFlow(workspaceRoot, flow.id);
      setFlows((current) =>
        current.filter(
          (candidate) =>
            candidate.id !== flow.id &&
            candidate.id !== result.id &&
            candidate.path !== result.path,
        ),
      );

      if (selectedIdRef.current === flow.id || selectedIdRef.current === result.id) {
        replaceSelectedId("");
        replaceDraftFlow(null);
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
    setLoading(true);
    setMessage(null);

    try {
      const result = await restoreRalphFlowRevision(workspaceRoot, {
        name: selectedId,
        revision: revisionId,
      });
      if (
        requestId !== restoreRequestRef.current ||
        selectedIdRef.current !== selectedIdAtStart
      ) {
        return;
      }

      replaceDraftFlow(result.flow);
      replaceSavedSnapshot(getFlowSnapshot(result.flow));
      replaceSelectedId(result.flow.id);
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
        upsertFlowSummary(current, flowToSummary(result.flow, result.path)),
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
    const flowSnapshotAtStart = getFlowSnapshot(flowToRun);
    const taskId = createRalphRunTaskId(flowToRun.id);
    const flowName = flowToRun.name || flowToRun.id;
    setActiveRuns((current) => [
      {
        id: taskId,
        flowId: flowToRun.id,
        flowName,
        startedAt: Date.now(),
        status: "running",
      },
      ...current,
    ]);
    setLastRun(null);
    setEditorMode("run");
    setMessage(`Ralph run \`${flowName}\` started in the background.`);

    void (async () => {
      try {
        const result = await runRalphFlow(workspaceRoot, {
          name: flowToRun.id,
          taskId,
          mode: runMode,
          provider: runProvider,
          model: runModel,
          ...(runProfile ? { profile: runProfile } : {}),
          ...(runReasoning ? { reasoning: runReasoning } : {}),
          ...(defaultMaxTransitions
            ? { maxTransitions: defaultMaxTransitions }
            : {}),
          params: Object.fromEntries(
            Object.entries(variableValues)
              .map(([name, value]) => [name.trim(), value] as const)
            .filter(([name]) => Boolean(name)),
          ),
        });
        const currentDraft = draftFlowRef.current;
        const stillViewingSameSnapshot =
          selectedIdRef.current === flowToRun.id &&
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
        } else if (selectedIdRef.current === flowToRun.id) {
          setMessage(
            `Ralph run \`${flowName}\` finished for an older flow version.`,
          );
        }
      } catch (error) {
        const currentDraft = draftFlowRef.current;

        if (
          selectedIdRef.current === flowToRun.id &&
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
    updateDraftFlow((flow) => ({
      ...flow,
      blocks: flow.blocks.filter((block) => !removableBlockIdSet.has(block.id)),
      edges: flow.edges.filter(
        (edge) =>
          !removableBlockIdSet.has(edge.from) && !removableBlockIdSet.has(edge.to),
      ),
    }));
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

    if (!sourceBlock || !output) {
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
    const output = connection.sourceHandle
      ? (connection.sourceHandle as RalphExecutionOutput)
      : oldEdge.sourceHandle
        ? (oldEdge.sourceHandle as RalphExecutionOutput)
        : sourceBlock
          ? getBlockOutputs(sourceBlock)[0]
          : undefined;

    if (!sourceBlock || !output) {
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

    if (selectedChange) {
      setSelectedBlockId(selectedChange.id);
      setSelectedEdgeId(null);
      closeCanvasMenu();
    }

    setCanvasNodes((currentNodes) => applyNodeChanges(changes, currentNodes));
  };

  const handleNodeDragStop: OnNodeDrag<RalphCanvasNode> = (
    _event,
    node,
    draggedNodes,
  ): void => {
    const movedNodes = draggedNodes.length > 0 ? draggedNodes : [node];
    const movedPositionsById = getCanvasNodePositions(movedNodes);

    updateDraftFlow((flow) => {
      let changed = false;
      const blocks = flow.blocks.map((block) => {
        const nextPosition = movedPositionsById.get(block.id);

        if (!nextPosition || arePositionsEqual(block.position, nextPosition)) {
          return block;
        }

        changed = true;
        return { ...block, position: nextPosition };
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

  const openPaneMenu = (event: ReactMouseEvent): void => {
    event.preventDefault();
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
    if (!isActive) {
      return;
    }

    const handleEditorShortcut = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      const hasModifier = event.ctrlKey || event.metaKey;

      if (key === "escape" && canvasMenu) {
        event.preventDefault();
        closeCanvasMenu();
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
    options: { disabled?: boolean; danger?: boolean; icon?: LucideIcon; key?: string } = {},
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
        {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" /> : null}
        <span className="min-w-0 truncate">{label}</span>
      </button>
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
            {renderCanvasMenuButton("Prompt", () =>
              addBlock("PROMPT", canvasMenu.position),
            )}
            {renderCanvasMenuButton("Validator", () =>
              addBlock("VALIDATOR", canvasMenu.position),
            )}
            {renderCanvasMenuButton("Decision", () =>
              addBlock("DECISION", canvasMenu.position),
            )}
            {renderCanvasMenuButton("Pack", () =>
              addBlock("PACK", canvasMenu.position),
            )}
            {renderCanvasMenuButton("Utility", () =>
              addBlock("UTILITY", canvasMenu.position),
            )}
            {MCP_BLOCK_ACTIONS.map((action) =>
              renderCanvasMenuButton(`MCP ${action.label}`, () =>
                addBlock(action.type, canvasMenu.position),
                { key: action.type },
              ),
            )}
            {renderCanvasMenuButton("End", () =>
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
            {renderCanvasMenuButton("Add prompt after", () =>
              addBlockAfter(menuBlock.id, "PROMPT"),
            )}
            {renderCanvasMenuButton("Add validator after", () =>
              addBlockAfter(menuBlock.id, "VALIDATOR"),
            )}
            {renderCanvasMenuButton("Add decision after", () =>
              addBlockAfter(menuBlock.id, "DECISION"),
            )}
            {renderCanvasMenuButton("Add pack after", () =>
              addBlockAfter(menuBlock.id, "PACK"),
            )}
            {renderCanvasMenuButton("Add utility after", () =>
              addBlockAfter(menuBlock.id, "UTILITY"),
            )}
            {MCP_BLOCK_ACTIONS.map((action) =>
              renderCanvasMenuButton(`Add MCP ${action.label.toLowerCase()} after`, () =>
                addBlockAfter(menuBlock.id, action.type),
                { key: action.type },
              ),
            )}
            {renderCanvasMenuButton("Add end after", () =>
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
        <div className="grid grid-cols-2 gap-2">
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
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={currentCondition.path ?? ""}
              aria-label="Utility condition path"
              placeholder="body.state"
              onChange={(event) => updateCondition({ path: event.target.value })}
              className="h-8 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
            />
            <Input
              value={currentCondition.value ?? ""}
              aria-label="Utility condition value"
              placeholder="done"
              onChange={(event) => updateCondition({ value: event.target.value })}
              className="h-8 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
            />
          </div>
        ) : (
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
      <div className="grid gap-3 border-t border-slate-800 pt-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <SelectedUtilityIcon
              className={cn("h-4 w-4 shrink-0", selectedUtilityVisual.badgeClassName)}
            />
            <span className="truncate">
              {formatUtilityTypeLabel(selectedUtility.type)} Utility
            </span>
          </div>
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
        </div>

        {selectedUtility.type === "WAIT" ? (
          <div className="grid gap-2">
            <div className="grid grid-cols-2 gap-2">
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
                <div className="grid grid-cols-2 gap-2">
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
                </div>
              </>
            ) : null}
          </div>
        ) : null}

        {selectedUtility.type === "HTTP_FETCH" ||
        selectedUtility.type === "POLL" ? (
          <div className="grid gap-2">
            <div className="grid grid-cols-[0.55fr_1.45fr] gap-2">
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
              <Input
                value={selectedUtility.url ?? ""}
                aria-label="HTTP URL"
                placeholder="{{url:url}}"
                onChange={(event) =>
                  updateSelectedUtility({ url: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </div>
            <Textarea
              value={selectedUtility.body ?? ""}
              aria-label="HTTP body"
              placeholder="Optional request body"
              onChange={(event) =>
                updateSelectedUtility({ body: event.target.value })
              }
              className="min-h-16 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100 placeholder:text-slate-600"
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={selectedUtility.outputPath ?? ""}
                aria-label="HTTP output path"
                placeholder="Save body to path"
                onChange={(event) =>
                  updateSelectedUtility({ outputPath: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
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
            </div>
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
            {selectedUtility.type === "POLL" ? (
              <>
                {renderUtilityConditionFields(selectedUtility.condition)}
                <div className="grid grid-cols-3 gap-2">
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
            <Textarea
              value={selectedUtility.command ?? ""}
              aria-label="Utility command"
              placeholder="npm test"
              onChange={(event) =>
                updateSelectedUtility({ command: event.target.value })
              }
              className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={selectedUtility.cwd ?? ""}
                aria-label="Command working directory"
                placeholder="Workspace"
                onChange={(event) =>
                  updateSelectedUtility({ cwd: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
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
            </div>
            {selectedUtility.type === "RUN_COMMAND" ? (
              <Input
                value={(selectedUtility.acceptedExitCodes ?? [0]).join(", ")}
                aria-label="Accepted exit codes"
                placeholder="0"
                onChange={(event) =>
                  updateSelectedUtility({
                    acceptedExitCodes: parseNumberList(event.target.value) ?? [0],
                  })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            ) : null}
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
          </div>
        ) : null}

        {selectedUtility.type === "READ_FILE" ||
        selectedUtility.type === "WRITE_FILE" ? (
          <div className="grid gap-2">
            <Input
              value={selectedUtility.path ?? ""}
              aria-label="Utility file path"
              placeholder="{{file:path}}"
              onChange={(event) =>
                updateSelectedUtility({ path: event.target.value })
              }
              className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
            />
            {selectedUtility.type === "WRITE_FILE" ? (
              <>
                <Textarea
                  value={selectedUtility.content ?? ""}
                  aria-label="Utility file content"
                  placeholder="{{lastResult}}"
                  onChange={(event) =>
                    updateSelectedUtility({ content: event.target.value })
                  }
                  className="min-h-28 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
                />
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
            <Input
              value={selectedUtility.rootPath ?? "."}
              aria-label="Search root path"
              placeholder="."
              onChange={(event) =>
                updateSelectedUtility({ rootPath: event.target.value })
              }
              className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
                value={selectedUtility.pattern ?? ""}
                aria-label="Search pattern"
                placeholder="{{query:string}}"
                onChange={(event) =>
                  updateSelectedUtility({ pattern: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
              <Input
                value={selectedUtility.glob ?? ""}
                aria-label="Search glob"
                placeholder="*.ts"
                onChange={(event) =>
                  updateSelectedUtility({ glob: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </div>
          </div>
        ) : null}

        {selectedUtility.type === "GIT_STATUS" ? (
          <Input
            value={selectedUtility.cwd ?? "."}
            aria-label="Git working directory"
            placeholder="Workspace"
            onChange={(event) =>
              updateSelectedUtility({ cwd: event.target.value })
            }
            className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
          />
        ) : null}

        {selectedUtility.type === "SET_VARIABLE" ? (
          <div className="grid gap-2">
            <Input
              value={selectedUtility.variableName ?? ""}
              aria-label="Utility variable name"
              placeholder="scope"
              onChange={(event) =>
                updateSelectedUtility({ variableName: event.target.value })
              }
              className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
            />
            <Textarea
              value={selectedUtility.value ?? ""}
              aria-label="Utility variable value"
              placeholder="{{lastResultSummary}}"
              onChange={(event) =>
                updateSelectedUtility({ value: event.target.value })
              }
              className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
            />
          </div>
        ) : null}

        {selectedUtility.type === "TRANSFORM_JSON" ||
        selectedUtility.type === "VALIDATE_JSON" ? (
          <div className="grid gap-2">
            <Textarea
              value={selectedUtility.input ?? ""}
              aria-label="Utility JSON input"
              placeholder="Leave empty to use last utility data"
              onChange={(event) =>
                updateSelectedUtility({ input: event.target.value })
              }
              className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
            />
            {selectedUtility.type === "TRANSFORM_JSON" ? (
              <Textarea
                value={selectedUtility.expression ?? "input"}
                aria-label="JSON transform expression"
                placeholder="input"
                onChange={(event) =>
                  updateSelectedUtility({ expression: event.target.value })
                }
                className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
              />
            ) : (
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
            )}
          </div>
        ) : null}

        {selectedUtility.type === "NOTIFY" ? (
          <Textarea
            value={selectedUtility.message ?? ""}
            aria-label="Notification message"
            placeholder="{{lastResultSummary}}"
            onChange={(event) =>
              updateSelectedUtility({ message: event.target.value })
            }
            className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
          />
        ) : null}

        <div className="grid gap-2 border-t border-cyan-400/10 pt-2">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-300/70">
              Advanced JSON
            </span>
            <Button
              type="button"
              variant="outline"
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
          {utilityJsonError ? (
            <div className="rounded border border-rose-400/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-100">
              {utilityJsonError}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-5 py-3 text-left">
            <div className="flex min-w-0 items-center justify-between gap-4">
              <h1 className="flex min-w-0 items-center gap-2 text-lg font-semibold text-white">
                <Workflow className="h-5 w-5 shrink-0 text-emerald-300" />
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
              "grid min-h-0 grid-cols-[16rem_minmax(0,1fr)_22rem] overflow-hidden 2xl:grid-cols-[18rem_minmax(0,1fr)_24rem]",
              editorMode === "design"
                ? "grid-rows-[minmax(0,1fr)_5rem]"
                : "grid-rows-[minmax(0,1fr)_18rem]",
            )}
          >
            <aside className="row-span-2 grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-slate-800 bg-slate-950/80">
              <div className="grid gap-3 border-b border-slate-800 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
                    Flows
                  </span>
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
                          ? "No Ralph flows found."
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
                    displayFlows.map((flow) => (
                      (() => {
                        const isDraftSummary = draftFlow?.id === flow.id;
                        const isGeneratedSummary =
                          generationJob?.status === "created" &&
                          generationJob.result?.flow?.id === flow.id;
                        const activeFlowRuns = activeRunsByFlowId.get(flow.id) ?? [];
                        const runStatusLabel = getFlowRunStatusLabel(
                          activeFlowRuns,
                        );
                        const canLoadFlow =
                          Boolean(flow.path) || draftFlow?.id === flow.id;
                        const deleteDisabled =
                          !workspaceRoot ||
                          !flow.path ||
                          activeFlowRuns.length > 0 ||
                          (generationRunning && generationJob?.targetFlowId === flow.id);
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

                        return (
                          <div
                            key={flow.id}
                            className={cn(
                              "flex min-w-0 items-center gap-2 border-b border-slate-800/70 px-2 py-2 last:border-b-0",
                              selectedId === flow.id
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
                              className="grid min-w-0 flex-1 gap-1 text-left disabled:cursor-default"
                            >
                              <span className="flex min-w-0 items-center justify-between gap-2 text-xs text-slate-500">
                              <span className="truncate">
                                <span className="text-sm font-medium text-slate-100">
                                  {flow.name}
                                </span>
                                <span className="ml-2">{formatFlowSubtitle(flow)}</span>
                              </span>
                              <span
                                className={cn(
                                  "shrink-0 text-[0.68rem] font-medium",
                                  runStatusLabel
                                    ? "text-sky-200"
                                    : statusLabel === "Generated"
                                      ? "text-emerald-200"
                                    : statusLabel === "Unsaved" ||
                                        statusLabel === "Warnings"
                                      ? "text-amber-200"
                                      : statusLabel === "Errors"
                                        ? "text-red-200"
                                        : "text-slate-500",
                                )}
                              >
                                {statusLabel}
                              </span>
                              </span>
                            </button>
                            {flow.path ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                disabled={deleteDisabled}
                                aria-label={`Delete Ralph flow ${flow.name}`}
                                title={
                                  activeFlowRuns.length > 0
                                    ? `Stop Ralph run ${flow.name} before deleting`
                                    : `Delete ${flow.name}`
                                }
                                onClick={() => void deleteFlow(flow)}
                                className="h-7 w-7 shrink-0 rounded-md text-slate-500 hover:bg-rose-500/10 hover:text-rose-100 disabled:text-slate-700"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            ) : null}
                          </div>
                        );
                      })()
                    ))
                  )}
                </div>
              </ScrollArea>
            </aside>

            <main className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-slate-950">
              <div className="flex min-w-0 items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Route className="h-4 w-4 shrink-0 text-sky-300" />
                  <span className="truncate text-sm font-semibold text-white">
                    {flowTitle}
                  </span>
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
                              className="h-8 rounded-lg px-2 text-xs text-slate-300 hover:bg-slate-900 hover:text-white disabled:text-slate-700"
                            >
                              <Icon className={cn("h-4 w-4", tone.badgeClassName)} />
                              <span className="hidden 2xl:inline">{action.label}</span>
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">{action.type}</TooltipContent>
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
                            className="h-8 rounded-lg px-2 text-xs text-slate-300 hover:bg-slate-900 hover:text-white"
                          >
                            <Globe2 className="h-4 w-4 text-violet-300" />
                            <span className="hidden 2xl:inline">MCP</span>
                            <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
                          </Button>
                        </DropdownMenuTrigger>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">MCP block</TooltipContent>
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
                    }}
                    onEdgeClick={(_, edge) => {
                      setSelectedEdgeId(edge.id);
                      setSelectedBlockId(null);
                      closeCanvasMenu();
                    }}
                    onPaneClick={() => {
                      setSelectedBlockId(null);
                      setSelectedEdgeId(null);
                      closeCanvasMenu();
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
                {!draftFlow ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
                    <div className="pointer-events-auto grid max-w-md gap-3 rounded-lg border border-dashed border-slate-800 bg-slate-950/90 px-5 py-4 text-center shadow-xl shadow-black/25">
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

            <aside className="col-start-3 row-start-1 grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-l border-slate-800 bg-slate-950/80">
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
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
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

              <ScrollArea className="min-h-0" type="always">
                {selectedBlock ? (
                  <div className="grid gap-4 p-4 pr-5">
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

                    {selectedBlock.type !== "START" && selectedBlock.type !== "END" ? (
                      <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200">
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
                    selectedBlock.type === "DECISION" ? (
                      <label className="grid gap-2 text-sm text-slate-200">
                        <span className="font-medium">Prompt</span>
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
                      </label>
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
                      <div className="grid gap-3 border-t border-slate-800 pt-3 text-sm text-slate-200">
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

                    {selectedBlock.type === "UTILITY" ? renderUtilitySettings() : null}

                    {selectedBlockUsesAgentSettings ? (
                      <div className="grid gap-3 border-t border-slate-800 pt-3">
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

                        <div className="grid gap-2 border-t border-slate-800 pt-3">
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

                          <div className="grid gap-2 border-t border-slate-800 pt-2">
                            <div className="flex items-center justify-between gap-3">
                              <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
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

                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setShowAdvancedSettings((current) => !current)}
                          className="h-8 justify-start rounded-lg px-2 text-xs text-slate-300 hover:bg-slate-800 hover:text-white"
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" />
                          {showAdvancedSettings ? "Hide More" : "Show More"}
                        </Button>

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

                    <div className="grid gap-2 border-t border-slate-800 pt-3">
                      <div className="text-xs font-semibold tracking-[0.16em] text-slate-500 uppercase">
                        Routes
                      </div>
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
                            className="grid gap-1 border-b border-slate-800/70 py-1.5 text-xs text-slate-300 last:border-b-0"
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
                  <div className="grid gap-4 p-4 pr-5">
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
                            <div className="text-xs font-semibold tracking-[0.16em] text-slate-500 uppercase">
                              Route
                            </div>
                            <div className="grid gap-1.5 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-xs">
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
                  <div className="grid gap-4 p-4 pr-5">
                    {draftFlow ? (
                      <>
                        <div className="grid gap-3">
                          <div className="text-xs font-semibold tracking-[0.16em] text-slate-500 uppercase">
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
                        </div>

                        <div className="grid gap-2 border-t border-slate-800 pt-3">
                          <div className="text-xs font-semibold tracking-[0.16em] text-slate-500 uppercase">
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

                        <div className="grid gap-2 border-t border-slate-800 pt-3">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-xs font-semibold tracking-[0.16em] text-slate-500 uppercase">
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
                                unsavedFlowId === selectedId
                              }
                              aria-label="Refresh Ralph revisions"
                              title="Refresh Ralph revisions"
                              onClick={() => void refreshRevisions(selectedId)}
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
                          {unsavedFlowId === selectedId ? (
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
              </ScrollArea>
            </aside>

            {editorMode === "design" ? (
              <section className="col-start-2 col-span-2 row-start-2 grid min-h-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] border-t border-slate-800 bg-slate-950">
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
                        {activeRunCount > 0 ? "Run another" : "Run"}
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
                "col-start-2 col-span-2 row-start-2 grid min-h-0 border-t border-slate-800 bg-slate-950",
                editorMode === "generate"
                  ? "grid-cols-[minmax(16rem,1.35fr)_minmax(12rem,0.85fr)_minmax(12rem,0.7fr)] 2xl:grid-cols-[minmax(28rem,1.35fr)_minmax(18rem,0.85fr)_22rem]"
                  : editorMode === "run"
                    ? "grid-cols-[minmax(12rem,0.75fr)_minmax(12rem,0.8fr)_minmax(16rem,1.35fr)] 2xl:grid-cols-[20rem_minmax(18rem,0.8fr)_minmax(28rem,1.35fr)]"
                    : "grid-cols-[minmax(12rem,0.75fr)_minmax(16rem,1.35fr)_minmax(12rem,0.7fr)] 2xl:grid-cols-[20rem_minmax(28rem,1.35fr)_22rem]",
              )}
            >
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
                  <div className="grid gap-2 p-3">
                    <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1">
                      {[
                        ["flow", "Flow"],
                        ["refactor", "Improve"],
                        ["prompt-block", "Prompt"],
                      ].map(([target, label]) => (
                        <button
                          key={target}
                          type="button"
                          onClick={() => setAiTarget(target as RalphAiTarget)}
                          className={cn(
                            "h-7 rounded-md px-2 text-xs font-semibold",
                            aiTarget === target
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
                        ["do-it", "Do it"],
                        ["interview", "Interview"],
                      ].map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() =>
                            setAiGenerationMode(mode as RalphAiGenerationMode)
                          }
                          className={cn(
                            "h-7 rounded-md px-2 text-xs font-semibold",
                            aiGenerationMode === mode
                              ? "bg-sky-500/20 text-sky-100"
                              : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <Textarea
                      value={aiPromptDraft}
                      aria-label="AI flow generation prompt"
                      placeholder={
                        aiTarget === "flow"
                          ? "Describe a complete Ralph flow."
                          : aiTarget === "prompt-block"
                            ? "Describe the prompt block to add."
                            : "Describe the changes to apply to this flow."
                      }
                      onChange={(event) => setAiPromptDraft(event.target.value)}
                      className="min-h-16 border-slate-700 bg-slate-950 text-sm text-slate-100 placeholder:text-slate-600"
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
                      {generationRunning ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      {generationRunning
                        ? "Working"
                        : aiTarget === "flow"
                          ? "Generate"
                          : "Apply"}
                    </Button>
                    {generationJob ? (
                      <div
                        className={cn(
                          "grid gap-2 border-t border-slate-800 pt-2 text-sm",
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
                              {generationJob.status === "running"
                                ? "Generating"
                                : generationJob.status === "stopping"
                                  ? "Stopping"
                                : generationJob.status === "created"
                                  ? "Generated"
                                  : generationJob.status === "blocked"
                                    ? "Blocked"
                                    : "Failed"}
                            </span>
                          </span>
                          {generationJob.status === "running" ? (
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => void stopGeneration()}
                              className="h-7 shrink-0 rounded-lg border-rose-400/30 bg-rose-500/10 px-2 text-xs text-rose-100 hover:bg-rose-500/15 hover:text-white"
                            >
                              <Octagon className="h-3.5 w-3.5" />
                              Stop
                            </Button>
                          ) : generationJob.result?.flow ? (
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => void openGeneratedFlow()}
                              className="h-7 shrink-0 rounded-lg border-slate-700 bg-slate-900 px-2 text-xs text-slate-100 hover:bg-slate-800 hover:text-white"
                            >
                              Open
                            </Button>
                          ) : null}
                        </div>
                        <div className="max-h-12 overflow-hidden text-xs text-slate-500">
                          {generationJob.summary}
                        </div>
                      </div>
                    ) : null}
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
                          onClick={() => {
                            if (issue.blockId) {
                              setSelectedBlockId(issue.blockId);
                            }
                          }}
                          className={cn(
                            "flex min-w-0 items-center justify-between gap-3 border-b border-slate-800/70 py-2 text-left text-sm last:border-b-0",
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
                    {activeRunCount > 0 ? "Run another" : "Run"}
                  </Button>
                </div>
                <ScrollArea className="min-h-0" type="always">
                  {editorMode === "run" ? (
                  <div className="grid gap-2 p-3">
                    {runBlockedReason ? (
                      <div className="grid gap-2 text-sm text-amber-100">
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <span className="min-w-0 break-words">
                            {runBlockedReason}
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
                    ) : (
                      <div className="px-1 text-xs text-slate-500">
                        {runReadyMessage}
                      </div>
                    )}

                    {activeRuns.length > 0 ? (
                      <div className="grid gap-1 border-t border-slate-800 pt-2">
                        <div className="flex min-w-0 items-center justify-between gap-3 px-1">
                          <div className="text-xs font-medium text-slate-400">
                            Background Ralph runs
                          </div>
                          <span className="shrink-0 text-xs text-slate-500">
                            {activeRuns.length}
                          </span>
                        </div>
                        <div className="grid">
                          {activeRuns.map((activeRun) => (
                            <div
                              key={activeRun.id}
                              className="flex min-w-0 items-center justify-between gap-2 border-b border-slate-800/70 px-1 py-1.5 last:border-b-0"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-slate-200">
                                  {activeRun.flowName}
                                </div>
                                <div className="truncate text-xs text-slate-500">
                                  {activeRun.status === "stopping"
                                    ? "Stopping"
                                    : activeRun.currentBlockTitle
                                      ? `Active: ${activeRun.currentBlockTitle}`
                                      : `Running since ${formatRevisionDate(new Date(activeRun.startedAt).toISOString())}`}
                                </div>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                disabled={activeRun.status === "stopping"}
                                aria-label={`Stop Ralph run ${activeRun.flowName}`}
                                onClick={() => void stopRalphRun(activeRun.id)}
                                className="h-7 shrink-0 rounded-lg border-slate-700 bg-slate-900 px-2 text-xs text-rose-200 hover:border-rose-400/30 hover:bg-rose-500/10 hover:text-white disabled:opacity-60"
                              >
                                {activeRun.status === "stopping" ? (
                                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Octagon className="h-3.5 w-3.5" />
                                )}
                                Stop
                              </Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {draftFlow && (draftFlow.variables ?? []).length > 0 ? (
                      <div className="grid gap-2">
                        {(draftFlow.variables ?? []).map((variable) => (
                          <label
                            key={variable.name}
                            className="grid gap-1.5 text-sm text-slate-200"
                          >
                            <span className="flex min-w-0 items-center justify-between gap-3">
                              <span className="truncate font-medium">
                                {variable.name}
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
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="px-1 text-xs text-slate-500">
                        No variables required.
                      </div>
                    )}

                    {requiredMissingVariables.length > 0 ? (
                      <div className="break-words text-sm text-amber-100">
                        Missing required variable(s):{" "}
                        {requiredMissingVariables.join(", ")}.
                      </div>
                    ) : null}

                    {lastRun ? (
                      <div className="grid gap-2 border-t border-slate-800 pt-2">
                        <div className="text-sm font-medium text-slate-100">
                          {lastRun.status}
                        </div>
                        <p className="break-words text-sm text-slate-400">
                          {lastRun.summary}
                        </p>
                        <div className="grid gap-1">
                          {lastRun.events.slice(-8).map((event, index) => (
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

                    {message ? (
                      <div className="break-words text-sm text-slate-300">
                        {message}
                      </div>
                    ) : null}
                  </div>
                  ) : (
                    <div className="grid gap-2 p-3">
                      <div
                        className={cn(
                          "text-sm",
                          runBlockedReason ? "text-amber-100" : "text-lime-100",
                        )}
                      >
                        {runBlockedReason ?? runReadyMessage}
                      </div>
                      {runBlockedReason === "Save flow before running." && canSaveFlow ? (
                        <Button
                          type="button"
                          onClick={() => void saveFlow()}
                          className="h-8 justify-self-end rounded-lg bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-500"
                        >
                          <Save className="h-3.5 w-3.5" />
                          Save
                        </Button>
                      ) : null}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </section>
            )}
          </div>
    </section>
  );
};
