import {
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Connection,
  type NodeChange,
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
  Copy,
  FileJson,
  FileText,
  Globe2,
  GripVertical,
  History,
  LayoutGrid,
  LoaderCircle,
  Maximize2,
  Octagon,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Route,
  Save,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Variable,
  Workflow,
  X,
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
} from "react";
import {
  createImageInputUnsupportedModelMessage,
  getSupportedImageInputExtensions,
  modelSupportsImageInput,
} from "../../../core/model-capabilities.js";
import {
  createImportedRalphStarterFlow,
  createUpgradedRalphStarterFlowWithReport,
  type RalphStarterFlowSummary,
} from "../../../core/ralph-starter-flows.js";
import type { RalphGenerationInterviewSession } from "../../../core/ralph-generation.js";
import { createRalphFlowFingerprint } from "../../../core/_helpers/create-ralph-flow-fingerprint.helper.js";
import { discoverRalphFlowVariables } from "../../../core/_helpers/ralph-placeholders.helper.js";
import type {
  RalphAnnotationTone,
  RalphAskUserMode,
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
  RalphInputFieldType,
  RalphInputValue,
  RalphPromptBlock,
  RalphPosition,
  RalphRunResult,
  RalphRunSummary,
  RalphUtilityCondition,
  RalphUtilityConfig,
  RalphUtilityType,
  RalphValidationScope,
} from "../../../core/ralph.js";
import type {
  ReasoningMode,
  RunMode,
} from "../../../core/runtime-contract.generated.js";
import {
  getCatalogModelsForProvider,
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
  openRalphFlowInExplorer,
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
  RALPH_CANVAS_STACK_OFFSET,
  createDerivedGroupChildrenById,
  createLockedCanvasBlockIdSet,
  flowToEdges,
  flowToNodes,
  forceRalphFlowLayout,
  getBlockFallbackWidth,
  getCanvasBlockSize,
  getDefaultCanvasPosition,
  getDisplacedCanvasPosition,
  getSelectableRouteTargets,
  normalizeDerivedGroupMembership,
  type RalphCanvasEdge,
  type RalphNodeData,
  type RalphCanvasNode,
} from "./_helpers/ralph-canvas-layout.helper";
import {
  formatCatalogModelLabel,
  formatProviderOptionLabel,
  formatRouteOptionTargetLabel,
  formatRouteTargetLabel,
  formatUnconnectedRouteLabel,
  formatUtilityTypeLabel,
  formatValidationScopeLabel,
  titleFromId,
} from "./_helpers/format-ralph-flow-labels.helper";
import {
  MAX_RALPH_HISTORY_ENTRIES,
  arePositionsEqual,
  areSizesEqual,
  createDefaultInputField,
  createSetupVariableErrorId,
  formatRevisionDate,
  formatSaveFlowMessage,
  getCanvasMenuPlacement,
  getCanvasNodePositions,
  getFlowLayoutKey,
  getFlowSnapshot,
  isEditableShortcutTarget,
  isGroupChildMoveSuppressed,
  isLockedNodePositionChange,
  shouldSyncUtilityTitle,
  updatePromptLikeText,
  type RalphPersistedFlowValidationResult,
} from "./_helpers/ralph-flow-editor-state.helper";
import {
  createBlock,
  createCopiedBlock,
  createDefaultUtilityConfig,
  createEdgeId,
} from "./_helpers/ralph-block-factory.helper";
import {
  canCopyGenerationError,
  createLocalGenerationInterviewPrompt,
  createPromptBlockGenerationPrompt,
  formatCreateFlowMessage,
  formatGenerationActivityTime,
  formatGenerationErrorClipboardText,
  formatJsonDraft,
  formatPromptBlockTargetLabel,
  formatRunMessage,
  getEffectiveProvider,
  getGenerationJobStatusLabel,
  getGenerationPhaseLabel,
  getPreferredModelForProvider,
  getProviderOption,
  getTrimmedGenerationInterviewAnswerComments,
  isRalphPromptBlock,
  parseJsonDraft,
  parseNumberList,
  parseStringRecordDraft,
  type RalphGenerationStatus,
} from "./_helpers/ralph-generation-formatting.helper";
import {
  getBlockVisual,
  getUtilityTone,
} from "./_helpers/get-ralph-block-visual.helper";
import { getPromptLikeText } from "./_helpers/get-ralph-node-preview.helper";
import {
  DEFAULT_RALPH_FLOW_SCOPE,
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
  navigateRalphAiPromptHistory,
  normalizeRalphAiPromptHistory,
} from "./_helpers/normalize-ralph-ai-prompt-history.helper";
import {
  formatDurationMs,
  formatRunRecordDuration,
  getTimestampMs,
} from "./_helpers/format-duration-ms.helper";
import {
  RALPH_INSPECTOR_DEFAULT_WIDTH,
  RALPH_INSPECTOR_SCROLL_EPSILON,
  clampRalphInspectorWidth,
  loadRalphInspectorWidth,
  saveRalphInspectorWidth,
} from "./_helpers/ralph-inspector-width.helper";
import {
  applyActiveRunBlockProgressSnapshot,
  applyActiveRunEventSnapshot,
  createRalphBlockProgressSnapshot,
  getRalphProgressSnapshot,
  getRunEventToneClassName,
  getSortedActiveBlockDetails,
  type ActiveRalphRun,
} from "./_helpers/ralph-active-run-progress.helper";
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
  getDefaultRalphInputValue,
  validateRalphInputFieldValues,
} from "./_helpers/validate-ralph-input-field-values.helper";
import {
  createDefaultRalphVariableValues,
  getRalphVariableValue,
  validateRalphFlowVariableValues,
} from "./_helpers/validate-ralph-flow-variable-values.helper";
import {
  getOutputChipClassName,
  getRunStatusPresentation,
} from "./_helpers/ralph-run-presentation.helper";
import {
  applyGenerationActivity,
  createGenerationActivityFromProgress,
  createGenerationActivityFromResultEvent,
  type RalphGenerationActivityEvent,
} from "./_helpers/ralph-generation-activity.helper";
import {
  createStarterImportId,
  getStarterFlowById,
  getStarterFlowUpdate,
} from "./_helpers/ralph-starter-flow-presentation.helper";
import {
  ACTIVE_RUN_LIST_LIMIT,
  ACTIVE_TASK_REGISTRATION_GRACE_MS,
  ANNOTATION_TONES,
  ASK_USER_MODE_OPTIONS,
  DEFAULT_RUNTIME_PROVIDER_OPTIONS,
  EDITOR_MODES,
  END_STATUS_OPTIONS,
  INPUT_FIELD_TYPE_OPTIONS,
  LIVE_EXPANDED_NODE_PREVIEW_LIMIT,
  LIVE_VARIABLE_PREVIEW_LIMIT,
  RALPH_INSPECTOR_SECTIONS,
  RALPH_NEW_BLOCK_CENTER_DURATION_MS,
  RALPH_REACT_FLOW_PRO_OPTIONS,
  RALPH_VALIDATION_JUMP_DURATION_MS,
  RALPH_VARIABLE_SNIPPETS,
  UTILITY_TYPE_OPTIONS,
  VALIDATION_SCOPE_OPTIONS,
  createRalphProviderOptions,
  type ClipboardCopyState,
  type RalphAiGenerationMode,
  type RalphAiTarget,
  type RalphAttachmentSelectionKind,
  type RalphEditorMode,
  type RalphInspectorSectionId,
  type RalphRunPanelTab,
} from "./_helpers/ralph-flow-editor-options.helper";
import {
  RALPH_EDGE_TYPES,
  RALPH_NODE_TYPES,
} from "./components/ralph-flow-canvas-elements";
import {
  RalphInspectorDetails,
  RalphInspectorField,
} from "./components/ralph-inspector-primitives";
import { RalphUtilityConditionFields } from "./components/ralph-utility-condition-fields";
import {
  RalphInspectorSectionTabs,
  RalphSelectedRouteSummary,
} from "./components/ralph-inspector-navigation";
import {
  ActiveRalphBlockDetailCard,
  RalphRunRecordBlockCard,
} from "./components/ralph-run-detail-cards";
import {
  RalphExpandedEditorDialog,
  RalphStarterFlowDialog,
  type RalphExpandedEditorState,
} from "./components/ralph-editor-dialogs";
import {
  RalphGenerationInterviewDialog,
  type RalphGenerationInterviewDialogState,
} from "./components/ralph-generation-interview-dialog";
import { RalphFlowEditorToolbar } from "./components/ralph-flow-editor-toolbar";
import {
  RalphCanvasContextMenu,
  RalphFlowListContextMenu,
  type RalphCanvasMenu,
  type RalphFlowListMenu,
} from "./components/ralph-flow-context-menus";
import { RalphPromptHighlight } from "./components/ralph-prompt-highlight";
import {
  RalphInputControl,
  RalphSetupVariableControl,
} from "./components/ralph-input-controls";
import {
  RalphFlowLibraryPanel,
  type RalphFlowListRow,
} from "./components/ralph-flow-library-panel";

export type { RalphFlowLibraryMode } from "./_helpers/normalize-ralph-flow-scope.helper";

export interface RalphFlowEditorProps {
  workspaceRoot: string | null;
  initialPrompt?: string;
  isActive?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  flowLibraryMode?: RalphFlowLibraryMode;
  onFlowLibraryModeChange?: (mode: RalphFlowLibraryMode) => void;
  runMode: RunMode;
  generationProvider: RuntimeProvider;
  generationModel: string;
  generationReasoning?: ReasoningMode;
  runProvider: RuntimeProvider;
  runModel: string;
  runReasoning?: ReasoningMode;
  defaultMaxTransitions?: number;
  providerOptions?: readonly RuntimeProvider[];
  generationPromptHistory?: readonly string[];
  onGenerationPromptHistoryChange?: (history: string[]) => void;
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
  workspaceRoot: string;
  userPrompt: string;
  generationPrompt: string;
  target: RalphAiTarget;
  generationMode: RalphAiGenerationMode;
  targetScope: RalphFlowScope;
  targetFlowName: string;
  existingFlow?: RalphFlow;
  expectedFingerprintAtStart?: string;
  targetFlowId: string | null;
  selectedIdAtStart: string | null;
  selectedScopeAtStart: RalphFlowScope;
  draftSnapshotAtStart: string;
  promptBlockLabel?: string;
}

interface RalphAttachmentMutationContext {
  workspaceRoot: string | null;
  scope: RalphFlowScope;
  flowId: string;
  blockId: string;
  attachmentsSnapshot: string;
}

export const createRalphRunResultFromDetail = (
  detail: RalphRunDetailResult,
  variables: ReturnType<typeof discoverRalphFlowVariables> = [],
): RalphRunResult => {
  const { record } = detail;
  const checkpoint = record.checkpoint;

  return {
    runId: record.id,
    startedAt: checkpoint?.startedAt ?? record.createdAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    flow: record.flowId,
    status: record.status,
    summary: record.summary,
    events: record.events,
    blockResults:
      checkpoint?.blockResults ??
      record.blockResults.map((block) => ({
        blockId: block.blockId,
        ...(block.operationId ? { operationId: block.operationId } : {}),
        output: block.output,
        status: block.status,
        attempt: block.attempt,
        ...(block.durationMs !== undefined ? { durationMs: block.durationMs } : {}),
        ...(block.progress ? { progress: block.progress } : {}),
        ...(block.data !== undefined ? { data: block.data } : {}),
        summary: block.summary,
        ...(block.markdown ? { markdown: block.markdown } : {}),
        ...(block.error ? { error: block.error } : {}),
      })),
    missingVariables: [],
    unknownVariables: [],
    validation: {
      ...record.validation,
      errorIssues: [],
      warningIssues: [],
      variables,
    },
    ...(checkpoint?.pendingInput ? { pendingInput: checkpoint.pendingInput } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(checkpoint?.autonomy ? { autonomy: checkpoint.autonomy } : {}),
    ...(record.durability ? { durability: record.durability } : {}),
  };
};

export const RalphFlowEditor = ({
  workspaceRoot,
  initialPrompt = "",
  isActive = true,
  onDirtyChange,
  flowLibraryMode = "workspace",
  onFlowLibraryModeChange,
  runMode,
  generationProvider,
  generationModel,
  generationReasoning,
  runProvider,
  runModel,
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
  const [starterFlowDialogOpen, setStarterFlowDialogOpen] = useState(false);
  const [starterImportError, setStarterImportError] = useState<string | null>(
    null,
  );
  const [starterImportScope, setStarterImportScope] = useState<RalphFlowScope>(
    () => getDefaultCreationScope(flowLibraryMode),
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
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  const expandedEditorTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const reactFlowInstanceRef =
    useRef<ReactFlowInstance<RalphCanvasNode, RalphCanvasEdge> | null>(null);
  const selectedIdRef = useRef(selectedId);
  const selectedScopeRef = useRef(selectedScope);
  const draftFlowRef = useRef<RalphFlow | null>(draftFlow);
  const lastRunRef = useRef<RalphRunResult | null>(lastRun);
  const draftFlowScopeRef = useRef<RalphFlowScope>(draftFlowScope);
  const draftFlowWorkspaceRootRef = useRef<string | null>(
    draftFlow ? workspaceRoot : null,
  );
  const savedSnapshotRef = useRef(savedSnapshot);
  const flowListRequestRef = useRef(0);
  const flowDetailsRequestRef = useRef(0);
  const revisionsRequestRef = useRef(0);
  const runHistoryRequestRef = useRef(0);
  const runViewRequestRef = useRef(0);
  const saveRequestRef = useRef(0);
  const restoreRequestRef = useRef(0);
  const blockingOperationRef = useRef(0);
  const reconcileRequestRef = useRef(0);
  const reconcileInFlightRef = useRef(false);
  const generationRequestRef = useRef<string | null>(null);
  const generationInterviewRequestRef = useRef<string | null>(null);
  const workspaceRootRef = useRef(workspaceRoot);
  const pendingInputIdRef = useRef<string | null>(null);
  const pendingResumeRequestRef = useRef<string | null>(null);
  const utilityJsonBlockIdRef = useRef<string | null>(null);
  const utilityJsonBaselineRef = useRef("");
  const utilityJsonDirtyRef = useRef(false);
  const initialPromptAppliedRef = useRef(false);
  workspaceRootRef.current = workspaceRoot;
  lastRunRef.current = lastRun;
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
    draftFlowScopeRef.current = nextDraftFlowScope;
    draftFlowWorkspaceRootRef.current = nextDraftFlow ? workspaceRoot : null;
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
  const replaceLastRun = (nextLastRun: RalphRunResult | null): void => {
    lastRunRef.current = nextLastRun;
    setLastRun(nextLastRun);
  };
  const beginBlockingOperation = (): number => {
    const operationId = blockingOperationRef.current + 1;
    blockingOperationRef.current = operationId;
    setLoading(true);
    return operationId;
  };
  const finishBlockingOperation = (operationId: number): void => {
    if (blockingOperationRef.current === operationId) {
      setLoading(false);
    }
  };
  const updateUtilityJsonDraft = (value: string): void => {
    utilityJsonDirtyRef.current = value !== utilityJsonBaselineRef.current;
    setUtilityJsonDraft(value);
    setUtilityJsonError(null);
  };
  const issues = useMemo(
    () =>
      draftFlow
        ? validateFlowLocally(draftFlow, modelCatalog, flows, selectedScope)
        : [],
    [draftFlow, flows, modelCatalog, selectedScope],
  );
  const draftSnapshot = useMemo(
    () => getFlowSnapshot(draftFlow),
    [draftFlow],
  );
  const dirty = draftFlow ? savedSnapshot !== draftSnapshot : false;
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
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (!pendingInput) {
      pendingInputIdRef.current = null;
      setPendingInputValues({});
      return;
    }

    const isSameRequest = pendingInputIdRef.current === pendingInput.id;
    pendingInputIdRef.current = pendingInput.id;
    setPendingInputValues((current) =>
      Object.fromEntries(
        pendingInput.fields.map((field) => [
          field.id,
          isSameRequest && Object.hasOwn(current, field.id)
            ? current[field.id]
            : field.defaultValue ?? (field.type === "boolean" ? false : null),
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
      setStarterImportScope(flowLibraryMode);
    }
  }, [flowLibraryMode]);

  useEffect(() => {
    draftFlowRef.current = draftFlow;
  }, [draftFlow]);

  useEffect(() => {
    draftFlowScopeRef.current = draftFlowScope;
  }, [draftFlowScope]);

  useEffect(() => {
    savedSnapshotRef.current = savedSnapshot;
  }, [savedSnapshot]);

  useEffect(
    () => () => {
      flowListRequestRef.current += 1;
      flowDetailsRequestRef.current += 1;
      revisionsRequestRef.current += 1;
      runHistoryRequestRef.current += 1;
      runViewRequestRef.current += 1;
      saveRequestRef.current += 1;
      restoreRequestRef.current += 1;
      blockingOperationRef.current += 1;
      reconcileRequestRef.current += 1;
      generationInterviewRequestRef.current = null;
    },
    [],
  );

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
        const nextState = navigateRalphAiPromptHistory(
          {
            draft: aiPromptDraft,
            draftBeforeHistory: aiPromptDraftBeforeHistory,
            historyIndex: aiPromptHistoryIndex,
          },
          aiPromptHistory,
          "previous",
        );

        setAiPromptDraft(nextState.draft);
        setAiPromptDraftBeforeHistory(nextState.draftBeforeHistory);
        setAiPromptHistoryIndex(nextState.historyIndex);
        return;
      }

      const nextState = navigateRalphAiPromptHistory(
        {
          draft: aiPromptDraft,
          draftBeforeHistory: aiPromptDraftBeforeHistory,
          historyIndex: aiPromptHistoryIndex,
        },
        aiPromptHistory,
        "next",
      );

      setAiPromptDraft(nextState.draft);
      setAiPromptDraftBeforeHistory(nextState.draftBeforeHistory);
      setAiPromptHistoryIndex(nextState.historyIndex);
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

  const getExpandedEditorContextKey = (): string =>
    [
      workspaceRootRef.current ?? "",
      draftFlowScopeRef.current,
      draftFlowRef.current?.id ?? "",
      selectedBlockId ?? "",
    ].join("::");

  const openExpandedEditor = (editor: RalphExpandedEditorState): void => {
    setExpandedEditor({
      ...editor,
      contextKey: getExpandedEditorContextKey(),
    });
    setExpandedEditorDraft(editor.value);
    setExpandedEditorWrap(editor.mode !== "code");
  };

  const applyExpandedEditor = (): void => {
    if (!expandedEditor) {
      return;
    }

    if (expandedEditor.contextKey !== getExpandedEditorContextKey()) {
      setExpandedEditor(null);
      setMessage(
        "The flow or block changed while the expanded editor was open. Reopen it before applying changes.",
      );
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
  const defaultFlowActionScope =
    flowLibraryMode === "workspace" || flowLibraryMode === "user"
      ? flowLibraryMode
      : creationScope;
  const starterImportScopeLabel = RALPH_FLOW_SCOPE_LABELS[starterImportScope];
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
    const visibleDisplayFlows = displayFlows.filter((flow) =>
      isFlowScopeVisibleInLibraryMode(getFlowSummaryScope(flow), flowLibraryMode),
    );

    if (flowLibraryMode !== "all") {
      return visibleDisplayFlows.map((flow) => ({ type: "flow", flow }));
    }

    return RALPH_FLOW_SCOPES.flatMap((scope) => {
      const scopedFlows = visibleDisplayFlows.filter(
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
  const selectedFlowPrimaryActiveRun = selectedFlowActiveRuns[0] ?? null;
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
  const commitNodeResizeEnd = useCallback(
    (
      blockId: string,
      size: { width: number; height: number },
      position: RalphPosition,
    ): void => {
      setDraftFlow((current) => {
        if (!current) {
          draftFlowRef.current = current;
          return current;
        }

        if (createLockedCanvasBlockIdSet(current).has(blockId)) {
          draftFlowRef.current = current;
          return current;
        }

        let changed = false;
        const blocks = current.blocks.map((block) => {
          if (block.id !== blockId) {
            return block;
          }

          if (
            areSizesEqual(block.size, size) &&
            arePositionsEqual(block.position, position)
          ) {
            return block;
          }

          changed = true;
          return {
            ...block,
            size,
            position,
          };
        });

        if (!changed) {
          draftFlowRef.current = current;
          return current;
        }

        const next = { ...current, blocks };
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
    },
    [],
  );
  const flowNodes = useMemo(
    () =>
      draftFlow
        ? flowToNodes(
            draftFlow,
            issues,
            selectedBlockId,
            activeCanvasBlockId,
            commitNodeResizeEnd,
          )
        : [],
    [
      activeCanvasBlockId,
      commitNodeResizeEnd,
      draftFlow,
      issues,
      selectedBlockId,
    ],
  );
  const canvasIdentityKey = [
    workspaceRoot ?? "",
    selectedScope,
    draftFlow?.id ?? "",
  ].join("::");
  const flowLayoutKey = useMemo(
    () => `${canvasIdentityKey}::${getFlowLayoutKey(draftFlow)}`,
    [canvasIdentityKey, draftFlow],
  );
  const setupVariables = useMemo(
    () => (draftFlow ? discoverRalphFlowVariables(draftFlow) : []),
    [draftFlow],
  );
  useEffect(() => {
    const defaults = createDefaultRalphVariableValues(setupVariables);
    setVariableValues((current) => {
      const next = Object.fromEntries(
        setupVariables.map((variable) => [
          variable.name,
          Object.hasOwn(current, variable.name)
            ? current[variable.name]
            : defaults[variable.name],
        ]),
      );

      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [setupVariables]);
  const edges = useMemo(
    () =>
      draftFlow ? flowToEdges(draftFlow, selectedEdgeId, selectedBlockId) : [],
    [draftFlow, selectedBlockId, selectedEdgeId],
  );
  const requiredMissingVariables = useMemo(() => {
    if (!draftFlow) {
      return [];
    }

    return setupVariables
      .filter((variable) => variable.required)
      .filter((variable) => !getRalphVariableValue(variable, variableValues).trim())
      .map((variable) => variable.name);
  }, [setupVariables, variableValues]);
  const setupVariableErrors = useMemo(() => {
    if (!draftFlow) {
      return {};
    }

    return validateRalphFlowVariableValues(setupVariables, variableValues);
  }, [draftFlow, setupVariables, variableValues]);
  const setupVariableErrorNames = useMemo(
    () => Object.keys(setupVariableErrors),
    [setupVariableErrors],
  );
  const hasBlockingIssues = issues.some((issue) => issue.level === "error");
  const errorCount = issues.filter((issue) => issue.level === "error").length;
  const warningCount = issues.length - errorCount;
  const showMiniMap = editorMode === "design" && canvasNodes.length >= 4;
  const activeRunCount = activeRuns.length;
  const pendingInputSupersededByActiveRun = Boolean(
    pendingInput && selectedFlowActiveRunCount > 0,
  );
  const visiblePendingInput =
    pendingInput && !inputSubmitting && !pendingInputSupersededByActiveRun
      ? pendingInput
      : null;
  const pendingInputContinuationInProgress = Boolean(
    pendingInput && (inputSubmitting || pendingInputSupersededByActiveRun),
  );
  const visibleLastRun = pendingInputContinuationInProgress ? null : lastRun;
  const canRetryRecoverableRun = Boolean(
    workspaceRoot &&
      lastRun?.runId &&
      lastRun.checkpoint &&
      !pendingInput &&
      !inputSubmitting &&
      !pendingInputSupersededByActiveRun &&
      selectedFlowActiveRunCount === 0 &&
      (lastRun.status === "blocked" || lastRun.status === "crashed"),
  );
  const runButtonLabel = selectedFlowPrimaryActiveRun ? "View active run" : "Run";
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
    requiredMissingVariables.length === 0 &&
    setupVariableErrorNames.length === 0;
  const canRunAction = Boolean(selectedFlowPrimaryActiveRun) || canRunFlow;
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

    if (setupVariableErrorNames.length > 0) {
      return `Fix setup variable${setupVariableErrorNames.length === 1 ? "" : "s"}: ${setupVariableErrorNames.join(", ")}.`;
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
    setupVariableErrorNames,
    workspaceRoot,
  ]);
  const runReadyMessage =
    warningCount > 0
      ? `Ready to run with ${warningCount} warning${warningCount === 1 ? "" : "s"}.`
      : "Ready to run.";
  const runActionMessage = selectedFlowPrimaryActiveRun
    ? "Active run is already running."
    : runBlockedReason ?? runReadyMessage;
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
          if (
            current?.id !== event.taskId &&
            generationRequestRef.current !== event.taskId
          ) {
            return current;
          }

          return current?.id === event.taskId
            ? applyGenerationActivity(current, generationActivity)
            : current;
        });
      }

      const snapshot = getRalphProgressSnapshot(event.progress);
      const blockProgressSnapshot = createRalphBlockProgressSnapshot(
        event.progress,
        event.timestamp,
      );

      if (!snapshot && !blockProgressSnapshot) {
        return;
      }

      setActiveRuns((current) =>
        current.map((run) => {
          if (run.id !== event.taskId) {
            return run;
          }

          const runWithEvent = snapshot
            ? applyActiveRunEventSnapshot(run, snapshot, event.timestamp)
            : run;

          return blockProgressSnapshot
            ? applyActiveRunBlockProgressSnapshot(
                runWithEvent,
                blockProgressSnapshot,
              )
            : runWithEvent;
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

      let loadedFlows = scopeResults
        .flatMap(({ scope, result }) =>
          result.flows.map((flow) => withFlowSummaryScope(flow, scope)),
        )
        .sort(compareFlowSummaries);

      const currentId = selectedIdRef.current;
      const currentScope = selectedScopeRef.current;
      const currentDraft = draftFlowRef.current;
      const currentDraftScope = draftFlowScopeRef.current;
      const currentDraftMatchesSelection =
        Boolean(currentDraft) &&
        currentDraft?.id === currentId &&
        currentDraftScope === currentScope;
      const currentDraftDirty = Boolean(
        currentDraftMatchesSelection &&
        currentDraft &&
        getFlowSnapshot(currentDraft) !== savedSnapshotRef.current,
      );
      const currentDraftUnsaved =
        currentDraftMatchesSelection &&
        unsavedFlowId === currentDraft?.id &&
        unsavedFlowScope === currentDraftScope;
      const canKeepCurrentDraft =
        currentDraftMatchesSelection &&
        Boolean(currentDraft) &&
        (currentDraftUnsaved ||
          currentDraftDirty ||
          isFlowScopeVisibleInLibraryMode(currentDraftScope, flowLibraryMode));
      let autoUpgradedSelectedFlow: {
        flow: RalphFlow;
        scope: RalphFlowScope;
      } | undefined;

      loadedFlows = await Promise.all(
        loadedFlows.map(async (flowSummary) => {
          const isSelected = hasFlowSelection(
            flowSummary,
            currentId,
            currentScope,
          );
          if (
            flowSummary.source?.kind !== "starter" ||
            (isSelected && (currentDraftDirty || currentDraftUnsaved)) ||
            getFlowActiveRuns(flowSummary).length > 0
          ) {
            return flowSummary;
          }

          const starterFlow = getStarterFlowById(flowSummary.source.id);
          if (!starterFlow || starterFlow.version <= flowSummary.source.version) {
            return flowSummary;
          }

          const flowScope = getFlowSummaryScope(flowSummary);

          try {
            const current = await showRalphFlow(
              workspaceRoot,
              flowSummary.id,
              flowScope,
            );
            const upgrade = createUpgradedRalphStarterFlowWithReport(
              current.flow,
              starterFlow,
              new Date().toISOString(),
            );

            if (
              !upgrade.report.applied ||
              (upgrade.report.strategy !== "replace-unmodified" &&
                upgrade.report.conflicts.length > 0)
            ) {
              return flowSummary;
            }

            const saved = await saveRalphFlow(workspaceRoot, {
              flow: upgrade.flow,
              scope: flowScope,
              expectedFingerprint: createRalphFlowFingerprint(current.flow),
            });

            if (isSelected) {
              autoUpgradedSelectedFlow = {
                flow: saved.flow,
                scope: flowScope,
              };
            }

            return flowToSummary(saved.flow, saved.path, flowScope);
          } catch (error) {
            // Concurrent edits and temporarily unavailable scopes remain visible
            // and are retried on the next refresh without overwriting local work.
            console.warn(
              `Automatic starter upgrade deferred for ${flowSummary.id}.`,
              error,
            );
            return flowSummary;
          }
        }),
      );

      if (requestId !== flowListRequestRef.current) {
        return;
      }

      loadedFlows.sort(compareFlowSummaries);
      setFlows(loadedFlows);
      const currentDraftStillMatchesRefresh = Boolean(
        currentDraft &&
        workspaceRootRef.current === workspaceRoot &&
        selectedIdRef.current === currentId &&
        selectedScopeRef.current === currentScope &&
        draftFlowRef.current?.id === currentDraft.id &&
        draftFlowScopeRef.current === currentDraftScope &&
        getFlowSnapshot(draftFlowRef.current) === getFlowSnapshot(currentDraft),
      );
      if (autoUpgradedSelectedFlow && currentDraftStillMatchesRefresh) {
        replaceDraftFlow(
          autoUpgradedSelectedFlow.flow,
          autoUpgradedSelectedFlow.scope,
        );
        replaceSavedSnapshot(getFlowSnapshot(autoUpgradedSelectedFlow.flow));
        setVariableValues(
          createDefaultRalphVariableValues(
            discoverRalphFlowVariables(autoUpgradedSelectedFlow.flow),
          ),
        );
        setSelectedBlockId((currentBlockId) =>
          autoUpgradedSelectedFlow?.flow.blocks.some(
            (block) => block.id === currentBlockId,
          )
            ? currentBlockId
            : autoUpgradedSelectedFlow?.flow.blocks[0]?.id ?? null,
        );
      }
      const nextEmptySelectionScope = getDefaultCreationScope(flowLibraryMode);
      const nextSelection = (() => {
        if (!currentId) {
          if (loadedFlows[0]) {
            return {
              id: loadedFlows[0].id,
              scope: getFlowSummaryScope(loadedFlows[0]),
            };
          }

          return canKeepCurrentDraft && currentDraft
            ? { id: currentDraft.id, scope: currentDraftScope }
            : { id: "", scope: nextEmptySelectionScope };
        }

        if (
          currentDraftMatchesSelection &&
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

        return canKeepCurrentDraft && currentDraft
          ? { id: currentDraft.id, scope: currentDraftScope }
          : { id: "", scope: nextEmptySelectionScope };
      })();

      if (
        !autoUpgradedSelectedFlow &&
        currentDraftMatchesSelection &&
        !currentDraftDirty &&
        !currentDraftUnsaved &&
        nextSelection.id === currentId &&
        nextSelection.scope === currentScope &&
        currentDraft
      ) {
        const snapshotBeforeDetailRefresh = getFlowSnapshot(currentDraft);
        const refreshed = await showRalphFlow(
          workspaceRoot,
          currentId,
          currentScope,
        );
        if (
          requestId === flowListRequestRef.current &&
          workspaceRootRef.current === workspaceRoot &&
          selectedIdRef.current === currentId &&
          selectedScopeRef.current === currentScope &&
          draftFlowRef.current?.id === currentId &&
          getFlowSnapshot(draftFlowRef.current) === snapshotBeforeDetailRefresh
        ) {
          replaceDraftFlow(refreshed.flow, currentScope);
          replaceSavedSnapshot(getFlowSnapshot(refreshed.flow));
          setSelectedBlockId((currentBlockId) =>
            refreshed.flow.blocks.some((block) => block.id === currentBlockId)
              ? currentBlockId
              : refreshed.flow.blocks[0]?.id ?? null,
          );
        }
      }

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
    const requestId = revisionsRequestRef.current + 1;
    revisionsRequestRef.current = requestId;

    if (!workspaceRoot || !flowId) {
      setRevisions([]);
      setRevisionsLoading(false);
      return;
    }

    setRevisionsLoading(true);

    try {
      const result = await listRalphFlowRevisions(workspaceRoot, flowId, scope);
      if (
        requestId !== revisionsRequestRef.current ||
        selectedIdRef.current !== flowId ||
        selectedScopeRef.current !== scope
      ) {
        return;
      }

      setRevisions(result.revisions);
    } catch (error) {
      if (
        requestId !== revisionsRequestRef.current ||
        selectedIdRef.current !== flowId ||
        selectedScopeRef.current !== scope
      ) {
        return;
      }

      setRevisions([]);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === revisionsRequestRef.current) {
        setRevisionsLoading(false);
      }
    }
  };

  const refreshRunHistory = async (
    flowId: string | null = selectedIdRef.current,
    scope: RalphFlowScope = selectedScopeRef.current,
  ): Promise<void> => {
    const requestId = runHistoryRequestRef.current + 1;
    runHistoryRequestRef.current = requestId;

    if (!workspaceRoot) {
      setRunHistory([]);
      setRunHistoryLoading(false);
      return;
    }

    setRunHistoryLoading(true);

    try {
      const result = await listRalphRuns(workspaceRoot, flowId || undefined, scope);
      if (
        requestId !== runHistoryRequestRef.current ||
        (flowId !== null && selectedIdRef.current !== flowId) ||
        selectedScopeRef.current !== scope
      ) {
        return;
      }

      setRunHistory(result.runs);
    } catch (error) {
      if (
        requestId !== runHistoryRequestRef.current ||
        (flowId !== null && selectedIdRef.current !== flowId) ||
        selectedScopeRef.current !== scope
      ) {
        return;
      }

      setRunHistory([]);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === runHistoryRequestRef.current) {
        setRunHistoryLoading(false);
      }
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

    const requestId = runViewRequestRef.current + 1;
    runViewRequestRef.current = requestId;
    const workspaceAtStart = workspaceRoot;
    setSelectedRunId(runId);
    setSelectedRunDetail(null);
    setSelectedRunLog(null);
    setRunLogLoading(false);
    setRunDetailLoading(true);
    setRunDetailError(null);

    try {
      const result = await showRalphRunDetail(workspaceRoot, runId, scope);
      if (
        requestId !== runViewRequestRef.current ||
        workspaceRootRef.current !== workspaceAtStart
      ) {
        return;
      }

      setSelectedRunDetail(result);
      if (
        result.record.id === runId &&
        result.record.flowId === selectedIdRef.current &&
        scope === selectedScopeRef.current &&
        (!lastRunRef.current || lastRunRef.current.runId !== result.record.id)
      ) {
        const currentFlow = draftFlowRef.current;
        replaceLastRun(
          createRalphRunResultFromDetail(
            result,
            currentFlow ? discoverRalphFlowVariables(currentFlow) : [],
          ),
        );
        if (result.record.checkpoint?.pendingInput) {
          setVariableValues({
            ...result.record.variableValues,
            ...result.record.checkpoint.variables,
          });
        }
      }
      setEditorMode("run");

      if (options.selectTab ?? true) {
        setRunPanelTab("details");
      }
    } catch (error) {
      if (requestId !== runViewRequestRef.current) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      setRunDetailError(message);
      setMessage(message);
    } finally {
      if (requestId === runViewRequestRef.current) {
        setRunDetailLoading(false);
      }
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

    const requestId = runViewRequestRef.current + 1;
    runViewRequestRef.current = requestId;
    const workspaceAtStart = workspaceRoot;
    setSelectedRunId(runId);
    setSelectedRunDetail(null);
    setSelectedRunLog(null);
    setRunDetailLoading(false);
    setRunLogLoading(true);

    try {
      const result = await showRalphRunLog(workspaceRoot, runId, kind, scope);
      if (
        requestId !== runViewRequestRef.current ||
        workspaceRootRef.current !== workspaceAtStart
      ) {
        return;
      }

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
      if (requestId !== runViewRequestRef.current) {
        return;
      }

      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === runViewRequestRef.current) {
        setRunLogLoading(false);
      }
    }
  };

  const reconcileActiveRalphRuns = async (requestId: number): Promise<void> => {
    const activeTasks = await loadActiveDesktopTasks();

    if (!activeTasks || requestId !== reconcileRequestRef.current) {
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
      .filter((task) => {
        const action = getRalphTaskAction(task);

        return action === "run" || action === "resume";
      })
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
          ...(runReasoning ? { reasoning: runReasoning } : {}),
          ...(defaultMaxTransitions
            ? { maxTransitions: defaultMaxTransitions }
            : {}),
          variableValues: {},
          events: [],
          blockDetails: {},
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
      const matchingActiveTask = current
        ? activeRalphTasks.find((task) => task.id === current.id)
        : undefined;
      if (current && matchingActiveTask && current.status === "blocked") {
        return {
          ...current,
          status: "running",
          summary: `AI flow generation \`${current.targetAlias}\` is running in the background.`,
        };
      }

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
    const requestId = reconcileRequestRef.current + 1;
    reconcileRequestRef.current = requestId;

    if (!isActive || !workspaceRoot) {
      return;
    }

    let cancelled = false;
    const reconcile = (): void => {
      if (reconcileInFlightRef.current) {
        return;
      }

      reconcileInFlightRef.current = true;
      void reconcileActiveRalphRuns(requestId)
        .catch((error) => {
          if (!cancelled && requestId === reconcileRequestRef.current) {
            setMessage(error instanceof Error ? error.message : String(error));
          }
        })
        .finally(() => {
          reconcileInFlightRef.current = false;
        });
    };
    reconcile();
    const interval = window.setInterval(reconcile, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (requestId === reconcileRequestRef.current) {
        reconcileRequestRef.current += 1;
      }
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
    runProvider,
    runReasoning,
    selectedScope,
    workspaceRoot,
  ]);

  useEffect(() => {
    if (!isActive || !workspaceRoot || !selectedId || selectedFlowUnsaved) {
      revisionsRequestRef.current += 1;
      setRevisions([]);
      setRevisionsLoading(false);
      return;
    }

    void refreshRevisions(selectedId, selectedScope);
  }, [isActive, selectedFlowUnsaved, selectedId, selectedScope, workspaceRoot]);

  useEffect(() => {
    runViewRequestRef.current += 1;

    if (!isActive || !workspaceRoot || !selectedId || selectedFlowUnsaved) {
      runHistoryRequestRef.current += 1;
      setRunHistory([]);
      setRunHistoryLoading(false);
      setSelectedRunLog(null);
      setSelectedRunId(null);
      setSelectedRunDetail(null);
      setRunDetailError(null);
      setRunDetailLoading(false);
      setRunLogLoading(false);
      return;
    }

    setSelectedRunId(null);
    setSelectedRunDetail(null);
    setRunDetailError(null);
    setSelectedRunLog(null);
    setRunDetailLoading(false);
    setRunLogLoading(false);
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
    const selectedUtilityBlockId = selectedUtility ? selectedBlock?.id ?? null : null;

    if (!selectedUtility || !selectedUtilityBlockId) {
      utilityJsonBlockIdRef.current = null;
      utilityJsonBaselineRef.current = "";
      utilityJsonDirtyRef.current = false;
      setUtilityJsonDraft("");
      setUtilityJsonError(null);
      return;
    }

    const formattedUtility = formatJsonDraft(selectedUtility);
    if (utilityJsonBlockIdRef.current !== selectedUtilityBlockId) {
      utilityJsonBlockIdRef.current = selectedUtilityBlockId;
      utilityJsonBaselineRef.current = formattedUtility;
      utilityJsonDirtyRef.current = false;
      setUtilityJsonDraft(formattedUtility);
    } else if (!utilityJsonDirtyRef.current) {
      utilityJsonBaselineRef.current = formattedUtility;
      setUtilityJsonDraft(formattedUtility);
    }

    setUtilityJsonError(null);
  }, [selectedBlock?.id, selectedUtility]);

  useEffect(() => {
    const requestId = flowDetailsRequestRef.current + 1;
    flowDetailsRequestRef.current = requestId;

    if (!isActive || !workspaceRoot || !selectedId) {
      setDetailsLoading(false);
      replaceDraftFlow(null, selectedScope);
      replaceSavedSnapshot("");
      setVariableValues({});
      setSelectedBlockId(null);
      setLastRun(null);
      return;
    }

    if (
      draftFlowRef.current?.id === selectedId &&
      draftFlowScopeRef.current === selectedScope &&
      draftFlowWorkspaceRootRef.current === workspaceRoot
    ) {
      setDetailsLoading(false);
      return;
    }

    let cancelled = false;

    replaceDraftFlow(null, selectedScope);
    replaceSavedSnapshot("");
    setVariableValues({});
    setSelectedBlockId(null);
    setLastRun(null);
    setDetailsLoading(true);
    void showRalphFlow(workspaceRoot, selectedId, selectedScope)
      .then((result) => {
        if (
          cancelled ||
          requestId !== flowDetailsRequestRef.current ||
          workspaceRootRef.current !== workspaceRoot ||
          selectedIdRef.current !== selectedId ||
          selectedScopeRef.current !== selectedScope
        ) {
          return;
        }

        replaceDraftFlow(result.flow, selectedScope);
        replaceSavedSnapshot(getFlowSnapshot(result.flow));
        setSelectedBlockId(result.flow.blocks[0]?.id ?? null);
        setVariableValues(
          createDefaultRalphVariableValues(discoverRalphFlowVariables(result.flow)),
        );
        setLastRun(null);
      })
      .catch((error) => {
        if (
          !cancelled &&
          requestId === flowDetailsRequestRef.current &&
          workspaceRootRef.current === workspaceRoot &&
          selectedIdRef.current === selectedId &&
          selectedScopeRef.current === selectedScope
        ) {
          replaceDraftFlow(null, selectedScope);
          replaceSavedSnapshot("");
          setVariableValues({});
          setSelectedBlockId(null);
          setLastRun(null);
          setMessage(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled && requestId === flowDetailsRequestRef.current) {
          setDetailsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    isActive,
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
    const current = draftFlowRef.current;
    if (!current) {
      return;
    }

    const next = updater(current);
    const currentSnapshot = getFlowSnapshot(current);
    const nextSnapshot = getFlowSnapshot(next);

    if (currentSnapshot === nextSnapshot) {
      return;
    }

    setUndoStack((history) =>
      [...history, currentSnapshot].slice(-MAX_RALPH_HISTORY_ENTRIES),
    );
    setRedoStack([]);
    draftFlowRef.current = next;
    setDraftFlow(next);
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

  const updateSelectedInputFields = (
    updater: (fields: RalphInputField[]) => RalphInputField[],
  ): void => {
    if (!selectedBlock || selectedBlock.type !== "ASK_USER") {
      return;
    }

    updateBlock(selectedBlock.id, (block) =>
      block.type === "ASK_USER"
        ? {
            ...block,
            fields: updater(block.fields),
          }
        : block,
    );
  };

  const updateSelectedInputField = (
    fieldId: string,
    patch: Partial<RalphInputField>,
  ): void => {
    updateSelectedInputFields((fields) =>
      fields.map((field) =>
        field.id === fieldId
          ? {
              ...field,
              ...patch,
            }
          : field,
      ),
    );
  };

  const addSelectedInputField = (): void => {
    updateSelectedInputFields((fields) => [
      ...fields,
      createDefaultInputField(fields),
    ]);
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
    if (
      selectedUtility &&
      utilityJsonDirtyRef.current &&
      formatJsonDraft(selectedUtility) !== utilityJsonBaselineRef.current
    ) {
      setUtilityJsonError(
        "Utility settings changed elsewhere while this JSON draft was open. Reopen the JSON editor to merge those changes.",
      );
      return;
    }

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

    const nextUtility = parsed as RalphUtilityConfig;
    const formattedUtility = formatJsonDraft(nextUtility);
    utilityJsonBaselineRef.current = formattedUtility;
    utilityJsonDirtyRef.current = false;
    setUtilityJsonDraft(formattedUtility);
    replaceSelectedUtility(nextUtility);
    setUtilityJsonError(null);
  };

  const attachPathsToBlock = async (
    blockId: string,
    paths: string[],
    context: RalphAttachmentMutationContext,
  ): Promise<void> => {
    const resolution = await resolveDroppedPaths(paths);
    const incomingAttachments = resolution.entries.map(createRalphPathAttachment);

    if (incomingAttachments.length === 0) {
      return;
    }

    const currentFlow = draftFlowRef.current;
    const currentBlock = currentFlow?.blocks.find((block) => block.id === blockId);
    if (
      workspaceRootRef.current !== context.workspaceRoot ||
      draftFlowScopeRef.current !== context.scope ||
      currentFlow?.id !== context.flowId ||
      context.blockId !== blockId ||
      !currentBlock ||
      JSON.stringify(currentBlock.settings?.attachments ?? []) !==
        context.attachmentsSnapshot
    ) {
      setMessage(
        "The target flow, block, or attachment list changed while paths were being resolved. Add the attachments again.",
      );
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
    const attachmentContext: RalphAttachmentMutationContext = {
      workspaceRoot: workspaceRootRef.current,
      scope: draftFlowScopeRef.current,
      flowId: draftFlowRef.current?.id ?? "",
      blockId,
      attachmentsSnapshot: JSON.stringify(selectedBlock.settings?.attachments ?? []),
    };

    if (!isTauri()) {
      await attachPathsToBlock(blockId, [
        selectionKind === "folders"
          ? "/mock/context-folder"
          : selectionKind === "images"
            ? "/mock/screenshot.png"
            : "/mock/document.txt",
      ], attachmentContext);
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

      await attachPathsToBlock(blockId, paths, attachmentContext);
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

  const applyNewLocalFlow = (
    targetScope: RalphFlowScope = defaultFlowActionScope,
  ): void => {
    const nextAlias = createUniqueFlowAlias(
      normalizedFlowAliasDraft || "ralph-flow",
      displayFlows,
      targetScope,
    );
    const nextFlow = createBlankFlow(nextAlias);

    setCreationScope(targetScope);
    setDetailsLoading(false);
    replaceDraftFlow(nextFlow, targetScope);
    replaceSavedSnapshot("");
    replaceSelectedId(nextFlow.id, targetScope);
    setUnsavedFlowId(nextFlow.id);
    setUnsavedFlowScope(targetScope);
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
      createDefaultRalphVariableValues(discoverRalphFlowVariables(generatedFlow)),
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
    const expectedFingerprintAtStart =
      existingFlow && savedSnapshotRef.current
        ? createRalphFlowFingerprint(
            JSON.parse(savedSnapshotRef.current) as RalphFlow,
          )
        : undefined;

    return {
      workspaceRoot,
      userPrompt: normalizedAiPrompt,
      generationPrompt,
      target: aiTarget,
      generationMode: aiGenerationMode,
      targetScope,
      targetFlowName,
      ...(existingFlow ? { existingFlow } : {}),
      ...(expectedFingerprintAtStart ? { expectedFingerprintAtStart } : {}),
      targetFlowId: existingFlow?.id ?? null,
      selectedIdAtStart: selectedIdRef.current,
      selectedScopeAtStart: selectedScopeRef.current,
      draftSnapshotAtStart,
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
    if (workspaceRootRef.current !== context.workspaceRoot) {
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
      const result = await createRalphFlow(context.workspaceRoot, {
        prompt: generationPrompt,
        scope: context.targetScope,
        mode: runMode,
        provider: generationProvider,
        model: generationModel,
        ...(generationReasoning ? { reasoning: generationReasoning } : {}),
        name: context.targetFlowName,
        ...(context.existingFlow ? { existingFlow: context.existingFlow } : {}),
        ...(context.expectedFingerprintAtStart
          ? { expectedFingerprint: context.expectedFingerprintAtStart }
          : {}),
        target: context.target,
        generationMode,
        taskId: jobId,
      });
      if (
        generationRequestRef.current !== jobId ||
        workspaceRootRef.current !== context.workspaceRoot
      ) {
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

      const generatedFlow = result.flow;

      if (generatedFlow?.id) {
        setFlows((current) =>
          upsertFlowSummary(
            current,
            flowToSummary(generatedFlow, result.flowPath, context.targetScope),
          ),
        );
        const currentDraft = draftFlowRef.current;
        const currentDraftSnapshot = currentDraft
          ? getFlowSnapshot(currentDraft)
          : "";
        const selectionAndDraftAreUnchanged =
          workspaceRootRef.current === context.workspaceRoot &&
          selectedIdRef.current === context.selectedIdAtStart &&
          selectedScopeRef.current === context.selectedScopeAtStart &&
          currentDraftSnapshot === context.draftSnapshotAtStart;
        const canAdoptGeneratedFlow =
          selectionAndDraftAreUnchanged &&
          (context.target === "flow" ||
            (selectedScopeRef.current === context.targetScope &&
              currentDraft?.id === context.targetFlowId));

        if (canAdoptGeneratedFlow) {
          replaceDraftFlow(generatedFlow, context.targetScope);
          replaceSavedSnapshot(getFlowSnapshot(generatedFlow));
          replaceSelectedId(generatedFlow.id, context.targetScope);
          setUnsavedFlowId((current) =>
            current === generatedFlow.id && unsavedFlowScope === context.targetScope
              ? null
              : current,
          );
          setSelectedBlockId(generatedFlow.blocks[0]?.id ?? null);
          setVariableValues(
            createDefaultRalphVariableValues(
              discoverRalphFlowVariables(generatedFlow),
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
    if (
      generationInterviewRequestRef.current !== taskId ||
      workspaceRootRef.current !== context.workspaceRoot
    ) {
      return;
    }

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
    if (generationInterviewRequestRef.current !== taskId) {
      return;
    }
    await executeFlowGenerationWithAgent(context, finalPrompt, "do-it");
    if (generationInterviewRequestRef.current === taskId) {
      generationInterviewRequestRef.current = null;
    }
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
    generationInterviewRequestRef.current = taskId;

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

      if (generationInterviewRequestRef.current !== taskId) {
        return;
      }
      await applyGenerationInterviewResult(context, taskId, result);
    } catch (error) {
      if (generationInterviewRequestRef.current !== taskId) {
        return;
      }
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
    formatMessage: (result: RalphPersistedFlowValidationResult) => string,
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
    const selectedIdAtStart = selectedId;
    const workspaceAtStart = workspaceRoot;
    const draftSnapshotAtStart = getFlowSnapshot(draftFlow);
    const flowToSave = normalizeDerivedGroupMembership(draftFlow);
    const expectedFingerprint = savedSnapshotRef.current
      ? createRalphFlowFingerprint(
          JSON.parse(savedSnapshotRef.current) as RalphFlow,
        )
      : undefined;
    const operationId = beginBlockingOperation();
    setMessage(null);

    try {
      const result = await saveRalphFlow(workspaceRoot, {
        flow: flowToSave,
        scope: saveScope,
        ...(expectedFingerprint ? { expectedFingerprint } : {}),
      });
      if (
        requestId !== saveRequestRef.current ||
        workspaceRootRef.current !== workspaceAtStart
      ) {
        return false;
      }

      const currentDraft = draftFlowRef.current;
      const currentDraftMatchesSave =
        currentDraft?.id === flowToSave.id &&
        draftFlowScopeRef.current === saveScope &&
        selectedScopeRef.current === saveScope &&
        selectedIdRef.current === selectedIdAtStart;
      const draftChangedDuringSave =
        !currentDraftMatchesSave ||
        currentDraft === null ||
        getFlowSnapshot(currentDraft) !== draftSnapshotAtStart;

      if (currentDraftMatchesSave) {
        replaceSavedSnapshot(getFlowSnapshot(result.flow));
        replaceSelectedId(result.flow.id, saveScope);

        if (!draftChangedDuringSave) {
          replaceDraftFlow(result.flow, saveScope);
          const resultVariables = discoverRalphFlowVariables(result.flow);
          const defaults = createDefaultRalphVariableValues(resultVariables);
          setVariableValues((current) =>
            Object.fromEntries(
              resultVariables.map((variable) => [
                variable.name,
                Object.hasOwn(current, variable.name)
                  ? current[variable.name]
                  : defaults[variable.name],
              ]),
            ),
          );
        }
      }

      setUnsavedFlowId((current) =>
        current === result.flow.id && unsavedFlowScope === saveScope
          ? null
          : current,
      );
      setMessage(
        draftChangedDuringSave
          ? `${formatMessage(result)} Newer editor changes remain unsaved.`
          : formatMessage(result),
      );
      setFlows((current) =>
        upsertFlowSummary(
          current,
          flowToSummary(result.flow, result.path, saveScope),
        ),
      );
      if (currentDraftMatchesSave) {
        void refreshRevisions(result.flow.id, saveScope);
      }
      return !draftChangedDuringSave;
    } catch (error) {
      if (requestId === saveRequestRef.current) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
      return false;
    } finally {
      finishBlockingOperation(operationId);
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

  const createLocalFlow = async (
    targetScope: RalphFlowScope = defaultFlowActionScope,
  ): Promise<void> => {
    if (!(await saveDirtyDraftBeforeReplacement("creating a new flow"))) {
      return;
    }

    applyNewLocalFlow(targetScope);
  };

  const openStarterFlowDialog = (): void => {
    setStarterImportScope(defaultFlowActionScope);
    setStarterImportError(null);
    setStarterFlowDialogOpen(true);
  };

  const importStarterFlow = async (
    starterFlowSummary: RalphStarterFlowSummary,
    targetScope: RalphFlowScope = starterImportScope,
  ): Promise<void> => {
    if (!workspaceRoot) {
      setMessage("Choose a workspace before importing starter flows.");
      return;
    }

    if (!(await saveDirtyDraftBeforeReplacement("importing a starter flow"))) {
      setStarterImportError(
        "Could not save the current flow before importing the starter flow.",
      );
      return;
    }

    const starterFlow = getStarterFlowById(starterFlowSummary.id);

    if (!starterFlow) {
      const errorMessage = `Starter flow \`${starterFlowSummary.name}\` is not available.`;
      setMessage(errorMessage);
      setStarterImportError(errorMessage);
      return;
    }

    const targetScopeLabel = RALPH_FLOW_SCOPE_LABELS[targetScope].toLowerCase();
    const operationId = beginBlockingOperation();
    setMessage(null);
    setStarterImportError(null);

    try {
      const existingFlows = await listRalphFlows(workspaceRoot, targetScope);
      const existingTargetFlows = existingFlows.flows.map((flow) =>
        withFlowSummaryScope(flow, targetScope),
      );
      const alias = createUniqueFlowAlias(
        starterFlow.defaultAlias,
        existingTargetFlows,
        targetScope,
      );
      const importedAt = new Date().toISOString();
      const flow = createImportedRalphStarterFlow(starterFlow, {
        id: createStarterImportId(starterFlow),
        alias,
        importedAt,
      });
      const result = await saveRalphFlow(workspaceRoot, {
        flow,
        scope: targetScope,
      });

      if (workspaceRootRef.current !== workspaceRoot) {
        return;
      }

      replaceSelectedId(result.flow.id, targetScope);
      replaceDraftFlow(result.flow, targetScope);
      replaceSavedSnapshot(getFlowSnapshot(result.flow));
      setCreationScope(targetScope);
      setStarterImportScope(targetScope);
      setUnsavedFlowId(null);
      setSelectedBlockId(result.flow.blocks[0]?.id ?? null);
      setVariableValues(
        createDefaultRalphVariableValues(discoverRalphFlowVariables(result.flow)),
      );
      setRevisions([]);
      setLastRun(null);
      setFlows((current) =>
        upsertFlowSummary(
          current,
          flowToSummary(result.flow, result.path, targetScope),
        ),
      );
      setStarterFlowDialogOpen(false);
      setStarterImportError(null);
      onFlowLibraryModeChange?.(targetScope);
      setMessage(
        `Imported starter flow \`${result.flow.name}\` to ${targetScopeLabel}.`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setMessage(errorMessage);
      setStarterImportError(errorMessage);
    } finally {
      finishBlockingOperation(operationId);
    }
  };

  const upgradeStarterFlow = async (
    flowSummary: RalphFlowSummary,
  ): Promise<void> => {
    if (!workspaceRoot || flowSummary.source?.kind !== "starter") {
      return;
    }

    if (!(await saveDirtyDraftBeforeReplacement("upgrading a starter flow"))) {
      return;
    }

    const starterFlow = getStarterFlowById(flowSummary.source.id);
    if (!starterFlow || starterFlow.version <= flowSummary.source.version) {
      setMessage(`Starter flow \`${flowSummary.name}\` is already current.`);
      return;
    }

    const flowScope = getFlowSummaryScope(flowSummary);
    if (getFlowActiveRuns(flowSummary).length > 0) {
      setMessage(
        `Wait for active runs of \`${flowSummary.name}\` before upgrading its starter graph.`,
      );
      return;
    }

    const operationId = beginBlockingOperation();
    setMessage(null);

    try {
      const current = await showRalphFlow(workspaceRoot, flowSummary.id, flowScope);
      const upgrade = createUpgradedRalphStarterFlowWithReport(
        current.flow,
        starterFlow,
        new Date().toISOString(),
      );
      if (!upgrade.report.applied) {
        setMessage(
          `Could not upgrade \`${flowSummary.name}\`: ${upgrade.report.conflicts.join(" ")}`,
        );
        return;
      }
      const result = await saveRalphFlow(workspaceRoot, {
        flow: upgrade.flow,
        scope: flowScope,
        expectedFingerprint: createRalphFlowFingerprint(current.flow),
      });

      if (workspaceRootRef.current !== workspaceRoot) {
        return;
      }

      replaceSelectedId(result.flow.id, flowScope);
      replaceDraftFlow(result.flow, flowScope);
      replaceSavedSnapshot(getFlowSnapshot(result.flow));
      setSelectedBlockId(result.flow.blocks[0]?.id ?? null);
      setVariableValues(
        createDefaultRalphVariableValues(discoverRalphFlowVariables(result.flow)),
      );
      setRevisions([]);
      void refreshRevisions(result.flow.id, flowScope);
      setLastRun(null);
      setFlows((currentFlows) =>
        upsertFlowSummary(
          currentFlows,
          flowToSummary(result.flow, result.path, flowScope),
        ),
      );

      const conflictSuffix = upgrade.report.conflicts.length > 0
        ? ` ${upgrade.report.conflicts.length} local/upstream conflict(s) were preserved for review.`
        : "";
      setMessage(
        `Upgraded \`${result.flow.name}\` to starter v${starterFlow.version} using ${upgrade.report.strategy}.${conflictSuffix}`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      finishBlockingOperation(operationId);
    }
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

  const focusActiveRun = (
    run: ActiveRalphRun,
    nextMessage?: string,
  ): void => {
    setSelectedRunId(run.id);
    setSelectedRunDetail(null);
    setRunDetailError(null);
    setSelectedRunLog(null);
    setEditorMode("run");
    setRunPanelTab("live");

    if (nextMessage) {
      setMessage(nextMessage);
    }
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

    const operationId = beginBlockingOperation();
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
      const targetResult = targetExists
        ? await showRalphFlow(workspaceRoot, flow.id, targetScope)
        : null;
      const savedResult = await saveRalphFlow(workspaceRoot, {
        flow: sourceResult.flow,
        scope: targetScope,
        ...(targetResult
          ? { expectedFingerprint: createRalphFlowFingerprint(targetResult.flow) }
          : {}),
      });
      const targetSummary = flowToSummary(
        savedResult.flow,
        savedResult.path,
        targetScope,
      );
      const sourceFlowKey = getFlowSelectionKey(flow.id, sourceScope);
      let deletedPath: string | null = null;

      if (operation === "move") {
        const deleteResult = await deleteRalphFlow(
          workspaceRoot,
          flow.id,
          sourceScope,
          createRalphFlowFingerprint(sourceResult.flow),
        );
        deletedPath = deleteResult.path;
      }

      if (workspaceRootRef.current !== workspaceRoot) {
        return;
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
      finishBlockingOperation(operationId);
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

  const openFlowInExplorer = async (flow: RalphFlowSummary): Promise<void> => {
    closeFlowListMenu();

    if (!workspaceRoot) {
      return;
    }

    const operationId = beginBlockingOperation();
    setMessage(null);

    try {
      await openRalphFlowInExplorer(
        workspaceRoot,
        flow.id,
        getFlowSummaryScope(flow),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      finishBlockingOperation(operationId);
    }
  };

  const deleteFlow = async (flow: RalphFlowSummary): Promise<void> => {
    closeFlowListMenu();

    if (!workspaceRoot) {
      return;
    }

    const flowScope = getFlowSummaryScope(flow);
    const flowKey = getFlowSelectionKey(flow.id, flowScope);
    const activeFlowRuns = getFlowActiveRuns(flow);
    const isSelectedOpenFlow =
      selectedIdRef.current === flow.id &&
      selectedScopeRef.current === flowScope &&
      draftFlowRef.current?.id === flow.id;
    const isUnsavedOpenFlow =
      isSelectedOpenFlow &&
      unsavedFlowId === flow.id &&
      unsavedFlowScope === flowScope;

    if (activeFlowRuns.length > 0) {
      setMessage(`Stop Ralph run \`${flow.name}\` before deleting this flow.`);
      setEditorMode("run");
      return;
    }

    if (!flow.path && !isSelectedOpenFlow) {
      return;
    }

    const confirmed = isUnsavedOpenFlow
      ? window.confirm(`Discard unsaved Ralph flow "${flow.name}"?`)
      : window.confirm(
          `Delete Ralph flow "${flow.name}"? This removes the saved flow and its revisions.`,
        );

    if (!confirmed) {
      return;
    }

    if (isUnsavedOpenFlow) {
      setFlows((current) =>
        current.filter(
          (candidate) => getFlowSummarySelectionKey(candidate) !== flowKey,
        ),
      );
      replaceSelectedId("", flowScope);
      replaceDraftFlow(null, flowScope);
      replaceSavedSnapshot("");
      setUnsavedFlowId(null);
      setSelectedBlockId(null);
      setSelectedEdgeId(null);
      setVariableValues({});
      setRevisions([]);
      setLastRun(null);
      setMessage(`Removed unsaved Ralph flow \`${flow.name}\`.`);
      return;
    }

    const operationId = beginBlockingOperation();
    setMessage(null);

    try {
      let expectedFingerprint: string;
      if (
        selectedIdRef.current === flow.id &&
        selectedScopeRef.current === flowScope &&
        savedSnapshotRef.current
      ) {
        expectedFingerprint = createRalphFlowFingerprint(
          JSON.parse(savedSnapshotRef.current) as RalphFlow,
        );
      } else {
        const current = await showRalphFlow(workspaceRoot, flow.id, flowScope);
        expectedFingerprint = createRalphFlowFingerprint(current.flow);
      }
      const result = await deleteRalphFlow(
        workspaceRoot,
        flow.id,
        flowScope,
        expectedFingerprint,
      );
      if (workspaceRootRef.current !== workspaceRoot) {
        return;
      }
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
      finishBlockingOperation(operationId);
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
    const workspaceAtStart = workspaceRoot;
    const draftSnapshotAtStart = draftFlowRef.current
      ? getFlowSnapshot(draftFlowRef.current)
      : "";
    const expectedFingerprint = savedSnapshotRef.current
      ? createRalphFlowFingerprint(
          JSON.parse(savedSnapshotRef.current) as RalphFlow,
        )
      : undefined;
    const operationId = beginBlockingOperation();
    setMessage(null);

    try {
      const result = await restoreRalphFlowRevision(workspaceRoot, {
        name: selectedId,
        revision: revisionId,
        scope: selectedScopeAtStart,
        ...(expectedFingerprint ? { expectedFingerprint } : {}),
      });
      if (
        requestId !== restoreRequestRef.current ||
        workspaceRootRef.current !== workspaceAtStart ||
        selectedIdRef.current !== selectedIdAtStart ||
        selectedScopeRef.current !== selectedScopeAtStart ||
        (draftFlowRef.current
          ? getFlowSnapshot(draftFlowRef.current)
          : "") !== draftSnapshotAtStart
      ) {
        return;
      }

      replaceDraftFlow(result.flow, selectedScopeAtStart);
      replaceSavedSnapshot(getFlowSnapshot(result.flow));
      replaceSelectedId(result.flow.id, selectedScopeAtStart);
      setUnsavedFlowId(null);
      setSelectedBlockId(result.flow.blocks[0]?.id ?? null);
      setVariableValues(
        createDefaultRalphVariableValues(discoverRalphFlowVariables(result.flow)),
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
      void refreshRevisions(result.flow.id, selectedScopeAtStart);
    } catch (error) {
      if (requestId === restoreRequestRef.current) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      finishBlockingOperation(operationId);
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

  const closeGenerationInterview = (): void => {
    const taskId = generationInterview?.taskId;
    const shouldCancel =
      generationInterview?.status === "loading" ||
      generationInterview?.status === "generating";

    generationInterviewRequestRef.current = null;
    setGenerationInterview(null);
    if (taskId && shouldCancel) {
      void cancelDesktopTask(taskId).catch(() => undefined);
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
    generationInterviewRequestRef.current = taskId;
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
    if (generationInterviewRequestRef.current !== taskId) {
      return;
    }
    await executeFlowGenerationWithAgent(
      generationInterview.context,
      finalPrompt,
      "do-it",
    );
    if (generationInterviewRequestRef.current === taskId) {
      generationInterviewRequestRef.current = null;
    }
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

    const workspaceAtStart = workspaceRoot;
    const scopeAtStart = selectedScope;
    const selectedIdAtStart = selectedId;
    const runIdAtStart = lastRun.runId;
    const pendingInputIdAtStart = pendingInput.id;
    const resumeFlowId = lastRun.flow;
    const resumeFlowName =
      draftFlowRef.current?.name || selectedSummary?.name || resumeFlowId;
    const resumeTaskId = createRalphRunTaskId(resumeFlowId);
    pendingResumeRequestRef.current = resumeTaskId;
    const resumeStartedAt = Date.now();
    const resumeVariableValues = Object.fromEntries(
      Object.entries({
        ...(lastRun.checkpoint?.variables ?? {}),
        ...variableValues,
      })
        .map(([name, value]) => [name.trim(), value] as const)
        .filter(([name]) => Boolean(name)),
    );

    setActiveRuns((current) => [
      {
        id: resumeTaskId,
        flowId: resumeFlowId,
        scope: scopeAtStart,
        flowName: resumeFlowName,
        startedAt: resumeStartedAt,
        status: "running",
        mode: runMode,
        provider: runProvider,
        model: runModel,
        ...(runReasoning ? { reasoning: runReasoning } : {}),
        ...(defaultMaxTransitions
          ? { maxTransitions: defaultMaxTransitions }
          : {}),
        variableValues: resumeVariableValues,
        events: [],
        blockDetails: {},
      },
      ...current.filter((run) => run.id !== resumeTaskId),
    ]);
    setInputSubmitting(true);
    setEditorMode("run");
    setRunPanelTab("live");
    setMessage(
      action === "cancel"
        ? `Cancelling input for ${pendingInput.title}.`
        : `Submitting input for ${pendingInput.title}.`,
    );

    try {
      const result = await resumeRalphRun(workspaceRoot, {
        runId: runIdAtStart,
        scope: scopeAtStart,
        taskId: resumeTaskId,
        mode: runMode,
        provider: runProvider,
        model: runModel,
        ...(runReasoning ? { reasoning: runReasoning } : {}),
        ...(defaultMaxTransitions
          ? { maxTransitions: defaultMaxTransitions }
          : {}),
        inputResponse: {
          requestId: pendingInputIdAtStart,
          action,
          ...(action === "submit" ? { values: pendingInputValues } : {}),
        },
      });

      if (
        pendingResumeRequestRef.current !== resumeTaskId ||
        workspaceRootRef.current !== workspaceAtStart ||
        selectedIdRef.current !== selectedIdAtStart ||
        selectedScopeRef.current !== scopeAtStart
      ) {
        return;
      }

      replaceLastRun(result.run);
      setMessage(
        result.runLogPath
          ? `${formatRunMessage(result.run)} Run log: ${result.runLogPath}`
          : formatRunMessage(result.run),
      );
      if (result.run.runId) {
        void openRunDetail(result.run.runId, scopeAtStart, { selectTab: false });
      }
      if (selectedIdAtStart) {
        void refreshRunHistory(selectedIdAtStart, scopeAtStart);
      }
    } catch (error) {
      if (pendingResumeRequestRef.current === resumeTaskId) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setActiveRuns((current) =>
        current.filter((run) => run.id !== resumeTaskId),
      );
      if (pendingResumeRequestRef.current === resumeTaskId) {
        pendingResumeRequestRef.current = null;
        setInputSubmitting(false);
      }
    }
  };

  const retryRecoverableRun = async (): Promise<void> => {
    if (
      !workspaceRoot ||
      !lastRun?.runId ||
      !lastRun.checkpoint ||
      pendingInput ||
      (lastRun.status !== "blocked" && lastRun.status !== "crashed")
    ) {
      return;
    }

    const workspaceAtStart = workspaceRoot;
    const scopeAtStart = selectedScope;
    const selectedIdAtStart = selectedId;
    const runIdAtStart = lastRun.runId;
    const resumeFlowId = lastRun.flow;
    const resumeFlowName =
      draftFlowRef.current?.name || selectedSummary?.name || resumeFlowId;
    const resumeTaskId = createRalphRunTaskId(resumeFlowId);
    pendingResumeRequestRef.current = resumeTaskId;
    const resumeStartedAt = Date.now();
    const resumeVariableValues = Object.fromEntries(
      Object.entries({
        ...(lastRun.checkpoint.variables ?? {}),
        ...variableValues,
      })
        .map(([name, value]) => [name.trim(), value] as const)
        .filter(([name]) => Boolean(name)),
    );

    setActiveRuns((current) => [
      {
        id: resumeTaskId,
        flowId: resumeFlowId,
        scope: scopeAtStart,
        flowName: resumeFlowName,
        startedAt: resumeStartedAt,
        status: "running",
        mode: runMode,
        provider: runProvider,
        model: runModel,
        ...(runReasoning ? { reasoning: runReasoning } : {}),
        ...(defaultMaxTransitions
          ? { maxTransitions: defaultMaxTransitions }
          : {}),
        variableValues: resumeVariableValues,
        events: [],
        blockDetails: {},
      },
      ...current.filter((run) => run.id !== resumeTaskId),
    ]);
    setInputSubmitting(true);
    setEditorMode("run");
    setRunPanelTab("live");
    setMessage(`Retrying ${lastRun.checkpoint.currentBlockId}.`);

    try {
      const result = await resumeRalphRun(workspaceRoot, {
        runId: runIdAtStart,
        scope: scopeAtStart,
        taskId: resumeTaskId,
        mode: runMode,
        provider: runProvider,
        model: runModel,
        ...(runReasoning ? { reasoning: runReasoning } : {}),
        ...(defaultMaxTransitions
          ? { maxTransitions: defaultMaxTransitions }
          : {}),
        retryCurrent: true,
      });

      if (
        pendingResumeRequestRef.current !== resumeTaskId ||
        workspaceRootRef.current !== workspaceAtStart ||
        selectedIdRef.current !== selectedIdAtStart ||
        selectedScopeRef.current !== scopeAtStart
      ) {
        return;
      }

      replaceLastRun(result.run);
      setMessage(
        result.runLogPath
          ? `${formatRunMessage(result.run)} Run log: ${result.runLogPath}`
          : formatRunMessage(result.run),
      );
      if (result.run.runId) {
        void openRunDetail(result.run.runId, scopeAtStart, { selectTab: false });
      }
      if (selectedIdAtStart) {
        void refreshRunHistory(selectedIdAtStart, scopeAtStart);
      }
    } catch (error) {
      if (pendingResumeRequestRef.current === resumeTaskId) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setActiveRuns((current) =>
        current.filter((run) => run.id !== resumeTaskId),
      );
      if (pendingResumeRequestRef.current === resumeTaskId) {
        pendingResumeRequestRef.current = null;
        setInputSubmitting(false);
      }
    }
  };

  const renderRalphInputControl = (
    field: RalphInputField,
    value: RalphInputValue | undefined,
    onChange: (value: RalphInputValue) => void,
  ): JSX.Element => (
    <RalphInputControl field={field} value={value} onChange={onChange} />
  );

  const renderPendingInputControl = (
    field: RalphInputField,
  ): JSX.Element => {
    return renderRalphInputControl(
      field,
      pendingInputValues[field.id] ?? null,
      (value) => updatePendingInputValue(field.id, value),
    );
  };

  const updateSetupVariableValue = (
    variableName: string,
    value: string,
  ): void => {
    setVariableValues((current) => ({
      ...current,
      [variableName]: value,
    }));
  };

  const runFlow = async (): Promise<void> => {
    if (selectedFlowPrimaryActiveRun) {
      focusActiveRun(
        selectedFlowPrimaryActiveRun,
        `Ralph run \`${selectedFlowPrimaryActiveRun.flowName}\` is already running.`,
      );
      return;
    }

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

    if (setupVariableErrorNames.length > 0) {
      setMessage(`Fix setup variable(s): ${setupVariableErrorNames.join(", ")}.`);
      return;
    }

    const flowToRun = draftFlow;
    const runScope = selectedScope;
    const workspaceAtStart = workspaceRoot;
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
        ...(runReasoning ? { reasoning: runReasoning } : {}),
        ...(defaultMaxTransitions
          ? { maxTransitions: defaultMaxTransitions }
          : {}),
        variableValues: runVariableValues,
        events: [],
        blockDetails: {},
      },
      ...current,
    ]);
    replaceLastRun(null);
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
          ...(runReasoning ? { reasoning: runReasoning } : {}),
          ...(defaultMaxTransitions
            ? { maxTransitions: defaultMaxTransitions }
            : {}),
          params: runVariableValues,
        });
        const currentDraft = draftFlowRef.current;
        const stillViewingSameSnapshot =
          workspaceRootRef.current === workspaceAtStart &&
          selectedIdRef.current === flowToRun.id &&
          selectedScopeRef.current === runScope &&
          currentDraft?.id === flowToRun.id &&
          getFlowSnapshot(currentDraft) === flowSnapshotAtStart;

        if (stillViewingSameSnapshot) {
          replaceLastRun(result.run);
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
          workspaceRootRef.current === workspaceAtStart &&
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
          workspaceRootRef.current === workspaceAtStart &&
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

  const getViewportCenteredBlockPosition = (
    block: RalphFlowBlock,
  ): RalphPosition | null => {
    const instance = reactFlowInstanceRef.current;
    const viewport = canvasViewportRef.current;

    if (!instance || !viewport) {
      return null;
    }

    const bounds = viewport.getBoundingClientRect();

    if (bounds.width <= 0 || bounds.height <= 0) {
      return null;
    }

    const center = instance.screenToFlowPosition({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    });
    const size = getCanvasBlockSize(block);

    return {
      x: Math.round(center.x - size.width / 2),
      y: Math.round(center.y - size.height / 2),
    };
  };

  const getSelectedBlockStackPosition = (
    flow: RalphFlow,
  ): RalphPosition | null => {
    if (!selectedBlockId) {
      return null;
    }

    const blockIndex = flow.blocks.findIndex((block) => block.id === selectedBlockId);

    if (blockIndex < 0) {
      return null;
    }

    const block = flow.blocks[blockIndex];
    const nodePosition = reactFlowInstanceRef.current?.getNode(block.id)?.position;
    const position = nodePosition ?? block.position ?? getDefaultCanvasPosition(blockIndex);

    return {
      x: Math.round(position.x + RALPH_CANVAS_STACK_OFFSET),
      y: Math.round(position.y + RALPH_CANVAS_STACK_OFFSET),
    };
  };

  const getAutomaticBlockPosition = (
    flow: RalphFlow,
    block: RalphFlowBlock,
  ): RalphPosition => {
    return (
      getSelectedBlockStackPosition(flow) ??
      getViewportCenteredBlockPosition(block) ??
      block.position ??
      getDefaultCanvasPosition(flow.blocks.length)
    );
  };

  const resolveNewBlockPosition = (
    flow: RalphFlow,
    block: RalphFlowBlock,
    position?: RalphPosition,
  ): RalphPosition => {
    return getDisplacedCanvasPosition(
      flow,
      position ?? getAutomaticBlockPosition(flow, block),
    );
  };

  const centerCanvasOnBlock = (block: RalphFlowBlock): void => {
    if (!block.position) {
      return;
    }

    const position = block.position;
    const size = getCanvasBlockSize(block);
    const centerX = position.x + size.width / 2;
    const centerY = position.y + size.height / 2;
    const centerBlock = (): void => {
      const instance = reactFlowInstanceRef.current;

      if (!instance) {
        return;
      }

      void instance.setCenter(centerX, centerY, {
        duration: RALPH_NEW_BLOCK_CENTER_DURATION_MS,
        zoom: instance.getZoom(),
      });
    };

    if (
      typeof window !== "undefined" &&
      typeof window.requestAnimationFrame === "function"
    ) {
      window.requestAnimationFrame(centerBlock);
      return;
    }

    centerBlock();
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
    const nextBlock = {
      ...createdBlock,
      position: resolveNewBlockPosition(draftFlow, createdBlock, position),
    };
    updateDraftFlow((flow) => ({
      ...flow,
      blocks: [...flow.blocks, nextBlock],
    }));
    setSelectedBlockId(nextBlock.id);
    setSelectedEdgeId(null);
    closeCanvasMenu();

    if (!position) {
      centerCanvasOnBlock(nextBlock);
    }
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

    const nextBlockBase = createBlock(draftFlow, type);
    const nextPosition = getDisplacedCanvasPosition(draftFlow, {
      x: (sourceBlock.position?.x ?? 0) + RALPH_CANVAS_X_GAP,
      y: sourceBlock.position?.y ?? 0,
    });
    const nextBlock = {
      ...nextBlockBase,
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
    centerCanvasOnBlock(nextBlock);
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

  const setBlockLocked = (blockId: string, locked: boolean): void => {
    updateBlock(blockId, (block) => ({
      ...block,
      locked,
    }));
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
      (
        change,
      ): change is Extract<NodeChange<RalphCanvasNode>, { type: "select" }> =>
        change.type === "select" && change.selected,
    );
    const lockedBlockIds = draftFlowRef.current
      ? createLockedCanvasBlockIdSet(draftFlowRef.current)
      : new Set<string>();
    const allowedChanges = changes.filter(
      (change) => !isLockedNodePositionChange(change, lockedBlockIds),
    );

    if (selectedChange) {
      setSelectedBlockId(selectedChange.id);
      setSelectedEdgeId(null);
      closeCanvasMenu();
    }

    setCanvasNodes((currentNodes) => applyNodeChanges(allowedChanges, currentNodes));
  };

  const handleNodeDragStop: OnNodeDrag<RalphCanvasNode> = (
    event,
    node,
    draggedNodes,
  ): void => {
    const movedNodes = draggedNodes.length > 0 ? draggedNodes : [node];
    const draggedPositionsById = getCanvasNodePositions(movedNodes);
    const suppressChildMove = isGroupChildMoveSuppressed(event);

    updateDraftFlow((flow) => {
      const lockedBlockIds = createLockedCanvasBlockIdSet(flow);
      const movedPositionsById = new Map(
        [...draggedPositionsById].filter(
          ([blockId]) => !lockedBlockIds.has(blockId),
        ),
      );

      if (movedPositionsById.size === 0) {
        return flow;
      }

      const childrenByGroupId = createDerivedGroupChildrenById(flow);
      const movedBlockIds = new Set(movedPositionsById.keys());
      const reservedMovedPositions: RalphPosition[] = [];
      const resolvedMovedPositionsById = new Map<string, RalphPosition>();
      const childMoveDeltas = new Map<string, RalphPosition>();
      const suppressedChildBlockIds = new Set<string>();

      for (const block of flow.blocks) {
        const nextPosition = movedPositionsById.get(block.id);

        if (!nextPosition) {
          continue;
        }

        const resolvedPosition = getDisplacedCanvasPosition(flow, nextPosition, {
          ignoredBlockIds: movedBlockIds,
          reservedPositions: reservedMovedPositions,
        });
        resolvedMovedPositionsById.set(block.id, resolvedPosition);
        reservedMovedPositions.push(resolvedPosition);
      }

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
        const nextPosition = resolvedMovedPositionsById.get(block.id);

        if (block.type !== "GROUP" || !nextPosition || lockedBlockIds.has(block.id)) {
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
          if (movedPositionsById.has(childId) || lockedBlockIds.has(childId)) {
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
        const nextPosition = resolvedMovedPositionsById.get(block.id);

        if (nextPosition) {
          if (suppressedChildBlockIds.has(block.id)) {
            return block;
          }

          if (lockedBlockIds.has(block.id)) {
            return block;
          }

          if (arePositionsEqual(block.position, nextPosition)) {
            return block;
          }

          changed = true;
          return { ...block, position: nextPosition };
        }

        const childDelta = childMoveDeltas.get(block.id);

        if (lockedBlockIds.has(block.id)) {
          return block;
        }

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
    event: ReactMouseEvent | MouseEvent,
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

  const openPaneMenu = (event: ReactMouseEvent | MouseEvent): void => {
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
        if (canRunAction) {
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
    canRunAction,
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

  const renderFlowListContextMenu = (): JSX.Element | null => (
    <RalphFlowListContextMenu
      flowListMenu={flowListMenu}
      workspaceRoot={workspaceRoot}
      loading={loading}
      selectedId={selectedId}
      selectedScope={selectedScope}
      draftFlow={draftFlow}
      getFlowActiveRuns={getFlowActiveRuns}
      isGenerationTargetingFlow={isGenerationTargetingFlow}
      openFlowInExplorer={openFlowInExplorer}
      copyOrMoveFlowToScope={copyOrMoveFlowToScope}
      deleteFlow={deleteFlow}
    />
  );

  const renderCanvasContextMenu = (): JSX.Element | null => (
    <RalphCanvasContextMenu
      canvasMenu={canvasMenu}
      draftFlow={draftFlow}
      hasCopiedBlock={copiedBlock !== null}
      addBlock={addBlock}
      addBlockAfter={addBlockAfter}
      pasteCopiedBlock={pasteCopiedBlock}
      cleanFlowLayout={cleanFlowLayout}
      setBlockLocked={setBlockLocked}
      copyBlock={copyBlock}
      duplicateBlock={duplicateBlock}
      deleteSelectedBlock={deleteSelectedBlock}
      removeEdge={removeEdge}
    />
  );
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
  ): JSX.Element => (
    <RalphUtilityConditionFields
      condition={condition}
      inspectorTwoColumnClass={inspectorTwoColumnClass}
      onChange={(nextCondition) =>
        updateSelectedUtility({ condition: nextCondition })
      }
    />
  );

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

        {selectedUtility.type === "CONDITION" ? (
          <div className="grid gap-2">
            {renderUtilityConditionFields(selectedUtility.condition)}
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
            <RalphInspectorField
              label="Fallback command"
              help="Used when command resolves to blank. Supports {{variables}}."
              action={renderExpandFieldButton("Expand", () =>
                openExpandedEditor({
                  title: "Fallback command",
                  description:
                    "Edit the fallback shell command in a larger workspace. Variables are inserted literally.",
                  ariaLabel: "Expanded utility fallback command",
                  mode: "code",
                  value: selectedUtility.fallbackCommand ?? "",
                  supportsVariables: true,
                  onApply: (fallbackCommand) =>
                    updateSelectedUtility({ fallbackCommand }),
                }),
              )}
            >
              <Textarea
                value={selectedUtility.fallbackCommand ?? ""}
                aria-label="Utility fallback command"
                placeholder="{{data:detect-project-commands:verificationCommand}}"
                onChange={(event) =>
                  updateSelectedUtility({ fallbackCommand: event.target.value })
                }
                className="min-h-16 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
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
                    { name: "tablet", width: 768, height: 1024 },
                    { name: "mobile", width: 390, height: 844 },
                    { name: "small-mobile", width: 320, height: 568 },
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
        selectedUtility.type === "WRITE_FILE" ||
        selectedUtility.type === "READ_JSON" ||
        selectedUtility.type === "WRITE_JSON" ||
        selectedUtility.type === "PATCH_JSON" ||
        selectedUtility.type === "APPEND_JSONL" ||
        selectedUtility.type === "READ_JSONL" ||
        selectedUtility.type === "QUERY_JSONL" ||
        selectedUtility.type === "SELECT_JSON_TASK" ||
        selectedUtility.type === "MARK_JSON_TASK" ||
        selectedUtility.type === "FILE_EXISTS" ||
        selectedUtility.type === "DELETE_FILE" ||
        selectedUtility.type === "MOVE_FILE" ||
        selectedUtility.type === "ARCHIVE_FILE" ? (
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
            {selectedUtility.type === "WRITE_JSON" ||
            selectedUtility.type === "PATCH_JSON" ||
            selectedUtility.type === "APPEND_JSONL" ? (
              <>
                <RalphInspectorField label="JSON input" help="Blank uses the previous utility result. Supports {{variables}}.">
                  <Textarea
                    value={selectedUtility.input ?? ""}
                    aria-label="Utility JSON file input"
                    placeholder="Leave empty to use previous result data"
                    onChange={(event) =>
                      updateSelectedUtility({ input: event.target.value })
                    }
                    className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
                  />
                </RalphInspectorField>
                {selectedUtility.type === "PATCH_JSON" ? (
                  <RalphInspectorField label="Patch mode" help="Merge recursively or replace the whole JSON document.">
                    <select
                      value={selectedUtility.jsonPatchMode ?? "merge"}
                      aria-label="JSON patch mode"
                      onChange={(event) =>
                        updateSelectedUtility({
                          jsonPatchMode:
                            event.target.value as NonNullable<
                              RalphUtilityConfig["jsonPatchMode"]
                            >,
                        })
                      }
                      className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                    >
                      <option value="merge">Merge</option>
                      <option value="replace">Replace</option>
                    </select>
                  </RalphInspectorField>
                ) : null}
              </>
            ) : null}
            {selectedUtility.type === "READ_JSONL" ||
            selectedUtility.type === "QUERY_JSONL" ? (
              <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
                <RalphInspectorField label="Max entries" help="Maximum entries returned to later blocks.">
                  <Input
                    type="number"
                    min={0}
                    value={selectedUtility.maxResults ?? 100}
                    aria-label="JSONL max entries"
                    onChange={(event) =>
                      updateSelectedUtility({
                        maxResults: Number.parseInt(event.target.value, 10) || 0,
                      })
                    }
                    className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                  />
                </RalphInspectorField>
                <RalphInspectorField label="Schema" help="Optional schema is configured below.">
                  <span className="flex h-9 items-center rounded-md border border-slate-800 bg-slate-950 px-3 text-xs text-slate-400">
                    {selectedUtility.schema === undefined ? "No schema" : "Schema configured"}
                  </span>
                </RalphInspectorField>
              </div>
            ) : null}
            {selectedUtility.type === "QUERY_JSONL" ? (
              renderUtilityConditionFields(selectedUtility.condition)
            ) : null}
            {selectedUtility.type === "SELECT_JSON_TASK" ||
            selectedUtility.type === "MARK_JSON_TASK" ? (
              <div className="grid gap-2 rounded-md border border-slate-800 bg-slate-950 p-2">
                <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
                  <RalphInspectorField label="JSON path" help="Array path inside the JSON file.">
                    <Input
                      value={selectedUtility.jsonPath ?? "tasks"}
                      aria-label="JSON task path"
                      placeholder="tasks"
                      onChange={(event) =>
                        updateSelectedUtility({ jsonPath: event.target.value })
                      }
                      className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                    />
                  </RalphInspectorField>
                  {selectedUtility.type === "SELECT_JSON_TASK" ? (
                    <RalphInspectorField label="Strategy" help="Task selection method.">
                      <select
                        value={selectedUtility.strategy ?? "start-to-end"}
                        aria-label="JSON task selection strategy"
                        onChange={(event) =>
                          updateSelectedUtility({
                            strategy:
                              event.target.value as NonNullable<
                                RalphUtilityConfig["strategy"]
                              >,
                          })
                        }
                        className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                      >
                        <option value="start-to-end">Start to End</option>
                        <option value="random">Random</option>
                        <option value="least-recent">Least Recent</option>
                        <option value="priority">Priority</option>
                        <option value="risk-first">Risk First</option>
                        <option value="ui-first">UI First</option>
                      </select>
                    </RalphInspectorField>
                  ) : (
                    <RalphInspectorField label="Status" help="Status to write to the selected task.">
                      <Input
                        value={selectedUtility.status ?? selectedUtility.result ?? "done"}
                        aria-label="JSON task status"
                        placeholder="done"
                        onChange={(event) =>
                          updateSelectedUtility({ status: event.target.value })
                        }
                        className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                      />
                    </RalphInspectorField>
                  )}
                </div>
                {selectedUtility.type === "MARK_JSON_TASK" ? (
                  <RalphInspectorField label="Task id" help="Blank marks the previous selected or current in-progress task.">
                    <Input
                      value={selectedUtility.taskId ?? ""}
                      aria-label="JSON task id"
                      placeholder="Previous selected task"
                      onChange={(event) =>
                        updateSelectedUtility({ taskId: event.target.value })
                      }
                      className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                    />
                  </RalphInspectorField>
                ) : null}
              </div>
            ) : null}
            {selectedUtility.type === "MOVE_FILE" ||
            selectedUtility.type === "ARCHIVE_FILE" ? (
              <RalphInspectorField label="Output path" help="Destination path. Archive can leave this blank and use archive root.">
                <Input
                  value={selectedUtility.outputPath ?? ""}
                  aria-label="Utility output path"
                  placeholder=".machdoch/ralph/archive/file.json"
                  onChange={(event) =>
                    updateSelectedUtility({ outputPath: event.target.value })
                  }
                  className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                />
              </RalphInspectorField>
            ) : null}
            {selectedUtility.type === "ARCHIVE_FILE" ? (
              <RalphInspectorField label="Archive root" help="Used when output path is blank.">
                <Input
                  value={selectedUtility.rootPath ?? ".machdoch/ralph/archive"}
                  aria-label="Archive root path"
                  placeholder=".machdoch/ralph/archive"
                  onChange={(event) =>
                    updateSelectedUtility({ rootPath: event.target.value })
                  }
                  className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                />
              </RalphInspectorField>
            ) : null}
          </div>
        ) : null}

        {selectedUtility.type === "LOOP_COUNTER" ? (
          <div className="grid gap-2">
            <RalphInspectorField label="Counter file" help="Workspace-relative JSON state file.">
              <Input
                value={selectedUtility.path ?? ".machdoch/ralph/counters.json"}
                aria-label="Loop counter file"
                placeholder=".machdoch/ralph/counters.json"
                onChange={(event) =>
                  updateSelectedUtility({ path: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
              <RalphInspectorField label="Counter name" help="Counter group name.">
                <Input
                  value={selectedUtility.counterName ?? ""}
                  aria-label="Loop counter name"
                  placeholder="implementation-pass"
                  onChange={(event) =>
                    updateSelectedUtility({ counterName: event.target.value })
                  }
                  className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                />
              </RalphInspectorField>
              <RalphInspectorField label="Limit" help="Routes LIMIT_REACHED after this count.">
                <Input
                  type="number"
                  min={1}
                  value={selectedUtility.maxAttempts ?? 10}
                  aria-label="Loop counter limit"
                  onChange={(event) =>
                    updateSelectedUtility({
                      maxAttempts: Number.parseInt(event.target.value, 10) || 1,
                    })
                  }
                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                />
              </RalphInspectorField>
            </div>
            <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={selectedUtility.reset ?? false}
                onChange={(event) =>
                  updateSelectedUtility({ reset: event.target.checked })
                }
              />
              Reset counter
            </label>
          </div>
        ) : null}

        {selectedUtility.type === "SCAN_SCOPE_EVIDENCE" ? (
          <div className="grid gap-2">
            <RalphInspectorField label="Scan root" help="Workspace-relative root used for deterministic scope discovery.">
              <Input
                value={selectedUtility.rootPath ?? "."}
                aria-label="Scope scan root path"
                placeholder="."
                onChange={(event) =>
                  updateSelectedUtility({ rootPath: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField label="Exclude paths" help="Comma- or line-separated workspace paths skipped during discovery.">
              <Textarea
                value={selectedUtility.excludePaths ?? ""}
                aria-label="Scope scan exclude paths"
                placeholder="node_modules, dist, build"
                onChange={(event) =>
                  updateSelectedUtility({ excludePaths: event.target.value })
                }
                className="min-h-16 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
              />
            </RalphInspectorField>
            <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
              <RalphInspectorField label="Max depth" help="Directory depth below the scan root.">
                <Input
                  type="number"
                  min={0}
                  value={selectedUtility.maxDepth ?? 4}
                  aria-label="Scope scan max depth"
                  onChange={(event) =>
                    updateSelectedUtility({
                      maxDepth: Number.parseInt(event.target.value, 10) || 0,
                    })
                  }
                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                />
              </RalphInspectorField>
              <RalphInspectorField label="Max scopes" help="Upper bound for discovered scope candidates.">
                <Input
                  type="number"
                  min={1}
                  value={selectedUtility.maxResults ?? 200}
                  aria-label="Scope scan max results"
                  onChange={(event) =>
                    updateSelectedUtility({
                      maxResults: Number.parseInt(event.target.value, 10) || 1,
                    })
                  }
                  className="h-9 border-slate-700 bg-slate-950 text-sm text-slate-100"
                />
              </RalphInspectorField>
            </div>
          </div>
        ) : null}

        {selectedUtility.type === "UPDATE_SCOPE_REGISTRY" ||
        selectedUtility.type === "SELECT_SCOPE" ||
        selectedUtility.type === "MARK_SCOPE_RESULT" ? (
          <div className="grid gap-2">
            <RalphInspectorField label="Flow alias" help="Used to derive the default registry JSON path.">
              <Input
                value={selectedUtility.flowAlias ?? ""}
                aria-label="Scope registry flow alias"
                placeholder="security-review-fix-loop"
                onChange={(event) =>
                  updateSelectedUtility({ flowAlias: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField label="Registry path" help="Optional workspace-relative JSON registry path. Blank uses .machdoch/ralph/scope-registry/<flow>.scope-registry.json.">
              <Input
                value={selectedUtility.registryPath ?? selectedUtility.path ?? ""}
                aria-label="Scope registry path"
                placeholder=".machdoch/ralph/scope-registry/flow.scope-registry.json"
                onChange={(event) =>
                  updateSelectedUtility({ registryPath: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField label="Strategy" help="Selection method for choosing the next active scope.">
              <select
                value={selectedUtility.strategy ?? "round-robin"}
                aria-label="Scope selection strategy"
                onChange={(event) =>
                  updateSelectedUtility({
                    strategy:
                      event.target.value as NonNullable<
                        RalphUtilityConfig["strategy"]
                      >,
                  })
                }
                className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
              >
                <option value="round-robin">Round Robin</option>
                <option value="start-to-end">Start to End</option>
                <option value="random">Random</option>
                <option value="random-seeded">Seeded Random</option>
                <option value="least-recent">Least Recent</option>
                <option value="least-validated">Least Validated</option>
                <option value="priority">Priority</option>
                <option value="risk-first">Risk First</option>
                <option value="ui-first">UI First</option>
              </select>
            </RalphInspectorField>
            {selectedUtility.type === "UPDATE_SCOPE_REGISTRY" ? (
              <>
                <RalphInspectorField label="Evidence input" help="Blank uses the previous scope evidence utility result.">
                  <Textarea
                    value={selectedUtility.input ?? ""}
                    aria-label="Scope registry evidence input"
                    placeholder="Leave empty to use previous scope evidence"
                    onChange={(event) =>
                      updateSelectedUtility({ input: event.target.value })
                    }
                    className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
                  />
                </RalphInspectorField>
                <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={selectedUtility.includeMarkdown ?? false}
                    onChange={(event) =>
                      updateSelectedUtility({
                        includeMarkdown: event.target.checked,
                      })
                    }
                  />
                  Write markdown mirror
                </label>
              </>
            ) : null}
            {selectedUtility.type === "SELECT_SCOPE" ? (
              <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200">
                <input
                  type="checkbox"
                  checked={selectedUtility.forceNew ?? false}
                  onChange={(event) =>
                    updateSelectedUtility({ forceNew: event.target.checked })
                  }
                />
                Force new selection
              </label>
            ) : null}
            {selectedUtility.type === "MARK_SCOPE_RESULT" ? (
              <div className={cn("grid gap-2", inspectorTwoColumnClass)}>
                <RalphInspectorField label="Scope id" help="Blank marks the registry's current selected scope.">
                  <Input
                    value={selectedUtility.scopeId ?? ""}
                    aria-label="Scope registry mark scope id"
                    placeholder="Current scope"
                    onChange={(event) =>
                      updateSelectedUtility({ scopeId: event.target.value })
                    }
                    className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                  />
                </RalphInspectorField>
                <RalphInspectorField label="Outcome" help="Blank uses the previous block output.">
                  <Input
                    value={selectedUtility.result ?? ""}
                    aria-label="Scope registry mark outcome"
                    placeholder="DONE"
                    onChange={(event) =>
                      updateSelectedUtility({ result: event.target.value })
                    }
                    className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
                  />
                </RalphInspectorField>
              </div>
            ) : null}
          </div>
        ) : null}

        {selectedUtility.type === "CHANGE_SCOPE_GUARD" ? (
          <div className="grid gap-2">
            <RalphInspectorField label="Working directory" help="Repository path to inspect.">
              <Input
                value={selectedUtility.cwd ?? "."}
                aria-label="Scope guard working directory"
                placeholder="."
                onChange={(event) =>
                  updateSelectedUtility({ cwd: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField label="Allowed scope JSON" help="Blank uses previous result. Pass selected scope data when possible.">
              <Textarea
                value={selectedUtility.input ?? ""}
                aria-label="Scope guard input"
                placeholder="{{data:select-scope:scope}}"
                onChange={(event) =>
                  updateSelectedUtility({ input: event.target.value })
                }
                className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField label="Git baseline JSON" help="Optional GIT_SNAPSHOT result whose dirty files should be ignored.">
              <Textarea
                value={selectedUtility.baseline ?? ""}
                aria-label="Scope guard baseline"
                placeholder="{{result:git-snapshot-before}}"
                onChange={(event) =>
                  updateSelectedUtility({ baseline: event.target.value })
                }
                className="min-h-20 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
              />
            </RalphInspectorField>
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

        {selectedUtility.type === "GIT_STATUS" ||
        selectedUtility.type === "GIT_SNAPSHOT" ||
        selectedUtility.type === "GIT_DIFF_SUMMARY" ? (
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

        {selectedUtility.type === "DETECT_PROJECT_COMMANDS" ? (
          <div className="grid gap-2">
            <RalphInspectorField label="Project root" help="Workspace-relative root with manifests.">
              <Input
                value={selectedUtility.rootPath ?? "."}
                aria-label="Project command detection root"
                placeholder="."
                onChange={(event) =>
                  updateSelectedUtility({ rootPath: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField label="Output JSON" help="Optional command detection artifact path.">
              <Input
                value={selectedUtility.outputPath ?? ""}
                aria-label="Project command detection output path"
                placeholder=".machdoch/ralph/project-commands.json"
                onChange={(event) =>
                  updateSelectedUtility({ outputPath: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
          </div>
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

        {selectedUtility.type === "PROMPT_JSON" ||
        selectedUtility.type === "VALIDATOR_JSON" ? (
          <div className="grid gap-2">
            <RalphInspectorField label="Prompt" help="Prompt that must return schema-valid JSON. Supports {{variables}}.">
              <Textarea
                value={selectedUtility.prompt ?? ""}
                aria-label="Prompt JSON prompt"
                placeholder="Return structured JSON for the previous result."
                onChange={(event) =>
                  updateSelectedUtility({ prompt: event.target.value })
                }
                className="min-h-24 border-slate-700 bg-slate-950 font-mono text-xs leading-5 text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField label="Output JSON" help="Optional workspace-relative artifact path.">
              <Input
                value={selectedUtility.outputPath ?? ""}
                aria-label="Prompt JSON output path"
                placeholder=".machdoch/ralph/artifact.json"
                onChange={(event) =>
                  updateSelectedUtility({ outputPath: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <label className="flex items-center gap-2 rounded border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={selectedUtility.structuredOutput !== false}
                onChange={(event) =>
                  updateSelectedUtility({
                    structuredOutput: event.target.checked,
                  })
                }
              />
              Request provider structured output when available
            </label>
          </div>
        ) : null}

        {selectedUtility.type === "FINAL_REPORT" ? (
          <div className="grid gap-2">
            <RalphInspectorField label="Report JSON" help="Optional workspace-relative JSON report path.">
              <Input
                value={selectedUtility.path ?? ""}
                aria-label="Final report JSON path"
                placeholder=".machdoch/ralph/final-report.json"
                onChange={(event) =>
                  updateSelectedUtility({ path: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
            <RalphInspectorField label="Report markdown" help="Optional workspace-relative markdown report path.">
              <Input
                value={selectedUtility.outputPath ?? selectedUtility.markdownPath ?? ""}
                aria-label="Final report markdown path"
                placeholder=".machdoch/ralph/final-report.md"
                onChange={(event) =>
                  updateSelectedUtility({ outputPath: event.target.value })
                }
                className="h-9 border-slate-700 bg-slate-950 font-mono text-xs text-slate-100"
              />
            </RalphInspectorField>
          </div>
        ) : null}

        {selectedUtility.type === "TRANSFORM_JSON" ||
        selectedUtility.type === "READ_JSON" ||
        selectedUtility.type === "READ_JSONL" ||
        selectedUtility.type === "QUERY_JSONL" ||
        selectedUtility.type === "WRITE_JSON" ||
        selectedUtility.type === "PATCH_JSON" ||
        selectedUtility.type === "APPEND_JSONL" ||
        selectedUtility.type === "PROMPT_JSON" ||
        selectedUtility.type === "VALIDATOR_JSON" ||
        selectedUtility.type === "SELECT_JSON_TASK" ||
        selectedUtility.type === "MARK_JSON_TASK" ||
        selectedUtility.type === "VALIDATE_JSON" ? (
          <div className="grid gap-2">
            {selectedUtility.type === "TRANSFORM_JSON" ||
            selectedUtility.type === "VALIDATE_JSON" ? (
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
            ) : null}
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
            ) : selectedUtility.type === "VALIDATE_JSON" ? (
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
            ) : null}
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
                  onApply: updateUtilityJsonDraft,
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
                updateUtilityJsonDraft(event.target.value);
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
            <RalphFlowLibraryPanel
              activeRunsByFlowKey={activeRunsByFlowKey}
              canSaveFlow={canSaveFlow}
              defaultFlowActionScope={defaultFlowActionScope}
              dirty={dirty}
              displayFlowRows={displayFlowRows}
              draftFlow={draftFlow}
              errorCount={errorCount}
              flowLibraryMode={flowLibraryMode}
              flowListOpen={flowListOpen}
              flowsLoading={flowsLoading}
              generationCreatedFlow={
                generationJob?.status === "created" &&
                generationJob.result?.flow
                  ? {
                      flowId: generationJob.result.flow.id,
                      scope: generationJob.scope,
                    }
                  : null
              }
              getStarterFlowUpdate={getStarterFlowUpdate}
              loading={loading}
              selectedFlowKey={selectedFlowKey}
              selectedScope={selectedScope}
              warningCount={warningCount}
              workspaceRoot={workspaceRoot ?? ""}
              onCollapseFlowList={() => setFlowListOpen(false)}
              onCreateLocalFlow={(scope) => void createLocalFlow(scope)}
              onFlowContextMenu={openFlowListMenu}
              onFlowLibraryModeChange={onFlowLibraryModeChange}
              onOpenFlowList={() => setFlowListOpen(true)}
              onOpenStarterFlowDialog={openStarterFlowDialog}
              onRefreshFlows={() => void refreshFlows()}
              onSaveFlow={() => void saveFlow()}
              onSelectFlow={(flow) => void selectFlow(flow)}
              onUpgradeStarterFlow={(flow) => void upgradeStarterFlow(flow)}
            />

            <main className="col-start-2 row-start-1 grid min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-slate-950">
              <RalphFlowEditorToolbar
                flowTitle={flowTitle}
                selectedScope={selectedScope}
                selectedScopeLabel={selectedScopeLabel}
                hasSelectedFlow={Boolean(draftFlow || selectedSummary)}
                canUndo={canUndo}
                canRedo={canRedo}
                canCleanLayout={Boolean(draftFlow)}
                canShowInspector={editorMode === "design" && !showInspectorPanel}
                flowHasStart={flowHasStart}
                onUndo={undoFlowEdit}
                onRedo={redoFlowEdit}
                onCleanLayout={cleanFlowLayout}
                onShowInspector={() => setInspectorOpen(true)}
                onAddBlock={addBlock}
              />

              <div ref={canvasViewportRef} className="relative min-h-0">
                <ReactFlowProvider key={canvasIdentityKey}>
                  <ReactFlow<RalphCanvasNode, RalphCanvasEdge>
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

              <RalphInspectorSectionTabs
                sections={availableInspectorSections}
                activeSection={activeInspectorSection}
                missingRouteCount={missingSelectedRouteCount}
                onSelectSection={scrollInspectorSectionIntoView}
              />

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
                    selectedBlock.type === "ASK_USER" ||
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
                            <RalphPromptHighlight value={getPromptLikeText(selectedBlock)} />
                          </div>
                        ) : null}
                      </RalphInspectorField>
                    ) : null}

                    {selectedBlock.type === "ASK_USER" ? (
                      <div className="grid gap-3 rounded-lg bg-slate-900/25 p-3 text-sm text-slate-100 ring-1 ring-slate-800/60">
                        <RalphInspectorField
                          label="Mode"
                          help={
                            ASK_USER_MODE_OPTIONS.find(
                              (option) =>
                                option.value ===
                                (selectedBlock.mode ?? "missingOnly"),
                            )?.help
                          }
                        >
                          <select
                            value={selectedBlock.mode ?? "missingOnly"}
                            aria-label="Ask user mode"
                            onChange={(event) =>
                              updateBlock(selectedBlock.id, (block) =>
                                block.type === "ASK_USER"
                                  ? {
                                      ...block,
                                      mode: event.target.value as RalphAskUserMode,
                                    }
                                  : block,
                              )
                            }
                            className="h-9 rounded-md border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
                          >
                            {ASK_USER_MODE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </RalphInspectorField>
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
                                  disabled={
                                    selectedBlock.fields.length <=
                                    (selectedBlock.mode === "confirmOnly" ? 0 : 1)
                                  }
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
                                  block.type === "ASK_USER"
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
                                  block.type === "ASK_USER"
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
                      <RalphSelectedRouteSummary
                        outputs={selectedBlock ? selectedBlockOutputs : []}
                        routesByOutput={selectedRoutesByOutput}
                        blocks={draftFlow?.blocks}
                        missingRouteCount={missingSelectedRouteCount}
                        connectedRouteCount={connectedSelectedRouteCount}
                        onOpenRoutes={() => scrollInspectorSectionIntoView("routes")}
                      />
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
                          {setupVariables.length > 0 ? (
                            <div className="grid gap-1">
                              {setupVariables.map((variable) => (
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
                        selectedFlowPrimaryActiveRun
                          ? "text-sky-100"
                          : dirty
                          ? "text-amber-100"
                          : hasBlockingIssues
                            ? "text-rose-100"
                            : "text-slate-400",
                      )}
                    >
                      {selectedFlowPrimaryActiveRun
                        ? "Running"
                        : dirty
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
                      disabled={!canRunAction}
                      aria-label="Run Ralph flow"
                      onClick={() => void runFlow()}
                      className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs text-slate-100 hover:bg-slate-800 hover:text-white"
                    >
                      {selectedFlowPrimaryActiveRun ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                      {runButtonLabel}
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
                        disabled={!canRunAction}
                        aria-label="Run Ralph flow"
                        onClick={(event) => {
                          event.stopPropagation();
                          void runFlow();
                        }}
                        className="h-7 rounded-lg border-slate-700 bg-slate-900 px-2 text-xs text-slate-100 hover:bg-slate-800 hover:text-white"
                      >
                        {selectedFlowPrimaryActiveRun ? (
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                        {runButtonLabel}
                      </Button>
                    )}
                  </div>
                  <span
                    className={cn(
                      "truncate text-xs",
                      selectedFlowPrimaryActiveRun
                        ? "text-sky-200"
                        : runBlockedReason
                          ? "text-amber-200"
                          : "text-slate-500",
                    )}
                  >
                    {runActionMessage}
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
                      disabled={!canRunAction}
                      aria-label="Run Ralph flow"
                      onClick={(event) => {
                        event.stopPropagation();
                        void runFlow();
                      }}
                      className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs text-slate-100 hover:bg-slate-800 hover:text-white"
                    >
                      {loading ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : selectedFlowPrimaryActiveRun ? (
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

                    {pendingInputContinuationInProgress ? (
                      <div
                        role="status"
                        className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-sky-400/30 bg-sky-500/10 p-3 text-sm text-sky-100"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" />
                          <span className="min-w-0 truncate">
                            Input response submitted. Continuation is running.
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => setRunPanelTab("live")}
                          className="shrink-0 text-xs font-semibold text-sky-100 hover:text-white"
                        >
                          View live
                        </button>
                      </div>
                    ) : null}

                    {visiblePendingInput ? (
                      <div className="grid gap-3 rounded-lg border border-teal-400/30 bg-teal-950/20 p-3">
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="grid min-w-0 gap-1">
                            <div className="text-sm font-semibold text-teal-50">
                              {visiblePendingInput.title}
                            </div>
                            {visiblePendingInput.prompt ? (
                              <div className="text-xs leading-5 text-teal-100/80">
                                {visiblePendingInput.prompt}
                              </div>
                            ) : null}
                            {visiblePendingInput.interview ? (
                              <div className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-teal-200/75">
                                Interview turn {visiblePendingInput.interview.turn} / {visiblePendingInput.interview.maxTurns}
                              </div>
                            ) : null}
                          </div>
                          <span className="shrink-0 rounded-full border border-teal-300/30 bg-teal-400/10 px-2 py-1 text-[0.68rem] font-semibold text-teal-100">
                            Waiting
                          </span>
                        </div>
                        <div className="grid gap-3">
                          {visiblePendingInput.fields.map((field) => (
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
                            {visiblePendingInput.cancelLabel ?? "Cancel"}
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
                            {visiblePendingInput.submitLabel ?? "Continue"}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {runPanelTab === "setup" ? (
                      <div className="grid gap-3">
                        <div
                          className={cn(
                            "text-sm",
                            selectedFlowPrimaryActiveRun
                              ? "text-sky-100"
                              : runBlockedReason
                                ? "text-amber-100"
                                : "text-lime-100",
                          )}
                        >
                          <div className="flex min-w-0 items-center justify-between gap-3">
                            <span className="min-w-0 break-words">
                              {runActionMessage}
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
                              {setupVariables.length} total
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

                        {draftFlow && setupVariables.length > 0 ? (
                          <div className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
                            {setupVariables.map((variable) => {
                              const variableError = setupVariableErrors[variable.name];
                              const variableErrorId = variableError
                                ? createSetupVariableErrorId(variable.name)
                                : undefined;

                              return (
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
                                    <span
                                      title="Variable type is defined by the flow."
                                      className="h-7 shrink-0 rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[0.7rem] text-slate-400"
                                    >
                                      {variable.type}
                                    </span>
                                  </span>
                                  <RalphSetupVariableControl
                                    variable={variable}
                                    value={getRalphVariableValue(
                                      variable,
                                      variableValues,
                                    )}
                                    error={variableError}
                                    errorId={variableErrorId}
                                    onChange={updateSetupVariableValue}
                                  />
                                  {variableError ? (
                                    <span
                                      id={variableErrorId}
                                      role="alert"
                                      className="text-xs font-medium text-rose-200"
                                    >
                                      {variableError}
                                    </span>
                                  ) : null}
                                  {variable.default !== undefined ? (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        updateSetupVariableValue(
                                          variable.name,
                                          variable.default ?? "",
                                        )
                                      }
                                      className="justify-self-start text-[0.68rem] font-medium text-slate-500 hover:text-slate-200"
                                    >
                                      Reset to default
                                    </button>
                                  ) : null}
                                </label>
                              );
                            })}
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
                                  Active runs
                                </span>
                                <span>{activeRuns.length}</span>
                              </div>
                              <div className="grid gap-2">
                                {activeRuns.slice(0, ACTIVE_RUN_LIST_LIMIT).map((activeRun) => {
                                  const status = getRunStatusPresentation(
                                    activeRun.status,
                                  );
                                  const StatusIcon = status.icon;
                                  const isSelected = liveRunForPanel?.id === activeRun.id;

                                  return (
                                    <button
                                      key={activeRun.id}
                                      type="button"
                                      onClick={() => focusActiveRun(activeRun)}
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
                                {activeRuns.length > ACTIVE_RUN_LIST_LIMIT ? (
                                  <div className="rounded border border-slate-800 bg-slate-950/70 px-2 py-1.5 text-xs text-slate-500">
                                    {activeRuns.length - ACTIVE_RUN_LIST_LIMIT} more active run{activeRuns.length - ACTIVE_RUN_LIST_LIMIT === 1 ? "" : "s"} hidden. Open History after they finish.
                                  </div>
                                ) : null}
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

                                {(() => {
                                  const variableEntries = Object.entries(
                                    liveRunForPanel.variableValues,
                                  );

                                  if (variableEntries.length === 0) {
                                    return null;
                                  }

                                  const visibleVariableEntries = variableEntries.slice(
                                    0,
                                    LIVE_VARIABLE_PREVIEW_LIMIT,
                                  );
                                  const hiddenVariableCount =
                                    variableEntries.length - visibleVariableEntries.length;

                                  return (
                                    <div className="grid gap-1">
                                      {visibleVariableEntries.map(([name, value]) => (
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
                                      ))}
                                      {hiddenVariableCount > 0 ? (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setSelectedRunId(liveRunForPanel.id);
                                            setRunPanelTab("details");
                                          }}
                                          className="justify-self-start text-xs font-medium text-sky-200 hover:text-white"
                                        >
                                          View {hiddenVariableCount} more variable{hiddenVariableCount === 1 ? "" : "s"} in Details
                                        </button>
                                      ) : null}
                                    </div>
                                  );
                                })()}

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

                                {(() => {
                                  const blockDetails =
                                    getSortedActiveBlockDetails(liveRunForPanel);
                                  const visibleBlockDetails = blockDetails.slice(
                                    0,
                                    LIVE_EXPANDED_NODE_PREVIEW_LIMIT,
                                  );
                                  const hiddenBlockCount =
                                    blockDetails.length - visibleBlockDetails.length;

                                  return (
                                    <div className="grid gap-2">
                                      <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-400">
                                        <span>Expanded nodes</span>
                                        <span>{blockDetails.length}</span>
                                      </div>
                                      {blockDetails.length > 0 ? (
                                        <div className="grid gap-2">
                                          {visibleBlockDetails.map((detail) => (
                                            <ActiveRalphBlockDetailCard
                                              key={detail.blockId}
                                              detail={detail}
                                            />
                                          ))}
                                          {hiddenBlockCount > 0 ? (
                                            <button
                                              type="button"
                                              onClick={() => {
                                                setSelectedRunId(liveRunForPanel.id);
                                                setRunPanelTab("details");
                                              }}
                                              className="justify-self-start text-xs font-medium text-sky-200 hover:text-white"
                                            >
                                              View {hiddenBlockCount} more node{hiddenBlockCount === 1 ? "" : "s"} in Details
                                            </button>
                                          ) : null}
                                        </div>
                                      ) : (
                                        <div className="text-xs text-slate-500">
                                          No node internals captured yet.
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <div className="text-sm text-slate-500">
                            No active Ralph runs.
                          </div>
                        )}

                        {visibleLastRun ? (
                          <div className="grid gap-2 border-t border-slate-800 pt-3">
                            <div className="flex min-w-0 items-center justify-between gap-3">
                              <div className="min-w-0 text-sm font-medium text-slate-100">
                                Last result: {visibleLastRun.status}
                              </div>
                              {canRetryRecoverableRun ? (
                                <Button
                                  type="button"
                                  variant="outline"
                                  disabled={inputSubmitting}
                                  onClick={() => void retryRecoverableRun()}
                                  className="h-8 shrink-0 rounded-lg border-amber-400/30 bg-amber-500/10 px-3 text-xs text-amber-100 hover:bg-amber-500/15 hover:text-white"
                                >
                                  {inputSubmitting ? (
                                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <RotateCcw className="h-3.5 w-3.5" />
                                  )}
                                  Retry current block
                                </Button>
                              ) : null}
                            </div>
                            <p className="break-words text-sm text-slate-400">
                              {visibleLastRun.summary}
                            </p>
                            <div className="grid gap-1 md:grid-cols-2">
                              {visibleLastRun.events.slice(-10).map((event, index) => (
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
                              const isPartial = run.status === "partial";
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
                                        void (isPartial
                                          ? openRunLog(run.id, "simple", selectedScope)
                                          : openRunDetail(run.id, selectedScope))
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
                                        disabled={runDetailLoading || isPartial}
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
                            <div className="grid gap-1.5">
                              <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-300">
                                <span>Expanded nodes</span>
                                <span className="text-slate-500">
                                  {getSortedActiveBlockDetails(selectedActiveRun).length}
                                </span>
                              </div>
                              {getSortedActiveBlockDetails(selectedActiveRun).length > 0 ? (
                                <div className="grid gap-2">
                                  {getSortedActiveBlockDetails(selectedActiveRun).map(
                                    (detail) => (
                                      <ActiveRalphBlockDetailCard
                                        key={detail.blockId}
                                        detail={detail}
                                      />
                                    ),
                                  )}
                                </div>
                              ) : (
                                <div className="text-xs text-slate-500">
                                  No node internals captured yet.
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
                                        <RalphRunRecordBlockCard
                                          key={`${block.blockId}-${block.attempt}`}
                                          block={block}
                                        />
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
          <RalphGenerationInterviewDialog
            state={generationInterview}
            renderInputControl={renderRalphInputControl}
            getDefaultInputValue={getDefaultRalphInputValue}
            onClose={closeGenerationInterview}
            onValueChange={updateGenerationInterviewValue}
            onToggleComment={toggleGenerationInterviewComment}
            onCommentChange={updateGenerationInterviewComment}
            onSkipField={skipGenerationInterviewField}
            onGenerateNow={() => void generateFromInterviewNow()}
            onSubmitAnswers={() => void submitGenerationInterviewAnswers()}
          />
          <RalphStarterFlowDialog
            open={starterFlowDialogOpen}
            workspaceRoot={workspaceRoot}
            loading={loading}
            errorMessage={starterImportError}
            starterImportScope={starterImportScope}
            starterImportScopeLabel={starterImportScopeLabel}
            onOpenChange={setStarterFlowDialogOpen}
            onStarterImportScopeChange={setStarterImportScope}
            onImportStarterFlow={(starterFlow, targetScope) => {
              void importStarterFlow(starterFlow, targetScope);
            }}
          />
          <RalphExpandedEditorDialog
            editor={expandedEditor}
            draft={expandedEditorDraft}
            wrap={expandedEditorWrap}
            variableSnippets={RALPH_VARIABLE_SNIPPETS}
            textareaRef={expandedEditorTextareaRef}
            onDraftChange={setExpandedEditorDraft}
            onWrapChange={setExpandedEditorWrap}
            onClose={() => setExpandedEditor(null)}
            onApply={applyExpandedEditor}
            onCopy={() => void copyExpandedEditorDraft()}
            onInsertSnippet={insertExpandedEditorSnippet}
          />
    </section>
  );
};
