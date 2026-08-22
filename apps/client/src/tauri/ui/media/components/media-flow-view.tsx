import {
  Position,
  type Connection,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type OnSelectionChangeParams,
  type Edge,
  type ReactFlowInstance,
  useNodesState,
} from "@xyflow/react";
import {
  Box,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CirclePlay,
  Cloud,
  ClipboardPaste,
  Copy,
  Cpu,
  FileDown,
  FileDiff,
  FileUp,
  FolderGit2,
  GitBranch,
  Group,
  History,
  ImageIcon,
  LayoutDashboard,
  LayoutTemplate,
  LoaderCircle,
  LocateFixed,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Redo2,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  StickyNote,
  Trash2,
  Ungroup,
  Undo2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import type {
  MediaCompiledPlan,
  MediaAssetRecord,
  MediaCapability,
  MediaFlow,
  MediaFlowHead,
  MediaFlowGroupColor,
  MediaFlowHistory,
  MediaFlowImportInspection,
  InstantiateMediaFlowTemplateResult,
  MediaFlowLayout,
  MediaFlowLayoutComment,
  MediaGenerationAssetMetadata,
  MediaImageReferenceRole,
  MediaModelAddonDescriptor,
  MediaModelAddonSelection,
  MediaModelDescriptor,
  MediaFlowNode,
  MediaFlowRevision,
  MediaNodeLayer,
  MediaNodeType,
  MediaPortDataType,
  MediaRunDetail,
} from "../../../../core/media/contracts.js";
import {
  createMediaModelAddonSelection,
  getMediaModelAddonTriggerWords,
  inspectMediaModelAddonCompatibility,
  mediaModelAddonSelectionsEqual,
  promptContainsMediaModelAddonTrigger,
  reconcileMediaModelAddonSelections,
} from "../../../../core/media/model-addons.js";
import { listSelectableMediaModels } from "../../../../core/media/model-library.js";
import {
  getMediaReferenceConditioningCapabilities,
  mediaModelSupportsReferenceRole,
} from "../../../../core/media/reference-conditioning.js";
import {
  addMediaFlowLayoutComment,
  addMediaFlowLayoutGroup,
  createMediaFlowLayout,
  removeMediaFlowLayoutComment,
  removeMediaFlowLayoutGroup,
  updateMediaFlowLayoutComment,
  updateMediaFlowLayoutGroup,
} from "../../../../core/media/compiler.js";
import { createMediaFlowLayoutDigest } from "../../../../core/media/canonicalize.js";
import {
  getMediaNodeDefinition,
  inspectMediaFlowConnection,
  listMediaNodeDefinitions,
  listVisibleMediaNodeFields,
  validateMediaFlowNode,
  type MediaNodeFieldDefinition,
  type MediaNodeInspectorGroup,
  type MediaNodePortDefinition,
  type MediaNodeValidationIssue,
  type MediaFlowConnectionRequest,
} from "../../../../core/media/node-registry.js";
import { createMediaFlowRevisionDiff } from "../../../../core/media/revision-diff.js";
import { resolveMediaFlowVariables } from "../../../../core/media/variables.js";
import {
  hasMediaImageMaskContent,
  normalizeMediaImageMask,
} from "../../../../core/media/image-mask.js";
import {
  readSubjectCutoutModelPriority,
  subjectCutoutModelLabel,
} from "../../../../core/media/subject-cutout-policy.js";
import {
  fitMediaVideoDuration,
  identifyMediaVideoQualityPreset,
  isMediaVideoFrameCountValid,
  MEDIA_VIDEO_QUALITY_PRESETS,
  resolveMediaVideoExecutionSettings,
  resolveMediaVideoFrameContract,
  resolveMediaVideoQualityPresetSettings,
  summarizeMediaVideoDelivery,
} from "../../../../core/media/video-quality.js";
import { MediaFlowVariablesPanel } from "./media-flow-variables-panel";
import { MediaFlowTemplatesPanel } from "./media-flow-templates-panel";
import { MediaLoraStrengthControl } from "./media-lora-strength-control";
import {
  projectMediaRunOverlay,
  selectMediaRunOutputAssetForNode,
  selectMediaRunOverlayForCurrentFlow,
  type MediaRunOverlayNodeObservation,
  type MediaRunOverlayNodeState,
} from "../media-run-overlay";
import { readMediaAssetPreview } from "../media-runtime";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { SearchField } from "../../components/ui/search-field";
import { Textarea } from "../../components/ui/textarea";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { cn } from "../../lib/utils";
import {
  useOptionalCommandPageLauncher,
  useOptionalCommandShortcut,
  useOptionalRegisterCommands,
} from "../../commands/command-context";
import { getDefaultCommandShortcut } from "../../commands/command-defaults";
import type { CommandDefinition } from "../../commands/command-types";
import { createMediaNodeCommandPage } from "../media-node-command-page";
import { normalizeMediaSubmissionText } from "../media-generation-recipe";
import { MediaResourcePreview } from "./media-visual-preview";
import { MediaModelPicker } from "./media-model-picker";
import { MediaImageMaskEditor } from "./media-image-mask-editor";
import { FlowCanvas } from "../../flow/flow-canvas";
import { reconcileFlowElements } from "../../flow/flow-element-reconciliation";
import {
  FlowNodeHeader,
  FlowNodeShell,
  FlowPort,
  FlowPortDot,
} from "../../flow/flow-primitives";
import {
  FLOW_CANVAS_FIT_MAX_ZOOM,
  FLOW_CANVAS_FIT_PADDING,
  FLOW_EDGE_TYPE,
  createFlowCanvasEdge,
  type FlowPortTone,
} from "../../flow/flow-theme";

interface MediaFlowViewProps {
  flow: MediaFlow;
  layout: MediaFlowLayout;
  plan: MediaCompiledPlan;
  models: readonly MediaModelDescriptor[];
  addons: readonly MediaModelAddonDescriptor[];
  assetMetadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  assets?: readonly MediaAssetRecord[];
  onLayoutChange: (layout: MediaFlowLayout) => void;
  onFlowVariablesChange?: (flow: MediaFlow) => void;
  onTemplateApply?: (result: InstantiateMediaFlowTemplateResult) => void;
  onNodeConfigChange: (nodeId: string, fieldId: string, value: unknown) => void;
  onNodeConfigPatch?: (
    nodeId: string,
    values: Readonly<Record<string, unknown>>,
  ) => void;
  onNodeLabelChange: (nodeId: string, label: string) => void;
  onNodeAdd: (nodeType: MediaNodeType) => string | null;
  onNodeRemove: (nodeId: string) => void;
  onConnectPorts: (request: MediaFlowConnectionRequest) => void;
  onDisconnectInput: (nodeId: string, portId: string) => void;
  onDisconnectConnection?: (request: MediaFlowConnectionRequest) => void;
  canUndoSemantic?: boolean;
  canRedoSemantic?: boolean;
  onUndoSemantic?: () => void;
  onRedoSemantic?: () => void;
  onNodeCopy?: (nodeId: string) => void;
  onNodesCopy?: (nodeIds: readonly string[]) => void;
  onNodePaste?: () => string | null;
  clipboardLabel?: string | null;
  canPasteNode?: boolean;
  pasteBlockedReason?: string | null;
  history: MediaFlowHistory | null;
  savedFlows: readonly MediaFlowHead[];
  savedFlowsLoading: boolean;
  revisionLoading: boolean;
  revisionNotice: string | null;
  hasUnsavedChanges: boolean;
  onRefreshHistory: () => void;
  onRefreshSavedFlows: () => void;
  onOpenSavedFlow: (flowId: string) => void;
  onSaveRevision: () => void;
  onRestoreRevision: (revision: MediaFlowRevision) => void;
  portabilitySupported: boolean;
  portabilityLoading: boolean;
  importInspection: MediaFlowImportInspection | null;
  onInspectImport: () => void;
  onImportReviewed: () => void;
  onDismissImport: () => void;
  onExportRevision: () => void;
  onRunLocalFlow?: () => void;
  localRunPending?: boolean;
  localRunSupported?: boolean;
  localRunDescription?: string;
  onRunRemoteEdit?: () => void;
  remoteRunPending?: boolean;
  remoteRunSupported?: boolean;
  remoteRunDescription?: string;
  remoteRunMode?: "native" | "browser-preview" | null;
  remoteMaskIncluded?: boolean;
  remoteUploadManifest?: readonly {
    assetId: string;
    digest: string;
    byteSize: number;
    role: string;
    influence: number;
  }[];
  runOverlay?: MediaRunDetail | null;
  onRunOverlayClear?: () => void;
}

interface MediaCanvasNodeData extends Record<string, unknown> {
  label: string;
  nodeType: string;
  layer: MediaNodeLayer;
  detail: string;
  asset: MediaAssetRecord | null;
  assetId: string | null;
  assetLabel: string | null;
  inputs: readonly MediaNodePortDefinition[];
  outputs: readonly MediaNodePortDefinition[];
  runOverlay: MediaRunOverlayNodeObservation | null;
}

type MediaSemanticCanvasNode = Node<MediaCanvasNodeData, "mediaNode">;

interface MediaGroupCanvasNodeData extends Record<string, unknown> {
  label: string;
  color: MediaFlowGroupColor;
  collapsed: boolean;
  memberCount: number;
  width: number;
  height: number;
}

type MediaGroupCanvasNode = Node<MediaGroupCanvasNodeData, "mediaGroup">;

interface MediaCommentCanvasNodeData extends Record<string, unknown> {
  body: string;
  color: MediaFlowGroupColor;
  width: number;
  height: number;
}

type MediaCommentCanvasNode = Node<MediaCommentCanvasNodeData, "mediaComment">;
type MediaCanvasNode =
  | MediaSemanticCanvasNode
  | MediaGroupCanvasNode
  | MediaCommentCanvasNode;
type MediaCanvasEdge = Edge<Record<string, unknown>, typeof FLOW_EDGE_TYPE>;

const mediaCanvasPortSignature = (
  ports: readonly MediaNodePortDefinition[],
): string =>
  ports
    .map(
      (port) =>
        `${port.id}\u001f${port.label}\u001f${port.dataType}\u001f${port.cardinality}\u001f${port.required}`,
    )
    .join("\u001e");

const mediaRunObservationSignature = (
  observation: MediaRunOverlayNodeObservation | null,
): string =>
  observation
    ? [
        observation.state,
        observation.label,
        observation.detail,
        observation.stepCount,
        observation.observedEventCount,
      ].join("\u001f")
    : "";

const mediaCanvasNodeDisplaySignature = (node: MediaCanvasNode): string => {
  const base = [node.type, node.hidden ?? false];
  if (node.type === "mediaNode") {
    return [
      ...base,
      node.data.label,
      node.data.nodeType,
      node.data.layer,
      node.data.detail,
      node.data.asset?.id ?? "",
      node.data.assetId ?? "",
      node.data.assetLabel ?? "",
      mediaCanvasPortSignature(node.data.inputs),
      mediaCanvasPortSignature(node.data.outputs),
      mediaRunObservationSignature(node.data.runOverlay),
    ].join("\u001f");
  }
  if (node.type === "mediaGroup") {
    return [
      ...base,
      node.data.label,
      node.data.color,
      node.data.collapsed,
      node.data.memberCount,
      node.data.width,
      node.data.height,
    ].join("\u001f");
  }
  return [
    ...base,
    node.data.body,
    node.data.color,
    node.data.width,
    node.data.height,
  ].join("\u001f");
};

const reconcileMediaCanvasNodes = (
  current: MediaCanvasNode[],
  projected: readonly MediaCanvasNode[],
  preservePositions: boolean,
): MediaCanvasNode[] =>
  reconcileFlowElements({
    current,
    projected,
    equals: (previous, next) =>
      mediaCanvasNodeDisplaySignature(previous) ===
        mediaCanvasNodeDisplaySignature(next) &&
      (preservePositions ||
        (previous.position.x === next.position.x &&
          previous.position.y === next.position.y)),
    merge: (previous, next) => ({
      ...next,
      selected: previous.selected,
      dragging: previous.dragging,
      measured: previous.measured,
      ...(preservePositions
        ? {
            position: previous.position,
          }
        : {}),
    }),
  });

const mediaCanvasEdgeDisplaySignature = (edge: MediaCanvasEdge): string =>
  [
    edge.type ?? "",
    edge.source,
    edge.target,
    edge.sourceHandle ?? "",
    edge.targetHandle ?? "",
    edge.hidden ?? false,
    edge.animated ?? false,
    edge.style?.stroke ?? "",
    edge.style?.strokeWidth ?? "",
    edge.style?.opacity ?? "",
  ].join("\u001f");

const reconcileMediaCanvasEdges = (
  current: MediaCanvasEdge[],
  projected: readonly MediaCanvasEdge[],
): MediaCanvasEdge[] =>
  reconcileFlowElements({
    current,
    projected,
    equals: (previous, next) =>
      mediaCanvasEdgeDisplaySignature(previous) ===
      mediaCanvasEdgeDisplaySignature(next),
    merge: (previous, next) => ({ ...next, selected: previous.selected }),
  });

const LAYER_STYLES: Record<MediaNodeLayer, string> = {
  source: "border-sky-400/35 bg-sky-950/80 text-sky-100",
  task: "border-violet-400/35 bg-violet-950/80 text-violet-100",
  operation: "border-cyan-400/35 bg-cyan-950/80 text-cyan-100",
  control: "border-amber-400/35 bg-amber-950/80 text-amber-100",
  output: "border-emerald-400/35 bg-emerald-950/80 text-emerald-100",
  runtime: "border-slate-500/40 bg-slate-900/90 text-slate-100",
};

const PORT_TONES: Record<MediaPortDataType, FlowPortTone> = {
  prompt: "sky",
  image: "fuchsia",
  seed: "amber",
  video: "emerald",
  audio: "orange",
  "quality-report": "amber",
};

const PORT_LABELS: Record<MediaPortDataType, string> = {
  prompt: "Text",
  image: "Image",
  seed: "Seed",
  video: "Video",
  audio: "Audio",
  "quality-report": "Quality",
};

const GROUP_STYLES: Record<MediaFlowGroupColor, string> = {
  slate: "border-slate-500/35 bg-slate-500/5 text-slate-300",
  cyan: "border-cyan-400/35 bg-cyan-400/5 text-cyan-200",
  violet: "border-violet-400/35 bg-violet-400/5 text-violet-200",
  amber: "border-amber-400/35 bg-amber-400/5 text-amber-200",
  emerald: "border-emerald-400/35 bg-emerald-400/5 text-emerald-200",
};

const RUN_OVERLAY_NODE_STYLES: Record<MediaRunOverlayNodeState, string> = {
  pending: "ring-1 ring-slate-500/40 ring-offset-2 ring-offset-slate-950",
  queued: "ring-2 ring-amber-300/50 ring-offset-2 ring-offset-slate-950",
  running:
    "ring-2 ring-cyan-200 ring-offset-2 ring-offset-slate-950 shadow-[0_0_0_4px_rgba(34,211,238,0.18),0_0_28px_rgba(34,211,238,0.42)] animate-[pulse_1.2s_ease-in-out_infinite]",
  waiting: "ring-2 ring-fuchsia-300/75 ring-offset-2 ring-offset-slate-950",
  retrying: "ring-2 ring-amber-300/70 ring-offset-2 ring-offset-slate-950",
  completed: "ring-2 ring-emerald-300/65 ring-offset-2 ring-offset-slate-950",
  cached: "ring-2 ring-teal-300/55 ring-offset-2 ring-offset-slate-950",
  skipped:
    "ring-1 ring-slate-400/45 ring-offset-2 ring-offset-slate-950 opacity-70",
  failed: "ring-2 ring-rose-300/80 ring-offset-2 ring-offset-slate-950",
  blocked: "ring-2 ring-orange-300/80 ring-offset-2 ring-offset-slate-950",
  rejected: "ring-2 ring-rose-300/65 ring-offset-2 ring-offset-slate-950",
  canceled: "ring-2 ring-slate-400/55 ring-offset-2 ring-offset-slate-950",
  "not-reached": "opacity-55 grayscale-[0.35]",
  "not-observed":
    "ring-1 ring-slate-500/45 ring-offset-2 ring-offset-slate-950",
};

const RUN_OVERLAY_BADGE_STYLES: Record<MediaRunOverlayNodeState, string> = {
  pending: "border-slate-500/25 bg-slate-900/50 text-slate-400",
  queued: "border-amber-300/25 bg-amber-300/10 text-amber-100",
  running: "border-cyan-300/30 bg-cyan-300/10 text-cyan-100",
  waiting: "border-fuchsia-300/35 bg-fuchsia-300/10 text-fuchsia-100",
  retrying: "border-amber-300/35 bg-amber-300/10 text-amber-100",
  completed: "border-emerald-300/30 bg-emerald-300/10 text-emerald-100",
  cached: "border-teal-300/30 bg-teal-300/10 text-teal-100",
  skipped: "border-slate-500/25 bg-slate-900/50 text-slate-400",
  failed: "border-rose-300/35 bg-rose-300/10 text-rose-100",
  blocked: "border-orange-300/35 bg-orange-300/10 text-orange-100",
  rejected: "border-rose-300/30 bg-rose-300/10 text-rose-100",
  canceled: "border-slate-400/25 bg-slate-400/10 text-slate-300",
  "not-reached": "border-slate-600/30 bg-slate-900/40 text-slate-500",
  "not-observed": "border-slate-500/25 bg-slate-900/50 text-slate-400",
};

const readNodeDetail = (
  config: Record<string, unknown>,
  architecture: MediaModelDescriptor["architecture"] = null,
): string => {
  if (Array.isArray(config.modelPriority)) {
    const priority = config.modelPriority.filter(
      (modelId): modelId is string => typeof modelId === "string",
    );
    if (priority.length > 0) {
      return priority.map(subjectCutoutModelLabel).join(" → ");
    }
  }
  if (typeof config.prompt === "string") {
    return config.prompt.trim() || "Awaiting a creative brief";
  }
  if (typeof config.profile === "string") {
    return config.profile;
  }
  if (typeof config.maxSelections === "number") {
    return `Approve up to ${config.maxSelections}`;
  }
  if (typeof config.outputCount === "number") {
    return `${config.outputCount} output${config.outputCount === 1 ? "" : "s"}`;
  }
  const delivery = summarizeMediaVideoDelivery(config, architecture);
  if (delivery) {
    const loop =
      delivery.loopMode === "ping-pong"
        ? "boomerang · reversed"
        : delivery.loopMode === "seamless"
          ? "seamless"
          : "one-way";
    return `${delivery.durationSeconds.toFixed(2)}s · ${delivery.outputFrameCount} frames · ${delivery.width}×${delivery.height} · ${loop}`;
  }
  return "Configured by the recipe compiler";
};

const mediaAssetLabel = (asset: MediaAssetRecord, index: number): string =>
  asset.tags.find((tag) => tag.source === "user")?.label ??
  `Image ${index + 1}`;

const MediaAssetThumbnail = ({
  asset,
  alt,
  className,
}: {
  asset: MediaAssetRecord;
  alt: string;
  className?: string;
}): JSX.Element => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const assetId = asset.id;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    void readMediaAssetPreview(asset, 384)
      .then((blob) => {
        if (cancelled) return;
        if (typeof URL.createObjectURL !== "function") {
          setFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // Asset ids identify immutable image bytes; runtime metadata objects refresh periodically.
  }, [assetId]);

  if (url) {
    return (
      <img
        src={url}
        alt={alt}
        className={cn("h-full w-full object-cover", className)}
      />
    );
  }

  return (
    <span
      aria-label={failed ? `${alt} unavailable` : `${alt} loading`}
      className={cn(
        "flex h-full w-full items-center justify-center bg-slate-900/70 text-slate-600",
        className,
      )}
    >
      {failed ? (
        <ImageIcon aria-hidden="true" className="h-5 w-5" />
      ) : (
        <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
      )}
    </span>
  );
};

const MediaFlowNodeCard = ({
  data,
  selected,
}: NodeProps<MediaSemanticCanvasNode>): JSX.Element => {
  return (
    <FlowNodeShell
      role="group"
      aria-label={
        data.runOverlay
          ? `${data.label}, run state ${data.runOverlay.label}`
          : data.label
      }
      selected={selected}
      className={cn(
        LAYER_STYLES[data.layer],
        data.runOverlay && RUN_OVERLAY_NODE_STYLES[data.runOverlay.state],
      )}
    >
      {data.inputs.map((port, index) => (
        <FlowPort
          key={port.id}
          id={port.id}
          type="target"
          position={Position.Left}
          tone={PORT_TONES[port.dataType]}
          title={`${port.label}: ${port.dataType}`}
          aria-label={`${port.label} ${port.dataType} input`}
          style={{ top: `${((index + 1) / (data.inputs.length + 1)) * 100}%` }}
        />
      ))}
      <FlowNodeHeader
        category={data.layer}
        label={data.label}
        icon={<Box className="h-3.5 w-3.5 opacity-70" />}
      />
      {data.asset ? (
        <div className="mt-3 aspect-[4/3] overflow-hidden rounded-xl border border-white/10 bg-black/20">
          <MediaAssetThumbnail
            asset={data.asset}
            alt={`${data.assetLabel ?? data.label} preview`}
            className="object-contain"
          />
        </div>
      ) : data.assetId ? (
        <div className="mt-3 flex aspect-[4/3] items-center justify-center rounded-xl border border-dashed border-white/15 bg-black/15 text-center text-[9px] opacity-60">
          <span>
            <ImageIcon aria-hidden="true" className="mx-auto mb-1.5 h-5 w-5" />
            Asset unavailable
          </span>
        </div>
      ) : null}
      <div className="mt-2 line-clamp-2 text-[11px] leading-4 opacity-65">
        {data.detail}
      </div>
      {data.inputs.length > 0 || data.outputs.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-white/10 pt-2 text-[9px]">
          <div className="min-w-0 space-y-1">
            {data.inputs.map((port) => (
              <div
                key={`input-${port.id}`}
                className="flex min-w-0 items-center gap-1.5"
                title={`${port.label}: ${PORT_LABELS[port.dataType]} input`}
              >
                <FlowPortDot
                  aria-hidden="true"
                  tone={PORT_TONES[port.dataType]}
                />
                <span className="truncate opacity-70">
                  {port.label}
                  {port.required ? " *" : ""}
                </span>
              </div>
            ))}
          </div>
          <div className="min-w-0 space-y-1 text-right">
            {data.outputs.map((port) => (
              <div
                key={`output-${port.id}`}
                className="flex min-w-0 items-center justify-end gap-1.5"
                title={`${port.label}: ${PORT_LABELS[port.dataType]} output`}
              >
                <span className="truncate opacity-70">{port.label}</span>
                <FlowPortDot
                  aria-hidden="true"
                  tone={PORT_TONES[port.dataType]}
                />
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {data.runOverlay ? (
        <div
          title={data.runOverlay.detail}
          className={cn(
            "mt-2 flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-[9px]",
            RUN_OVERLAY_BADGE_STYLES[data.runOverlay.state],
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5 font-medium">
            <span
              aria-hidden="true"
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full bg-current",
                data.runOverlay.state === "running" && "animate-pulse",
              )}
            />
            <span className="truncate">{data.runOverlay.label}</span>
          </span>
          <span className="shrink-0 font-mono opacity-60">
            {data.runOverlay.stepCount} step
            {data.runOverlay.stepCount === 1 ? "" : "s"}
          </span>
        </div>
      ) : null}
      {data.outputs.map((port, index) => (
        <FlowPort
          key={port.id}
          id={port.id}
          type="source"
          position={Position.Right}
          tone={PORT_TONES[port.dataType]}
          title={`${port.label}: ${port.dataType}`}
          aria-label={`${port.label} ${port.dataType} output`}
          style={{ top: `${((index + 1) / (data.outputs.length + 1)) * 100}%` }}
        />
      ))}
    </FlowNodeShell>
  );
};

const MediaFlowGroupCard = ({
  data,
}: NodeProps<MediaGroupCanvasNode>): JSX.Element => (
  <div
    className={cn(
      "pointer-events-none rounded-2xl border border-dashed px-4 py-3 shadow-inner shadow-black/20",
      GROUP_STYLES[data.color],
    )}
    style={{ width: data.width, height: data.height }}
  >
    <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.12em] uppercase">
      <Group className="h-3.5 w-3.5" />
      <span className="truncate">{data.label}</span>
      <span className="ml-auto shrink-0 opacity-55">
        {data.memberCount} node{data.memberCount === 1 ? "" : "s"}
        {data.collapsed ? " hidden" : ""}
      </span>
    </div>
  </div>
);

const MediaFlowCommentCard = ({
  data,
}: NodeProps<MediaCommentCanvasNode>): JSX.Element => (
  <article
    aria-label="Canvas comment"
    className={cn(
      "h-full w-full overflow-hidden rounded-xl border px-3 py-2.5 shadow-xl shadow-black/25",
      GROUP_STYLES[data.color],
    )}
  >
    <div className="flex items-center gap-1.5 text-[9px] font-semibold tracking-[0.12em] uppercase opacity-65">
      <StickyNote className="h-3 w-3" />
      Comment
    </div>
    <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-[10px] leading-4 opacity-85">
      {data.body}
    </p>
  </article>
);

const NODE_TYPES = {
  mediaNode: MediaFlowNodeCard,
  mediaGroup: MediaFlowGroupCard,
  mediaComment: MediaFlowCommentCard,
} satisfies NodeTypes;

const formatConfigValue = (value: unknown): string => {
  if (value === null) {
    return "Automatic";
  }
  if (typeof value === "boolean") {
    return value ? "Enabled" : "Disabled";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value);
};

const formatByteSize = (bytes: number): string => {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_024 ** 2).toFixed(1)} MB`;
};

const INSPECTOR_GROUPS: readonly MediaNodeInspectorGroup[] = [
  "Basic",
  "Creative",
  "Expert",
];

const SavedWorkflowPicker = ({
  flow,
  savedFlows,
  loading,
  onOpen,
}: {
  flow: MediaFlow;
  savedFlows: readonly MediaFlowHead[];
  loading: boolean;
  onOpen: (flowId: string) => void;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const current = savedFlows.find((candidate) => candidate.flowId === flow.id);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label="Open workflow"
          aria-expanded={open}
          disabled={loading}
          className="flex h-9 min-w-44 max-w-64 items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-left outline-none hover:border-slate-600 focus-visible:ring-2 focus-visible:ring-cyan-400/30 disabled:opacity-50"
        >
          <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11px] font-medium text-slate-200">
              {flow.name}
            </span>
            <span className="block text-[9px] text-slate-500">
              {current ? `Revision ${current.headRevisionNumber}` : "Draft"}
            </span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(22rem,calc(100vw-2rem))] border-slate-700 bg-slate-950 p-0"
      >
        <Command className="bg-transparent text-slate-100">
          <CommandInput placeholder="Find workflow" />
          <CommandList>
            <CommandEmpty>No workflows</CommandEmpty>
            <CommandGroup>
              {savedFlows.map((savedFlow) => (
                <CommandItem
                  key={savedFlow.flowId}
                  value={`${savedFlow.name} ${savedFlow.flowId}`}
                  onSelect={() => {
                    if (savedFlow.flowId !== flow.id) {
                      onOpen(savedFlow.flowId);
                    }
                    setOpen(false);
                  }}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-slate-200">
                      {savedFlow.name}
                    </span>
                    <span className="block text-[9px] text-slate-500">
                      Revision {savedFlow.headRevisionNumber}
                    </span>
                  </span>
                  {savedFlow.flowId === flow.id ? (
                    <Check className="h-3.5 w-3.5 text-cyan-300" />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

const FIELD_CONTROL_CLASS =
  "mt-2 border-slate-700 bg-slate-950/65 text-xs text-slate-100 focus-visible:border-sky-400/60 focus-visible:ring-sky-400/20";

const MediaAssetPicker = ({
  controlId,
  fieldLabel,
  currentAssetId,
  currentAsset,
  imageAssets,
  disabled,
  invalid,
  describedBy,
  onChange,
}: {
  controlId: string;
  fieldLabel: string;
  currentAssetId: string;
  currentAsset: MediaAssetRecord | null;
  imageAssets: readonly MediaAssetRecord[];
  disabled: boolean;
  invalid: boolean;
  describedBy: string;
  onChange: (assetId: string) => void;
}): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredAssets = useMemo(
    () =>
      imageAssets.filter((asset, index) => {
        if (!normalizedQuery) return true;
        return [
          mediaAssetLabel(asset, index),
          asset.id,
          asset.digest,
          `${asset.width}x${asset.height}`,
          ...asset.tags.map((tag) => tag.label),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      }),
    [imageAssets, normalizedQuery],
  );
  const currentAssetIndex = currentAsset
    ? imageAssets.findIndex((asset) => asset.id === currentAsset.id)
    : -1;
  const currentAssetLabel =
    currentAsset && currentAssetIndex >= 0
      ? mediaAssetLabel(currentAsset, currentAssetIndex)
      : null;

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);
    if (!nextOpen) setQuery("");
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <button
        id={controlId}
        type="button"
        aria-label={`Choose ${fieldLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn(
          "mt-2 flex min-h-16 w-full items-center gap-3 rounded-xl border border-slate-700 bg-slate-950/65 p-2 text-left outline-none transition-colors hover:border-sky-400/40 hover:bg-sky-400/5 focus-visible:ring-2 focus-visible:ring-sky-400/30 disabled:cursor-not-allowed disabled:opacity-50",
          invalid && "border-rose-400/45",
        )}
      >
        <span className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
          {currentAsset ? (
            <MediaAssetThumbnail
              asset={currentAsset}
              alt={`${currentAssetLabel ?? fieldLabel} thumbnail`}
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-slate-600">
              <ImageIcon aria-hidden="true" className="h-5 w-5" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block break-words text-xs leading-5 font-medium",
              currentAsset ? "text-slate-100" : "text-slate-400",
            )}
          >
            {currentAssetLabel ??
              (currentAssetId ? "Unavailable asset" : "Choose an asset…")}
          </span>
          <span className="mt-1 block truncate text-[10px] text-slate-500">
            {currentAsset
              ? `${currentAsset.width} × ${currentAsset.height}`
              : currentAssetId ||
                `${imageAssets.length} image${imageAssets.length === 1 ? "" : "s"} available`}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-slate-500"
        />
      </button>

      <DialogContent className="max-h-[min(760px,calc(100vh-28px))] w-[min(720px,calc(100vw-28px))] max-w-none grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden border-slate-700 bg-slate-950 p-0 text-slate-100 sm:max-w-none">
        <DialogHeader className="border-b border-slate-800 px-5 py-4 pr-12">
          <DialogTitle className="text-base">Choose {fieldLabel}</DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Select an image from the Media Studio library.
          </DialogDescription>
        </DialogHeader>
        <SearchField
          value={query}
          aria-label={`Search ${fieldLabel} assets`}
          placeholder="Search images…"
          onChange={(event) => setQuery(event.target.value)}
          containerClassName="mx-5 mt-4"
          iconClassName="size-3.5 text-slate-600"
          className="h-9 border-slate-700 bg-slate-900/70 text-xs text-slate-100 placeholder:text-slate-600"
        />
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {filteredAssets.length > 0 ? (
            <div
              role="listbox"
              aria-label={`${fieldLabel} library images`}
              className="grid grid-cols-2 gap-3 sm:grid-cols-3"
            >
              {filteredAssets.map((asset) => {
                const assetIndex = imageAssets.findIndex(
                  (candidate) => candidate.id === asset.id,
                );
                const label = mediaAssetLabel(asset, assetIndex);
                const selected = asset.id === currentAssetId;
                return (
                  <button
                    key={asset.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-label={`Select ${label}, ${asset.width} by ${asset.height}`}
                    onClick={() => {
                      onChange(asset.id);
                      handleOpenChange(false);
                    }}
                    className={cn(
                      "group min-w-0 overflow-hidden rounded-xl border bg-slate-900/45 text-left outline-none transition-colors hover:border-sky-400/45 hover:bg-sky-400/5 focus-visible:ring-2 focus-visible:ring-sky-400/50",
                      selected
                        ? "border-sky-400/60 ring-1 ring-sky-400/25"
                        : "border-slate-800",
                    )}
                  >
                    <span className="relative block aspect-square overflow-hidden bg-slate-900">
                      <MediaAssetThumbnail
                        asset={asset}
                        alt={`${label} thumbnail`}
                      />
                      {selected ? (
                        <span className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-sky-400 text-slate-950 shadow-lg">
                          <Check aria-hidden="true" className="h-3.5 w-3.5" />
                        </span>
                      ) : null}
                    </span>
                    <span className="block truncate px-3 pt-2.5 text-xs font-medium text-slate-200">
                      {label}
                    </span>
                    <span className="block px-3 pb-2.5 pt-1 text-[10px] text-slate-500">
                      {asset.width} × {asset.height}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={ImageIcon}
              title={
                imageAssets.length === 0
                  ? "No image assets yet"
                  : "No matching images"
              }
              description={
                imageAssets.length === 0
                  ? "Import or generate an image in Media Studio first."
                  : "Try a different name, tag, id, or size."
              }
              role="status"
            />
          )}
        </div>
        {currentAssetId ? (
          <DialogFooter className="border-t border-slate-800 px-5 py-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange("");
                handleOpenChange(false);
              }}
              className="mr-auto text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              Clear selection
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};

const readModelAddonSelections = (
  value: unknown,
): MediaModelAddonSelection[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is MediaModelAddonSelection =>
      typeof entry === "object" &&
      entry !== null &&
      "kind" in entry &&
      (entry.kind === "lora" || entry.kind === "textual-inversion") &&
      "addonId" in entry &&
      typeof entry.addonId === "string" &&
      "enabled" in entry &&
      typeof entry.enabled === "boolean",
  );
};

const ModelAddonPicker = ({
  controlId,
  model,
  addons,
  assets,
  metadata,
  value,
  prompt,
  disabled,
  describedBy,
  onChange,
  onPromptChange,
}: {
  controlId: string;
  model: MediaModelDescriptor | null;
  addons: readonly MediaModelAddonDescriptor[];
  assets: readonly MediaAssetRecord[];
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  value: unknown;
  prompt: string;
  disabled: boolean;
  describedBy: string;
  onChange: (value: MediaModelAddonSelection[]) => void;
  onPromptChange: ((prompt: string) => void) | null;
}): JSX.Element => {
  const [query, setQuery] = useState("");
  const [openControlsId, setOpenControlsId] = useState<string | null>(null);
  const rawSelections = useMemo(() => readModelAddonSelections(value), [value]);
  const selections = useMemo(
    () => reconcileMediaModelAddonSelections(model, addons, rawSelections),
    [addons, model, rawSelections],
  );
  useEffect(() => {
    if (mediaModelAddonSelectionsEqual(rawSelections, selections)) return;
    onChange(selections);
  }, [onChange, rawSelections, selections]);
  const selectedById = new Map(
    selections.map((selection) => [selection.addonId, selection]),
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const modelCompatibleAddons = model
    ? addons.filter(
        (addon) =>
          inspectMediaModelAddonCompatibility(model, addon).status ===
          "compatible",
      )
    : [];
  const compatibleAddons = model
    ? modelCompatibleAddons.filter((addon) => {
        if (!normalizedQuery) return true;
        return [
          addon.displayName,
          addon.architecture,
          addon.baseModelHint ?? "",
          ...addon.triggerWords,
          ...(metadata[addon.id]?.categoryIds ?? []),
          ...(metadata[addon.id]?.tags ?? []),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      })
    : [];
  const missingTriggers = selections.flatMap((selection) => {
    if (!selection.enabled) return [];
    const addon = addons.find(
      (candidate) => candidate.id === selection.addonId,
    );
    if (!addon || promptContainsMediaModelAddonTrigger(prompt, addon))
      return [];
    const triggers = getMediaModelAddonTriggerWords(addon);
    return triggers.length > 0 ? [{ addon, trigger: triggers[0]! }] : [];
  });

  const updateSelection = (
    addonId: string,
    update: (selection: MediaModelAddonSelection) => MediaModelAddonSelection,
  ): void => {
    onChange(
      selections.map((selection) =>
        selection.addonId === addonId ? update(selection) : selection,
      ),
    );
  };

  return (
    <div
      id={controlId}
      aria-describedby={describedBy}
      className="mt-2 space-y-3"
    >
      {model ? (
        <>
          {modelCompatibleAddons.length > 0 ? (
            <div className="relative">
              <Input
                value={query}
                aria-label="Search compatible assets"
                placeholder="Search assets"
                disabled={disabled}
                onChange={(event) => setQuery(event.target.value)}
                className={cn(
                  FIELD_CONTROL_CLASS,
                  selections.length > 0 && "pr-24",
                )}
              />
              {selections.length > 0 ? (
                <div className="absolute inset-y-0 right-2 flex items-center gap-1.5 text-[9px] text-slate-400">
                  <span>{selections.length} selected</span>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onChange([])}
                    className="rounded px-1 py-0.5 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
                  >
                    Clear
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {compatibleAddons.length > 0 ? (
            <div className="grid grid-cols-2 gap-2">
              {compatibleAddons.map((addon) => {
                const selection = selectedById.get(addon.id);
                const capability = model.addonCapabilities.find(
                  (candidate) => candidate.kind === addon.kind,
                );
                const activeKindCount = selections.filter(
                  (candidate) =>
                    candidate.enabled && candidate.kind === addon.kind,
                ).length;
                const atCapacity =
                  !selection &&
                  capability !== undefined &&
                  activeKindCount >= capability.maxActive;
                return (
                  <article
                    key={addon.id}
                    className={cn(
                      "relative isolate overflow-hidden rounded-xl border transition-colors",
                      selection
                        ? "border-sky-400 bg-sky-400/10"
                        : "border-slate-800 bg-slate-900/60 hover:border-slate-600",
                      (disabled || atCapacity) && "opacity-45",
                    )}
                  >
                    <button
                      type="button"
                      aria-label={addon.displayName}
                      aria-pressed={selection !== undefined}
                      disabled={disabled || atCapacity}
                      onClick={() =>
                        onChange(
                          selection
                            ? selections.filter(
                                (candidate) => candidate.addonId !== addon.id,
                              )
                            : [
                                ...selections,
                                createMediaModelAddonSelection(addon),
                              ],
                        )
                      }
                      className="block w-full overflow-hidden rounded-xl text-left disabled:cursor-not-allowed"
                    >
                      <MediaResourcePreview
                        resourceId={addon.id}
                        metadata={metadata}
                        assets={assets}
                        className="aspect-[4/3] w-full"
                      />
                      <span className="flex items-center gap-2 p-2">
                        <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-slate-200">
                          {addon.displayName}
                        </span>
                        {selection ? (
                          <Check className="h-3.5 w-3.5 text-sky-300" />
                        ) : null}
                      </span>
                    </button>
                    {selection ? (
                      <div className="absolute inset-x-2 top-2 z-10 max-h-[calc(100%-1rem)] overflow-y-auto rounded-lg border border-sky-300/30 bg-slate-950/92 p-2 shadow-xl backdrop-blur">
                        <div className="flex items-center gap-1.5">
                          {selection.kind === "lora" ? (
                            <MediaLoraStrengthControl
                              label={addon.displayName}
                              value={selection.modelStrength}
                              disabled={disabled}
                              onChange={(modelStrength) =>
                                updateSelection(selection.addonId, (current) =>
                                  current.kind === "lora"
                                    ? { ...current, modelStrength }
                                    : current,
                                )
                              }
                            />
                          ) : (
                            <select
                              aria-label={`${addon.displayName} placement`}
                              value={selection.placement}
                              disabled={disabled}
                              onChange={(event) =>
                                updateSelection(selection.addonId, (current) =>
                                  current.kind === "textual-inversion"
                                    ? {
                                        ...current,
                                        placement: event.target.value as
                                          | "positive"
                                          | "negative"
                                          | "both",
                                      }
                                    : current,
                                )
                              }
                              className="h-7 min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-1.5 text-[9px] text-slate-200"
                            >
                              <option value="positive">Positive</option>
                              <option value="negative">Negative</option>
                              <option value="both">Both</option>
                            </select>
                          )}
                          {selection.kind === "lora" &&
                          (capability?.supportsSeparateComponentStrengths ||
                            capability?.supportsDenoisingSchedules) ? (
                            <button
                              type="button"
                              aria-label={`Adjust ${addon.displayName}`}
                              aria-expanded={openControlsId === addon.id}
                              disabled={disabled}
                              onClick={() =>
                                setOpenControlsId((current) =>
                                  current === addon.id ? null : addon.id,
                                )
                              }
                              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
                            >
                              <ChevronDown
                                className={cn(
                                  "h-3.5 w-3.5 transition-transform",
                                  openControlsId === addon.id && "rotate-180",
                                )}
                              />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            aria-label={`Remove ${addon.displayName}`}
                            disabled={disabled}
                            onClick={() =>
                              onChange(
                                selections.filter(
                                  (candidate) =>
                                    candidate.addonId !== selection.addonId,
                                ),
                              )
                            }
                            className="rounded p-1 text-slate-400 hover:bg-rose-400/10 hover:text-rose-200 disabled:opacity-50"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {selection.kind === "textual-inversion" ? (
                          <Input
                            value={selection.token}
                            aria-label={`${addon.displayName} token`}
                            disabled={disabled}
                            onChange={(event) =>
                              updateSelection(selection.addonId, (current) =>
                                current.kind === "textual-inversion"
                                  ? { ...current, token: event.target.value }
                                  : current,
                              )
                            }
                            className="mt-2 h-7 text-[9px]"
                          />
                        ) : null}
                        {selection.kind === "lora" &&
                        openControlsId === addon.id ? (
                          <div className="mt-2 space-y-2 border-t border-slate-800 pt-2 text-[9px] text-slate-300">
                            {capability?.supportsSeparateComponentStrengths ? (
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={
                                    selection.textEncoderStrength !== null
                                  }
                                  disabled={disabled}
                                  onChange={(event) =>
                                    updateSelection(
                                      selection.addonId,
                                      (current) =>
                                        current.kind === "lora"
                                          ? {
                                              ...current,
                                              textEncoderStrength: event.target
                                                .checked
                                                ? current.modelStrength
                                                : null,
                                            }
                                          : current,
                                    )
                                  }
                                />
                                Text strength
                              </label>
                            ) : null}
                            {selection.textEncoderStrength !== null ? (
                              <label className="block">
                                <span className="mb-1 flex justify-between">
                                  <span>Text</span>
                                  <span>
                                    {selection.textEncoderStrength.toFixed(2)}
                                  </span>
                                </span>
                                <input
                                  type="range"
                                  min={-2}
                                  max={2}
                                  step={0.05}
                                  value={selection.textEncoderStrength}
                                  disabled={disabled}
                                  onChange={(event) =>
                                    updateSelection(
                                      selection.addonId,
                                      (current) =>
                                        current.kind === "lora"
                                          ? {
                                              ...current,
                                              textEncoderStrength: Number(
                                                event.target.value,
                                              ),
                                            }
                                          : current,
                                    )
                                  }
                                  className="block w-full accent-sky-400"
                                />
                              </label>
                            ) : null}
                            {capability?.supportsDenoisingSchedules ? (
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={selection.denoisingSchedule !== null}
                                  disabled={disabled}
                                  onChange={(event) =>
                                    updateSelection(
                                      selection.addonId,
                                      (current) =>
                                        current.kind === "lora"
                                          ? {
                                              ...current,
                                              denoisingSchedule: event.target
                                                .checked
                                                ? { start: 0, end: 1 }
                                                : null,
                                            }
                                          : current,
                                    )
                                  }
                                />
                                Denoising window
                              </label>
                            ) : null}
                            {selection.denoisingSchedule ? (
                              <div className="grid grid-cols-2 gap-2">
                                {(["start", "end"] as const).map((key) => (
                                  <label key={key}>
                                    <span className="capitalize">{key}</span>
                                    <input
                                      type="number"
                                      min={
                                        key === "start"
                                          ? 0
                                          : selection.denoisingSchedule!.start +
                                            0.05
                                      }
                                      max={
                                        key === "start"
                                          ? selection.denoisingSchedule!.end -
                                            0.05
                                          : 1
                                      }
                                      step={0.05}
                                      value={selection.denoisingSchedule![key]}
                                      disabled={disabled}
                                      onChange={(event) =>
                                        updateSelection(
                                          selection.addonId,
                                          (current) =>
                                            current.kind === "lora" &&
                                            current.denoisingSchedule
                                              ? {
                                                  ...current,
                                                  denoisingSchedule: {
                                                    ...current.denoisingSchedule,
                                                    [key]: Number(
                                                      event.target.value,
                                                    ),
                                                  },
                                                }
                                              : current,
                                        )
                                      }
                                      className="mt-1 h-7 w-full rounded border border-slate-700 bg-slate-950 px-1.5"
                                    />
                                  </label>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-800 px-3 py-4 text-center text-[10px] text-slate-500">
              {normalizedQuery ? "No matching assets" : "No compatible assets"}
            </div>
          )}
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-800 px-3 py-4 text-center text-[10px] text-slate-500">
          Choose a model first
        </div>
      )}

      {missingTriggers.map(({ addon, trigger }) => (
        <div
          key={addon.id}
          className="flex items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-400/5 px-2.5 py-2"
        >
          <CircleAlert className="h-3.5 w-3.5 shrink-0 text-amber-300" />
          <span className="min-w-0 flex-1 text-[9px] text-amber-100">
            {addon.displayName} needs a trigger word
          </span>
          {onPromptChange ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onPromptChange(
                  prompt.trim() ? `${prompt.trim()}, ${trigger}` : trigger,
                )
              }
              className="shrink-0 text-[9px] font-medium text-amber-200 hover:text-amber-100 disabled:opacity-50"
            >
              Add {trigger}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
};

const NodeFieldEditor = ({
  node,
  field,
  models,
  addons,
  assets,
  assetMetadata,
  maskAsset,
  resolvedModel,
  requiredModelCapabilities,
  requiredReferenceRoles,
  generationPrompt,
  referenceRoleValues,
  onGenerationPromptChange,
  variables,
  issue,
  onChange,
  onPatch,
}: {
  node: MediaFlowNode;
  field: MediaNodeFieldDefinition;
  models: readonly MediaModelDescriptor[];
  addons: readonly MediaModelAddonDescriptor[];
  assets: readonly MediaAssetRecord[];
  assetMetadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  maskAsset: MediaAssetRecord | null;
  resolvedModel: MediaModelDescriptor | null;
  requiredModelCapabilities: readonly MediaCapability[];
  requiredReferenceRoles: readonly MediaImageReferenceRole[];
  generationPrompt: string;
  referenceRoleValues: readonly string[] | null;
  onGenerationPromptChange: ((prompt: string) => void) | null;
  variables: MediaFlow["variables"];
  issue: MediaNodeValidationIssue | null;
  onChange: (fieldId: string, value: unknown) => void;
  onPatch?: (values: Readonly<Record<string, unknown>>) => void;
}): JSX.Element => {
  const controlId = `media-node-${node.id}-${field.id}`;
  const descriptionId = `${controlId}-description`;
  const issueId = `${controlId}-issue`;
  const value = node.config[field.id];
  const variableTokenId =
    typeof value === "string"
      ? (value.match(/^\{\{([a-z][a-z0-9_-]{0,63})\}\}$/u)?.[1] ?? null)
      : null;
  const compatibleVariableTypes =
    field.kind === "number"
      ? new Set(["number"])
      : field.kind === "boolean"
        ? new Set(["boolean"])
        : field.kind === "text" ||
            field.kind === "textarea" ||
            field.kind === "select"
          ? new Set(["text", "choice"])
          : new Set<string>();
  const compatibleVariables = variables.filter((variable) =>
    compatibleVariableTypes.has(variable.type),
  );
  const boundVariable = variableTokenId
    ? (variables.find((variable) => variable.id === variableTokenId) ?? null)
    : null;
  const selectedOption = field.options?.find(
    (candidate) => candidate.value === value,
  );
  const compatibleModels = listSelectableMediaModels(models, {
    requiredCapabilities: requiredModelCapabilities,
  }).filter((model) =>
    requiredReferenceRoles.every((role) =>
      mediaModelSupportsReferenceRole(model, role),
    ),
  );
  const subjectCutoutModels = listSelectableMediaModels(models, {
    requiredCapabilities: ["background-remove"],
  });
  const modelPriority =
    field.kind === "model-priority"
      ? readSubjectCutoutModelPriority(node.config)
      : [];
  const currentModelId = typeof value === "string" ? value : null;
  const selectedModel =
    compatibleModels.find((model) => model.id === currentModelId) ??
    compatibleModels.find((model) => model.id === resolvedModel?.id) ??
    null;
  const currentModelIsMissing =
    currentModelId !== null &&
    !compatibleModels.some((model) => model.id === currentModelId);
  const imageAssets = assets.filter((asset) => asset.kind === "image");
  const currentAssetId = typeof value === "string" ? value : "";
  const currentAsset =
    imageAssets.find((asset) => asset.id === currentAssetId) ?? null;
  const describedBy = issue ? `${descriptionId} ${issueId}` : descriptionId;

  let control: JSX.Element;
  switch (field.kind) {
    case "textarea":
      control = (
        <Textarea
          id={controlId}
          value={typeof value === "string" ? value : ""}
          maxLength={field.maxLength}
          disabled={field.readOnly}
          aria-invalid={issue !== null}
          aria-describedby={describedBy}
          onChange={(event) => onChange(field.id, event.target.value)}
          onBlur={(event) => {
            if (
              field.id !== "prompt" &&
              field.id !== "negativePrompt" &&
              field.id !== "instructions"
            ) {
              return;
            }
            const normalizedValue = normalizeMediaSubmissionText(
              event.target.value,
              field.maxLength ?? 8_000,
            );
            if (normalizedValue !== event.target.value) {
              onChange(field.id, normalizedValue);
            }
          }}
          className={cn(FIELD_CONTROL_CLASS, "min-h-24 resize-y leading-5")}
        />
      );
      break;
    case "text":
      control = (
        <Input
          id={controlId}
          value={typeof value === "string" ? value : ""}
          maxLength={field.maxLength}
          disabled={field.readOnly}
          aria-invalid={issue !== null}
          aria-describedby={describedBy}
          onChange={(event) => onChange(field.id, event.target.value)}
          className={FIELD_CONTROL_CLASS}
        />
      );
      break;
    case "asset":
      control = (
        <MediaAssetPicker
          controlId={controlId}
          fieldLabel={field.label}
          currentAssetId={currentAssetId}
          currentAsset={currentAsset}
          imageAssets={imageAssets}
          disabled={field.readOnly === true}
          invalid={issue !== null}
          describedBy={describedBy}
          onChange={(assetId) => onChange(field.id, assetId)}
        />
      );
      break;
    case "mask":
      control = maskAsset ? (
        <MediaImageMaskEditor
          asset={maskAsset}
          value={normalizeMediaImageMask(value)}
          onChange={(mask) => onChange(field.id, mask)}
          className="mt-2"
        />
      ) : (
        <></>
      );
      break;
    case "number":
      control = (
        <Input
          id={controlId}
          type="number"
          value={typeof value === "number" ? value : ""}
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={field.readOnly}
          aria-invalid={issue !== null}
          aria-describedby={describedBy}
          onChange={(event) => {
            if (event.target.value !== "") {
              onChange(field.id, event.target.valueAsNumber);
            }
          }}
          className={FIELD_CONTROL_CLASS}
        />
      );
      break;
    case "boolean":
      control = (
        <button
          id={controlId}
          type="button"
          role="switch"
          aria-checked={value === true}
          aria-describedby={describedBy}
          disabled={field.readOnly}
          onClick={() => onChange(field.id, value !== true)}
          className={cn(
            "mt-2 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/30 disabled:cursor-not-allowed disabled:opacity-50",
            value === true
              ? "border-emerald-400/30 bg-emerald-400/8 text-emerald-100"
              : "border-slate-700 bg-slate-950/65 text-slate-400",
          )}
        >
          <span>{value === true ? "Enabled" : "Disabled"}</span>
          <span
            aria-hidden="true"
            className={cn(
              "relative h-5 w-9 rounded-full transition-colors",
              value === true ? "bg-emerald-400/45" : "bg-slate-700",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform",
                value === true ? "translate-x-[18px]" : "translate-x-0.5",
              )}
            />
          </span>
        </button>
      );
      break;
    case "addons": {
      control = (
        <ModelAddonPicker
          controlId={controlId}
          model={selectedModel}
          addons={addons}
          assets={assets}
          metadata={assetMetadata}
          value={value}
          prompt={generationPrompt}
          disabled={field.readOnly === true}
          describedBy={describedBy}
          onChange={(selections) => onChange(field.id, selections)}
          onPromptChange={onGenerationPromptChange}
        />
      );
      break;
    }
    case "model-priority": {
      const unselectedModel = subjectCutoutModels.find(
        (model) => !modelPriority.includes(model.id),
      );
      control = (
        <div
          id={controlId}
          aria-describedby={describedBy}
          className="mt-2 space-y-2"
        >
          {modelPriority.map((modelId, index) => {
            const isMissing = !subjectCutoutModels.some(
              (model) => model.id === modelId,
            );
            return (
              <div
                key={`${modelId}-${index}`}
                className="rounded-lg border border-slate-700 bg-slate-950/65 p-2"
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-700 text-[9px] text-slate-400">
                    {index + 1}
                  </span>
                  <MediaModelPicker
                    models={subjectCutoutModels}
                    value={modelId}
                    assets={assets}
                    metadata={assetMetadata}
                    disabled={field.readOnly}
                    compact
                    onChange={(nextModelId) => {
                      if (!nextModelId) return;
                      const nextPriority = [...modelPriority];
                      const duplicateIndex = nextPriority.indexOf(nextModelId);
                      if (duplicateIndex >= 0 && duplicateIndex !== index) {
                        [nextPriority[index], nextPriority[duplicateIndex]] = [
                          nextPriority[duplicateIndex]!,
                          nextPriority[index]!,
                        ];
                      } else {
                        nextPriority[index] = nextModelId;
                      }
                      onChange(field.id, nextPriority);
                    }}
                    className="min-w-0 flex-1 rounded-md bg-slate-950 text-[10px]"
                  />
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      disabled={field.readOnly || index === 0}
                      aria-label={`Move ${subjectCutoutModelLabel(modelId)} up`}
                      onClick={() => {
                        const nextPriority = [...modelPriority];
                        [nextPriority[index - 1], nextPriority[index]] = [
                          nextPriority[index]!,
                          nextPriority[index - 1]!,
                        ];
                        onChange(field.id, nextPriority);
                      }}
                      className="h-7 w-7 rounded border border-slate-700 text-[11px] text-slate-400 hover:bg-slate-800 disabled:opacity-30"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={
                        field.readOnly || index === modelPriority.length - 1
                      }
                      aria-label={`Move ${subjectCutoutModelLabel(modelId)} down`}
                      onClick={() => {
                        const nextPriority = [...modelPriority];
                        [nextPriority[index], nextPriority[index + 1]] = [
                          nextPriority[index + 1]!,
                          nextPriority[index]!,
                        ];
                        onChange(field.id, nextPriority);
                      }}
                      className="h-7 w-7 rounded border border-slate-700 text-[11px] text-slate-400 hover:bg-slate-800 disabled:opacity-30"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      disabled={field.readOnly || modelPriority.length === 1}
                      aria-label={`Remove ${subjectCutoutModelLabel(modelId)} fallback policy entry`}
                      onClick={() =>
                        onChange(
                          field.id,
                          modelPriority.filter(
                            (_, candidateIndex) => candidateIndex !== index,
                          ),
                        )
                      }
                      className="h-7 w-7 rounded border border-slate-700 text-[11px] text-slate-400 hover:border-rose-400/30 hover:bg-rose-400/10 hover:text-rose-200 disabled:opacity-30"
                    >
                      ×
                    </button>
                  </div>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2 pl-7 text-[9px]">
                  <span className="text-slate-500">
                    {index === 0 ? "Primary" : `Fallback ${index}`}
                  </span>
                  <span
                    className={
                      isMissing ? "text-amber-300" : "text-emerald-300"
                    }
                  >
                    {isMissing ? "Choose available model" : "Ready"}
                  </span>
                </div>
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={field.readOnly || !unselectedModel}
            onClick={() => {
              if (unselectedModel) {
                onChange(field.id, [...modelPriority, unselectedModel.id]);
              }
            }}
            className="h-8 w-full border-slate-700 text-[10px] text-slate-300 hover:bg-slate-800"
          >
            <Plus className="h-3 w-3" /> Add fallback
          </Button>
        </div>
      );
      break;
    }
    case "model":
      control = (
        <div className="mt-2">
          <MediaModelPicker
            id={controlId}
            models={compatibleModels}
            value={currentModelId}
            assets={assets}
            metadata={assetMetadata}
            disabled={field.readOnly}
            invalid={issue !== null}
            describedBy={describedBy}
            automaticLabel="Automatic compatible model"
            onChange={(modelId) => {
              if (Array.isArray(node.config.modelAddons) && onPatch) {
                onPatch({ modelId, modelAddons: [] });
              } else {
                onChange(field.id, modelId);
              }
            }}
            className="w-full rounded-md"
          />
          {currentModelIsMissing ? (
            <p className="mt-1 text-[10px] text-amber-300">
              Choose an available model.
            </p>
          ) : null}
        </div>
      );
      break;
    case "select":
      const options =
        field.id === "referenceRole" && referenceRoleValues
          ? field.options?.filter((candidate) =>
              referenceRoleValues.includes(candidate.value),
            )
          : field.options;
      control = (
        <select
          id={controlId}
          value={typeof value === "string" ? value : ""}
          disabled={field.readOnly}
          aria-invalid={issue !== null}
          aria-describedby={describedBy}
          onChange={(event) => onChange(field.id, event.target.value)}
          className={cn(
            FIELD_CONTROL_CLASS,
            "h-9 w-full rounded-md border px-3",
          )}
        >
          {options?.map((candidate) => (
            <option key={candidate.value} value={candidate.value}>
              {candidate.label}
            </option>
          ))}
        </select>
      );
      break;
  }

  if (boundVariable) {
    control = (
      <div className="mt-2 flex items-center justify-between gap-3 rounded-lg border border-cyan-400/25 bg-cyan-400/5 px-3 py-2">
        <code className="min-w-0 truncate text-[10px] text-cyan-200">{`{{${boundVariable.id}}}`}</code>
        <Badge
          variant="outline"
          className="border-cyan-400/20 text-[8px] capitalize text-cyan-300"
        >
          {boundVariable.type}
        </Badge>
      </div>
    );
  }

  return (
    <div className="py-1">
      <div className="flex items-center justify-between gap-2">
        <label
          id={`${controlId}-label`}
          htmlFor={controlId}
          className="text-[11px] font-medium text-slate-200"
        >
          {field.label}
        </label>
        {field.readOnly ? (
          <span className="text-[9px] font-medium tracking-wide text-cyan-400/70 uppercase">
            Synchronized
          </span>
        ) : compatibleVariables.length > 0 || variableTokenId ? (
          <select
            aria-label={`Variable binding for ${field.label}`}
            value={variableTokenId ?? ""}
            onChange={(event) =>
              onChange(
                field.id,
                event.target.value
                  ? `{{${event.target.value}}}`
                  : field.defaultValue,
              )
            }
            className="h-6 max-w-32 rounded border border-cyan-400/20 bg-slate-950 px-1.5 text-[8px] text-cyan-300 outline-none focus:border-cyan-400/50"
          >
            <option value="">Direct value</option>
            {variableTokenId && !boundVariable ? (
              <option value={variableTokenId}>
                Missing · {variableTokenId}
              </option>
            ) : null}
            {compatibleVariables.map((variable) => (
              <option key={variable.id} value={variable.id}>
                {variable.name}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {control}
      <p id={descriptionId} className="sr-only">
        {selectedOption?.description ?? field.description}
      </p>
      {issue ? (
        <p
          id={issueId}
          role="alert"
          className="mt-2 text-[10px] leading-4 text-rose-300"
        >
          {issue.message}
        </p>
      ) : null}
    </div>
  );
};

const NODE_CATEGORIES = [
  "Input",
  "Generation",
  "Transform",
  "Quality",
  "Control",
  "Output",
] as const;

const NodePalettePanel = ({
  flow,
  onAdd,
  onClose,
}: {
  flow: MediaFlow;
  onAdd: (nodeType: MediaNodeType) => void;
  onClose: () => void;
}): JSX.Element => {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const definitions = listMediaNodeDefinitions().filter((definition) => {
    if (!normalizedQuery) return true;
    return [
      definition.displayName,
      definition.type,
      definition.summary,
      definition.category,
      ...definition.inputs.map((port) => port.dataType),
      ...definition.outputs.map((port) => port.dataType),
    ]
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });

  return (
    <aside
      aria-label="Node palette"
      className="absolute inset-y-0 right-0 z-20 min-h-0 w-[min(390px,calc(100%-2rem))] overflow-y-auto border-l border-slate-800/80 bg-slate-950/95 p-5 shadow-2xl xl:static xl:w-auto xl:bg-slate-950/90 xl:shadow-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Plus className="h-4 w-4 text-cyan-300" />
            Add node
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close node palette"
          onClick={onClose}
          className="text-slate-500 hover:bg-slate-800 hover:text-slate-200"
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </Button>
      </div>

      <SearchField
        autoFocus
        value={query}
        aria-label="Search node palette"
        placeholder="Search nodes, ports, or types"
        onChange={(event) => setQuery(event.target.value)}
        containerClassName="mt-4"
        iconClassName="size-3.5 text-slate-600"
        className="border-slate-700 bg-slate-900/60 text-xs text-slate-100 placeholder:text-slate-600"
      />

      {definitions.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No installed node matches."
          description="Search uses names, stable types, categories, and typed ports."
          size="compact"
          role="status"
          className="mt-5"
        />
      ) : (
        <div className="mt-5 space-y-5">
          {NODE_CATEGORIES.map((category) => {
            const categoryDefinitions = definitions.filter(
              (definition) => definition.category === category,
            );
            if (categoryDefinitions.length === 0) return null;
            return (
              <section
                key={category}
                aria-labelledby={`node-category-${category}`}
              >
                <h3
                  id={`node-category-${category}`}
                  className="text-[9px] font-bold tracking-[0.15em] text-slate-600 uppercase"
                >
                  {category}
                </h3>
                <div className="mt-2 space-y-2">
                  {categoryDefinitions.map((definition) => {
                    const existingCount = flow.nodes.filter(
                      (node) => node.type === definition.type,
                    ).length;
                    const atLimit =
                      definition.maxInstances !== undefined &&
                      existingCount >= definition.maxInstances;
                    return (
                      <button
                        key={definition.type}
                        type="button"
                        disabled={atLimit}
                        aria-label={`Add ${definition.displayName}`}
                        onClick={() => onAdd(definition.type)}
                        className="w-full rounded-xl border border-slate-800 bg-slate-900/35 p-3 text-left transition-colors hover:border-cyan-400/25 hover:bg-cyan-400/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/30 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        <span className="flex items-start justify-between gap-3">
                          <span className="block text-xs font-medium text-slate-200">
                            {definition.displayName}
                          </span>
                          {atLimit ? (
                            <Badge
                              variant="outline"
                              className="border-slate-700 text-[8px] text-slate-500"
                            >
                              Added
                            </Badge>
                          ) : null}
                        </span>
                        <span className="mt-2 block text-[10px] leading-4 text-slate-500">
                          {definition.summary}
                        </span>
                        <span className="mt-2 flex flex-wrap gap-1">
                          {[
                            ...definition.inputs.map((port) => ({
                              direction: "input",
                              port,
                            })),
                            ...definition.outputs.map((port) => ({
                              direction: "output",
                              port,
                            })),
                          ].map(({ direction, port }) => (
                            <span
                              key={`${direction}-${port.id}-${port.dataType}`}
                              className="flex items-center gap-1 rounded border border-slate-800 bg-slate-950/60 px-1.5 py-0.5 text-[8px] text-slate-500"
                            >
                              <FlowPortDot
                                aria-hidden="true"
                                tone={PORT_TONES[port.dataType]}
                                className="h-1.5 w-1.5"
                              />
                              {direction === "input" ? "In" : "Out"} ·{" "}
                              {PORT_LABELS[port.dataType]}
                            </span>
                          ))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </aside>
  );
};

const VisualGroupEditor = ({
  group,
  nodeLabels,
  onChange,
  onRemove,
}: {
  group: MediaFlowLayout["groups"][number];
  nodeLabels: ReadonlyMap<string, string>;
  onChange: (
    groupId: string,
    change: {
      label?: string;
      color?: MediaFlowGroupColor;
      collapsed?: boolean;
    },
  ) => void;
  onRemove: (groupId: string) => void;
}): JSX.Element => {
  const [draftLabel, setDraftLabel] = useState(group.label);
  useEffect(() => setDraftLabel(group.label), [group.label]);

  const commitLabel = (): void => {
    const label = draftLabel.trim();
    if (!label) {
      setDraftLabel(group.label);
      return;
    }
    if (label !== group.label) onChange(group.id, { label });
  };

  return (
    <article className={cn("rounded-xl border p-3", GROUP_STYLES[group.color])}>
      <div className="flex items-center gap-2">
        <Group className="h-3.5 w-3.5 shrink-0" />
        <Input
          value={draftLabel}
          maxLength={80}
          aria-label={`Rename ${group.label}`}
          onChange={(event) => setDraftLabel(event.target.value)}
          onBlur={commitLabel}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setDraftLabel(group.label);
              event.currentTarget.blur();
            }
          }}
          className="h-7 min-w-0 border-current/15 bg-slate-950/45 px-2 text-[10px] text-current"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${group.label} group`}
          title="Remove visual group; nodes remain unchanged"
          onClick={() => onRemove(group.id)}
          className="shrink-0 text-current opacity-60 hover:bg-slate-950/40 hover:opacity-100"
        >
          <Ungroup className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
        <label className="text-[9px] opacity-65">
          Color
          <select
            value={group.color}
            aria-label={`Color for ${group.label}`}
            onChange={(event) =>
              onChange(group.id, {
                color: event.target.value as MediaFlowGroupColor,
              })
            }
            className="mt-1 h-7 w-full rounded-md border border-current/15 bg-slate-950/65 px-2 text-[10px] text-current outline-none"
          >
            {(["slate", "cyan", "violet", "amber", "emerald"] as const).map(
              (color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ),
            )}
          </select>
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={group.collapsed}
          onClick={() => onChange(group.id, { collapsed: !group.collapsed })}
          className="mt-4 h-7 border-current/15 bg-slate-950/40 px-2 text-[9px] text-current hover:bg-slate-950/65"
        >
          {group.collapsed ? "Expand" : "Collapse"}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {group.nodeIds.map((nodeId) => (
          <span
            key={nodeId}
            className="rounded border border-current/10 bg-slate-950/30 px-1.5 py-0.5 text-[8px] opacity-65"
          >
            {nodeLabels.get(nodeId) ?? nodeId}
          </span>
        ))}
      </div>
    </article>
  );
};

const CanvasCommentEditor = ({
  comment,
  onChange,
  onRemove,
}: {
  comment: MediaFlowLayoutComment;
  onChange: (
    commentId: string,
    change: Partial<
      Pick<MediaFlowLayoutComment, "body" | "color" | "width" | "height">
    >,
  ) => void;
  onRemove: (commentId: string) => void;
}): JSX.Element => {
  const [draftBody, setDraftBody] = useState(comment.body);
  useEffect(() => setDraftBody(comment.body), [comment.body]);

  const commitBody = (): void => {
    const body = draftBody.trim();
    if (!body) {
      setDraftBody(comment.body);
      return;
    }
    if (body !== comment.body) onChange(comment.id, { body });
  };

  return (
    <article
      className={cn("rounded-xl border p-3", GROUP_STYLES[comment.color])}
    >
      <div className="flex items-start gap-2">
        <StickyNote className="mt-1 h-3.5 w-3.5 shrink-0" />
        <Textarea
          value={draftBody}
          maxLength={1_000}
          aria-label={`Edit comment ${comment.id}`}
          onChange={(event) => setDraftBody(event.target.value)}
          onBlur={commitBody}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              setDraftBody(comment.body);
              event.currentTarget.blur();
            }
          }}
          className="min-h-20 min-w-0 resize-y border-current/15 bg-slate-950/45 px-2 py-1.5 text-[10px] leading-4 text-current"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove comment ${comment.id}`}
          onClick={() => onRemove(comment.id)}
          className="shrink-0 text-current opacity-60 hover:bg-slate-950/40 hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-[9px] opacity-65">
          Color
          <select
            value={comment.color}
            aria-label={`Color for comment ${comment.id}`}
            onChange={(event) =>
              onChange(comment.id, {
                color: event.target.value as MediaFlowGroupColor,
              })
            }
            className="mt-1 h-7 w-full rounded-md border border-current/15 bg-slate-950/65 px-2 text-[10px] text-current outline-none"
          >
            {(["slate", "cyan", "violet", "amber", "emerald"] as const).map(
              (color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="text-[9px] opacity-65">
          Card size
          <select
            value={`${comment.width}x${comment.height}`}
            aria-label={`Size for comment ${comment.id}`}
            onChange={(event) => {
              const [width, height] = event.target.value.split("x").map(Number);
              onChange(comment.id, { width, height });
            }}
            className="mt-1 h-7 w-full rounded-md border border-current/15 bg-slate-950/65 px-2 text-[10px] text-current outline-none"
          >
            <option value="240x120">Compact</option>
            <option value="320x180">Standard</option>
            <option value="420x260">Large</option>
          </select>
        </label>
      </div>
      <p className="mt-2 text-[8px] opacity-45">
        Ctrl+Enter saves · drag the card to position it
      </p>
    </article>
  );
};

const VisualGroupsPanel = ({
  flow,
  layout,
  onChange,
  onClose,
}: {
  flow: MediaFlow;
  layout: MediaFlowLayout;
  onChange: (layout: MediaFlowLayout) => void;
  onClose: () => void;
}): JSX.Element => {
  const nodeLabels = new Map(flow.nodes.map((node) => [node.id, node.label]));
  return (
    <aside
      aria-label="Canvas organization"
      className="absolute inset-y-0 right-0 z-20 min-h-0 w-[min(360px,calc(100%-2rem))] overflow-y-auto border-l border-slate-800/80 bg-slate-950/95 p-5 shadow-2xl xl:static xl:w-auto xl:bg-slate-950/90 xl:shadow-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <LayoutDashboard className="h-4 w-4 text-cyan-300" />
            Canvas organization
          </div>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">
            Layout-only groups and comments are revisioned but never affect
            execution.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close canvas organization"
          onClick={onClose}
          className="text-slate-500 hover:bg-slate-800 hover:text-slate-200"
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </Button>
      </div>
      <section className="mt-5" aria-labelledby="visual-groups-heading">
        <h3
          id="visual-groups-heading"
          className="text-[10px] font-bold tracking-[0.14em] text-slate-600 uppercase"
        >
          Groups · {layout.groups.length}
        </h3>
        <div className="mt-2 space-y-3">
          {layout.groups.length > 0 ? (
            layout.groups.map((group) => (
              <VisualGroupEditor
                key={group.id}
                group={group}
                nodeLabels={nodeLabels}
                onChange={(groupId, change) =>
                  onChange(
                    updateMediaFlowLayoutGroup({ layout, groupId, ...change }),
                  )
                }
                onRemove={(groupId) =>
                  onChange(removeMediaFlowLayoutGroup(layout, groupId))
                }
              />
            ))
          ) : (
            <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/20 p-5 text-center">
              <Group className="mx-auto h-5 w-5 text-slate-700" />
              <p className="mt-2 text-xs font-medium text-slate-400">
                No visual groups
              </p>
              <p className="mt-1 text-[10px] leading-4 text-slate-600">
                Select at least two nodes on the canvas, then choose Group
                selected nodes.
              </p>
            </div>
          )}
        </div>
      </section>
      <section className="mt-6" aria-labelledby="canvas-comments-heading">
        <div className="flex items-center justify-between gap-3">
          <h3
            id="canvas-comments-heading"
            className="text-[10px] font-bold tracking-[0.14em] text-slate-600 uppercase"
          >
            Comments · {layout.comments.length}
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={layout.comments.length >= 64}
            onClick={() =>
              onChange(addMediaFlowLayoutComment({ layout }).layout)
            }
            className="h-7 border-amber-400/20 bg-amber-400/5 px-2 text-[9px] text-amber-200 hover:bg-amber-400/10"
          >
            <MessageSquarePlus className="h-3 w-3" /> Add comment
          </Button>
        </div>
        <div className="mt-2 space-y-3">
          {layout.comments.length > 0 ? (
            layout.comments.map((comment) => (
              <CanvasCommentEditor
                key={comment.id}
                comment={comment}
                onChange={(commentId, change) =>
                  onChange(
                    updateMediaFlowLayoutComment({
                      layout,
                      commentId,
                      ...change,
                    }),
                  )
                }
                onRemove={(commentId) =>
                  onChange(removeMediaFlowLayoutComment(layout, commentId))
                }
              />
            ))
          ) : (
            <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/20 p-4 text-center">
              <StickyNote className="mx-auto h-5 w-5 text-slate-700" />
              <p className="mt-2 text-[10px] leading-4 text-slate-600">
                Add review context, handoff notes, or creative direction
                directly to the canvas.
              </p>
            </div>
          )}
        </div>
      </section>
    </aside>
  );
};

const NodeSelectionPanel = ({
  flow,
  layout,
  selectedNodeIds,
  onChange,
  onClose,
}: {
  flow: MediaFlow;
  layout: MediaFlowLayout;
  selectedNodeIds: readonly string[];
  onChange: (nodeIds: readonly string[]) => void;
  onClose: () => void;
}): JSX.Element => {
  const selected = new Set(selectedNodeIds);
  const collapsed = new Set(
    layout.groups
      .filter((group) => group.collapsed)
      .flatMap((group) => group.nodeIds),
  );
  const groupByNodeId = new Map(
    layout.groups.flatMap((group) =>
      group.nodeIds.map((nodeId) => [nodeId, group.label] as const),
    ),
  );
  const visibleNodeIds = flow.nodes
    .filter((node) => !collapsed.has(node.id))
    .map((node) => node.id);

  return (
    <aside
      aria-label="Node selection"
      className="absolute inset-y-0 right-0 z-20 min-h-0 w-[min(360px,calc(100%-2rem))] overflow-y-auto border-l border-slate-800/80 bg-slate-950/95 p-5 shadow-2xl xl:static xl:w-auto xl:bg-slate-950/90 xl:shadow-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Box className="h-4 w-4 text-violet-300" />
            Node selection
          </div>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">
            Choose an exact semantic region for grouping or clipboard
            operations.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close node selection"
          onClick={onClose}
          className="text-slate-500 hover:bg-slate-800 hover:text-slate-200"
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mt-4 flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange(visibleNodeIds)}
          className="h-7 border-violet-400/20 bg-violet-400/5 px-2 text-[10px] text-violet-200"
        >
          Select visible
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={selectedNodeIds.length === 0}
          onClick={() => onChange([])}
          className="h-7 px-2 text-[10px] text-slate-400 hover:bg-slate-800"
        >
          Clear
        </Button>
      </div>
      <div className="mt-4 space-y-2">
        {flow.nodes.map((node) => {
          const hidden = collapsed.has(node.id);
          const groupLabel = groupByNodeId.get(node.id);
          return (
            <label
              key={node.id}
              className={cn(
                "flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/35 p-3",
                hidden && "opacity-45",
              )}
            >
              <input
                type="checkbox"
                checked={selected.has(node.id)}
                disabled={hidden}
                aria-label={`Select ${node.label}`}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(node.id);
                  else next.delete(node.id);
                  onChange([...next]);
                }}
                className="mt-0.5 h-3.5 w-3.5 accent-violet-400"
              />
              <span className="min-w-0">
                <span className="block break-words text-[11px] leading-4 font-medium text-slate-200">
                  {node.label}
                </span>
                <span className="mt-0.5 block truncate text-[9px] text-slate-600">
                  {node.type}
                  {groupLabel ? ` · ${groupLabel}` : ""}
                  {hidden ? " · hidden" : ""}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </aside>
  );
};

const VideoQualityPresetPanel = ({
  config,
  model,
  onApply,
}: {
  config: Record<string, unknown>;
  model: MediaModelDescriptor | null;
  onApply: (values: Readonly<Record<string, unknown>>) => void;
}): JSX.Element => {
  const architecture = model?.architecture;
  const unsupportedLoopReason =
    architecture === "hunyuan-video-1.5-i2v" && config.loopMode === "seamless"
      ? "Hunyuan is first-frame-only. Choose an endpoint-conditioned model for a forward seamless loop."
      : null;
  const activePreset = identifyMediaVideoQualityPreset(config, architecture);
  const activeDescription =
    MEDIA_VIDEO_QUALITY_PRESETS.find((preset) => preset.id === activePreset)
      ?.description ??
    "Custom settings preserve deliberate overrides. Choose a preset to replace temporal density, sampling, matte, encoding, and memory controls together.";
  const delivery = summarizeMediaVideoDelivery(config, architecture);
  const execution = resolveMediaVideoExecutionSettings(config, architecture);
  const frameContract = resolveMediaVideoFrameContract(architecture);
  const frameCountValid = isMediaVideoFrameCountValid(
    config.numFrames,
    architecture,
  );
  const durationFits = ([2, 3, 4] as const).map((targetSeconds) => ({
    targetSeconds,
    fit:
      typeof config.fps === "number" &&
      (config.loopMode === "none" ||
        config.loopMode === "ping-pong" ||
        config.loopMode === "seamless")
        ? fitMediaVideoDuration(
            targetSeconds,
            config.fps,
            config.loopMode,
            architecture,
          )
        : null,
  }));
  const smoothDurationFit =
    config.loopMode === "none" ||
    config.loopMode === "ping-pong" ||
    config.loopMode === "seamless"
      ? fitMediaVideoDuration(3, 24, config.loopMode, architecture)
      : null;
  return (
    <section
      aria-labelledby="video-quality-preset-heading"
      className="mt-4 rounded-xl border border-violet-400/20 bg-violet-400/5 p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h3
          id="video-quality-preset-heading"
          className="flex items-center gap-1.5 text-[10px] font-semibold text-violet-100"
        >
          <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
          Quality preset
        </h3>
        <span className="text-[9px] font-medium text-violet-300/70">
          {activePreset ?? "custom"}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1">
        {MEDIA_VIDEO_QUALITY_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            aria-pressed={activePreset === preset.id}
            title={preset.description}
            onClick={() =>
              onApply(
                resolveMediaVideoQualityPresetSettings(preset, architecture),
              )
            }
            className={cn(
              "rounded-lg border px-2 py-1.5 text-[9px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-violet-300/40",
              activePreset === preset.id
                ? "border-violet-300/40 bg-violet-300/15 text-violet-100"
                : "border-slate-800 bg-slate-950/55 text-slate-500 hover:border-violet-300/25 hover:text-slate-300",
            )}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[9px] leading-4 text-slate-500">
        {activeDescription}
      </p>
      {unsupportedLoopReason ? (
        <div
          role="alert"
          className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-amber-400/25 bg-amber-400/8 px-2.5 py-2 text-[9px] leading-4 text-amber-100/75"
        >
          <span>{unsupportedLoopReason}</span>
          <button
            type="button"
            onClick={() =>
              onApply({
                modelId: "local:wan2.2-ti2v-5b",
              })
            }
            className="shrink-0 rounded-md border border-amber-300/30 bg-amber-300/10 px-2 py-1 font-medium text-amber-100 outline-none hover:bg-amber-300/15 focus-visible:ring-2 focus-visible:ring-amber-300/40"
          >
            Use native loop model
          </button>
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[9px] font-medium text-slate-500">
          Fit playback:
        </span>
        {durationFits.map(({ targetSeconds, fit }) => (
          <button
            key={targetSeconds}
            type="button"
            disabled={fit === null}
            aria-pressed={
              fit !== null && config.numFrames === fit.sourceFrameCount
            }
            title={
              fit
                ? `${fit.sourceFrameCount} native source frames deliver ${fit.outputFrameCount} frames (${fit.durationSeconds.toFixed(2)} seconds)${fit.exact ? "" : ", the closest supported duration"}`
                : (unsupportedLoopReason ??
                  "Choose a valid frame rate and loop mode first")
            }
            onClick={() => {
              if (fit) onApply({ numFrames: fit.sourceFrameCount });
            }}
            className={cn(
              "rounded-md border px-2 py-1 text-[9px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-violet-300/40 disabled:cursor-not-allowed disabled:opacity-40",
              fit !== null && config.numFrames === fit.sourceFrameCount
                ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-200"
                : "border-slate-800 bg-slate-950/55 text-slate-500 hover:border-violet-300/25 hover:text-slate-300",
            )}
          >
            {targetSeconds}s
            {fit && !fit.exact ? ` ≈ ${fit.durationSeconds.toFixed(2)}s` : ""}
          </button>
        ))}
        {smoothDurationFit?.exact ? (
          <button
            type="button"
            aria-pressed={
              config.fps === 24 &&
              config.numFrames === smoothDurationFit.sourceFrameCount
            }
            title={`${smoothDurationFit.sourceFrameCount} native source frames deliver ${smoothDurationFit.outputFrameCount} frames in 3 seconds at 24 fps`}
            onClick={() =>
              onApply({
                fps: 24,
                numFrames: smoothDurationFit.sourceFrameCount,
              })
            }
            className={cn(
              "rounded-md border px-2 py-1 text-[9px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-violet-300/40",
              config.fps === 24 &&
                config.numFrames === smoothDurationFit.sourceFrameCount
                ? "border-sky-400/35 bg-sky-400/10 text-sky-200"
                : "border-slate-800 bg-slate-950/55 text-slate-500 hover:border-sky-300/25 hover:text-slate-300",
            )}
          >
            3s smooth · 24 fps
          </button>
        ) : null}
      </div>
      {model ? (
        <>
          <p className="mt-2 text-[9px] leading-4 text-violet-200/70">
            {model.displayName}: {execution.numInferenceSteps} sampling steps,{" "}
            {execution.guidanceScale} guidance
            {execution.modelManaged ? " (fixed distilled trajectory)" : ""}.
          </p>
          {architecture !== "wan-2.2-ti2v" ? (
            <p className="mt-1 text-[9px] leading-4 text-amber-200/70">
              This runtime has no separate negative-conditioning channel for the
              selected model. Put identity, anatomy, camera, and stability
              constraints directly in the Motion brief.
            </p>
          ) : null}
          <p
            className={cn(
              "mt-1 text-[9px] leading-4",
              frameCountValid ? "text-emerald-300/70" : "text-amber-300/80",
            )}
          >
            {String(config.numFrames)} source frames{" "}
            {frameCountValid ? "fit" : "do not fit"} the native{" "}
            {frameContract.minimum}–{frameContract.maximum},{" "}
            {frameContract.stride}k+1 contract.
          </p>
        </>
      ) : null}
      {delivery ? (
        <p className="mt-2 rounded-lg border border-slate-800/80 bg-slate-950/55 px-2.5 py-2 text-[9px] leading-4 text-slate-400">
          {delivery.width} x {delivery.height} / {delivery.outputFrameCount}{" "}
          delivered frame{delivery.outputFrameCount === 1 ? "" : "s"} /{" "}
          {delivery.durationSeconds.toFixed(2)}s at {delivery.fps} fps /{" "}
          {delivery.transparent ? "verified alpha" : "opaque"} /{" "}
          {delivery.loopMode === "ping-pong"
            ? "boomerang with reversed playback"
            : delivery.loopMode === "seamless"
              ? "forward seamless loop without a duplicate end frame"
              : "one-way"}{" "}
          /{" "}
          {delivery.encodingQuality === "lossless" && !delivery.transparent
            ? "full-range 4:4:4 lossless"
            : `${delivery.encodingQuality} 4:2:0`}
        </p>
      ) : null}
    </section>
  );
};

const VideoKeyframeReviewPanel = ({
  firstFrame,
  lastFrame,
  model,
}: {
  firstFrame: {
    connected: boolean;
    asset: MediaAssetRecord | null;
  };
  lastFrame: {
    connected: boolean;
    asset: MediaAssetRecord | null;
  };
  model: MediaModelDescriptor | null;
}): JSX.Element => {
  const nativeFirstFrameOnly = model?.architecture === "hunyuan-video-1.5-i2v";
  const reviewedAssetCount = new Set(
    [firstFrame.asset?.id, lastFrame.asset?.id].filter(
      (assetId): assetId is string => assetId !== undefined,
    ),
  ).size;
  return (
    <section
      aria-labelledby="video-keyframe-review-heading"
      className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3"
    >
      <div className="flex items-center justify-between gap-3">
        <h3
          id="video-keyframe-review-heading"
          className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-100"
        >
          <CircleAlert aria-hidden="true" className="h-3.5 w-3.5" />
          Keyframe gate
        </h3>
        <span className="text-[9px] font-medium text-amber-300/70">
          {firstFrame.connected && lastFrame.connected
            ? firstFrame.asset && lastFrame.asset
              ? `${reviewedAssetCount} reviewed asset${reviewedAssetCount === 1 ? "" : "s"}`
              : "runtime sources"
            : "incomplete"}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {[
          { label: "First frame", frame: firstFrame },
          { label: "Last frame", frame: lastFrame },
        ].map(({ label, frame }) => (
          <div
            key={label}
            className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950/55"
          >
            <div className="aspect-video bg-black/30">
              {frame.asset ? (
                <MediaAssetThumbnail
                  asset={frame.asset}
                  alt={`${label} quality review`}
                  className="object-contain"
                />
              ) : (
                <span className="flex h-full items-center justify-center px-2 text-center text-[9px] text-slate-600">
                  {frame.connected ? "Generated at run time" : "Not connected"}
                </span>
              )}
            </div>
            <div className="flex items-center justify-between gap-2 border-t border-slate-800 px-2 py-1.5">
              <span className="text-[9px] font-medium text-slate-400">
                {label}
              </span>
              {frame.asset ? (
                <span className="text-[8px] tabular-nums text-slate-600">
                  {frame.asset.width} x {frame.asset.height}
                </span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[9px] leading-4 text-slate-500">
        {nativeFirstFrameOnly
          ? "Hunyuan uses the first image as its native reference; the last port must mirror it for the single-reference flow contract."
          : "Both keys condition the generated motion."}{" "}
        Inspect face, hands, limb count, costume, and framing at full size
        before a quality run.
      </p>
      {firstFrame.asset &&
      lastFrame.asset &&
      firstFrame.asset.digest === lastFrame.asset.digest ? (
        <p className="mt-1.5 text-[9px] leading-4 text-emerald-300/75">
          {nativeFirstFrameOnly
            ? "Matching inputs satisfy the native first-frame contract; the ending remains model-authored."
            : "Matching endpoints close the cycle. If motion locks, try another seed or use two forward A→B and B→A legs."}
        </p>
      ) : null}
    </section>
  );
};

const NodeInspector = ({
  node,
  flow,
  plan,
  models,
  addons,
  assets,
  assetMetadata,
  onNodeConfigChange,
  onNodeConfigPatch,
  onNodeLabelChange,
  onConnectPorts,
  onDisconnectInput,
  onDisconnectConnection,
  onNodeCopy,
  onNodeRemove,
  onClose,
}: {
  node: MediaFlowNode;
  flow: MediaFlow;
  plan: MediaCompiledPlan;
  models: readonly MediaModelDescriptor[];
  addons: readonly MediaModelAddonDescriptor[];
  assets: readonly MediaAssetRecord[];
  assetMetadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  onNodeConfigChange: (nodeId: string, fieldId: string, value: unknown) => void;
  onNodeConfigPatch?: (
    nodeId: string,
    values: Readonly<Record<string, unknown>>,
  ) => void;
  onNodeLabelChange: (nodeId: string, label: string) => void;
  onConnectPorts: (request: MediaFlowConnectionRequest) => void;
  onDisconnectInput: (nodeId: string, portId: string) => void;
  onDisconnectConnection: (request: MediaFlowConnectionRequest) => void;
  onNodeCopy: (nodeId: string) => void;
  onNodeRemove: (nodeId: string) => void;
  onClose: () => void;
}): JSX.Element => {
  const copyShortcut = useOptionalCommandShortcut("media.selection.copy");
  const definition = getMediaNodeDefinition(node.type);
  const groups = INSPECTOR_GROUPS.filter((group) =>
    definition?.fields.some((field) => field.group === group),
  );
  const groupKey = groups.join("\u001f");
  const [activeGroup, setActiveGroup] = useState<MediaNodeInspectorGroup>(
    groups[0] ?? "Basic",
  );
  const [nodeLabelDraft, setNodeLabelDraft] = useState(node.label);
  const [removeReviewOpen, setRemoveReviewOpen] = useState(false);
  useEffect(() => {
    setActiveGroup(groups[0] ?? "Basic");
    setRemoveReviewOpen(false);
  }, [groupKey, node.id]);
  useEffect(() => {
    setNodeLabelDraft(node.label);
  }, [node.id, node.label]);

  const incoming = flow.edges.filter((edge) => edge.toNodeId === node.id);
  const outgoing = flow.edges.filter((edge) => edge.fromNodeId === node.id);
  const diagnostics = plan.diagnostics.filter(
    (diagnostic) =>
      diagnostic.nodeId === node.id && diagnostic.severity === "error",
  );
  const resolvedFlow = useMemo(
    () => resolveMediaFlowVariables(flow).flow,
    [flow],
  );
  const resolvedNode = useMemo(
    () => resolvedFlow.nodes.find((entry) => entry.id === node.id) ?? node,
    [node, resolvedFlow.nodes],
  );
  const resolvedGenerationModel =
    plan.runtimeBindings.find((binding) => binding.nodeId === node.id)?.model ??
    null;
  const imageTaskBinding = plan.runtimeBindings.find(
    (binding) => binding.modality === "image",
  );
  const referenceRoleModel =
    node.type === "source.image"
      ? (imageTaskBinding?.model ?? null)
      : resolvedGenerationModel;
  const referenceRoleValues = referenceRoleModel
    ? [
        ...(referenceRoleModel.capabilities.includes("image-to-image")
          ? ["base"]
          : []),
        ...getMediaReferenceConditioningCapabilities(referenceRoleModel).roles,
        ...([
          "stable-diffusion-1",
          "stable-diffusion-2",
          "stable-diffusion-xl",
        ].includes(referenceRoleModel.architecture ?? "")
          ? ["pose"]
          : []),
      ]
    : null;
  const promptEdge = incoming.find((edge) => edge.toPortId === "prompt");
  const promptSource = promptEdge
    ? (resolvedFlow.nodes.find((entry) => entry.id === promptEdge.fromNodeId) ??
      null)
    : null;
  const generationPrompt =
    promptSource?.type === "source.prompt" &&
    typeof promptSource.config.prompt === "string"
      ? promptSource.config.prompt
      : "";
  const imageInputEdges = incoming.filter((edge) => edge.toPortId === "image");
  const imageInputSources = imageInputEdges.flatMap((edge) => {
    const source = resolvedFlow.nodes.find(
      (entry) => entry.id === edge.fromNodeId && entry.type === "source.image",
    );
    return source ? [source] : [];
  });
  const baseImageSource =
    imageInputSources.find(
      (source) => source.config.referenceRole === "base",
    ) ??
    imageInputSources[0] ??
    null;
  const baseImageAssetId =
    typeof baseImageSource?.config.assetId === "string"
      ? baseImageSource.config.assetId
      : null;
  const requiredReferenceRoles = imageInputSources.flatMap((source) => {
    const role = source.config.referenceRole;
    return typeof role === "string" && role !== "base" && role !== "pose"
      ? [role as MediaImageReferenceRole]
      : [];
  });
  const hasPoseInput = imageInputSources.some(
    (source) => source.config.referenceRole === "pose",
  );
  const conditionedImageCount = imageInputSources.filter(
    (source) => source.config.referenceRole !== "pose",
  ).length;
  const maskBaseAsset = baseImageAssetId
    ? (assets.find(
        (asset) => asset.id === baseImageAssetId && asset.kind === "image",
      ) ?? null)
    : null;
  const editMask = normalizeMediaImageMask(node.config.editMask);
  const firstFrameEdge = incoming.find(
    (edge) => edge.toPortId === "first-frame",
  );
  const lastFrameEdge = incoming.find((edge) => edge.toPortId === "last-frame");
  const videoNeedsTerminalConditioning =
    node.config.loopMode === "seamless" ||
    (firstFrameEdge !== undefined &&
      lastFrameEdge !== undefined &&
      firstFrameEdge.fromNodeId !== lastFrameEdge.fromNodeId);
  const requiredModelCapabilities: readonly MediaCapability[] =
    node.type === "task.generate-video"
      ? videoNeedsTerminalConditioning
        ? ["image-to-video", "start-end-to-video"]
        : ["image-to-video"]
      : node.type === "task.edit-image"
        ? [
            ...(hasPoseInput ? (["pose-control"] as const) : []),
            ...(hasMediaImageMaskContent(editMask)
              ? (["masked-image-edit"] as const)
              : []),
            ...(conditionedImageCount > 1
              ? (["multi-reference-edit"] as const)
              : conditionedImageCount === 1 &&
                  !hasMediaImageMaskContent(editMask)
                ? (["image-to-image"] as const)
                : []),
          ]
        : node.type === "task.generate-image" &&
            node.config.outputFormat === "svg"
          ? [
              node.config.svgMode === "vectorize"
                ? "image-to-svg"
                : imageInputEdges.length > 0
                  ? "guided-svg-generation"
                  : "text-to-svg",
            ]
          : ["text-to-image"];
  const videoKeyframes =
    node.type === "task.generate-video"
      ? (["first-frame", "last-frame"] as const).map((portId) => {
          const edge = incoming.find((entry) => entry.toPortId === portId);
          const source = edge
            ? resolvedFlow.nodes.find((entry) => entry.id === edge.fromNodeId)
            : null;
          const assetId =
            source?.type === "source.image" &&
            typeof source.config.assetId === "string"
              ? source.config.assetId
              : null;
          return {
            connected: edge !== undefined,
            asset: assetId
              ? (assets.find((asset) => asset.id === assetId) ?? null)
              : null,
          };
        })
      : null;
  const videoModel =
    node.type === "task.generate-video"
      ? (plan.runtimeBindings.find(
          (binding) =>
            binding.nodeId === node.id && binding.modality === "video",
        )?.model ?? null)
      : null;
  const validationIssues = validateMediaFlowNode(resolvedNode);
  const visibleFields = definition
    ? listVisibleMediaNodeFields(definition, node.config, activeGroup).filter(
        (field) =>
          (field.kind !== "mask" ||
            (maskBaseAsset !== null &&
              (hasMediaImageMaskContent(editMask) ||
                resolvedGenerationModel?.capabilities.includes(
                  "masked-image-edit",
                ) === true))) &&
          (field.id !== "influence" ||
            (referenceRoleModel !== null &&
              getMediaReferenceConditioningCapabilities(referenceRoleModel)
                .adjustableInfluence)),
      )
    : [];
  const commitNodeLabel = (): void => {
    const nextLabel = nodeLabelDraft.trim();
    if (!nextLabel || nextLabel === node.label) {
      setNodeLabelDraft(node.label);
      return;
    }
    onNodeLabelChange(node.id, nextLabel);
  };
  return (
    <aside
      aria-label="Node inspector"
      className="absolute inset-y-0 right-0 z-20 min-h-0 w-[min(360px,calc(100%-2rem))] overflow-y-auto border-l border-slate-800/80 bg-slate-950/95 p-5 shadow-2xl xl:static xl:w-auto xl:bg-slate-950/90 xl:shadow-none"
    >
      <div className="flex items-start justify-between gap-3">
        <label className="min-w-0 flex-1">
          <span className="text-[10px] font-medium text-slate-300">Name</span>
          <Input
            value={nodeLabelDraft}
            aria-label="Node name"
            maxLength={256}
            onChange={(event) => setNodeLabelDraft(event.target.value)}
            onBlur={commitNodeLabel}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setNodeLabelDraft(node.label);
                event.currentTarget.blur();
              }
            }}
            className="mt-1 h-8 text-xs font-semibold"
          />
        </label>
        <div className="mt-5 flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Copy ${node.label}`}
            aria-keyshortcuts={copyShortcut?.ariaKeyShortcuts}
            title={`Copy node${copyShortcut ? ` (${copyShortcut.label})` : ""}`}
            onClick={() => onNodeCopy(node.id)}
            className="text-slate-500 hover:bg-cyan-400/10 hover:text-cyan-300"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${node.label}`}
            aria-expanded={removeReviewOpen}
            onClick={() => setRemoveReviewOpen((open) => !open)}
            className="text-slate-500 hover:bg-rose-400/10 hover:text-rose-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close node inspector"
            onClick={onClose}
            className="text-slate-500 hover:bg-slate-800 hover:text-slate-200"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {removeReviewOpen ? (
        <div
          role="alertdialog"
          aria-label={`Confirm removal of ${node.label}`}
          className="mt-4 rounded-xl border border-rose-400/25 bg-rose-400/5 p-3"
        >
          <p className="text-[10px] leading-4 text-rose-100">
            Remove this node and {incoming.length + outgoing.length} connected
            edge
            {incoming.length + outgoing.length === 1 ? "" : "s"}?
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onNodeRemove(node.id);
                onClose();
              }}
              className="h-7 bg-rose-500 px-2.5 text-[10px] text-white hover:bg-rose-400"
            >
              <Trash2 className="h-3 w-3" />
              Remove node
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRemoveReviewOpen(false)}
              className="h-7 px-2.5 text-[10px] text-slate-400 hover:bg-slate-800"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      <section className="mt-5" aria-label="Node settings">
        {definition ? (
          <>
            {node.type === "task.generate-video" && onNodeConfigPatch ? (
              <>
                <VideoKeyframeReviewPanel
                  firstFrame={
                    videoKeyframes?.[0] ?? { connected: false, asset: null }
                  }
                  lastFrame={
                    videoKeyframes?.[1] ?? { connected: false, asset: null }
                  }
                  model={videoModel}
                />
                <VideoQualityPresetPanel
                  config={node.config}
                  model={videoModel}
                  onApply={(values) => onNodeConfigPatch(node.id, values)}
                />
              </>
            ) : null}
            {groups.length > 1 ? (
              <div
                role="tablist"
                aria-label="Node setting complexity"
                className={cn(
                  "grid gap-1 rounded-lg border border-slate-800 bg-slate-900/45 p-1",
                  node.type === "task.generate-video" &&
                    onNodeConfigPatch &&
                    "mt-4",
                  groups.length === 2 ? "grid-cols-2" : "grid-cols-3",
                )}
              >
                {groups.map((group) => (
                  <button
                    key={group}
                    type="button"
                    role="tab"
                    aria-selected={activeGroup === group}
                    onClick={() => setActiveGroup(group)}
                    className={cn(
                      "rounded-md px-2 py-1.5 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/30",
                      activeGroup === group
                        ? "bg-sky-400/12 text-sky-200"
                        : "text-slate-500 hover:bg-slate-800 hover:text-slate-300",
                    )}
                  >
                    {group}
                  </button>
                ))}
              </div>
            ) : null}
            <div
              role="tabpanel"
              aria-label={`${activeGroup} settings`}
              className={cn("space-y-3", groups.length > 1 && "mt-4")}
            >
              {visibleFields.map((field) => (
                <NodeFieldEditor
                  key={field.id}
                  node={node}
                  field={field}
                  models={models}
                  addons={addons}
                  assets={assets}
                  assetMetadata={assetMetadata}
                  maskAsset={maskBaseAsset}
                  resolvedModel={resolvedGenerationModel}
                  requiredModelCapabilities={requiredModelCapabilities}
                  requiredReferenceRoles={requiredReferenceRoles}
                  generationPrompt={generationPrompt}
                  referenceRoleValues={referenceRoleValues}
                  onGenerationPromptChange={
                    promptSource?.type === "source.prompt"
                      ? (prompt) =>
                          onNodeConfigChange(promptSource.id, "prompt", prompt)
                      : null
                  }
                  variables={flow.variables}
                  issue={
                    validationIssues.find(
                      (issue) => issue.fieldId === field.id,
                    ) ??
                    (field.id === "prompt" &&
                    diagnostics.some(
                      (diagnostic) => diagnostic.code === "PROMPT_REQUIRED",
                    )
                      ? {
                          code: "INVALID_CONFIG_VALUE",
                          severity: "error",
                          nodeId: node.id,
                          fieldId: "prompt",
                          message: "Prompt is required.",
                        }
                      : null)
                  }
                  onChange={(fieldId, value) =>
                    onNodeConfigChange(node.id, fieldId, value)
                  }
                  onPatch={
                    onNodeConfigPatch
                      ? (values) => onNodeConfigPatch(node.id, values)
                      : undefined
                  }
                />
              ))}
            </div>
          </>
        ) : (
          <dl className="mt-3 space-y-2">
            {Object.entries(node.config).map(([key, value]) => (
              <div
                key={key}
                className="rounded-lg border border-rose-400/20 bg-rose-400/5 px-3 py-2.5"
              >
                <dt className="text-[9px] tracking-wide text-rose-300 uppercase">
                  {key.replaceAll(/([A-Z])/g, " $1")}
                </dt>
                <dd className="mt-1 break-words text-[11px] leading-4 text-slate-300">
                  {formatConfigValue(value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {definition && definition.inputs.length > 0 ? (
        <section className="mt-6" aria-labelledby="node-connections-heading">
          <h3
            id="node-connections-heading"
            className="text-[10px] font-bold tracking-[0.14em] text-slate-600 uppercase"
          >
            Connections
          </h3>
          <div className="mt-3 space-y-4">
            {definition.inputs.map((inputPort) => {
              const currentEdges = incoming.filter(
                (edge) => edge.toPortId === inputPort.id,
              );
              const currentEdge = currentEdges[0];
              const currentValue = currentEdge
                ? `${currentEdge.fromNodeId}\u001f${currentEdge.fromPortId}`
                : "";
              const candidates = flow.nodes.flatMap((sourceNode) => {
                if (sourceNode.id === node.id) return [];
                const sourceDefinition = getMediaNodeDefinition(
                  sourceNode.type,
                );
                return (sourceDefinition?.outputs ?? [])
                  .filter(
                    (outputPort) => outputPort.dataType === inputPort.dataType,
                  )
                  .map((outputPort) => {
                    const request: MediaFlowConnectionRequest = {
                      fromNodeId: sourceNode.id,
                      fromPortId: outputPort.id,
                      toNodeId: node.id,
                      toPortId: inputPort.id,
                    };
                    return {
                      sourceNode,
                      outputPort,
                      request,
                      check: inspectMediaFlowConnection(flow, request),
                    };
                  });
              });

              return (
                <div key={inputPort.id}>
                  <label
                    htmlFor={`media-port-${node.id}-${inputPort.id}`}
                    className="text-[10px] font-medium text-slate-300"
                  >
                    {inputPort.label}
                    {inputPort.required ? " *" : ""}
                    <span className="ml-1.5 font-normal text-slate-600">
                      {PORT_LABELS[inputPort.dataType]}
                    </span>
                  </label>
                  {inputPort.cardinality === "collection" ? (
                    <div
                      role="group"
                      aria-label={`Connect ${inputPort.label}`}
                      className="mt-1.5 space-y-1"
                    >
                      {candidates.length > 0 ? (
                        candidates.map(
                          ({ sourceNode, outputPort, request, check }) => {
                            const checked = currentEdges.some(
                              (edge) =>
                                edge.fromNodeId === request.fromNodeId &&
                                edge.fromPortId === request.fromPortId,
                            );
                            return (
                              <label
                                key={`${sourceNode.id}\u001f${outputPort.id}`}
                                className="flex items-start gap-2 rounded-md px-1.5 py-1 text-[10px] text-slate-300 hover:bg-slate-900/70"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={!checked && !check.valid}
                                  aria-label={`Use ${sourceNode.label} as ${inputPort.label}`}
                                  onChange={(event) => {
                                    if (event.target.checked)
                                      onConnectPorts(request);
                                    else onDisconnectConnection(request);
                                  }}
                                  className="mt-0.5 h-3.5 w-3.5 accent-cyan-400"
                                />
                                <span className="min-w-0">
                                  <span className="block truncate">
                                    {sourceNode.label} · {outputPort.label}
                                  </span>
                                  {!checked && !check.valid ? (
                                    <span className="block text-[8px] leading-3 text-amber-400/70">
                                      {check.reason}
                                    </span>
                                  ) : null}
                                </span>
                              </label>
                            );
                          },
                        )
                      ) : (
                        <p className="text-[9px] text-slate-600">
                          Add a compatible source node to connect this
                          collection.
                        </p>
                      )}
                      {inputPort.required && currentEdges.length === 0 ? (
                        <p className="text-[9px] text-amber-300/80">
                          {inputPort.label} requires at least one connection.
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <select
                      id={`media-port-${node.id}-${inputPort.id}`}
                      value={currentValue}
                      aria-label={`Connect ${inputPort.label}`}
                      onChange={(event) => {
                        if (!event.target.value) {
                          onDisconnectInput(node.id, inputPort.id);
                          return;
                        }
                        const [fromNodeId, fromPortId] =
                          event.target.value.split("\u001f");
                        if (fromNodeId && fromPortId) {
                          onConnectPorts({
                            fromNodeId,
                            fromPortId,
                            toNodeId: node.id,
                            toPortId: inputPort.id,
                          });
                        }
                      }}
                      className="mt-1.5 h-8 w-full rounded-md border border-slate-700 bg-slate-950/70 px-2 text-[10px] text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/30"
                    >
                      <option value="">
                        {inputPort.required
                          ? "Required · disconnected"
                          : "Disconnected"}
                      </option>
                      {candidates.map(({ sourceNode, outputPort, check }) => {
                        const value = `${sourceNode.id}\u001f${outputPort.id}`;
                        return (
                          <option
                            key={value}
                            value={value}
                            disabled={!check.valid && value !== currentValue}
                          >
                            {sourceNode.label} · {outputPort.label}
                            {!check.valid && value !== currentValue
                              ? ` · ${check.reason}`
                              : ""}
                          </option>
                        );
                      })}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {diagnostics.length > 0 ? (
        <section className="mt-6" aria-labelledby="node-diagnostics-heading">
          <h3
            id="node-diagnostics-heading"
            className="text-[10px] font-bold tracking-[0.14em] text-slate-600 uppercase"
          >
            Compiler diagnostics
          </h3>
          <div className="mt-3 space-y-2">
            {diagnostics.map((diagnostic) => (
              <div
                key={`${diagnostic.code}-${diagnostic.message}`}
                className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-[10px] leading-4 text-amber-100"
              >
                {diagnostic.message}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </aside>
  );
};

const formatRevisionTime = (value: string): string => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(timestamp)
    : value;
};

const RevisionHistoryPanel = ({
  history,
  loading,
  onRefresh,
  onRestore,
}: {
  history: MediaFlowHistory | null;
  loading: boolean;
  onRefresh: () => void;
  onRestore: (revision: MediaFlowRevision) => void;
}): JSX.Element => {
  const [comparisonRevisionId, setComparisonRevisionId] = useState<
    string | null
  >(null);
  const headRevision = history?.revisions.find((revision) => revision.isHead);
  const comparisonRevision = history?.revisions.find(
    (revision) => revision.revisionId === comparisonRevisionId,
  );
  const comparison = useMemo(
    () =>
      comparisonRevision && headRevision
        ? createMediaFlowRevisionDiff(comparisonRevision, headRevision)
        : null,
    [comparisonRevision, headRevision],
  );

  return (
    <aside
      aria-label="Flow revision history"
      className="absolute inset-y-0 right-0 z-20 min-h-0 w-[min(390px,calc(100%-2rem))] overflow-y-auto border-l border-slate-800/80 bg-slate-950/95 p-5 shadow-2xl xl:static xl:w-auto xl:bg-slate-950/90 xl:shadow-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <History className="h-4 w-4 text-cyan-300" />
            Revision history
          </div>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">
            Immutable snapshots with execution-aware reproducibility diffs.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh flow revision history"
          disabled={loading}
          onClick={onRefresh}
          className="text-slate-500 hover:bg-slate-800 hover:text-slate-200"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {history?.head ? (
        <div className="mt-4 rounded-xl border border-cyan-400/20 bg-cyan-400/5 p-3">
          <div className="flex items-center justify-between gap-3 text-[10px]">
            <span className="font-semibold text-cyan-200">
              Head revision {history.head.headRevisionNumber}
            </span>
            <span className="text-slate-500">
              {history.revisions.length} retained
            </span>
          </div>
          <code className="mt-2 block truncate text-[9px] text-slate-600">
            {history.head.executionDigest}
          </code>
        </div>
      ) : null}

      {comparison && comparisonRevision && headRevision ? (
        <section
          aria-label="Revision comparison"
          className="mt-4 rounded-xl border border-violet-400/20 bg-violet-400/5 p-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-[11px] font-semibold text-violet-100">
                <FileDiff className="h-3.5 w-3.5" />
                Revision {comparisonRevision.revisionNumber} →{" "}
                {headRevision.revisionNumber}
              </div>
              <p className="mt-1 text-[9px] text-slate-500">
                Saved behavior, document metadata, and canvas layout are
                compared independently.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close revision comparison"
              onClick={() => setComparisonRevisionId(null)}
              className="text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1.5 text-center text-[9px]">
            {[
              ["Execution", comparison.executionChanged],
              ["Document", comparison.documentChanged],
              ["Layout", comparison.layoutChanged],
            ].map(([label, changed]) => (
              <div
                key={String(label)}
                className={cn(
                  "rounded border px-1 py-2",
                  changed
                    ? "border-amber-400/20 bg-amber-400/5 text-amber-200"
                    : "border-emerald-400/20 bg-emerald-400/5 text-emerald-200",
                )}
              >
                <div>{label}</div>
                <div className="mt-0.5 opacity-60">
                  {changed ? "Changed" : "Identical"}
                </div>
              </div>
            ))}
          </div>
          {comparison.nodeChanges.length > 0 ? (
            <div className="mt-3 space-y-1.5">
              {comparison.nodeChanges.map((change) => (
                <div
                  key={change.nodeId}
                  className="rounded border border-slate-800 bg-slate-950/35 p-2 text-[9px] text-slate-400"
                >
                  <span className="font-medium text-slate-200">
                    {change.nodeLabel}
                  </span>
                  <span className="ml-1 text-slate-600">· {change.kind}</span>
                  <div className="mt-1 break-words text-slate-600">
                    {change.changedFields.join(", ")}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {comparison.variableChanges.length > 0 ? (
            <div className="mt-3 space-y-1.5">
              {comparison.variableChanges.map((change) => (
                <div
                  key={change.variableId}
                  className="rounded border border-cyan-400/15 bg-cyan-400/5 p-2 text-[9px] text-slate-400"
                >
                  <span className="font-medium text-cyan-100">
                    {change.variableName}
                  </span>
                  <span className="ml-1 text-slate-600">
                    · variable {change.kind}
                  </span>
                  <div className="mt-1 break-words text-slate-600">
                    {change.changedFields.join(", ")}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          <div className="mt-3 text-[9px] leading-4 text-slate-500">
            {comparison.edgeChanges.length} edge ·{" "}
            {comparison.variableChanges.length} variable ·{" "}
            {comparison.presetChanges.length} preset ·{" "}
            {comparison.layoutChanges.length} position ·{" "}
            {comparison.metadataFieldsChanged.length} metadata changes
          </div>
        </section>
      ) : null}

      <div className="mt-4 space-y-3">
        {loading && !history ? (
          <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/35 p-4 text-xs text-slate-500">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Loading revisions…
          </div>
        ) : history?.revisions.length ? (
          history.revisions.map((revision) => (
            <article
              key={revision.revisionId}
              className={cn(
                "rounded-xl border p-3",
                revision.isHead
                  ? "border-cyan-400/25 bg-cyan-400/5"
                  : "border-slate-800 bg-slate-900/35",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-200">
                      Revision {revision.revisionNumber}
                    </span>
                    {revision.isHead ? (
                      <Badge className="border-cyan-400/20 bg-cyan-400/10 text-[9px] text-cyan-200">
                        Current
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500">
                    {formatRevisionTime(revision.createdAt)}
                  </p>
                </div>
                {!revision.isHead ? (
                  <div className="flex gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setComparisonRevisionId(revision.revisionId)
                      }
                      className="h-7 border-violet-400/20 bg-violet-400/5 px-2 text-[10px] text-violet-200 hover:bg-violet-400/10"
                    >
                      <FileDiff className="h-3 w-3" /> Compare
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={loading}
                      onClick={() => onRestore(revision)}
                      className="h-7 border-slate-700 bg-slate-950 px-2 text-[10px] text-slate-300 hover:bg-slate-800"
                    >
                      <RotateCcw className="h-3 w-3" /> Restore
                    </Button>
                  </div>
                ) : null}
              </div>
              <p className="mt-3 text-[11px] leading-4 text-slate-300">
                {revision.changeSummary}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[9px] text-slate-500">
                <span className="rounded border border-slate-800 px-1.5 py-0.5">
                  {revision.nodeCount} nodes
                </span>
                <span className="rounded border border-slate-800 px-1.5 py-0.5">
                  {revision.edgeCount} edges
                </span>
              </div>
              <code className="mt-3 block truncate text-[9px] text-slate-700">
                {revision.revisionId}
              </code>
            </article>
          ))
        ) : (
          <div className="rounded-xl border border-dashed border-slate-800 bg-slate-900/20 p-5 text-center">
            <History className="mx-auto h-5 w-5 text-slate-700" />
            <p className="mt-2 text-xs font-medium text-slate-400">
              No saved revisions
            </p>
            <p className="mt-1 text-[10px] leading-4 text-slate-600">
              Save the current flow to create its immutable first revision.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
};

const FlowPortabilityPanel = ({
  inspection,
  loading,
  supported,
  onInspect,
  onImport,
  onDismiss,
}: {
  inspection: MediaFlowImportInspection | null;
  loading: boolean;
  supported: boolean;
  onInspect: () => void;
  onImport: () => void;
  onDismiss: () => void;
}): JSX.Element => {
  const statusStyle =
    inspection?.status === "ready"
      ? "border-emerald-400/25 bg-emerald-400/5 text-emerald-200"
      : inspection?.status === "inspect-only"
        ? "border-amber-400/25 bg-amber-400/5 text-amber-100"
        : "border-rose-400/25 bg-rose-400/5 text-rose-100";

  return (
    <aside
      aria-label="Flow portability review"
      className="absolute inset-y-0 right-0 z-20 min-h-0 w-[min(410px,calc(100%-2rem))] overflow-y-auto border-l border-slate-800/80 bg-slate-950/95 p-5 shadow-2xl xl:static xl:w-auto xl:bg-slate-950/90 xl:shadow-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <FileUp className="h-4 w-4 text-violet-300" />
            Portable flow
          </div>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">
            Review exact schema and node requirements before creating an
            isolated copy.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close flow portability review"
          onClick={onDismiss}
          className="text-slate-500 hover:bg-slate-800 hover:text-slate-200"
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </Button>
      </div>

      {!supported ? (
        <div className="mt-5 rounded-xl border border-slate-800 bg-slate-900/35 p-4 text-[11px] leading-5 text-slate-400">
          File import and verified export are available in the native desktop
          app. Browser preview keeps these controls read-only.
        </div>
      ) : inspection ? (
        <>
          <div className={cn("mt-5 rounded-xl border p-4", statusStyle)}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-semibold">
                {inspection.status === "ready"
                  ? "Compatible and ready"
                  : inspection.status === "inspect-only"
                    ? "Read-only inspection"
                    : "Invalid bundle"}
              </span>
              <Badge
                variant="outline"
                className="border-current/25 text-[9px] text-current"
              >
                schema {inspection.bundleSchemaVersion ?? "?"}
              </Badge>
            </div>
            <p className="mt-2 break-words text-[10px] leading-4 opacity-80">
              {inspection.sourceFlowName ?? inspection.sourceDisplayName}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[9px] opacity-70">
              <span>{inspection.nodeCount} nodes</span>
              <span>·</span>
              <span>{inspection.edgeCount} edges</span>
              <span>·</span>
              <span>{inspection.requirements.length} requirements</span>
            </div>
          </div>

          {inspection.importMutations.length > 0 ? (
            <section
              className="mt-5"
              aria-labelledby="flow-import-mutations-heading"
            >
              <h3
                id="flow-import-mutations-heading"
                className="text-[10px] font-bold tracking-[0.14em] text-slate-600 uppercase"
              >
                Safe import plan
              </h3>
              <ul className="mt-2 space-y-2 text-[10px] leading-4 text-slate-400">
                {inspection.importMutations.map((mutation) => (
                  <li
                    key={mutation}
                    className="rounded-lg border border-slate-800 bg-slate-900/35 p-3"
                  >
                    {mutation}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {inspection.issues.length > 0 ? (
            <section
              className="mt-5"
              aria-labelledby="flow-import-issues-heading"
            >
              <h3
                id="flow-import-issues-heading"
                className="text-[10px] font-bold tracking-[0.14em] text-slate-600 uppercase"
              >
                Compatibility report
              </h3>
              <ul className="mt-2 space-y-2">
                {inspection.issues.map((issue, index) => (
                  <li
                    key={`${issue.code}-${issue.nodeId ?? index}`}
                    className={cn(
                      "rounded-lg border p-3 text-[10px] leading-4",
                      issue.severity === "error"
                        ? "border-rose-400/20 bg-rose-400/5 text-rose-100"
                        : "border-amber-400/20 bg-amber-400/5 text-amber-100",
                    )}
                  >
                    <div className="font-mono text-[9px] opacity-60">
                      {issue.code}
                    </div>
                    <div className="mt-1">{issue.message}</div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {inspection.unknownNodes.length > 0 ? (
            <section
              className="mt-5"
              aria-labelledby="unknown-flow-nodes-heading"
            >
              <h3
                id="unknown-flow-nodes-heading"
                className="text-[10px] font-bold tracking-[0.14em] text-slate-600 uppercase"
              >
                Preserved unknown nodes
              </h3>
              <p className="mt-2 text-[10px] leading-4 text-slate-500">
                Original node JSON and connected edges remain inspectable and
                are never coerced into a known node.
              </p>
              <div className="mt-3 space-y-2">
                {inspection.unknownNodes.map((node) => (
                  <details
                    key={node.nodeId}
                    className="rounded-lg border border-amber-400/15 bg-amber-400/5 p-3"
                  >
                    <summary className="cursor-pointer text-[10px] font-medium text-amber-100">
                      {node.nodeType}@{node.version ?? "?"} · {node.nodeId}
                    </summary>
                    <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded border border-slate-800 bg-slate-950/70 p-2 text-[9px] leading-4 text-slate-400">
                      {JSON.stringify(
                        {
                          node: node.originalNode,
                          connectedEdges: node.connectedEdges,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                ))}
              </div>
            </section>
          ) : null}

          <div className="mt-5 flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!inspection.canImport || loading}
              onClick={onImport}
              className="h-8 flex-1 bg-violet-500 text-xs text-white hover:bg-violet-400"
            >
              {loading ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileUp className="h-3.5 w-3.5" />
              )}
              {loading ? "Importing…" : "Import isolated copy"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={onInspect}
              className="h-8 border-slate-700 bg-slate-900 text-xs text-slate-300 hover:bg-slate-800"
            >
              Choose another
            </Button>
          </div>
          <code className="mt-4 block truncate text-[9px] text-slate-700">
            {inspection.bundleDigest}
          </code>
        </>
      ) : (
        <div className="mt-5 rounded-xl border border-dashed border-slate-800 bg-slate-900/20 p-5 text-center">
          <FileUp className="mx-auto h-5 w-5 text-slate-700" />
          <p className="mt-2 text-xs font-medium text-slate-300">
            Inspect before import
          </p>
          <p className="mt-1 text-[10px] leading-4 text-slate-600">
            The backend checks strict JSON, digests, graph bounds, node
            versions, and layout identity.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={onInspect}
            className="mt-4 h-8 border-violet-400/25 bg-violet-400/5 text-xs text-violet-200 hover:bg-violet-400/10"
          >
            {loading ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileUp className="h-3.5 w-3.5" />
            )}
            {loading ? "Inspecting…" : "Choose flow bundle"}
          </Button>
        </div>
      )}
    </aside>
  );
};

export const MediaFlowView = ({
  flow,
  layout,
  plan,
  models,
  addons,
  assetMetadata,
  assets = [],
  onLayoutChange,
  onFlowVariablesChange = () => undefined,
  onTemplateApply = () => undefined,
  onNodeConfigChange,
  onNodeConfigPatch,
  onNodeLabelChange,
  onNodeAdd,
  onNodeRemove,
  onConnectPorts,
  onDisconnectInput,
  onDisconnectConnection,
  canUndoSemantic = false,
  canRedoSemantic = false,
  onUndoSemantic = () => undefined,
  onRedoSemantic = () => undefined,
  onNodeCopy = () => undefined,
  onNodesCopy = () => undefined,
  onNodePaste = () => null,
  clipboardLabel = null,
  canPasteNode = false,
  pasteBlockedReason = null,
  history,
  savedFlows,
  savedFlowsLoading,
  revisionLoading,
  revisionNotice,
  hasUnsavedChanges,
  onRefreshHistory,
  onRefreshSavedFlows,
  onOpenSavedFlow,
  onSaveRevision,
  onRestoreRevision,
  portabilitySupported,
  portabilityLoading,
  importInspection,
  onInspectImport,
  onImportReviewed,
  onDismissImport,
  onExportRevision,
  onRunLocalFlow = () => undefined,
  localRunPending = false,
  localRunSupported = false,
  localRunDescription = "This flow does not have a local utility executor.",
  onRunRemoteEdit = () => undefined,
  remoteRunPending = false,
  remoteRunSupported = false,
  remoteRunDescription = "This flow does not have a remote image edit executor.",
  remoteRunMode = null,
  remoteMaskIncluded = false,
  remoteUploadManifest = [],
  runOverlay = null,
  onRunOverlayClear = () => undefined,
}: MediaFlowViewProps): JSX.Element => {
  const disconnectConnection =
    onDisconnectConnection ??
    ((request: MediaFlowConnectionRequest) =>
      onDisconnectInput(request.toNodeId, request.toPortId));
  const [planPanelOpen, setPlanPanelOpen] = useState(false);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [portabilityPanelOpen, setPortabilityPanelOpen] = useState(false);
  const [palettePanelOpen, setPalettePanelOpen] = useState(false);
  const [groupsPanelOpen, setGroupsPanelOpen] = useState(false);
  const [variablesPanelOpen, setVariablesPanelOpen] = useState(false);
  const [templatesPanelOpen, setTemplatesPanelOpen] = useState(false);
  const [remoteConfirmationOpen, setRemoteConfirmationOpen] = useState(false);
  const [selectionPanelOpen, setSelectionPanelOpen] = useState(false);
  const [followRun, setFollowRun] = useState(true);
  const remoteUploadFileCount =
    remoteUploadManifest.length + (remoteMaskIncluded ? 1 : 0);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null);
  const undoStack = useRef<MediaFlowLayout[]>([]);
  const redoStack = useRef<MediaFlowLayout[]>([]);
  const previousCanvasLayoutKey = useRef<string | null>(null);
  const flowInstance = useRef<ReactFlowInstance<
    MediaCanvasNode,
    MediaCanvasEdge
  > | null>(null);
  const lastFollowedActiveNodes = useRef("");
  const [, setHistoryRevision] = useState(0);
  const layoutByNodeId = useMemo(
    () => new Map(layout.nodes.map((entry) => [entry.nodeId, entry])),
    [layout.nodes],
  );
  const flowNodesById = useMemo(
    () => new Map(flow.nodes.map((node) => [node.id, node])),
    [flow.nodes],
  );
  const collapsedNodeIds = useMemo(
    () =>
      new Set(
        layout.groups
          .filter((group) => group.collapsed)
          .flatMap((group) => group.nodeIds),
      ),
    [layout.groups],
  );
  const resolvedNodesById = useMemo(
    () =>
      new Map(
        resolveMediaFlowVariables(flow).flow.nodes.map((node) => [
          node.id,
          node,
        ]),
      ),
    [flow],
  );
  const flowImageAssets = useMemo(
    () => assets.filter((asset) => asset.kind === "image"),
    [assets],
  );
  const runOverlayProjection = useMemo(
    () =>
      runOverlay
        ? projectMediaRunOverlay({ flow, plan, run: runOverlay })
        : null,
    [flow, plan, runOverlay],
  );
  const visualRunOverlayProjection = useMemo(
    () => selectMediaRunOverlayForCurrentFlow(runOverlayProjection),
    [runOverlayProjection],
  );
  const canvasLayoutKey = useMemo(
    () => `${flow.id}\u001f${createMediaFlowLayoutDigest(layout)}`,
    [flow.id, layout],
  );
  const projectedCanvasNodes = useMemo<MediaCanvasNode[]>(() => {
    const groupNodes = layout.groups.flatMap((group) => {
      const positions = group.nodeIds.flatMap((nodeId) => {
        const position = layoutByNodeId.get(nodeId);
        return position ? [position] : [];
      });
      if (positions.length < 2) return [];
      const minX = Math.min(...positions.map((position) => position.x));
      const minY = Math.min(...positions.map((position) => position.y));
      const maxX = Math.max(...positions.map((position) => position.x));
      const maxY = Math.max(...positions.map((position) => position.y));
      const width = group.collapsed ? 240 : Math.max(272, maxX - minX + 272);
      const height = group.collapsed ? 54 : Math.max(130, maxY - minY + 190);
      return [
        {
          id: `layout-group:${group.id}`,
          type: "mediaGroup" as const,
          position: { x: minX - 32, y: minY - 52 },
          data: {
            label: group.label,
            color: group.color,
            collapsed: group.collapsed,
            memberCount: group.nodeIds.length,
            width,
            height,
          },
          draggable: false,
          selectable: false,
          focusable: false,
          zIndex: -10,
          style: { width, height },
        } satisfies MediaGroupCanvasNode,
      ];
    });
    const commentNodes = layout.comments.map((comment) => ({
      id: `layout-comment:${comment.id}`,
      type: "mediaComment" as const,
      position: { x: comment.x, y: comment.y },
      data: {
        body: comment.body,
        color: comment.color,
        width: comment.width,
        height: comment.height,
      },
      draggable: true,
      selectable: false,
      focusable: false,
      zIndex: -5,
      style: { width: comment.width, height: comment.height },
    })) satisfies MediaCommentCanvasNode[];
    const semanticNodes = flow.nodes.map((node) => {
      const position = layoutByNodeId.get(node.id) ?? { x: 0, y: 0 };
      const definition = getMediaNodeDefinition(node.type);
      const resolvedConfig =
        resolvedNodesById.get(node.id)?.config ?? node.config;
      const configuredModel =
        typeof resolvedConfig.modelId === "string"
          ? (models.find((model) => model.id === resolvedConfig.modelId) ??
            null)
          : null;
      const assetField = definition?.fields.find(
        (field) => field.kind === "asset",
      );
      const configuredAssetValue = assetField
        ? resolvedConfig[assetField.id]
        : null;
      const configuredAssetId =
        typeof configuredAssetValue === "string"
          ? configuredAssetValue.trim()
          : "";
      const assetIndex = configuredAssetId
        ? flowImageAssets.findIndex((asset) => asset.id === configuredAssetId)
        : -1;
      const configuredAsset =
        assetIndex >= 0 ? (flowImageAssets[assetIndex] ?? null) : null;
      const runOutputAsset =
        node.type === "output.asset"
          ? selectMediaRunOutputAssetForNode(
              runOverlay,
              runOverlayProjection,
              node.id,
            )
          : null;
      const asset = configuredAsset ?? runOutputAsset;
      return {
        id: node.id,
        type: "mediaNode",
        position: { x: position.x, y: position.y },
        data: {
          label: node.label,
          nodeType: node.type,
          layer: node.layer,
          detail: readNodeDetail(resolvedConfig, configuredModel?.architecture),
          asset,
          assetId: configuredAssetId || runOutputAsset?.id || null,
          assetLabel: runOutputAsset
            ? runOutputAsset.kind === "vector"
              ? "Final SVG"
              : "Final image"
            : configuredAsset
              ? mediaAssetLabel(configuredAsset, assetIndex)
              : null,
          inputs: definition?.inputs ?? [],
          outputs: definition?.outputs ?? [],
          runOverlay:
            visualRunOverlayProjection?.observations.get(node.id) ?? null,
        },
        hidden: collapsedNodeIds.has(node.id),
      } satisfies MediaSemanticCanvasNode;
    });
    return [...groupNodes, ...commentNodes, ...semanticNodes];
  }, [
    collapsedNodeIds,
    flow.nodes,
    flowImageAssets,
    layout.comments,
    layout.groups,
    layoutByNodeId,
    models,
    resolvedNodesById,
    runOverlay,
    runOverlayProjection,
    visualRunOverlayProjection,
  ]);
  const [canvasNodes, setCanvasNodes, applyCanvasNodeChanges] =
    useNodesState<MediaCanvasNode>(projectedCanvasNodes);
  const projectedCanvasEdges = useMemo<MediaCanvasEdge[]>(
    () =>
      flow.edges.map((edge) => {
        const sourceState = visualRunOverlayProjection?.observations.get(
          edge.fromNodeId,
        )?.state;
        const targetState = visualRunOverlayProjection?.observations.get(
          edge.toNodeId,
        )?.state;
        const active = targetState === "running";
        const paused = targetState === "waiting" || targetState === "blocked";
        const traversed =
          ["completed", "cached", "skipped"].includes(sourceState ?? "") &&
          [
            "completed",
            "cached",
            "skipped",
            "running",
            "retrying",
            "waiting",
            "blocked",
          ].includes(targetState ?? "");
        const sourceNode = flowNodesById.get(edge.fromNodeId);
        const sourcePort = sourceNode
          ? getMediaNodeDefinition(sourceNode.type)?.outputs.find(
              (port) => port.id === edge.fromPortId,
            )
          : undefined;
        const sourceTone = sourcePort
          ? PORT_TONES[sourcePort.dataType]
          : "slate";
        const tone = active
          ? "cyan"
          : paused
            ? "fuchsia"
            : traversed
              ? "emerald"
              : sourceTone;
        return createFlowCanvasEdge({
          id: edge.id,
          source: edge.fromNodeId,
          target: edge.toNodeId,
          sourceHandle: edge.fromPortId,
          targetHandle: edge.toPortId,
          tone,
          hidden:
            collapsedNodeIds.has(edge.fromNodeId) ||
            collapsedNodeIds.has(edge.toNodeId),
          animated: active,
          emphasis:
            active || paused ? "strong" : traversed ? "medium" : "default",
          muted: Boolean(
            visualRunOverlayProjection && !active && !paused && !traversed,
          ),
        });
      }),
    [
      collapsedNodeIds,
      flow.edges,
      flowNodesById,
      visualRunOverlayProjection,
    ],
  );
  const [canvasEdges, setCanvasEdges] = useState<MediaCanvasEdge[]>(
    projectedCanvasEdges,
  );
  const activeNodeSignature = useMemo(
    () =>
      [...(visualRunOverlayProjection?.activeNodeIds ?? [])]
        .sort()
        .join("\u001f"),
    [visualRunOverlayProjection],
  );
  const activeNodeSummary = useMemo(() => {
    const activeNodeIds = new Set(
      visualRunOverlayProjection?.activeNodeIds ?? [],
    );
    return flow.nodes
      .filter((node) => activeNodeIds.has(node.id))
      .map((node) => node.label)
      .join(", ");
  }, [flow.nodes, visualRunOverlayProjection]);
  const selectedNode = useMemo(
    () => flow.nodes.find((node) => node.id === selectedNodeId),
    [flow.nodes, selectedNodeId],
  );
  const topologyKey = useMemo(
    () => flow.nodes.map((node) => node.id).join("\u001f"),
    [flow.nodes],
  );
  const panelOpen =
    planPanelOpen ||
    historyPanelOpen ||
    portabilityPanelOpen ||
    palettePanelOpen ||
    groupsPanelOpen ||
    variablesPanelOpen ||
    templatesPanelOpen ||
    selectionPanelOpen ||
    selectedNode !== undefined;

  const openNodePalette = useCallback((): void => {
    setSelectedNodeId(null);
    setPlanPanelOpen(false);
    setHistoryPanelOpen(false);
    setPortabilityPanelOpen(false);
    setGroupsPanelOpen(false);
    setVariablesPanelOpen(false);
    setTemplatesPanelOpen(false);
    setSelectionPanelOpen(false);
    setPalettePanelOpen(true);
  }, []);
  const toggleFlowPanel = useCallback(
    (
      panel:
        | "templates"
        | "variables"
        | "groups"
        | "selection"
        | "portability"
        | "history"
        | "plan",
    ): void => {
      setSelectedNodeId(null);
      setTemplatesPanelOpen((open) => (panel === "templates" ? !open : false));
      setVariablesPanelOpen((open) => (panel === "variables" ? !open : false));
      setGroupsPanelOpen((open) => (panel === "groups" ? !open : false));
      setSelectionPanelOpen((open) => (panel === "selection" ? !open : false));
      setPortabilityPanelOpen((open) =>
        panel === "portability" ? !open : false,
      );
      setHistoryPanelOpen((open) => (panel === "history" ? !open : false));
      setPlanPanelOpen((open) => (panel === "plan" ? !open : false));
      setPalettePanelOpen(false);
    },
    [],
  );

  const addNodeFromCommand = useCallback(
    (nodeType: MediaNodeType): boolean => {
      const nodeId = onNodeAdd(nodeType);
      if (!nodeId) return false;
      setPalettePanelOpen(false);
      setGroupsPanelOpen(false);
      setSelectionPanelOpen(false);
      setSelectedNodeId(nodeId);
      return true;
    },
    [onNodeAdd],
  );
  const nodeCommandPage = useMemo(
    () => createMediaNodeCommandPage(flow, addNodeFromCommand),
    [addNodeFromCommand, flow],
  );
  const openCommandPage = useOptionalCommandPageLauncher();
  const mediaCommandStateRef = useRef({
    canPasteNode,
    canRedoSemantic,
    canUndoSemantic,
    clipboardLabel,
    flow,
    hasUnsavedChanges,
    history,
    importInspection,
    localRunDescription,
    localRunPending,
    localRunSupported,
    nodeCommandPage,
    onDismissImport,
    onExportRevision,
    onImportReviewed,
    onInspectImport,
    onNodeCopy,
    onNodePaste,
    onNodesCopy,
    onOpenSavedFlow,
    onRedoSemantic,
    onRefreshHistory,
    onRefreshSavedFlows,
    onRestoreRevision,
    onRunLocalFlow,
    onRunOverlayClear,
    onSaveRevision,
    onUndoSemantic,
    pasteBlockedReason,
    portabilityLoading,
    portabilitySupported,
    remoteRunDescription,
    remoteRunPending,
    remoteRunSupported,
    revisionLoading,
    runOverlay,
    savedFlows,
    savedFlowsLoading,
    selectedNodeId,
    selectedNodeIds,
    setRemoteConfirmationOpen,
    toggleFlowPanel,
  });
  mediaCommandStateRef.current = {
    canPasteNode,
    canRedoSemantic,
    canUndoSemantic,
    clipboardLabel,
    flow,
    hasUnsavedChanges,
    history,
    importInspection,
    localRunDescription,
    localRunPending,
    localRunSupported,
    nodeCommandPage,
    onDismissImport,
    onExportRevision,
    onImportReviewed,
    onInspectImport,
    onNodeCopy,
    onNodePaste,
    onNodesCopy,
    onOpenSavedFlow,
    onRedoSemantic,
    onRefreshHistory,
    onRefreshSavedFlows,
    onRestoreRevision,
    onRunLocalFlow,
    onRunOverlayClear,
    onSaveRevision,
    onUndoSemantic,
    pasteBlockedReason,
    portabilityLoading,
    portabilitySupported,
    remoteRunDescription,
    remoteRunPending,
    remoteRunSupported,
    revisionLoading,
    runOverlay,
    savedFlows,
    savedFlowsLoading,
    selectedNodeId,
    selectedNodeIds,
    setRemoteConfirmationOpen,
    toggleFlowPanel,
  };
  const mediaCommands = useMemo<readonly CommandDefinition[]>(
    () => [
      {
        id: "media.flow.node.add",
        title: "Add node",
        group: "Media",
        keywords: ["find node", "semantic node"],
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        children: () => mediaCommandStateRef.current.nodeCommandPage,
      },
      {
        id: "media.flow.undo",
        title: "Undo semantic change",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        shortcuts: [{ chord: getDefaultCommandShortcut("media.flow.undo") }],
        palette: "visible",
        availability: () =>
          mediaCommandStateRef.current.canUndoSemantic
            ? { state: "enabled" }
            : { state: "disabled", reason: "Nothing to undo" },
        execute: () => mediaCommandStateRef.current.onUndoSemantic(),
      },
      {
        id: "media.flow.redo",
        title: "Redo semantic change",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        shortcuts: [
          { chord: getDefaultCommandShortcut("media.flow.redo") },
          {
            chord: getDefaultCommandShortcut("media.flow.redo-alternate"),
            platforms: ["windows", "linux"],
          },
        ],
        palette: "visible",
        availability: () =>
          mediaCommandStateRef.current.canRedoSemantic
            ? { state: "enabled" }
            : { state: "disabled", reason: "Nothing to redo" },
        execute: () => mediaCommandStateRef.current.onRedoSemantic(),
      },
      {
        id: "media.selection.copy",
        title: "Copy selected nodes",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        shortcuts: [
          { chord: getDefaultCommandShortcut("media.selection.copy") },
        ],
        palette: "visible",
        availability: () =>
          mediaCommandStateRef.current.selectedNodeIds.length > 0 ||
          mediaCommandStateRef.current.selectedNodeId
            ? { state: "enabled" }
            : { state: "disabled", reason: "Select a node to copy" },
        execute: () => {
          const state = mediaCommandStateRef.current;
          if (state.selectedNodeIds.length > 0)
            state.onNodesCopy(state.selectedNodeIds);
          else if (state.selectedNodeId) state.onNodeCopy(state.selectedNodeId);
        },
      },
      {
        id: "media.flow.paste",
        title: "Paste copied node",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        shortcuts: [{ chord: getDefaultCommandShortcut("media.flow.paste") }],
        palette: "visible",
        availability: () =>
          mediaCommandStateRef.current.canPasteNode
            ? { state: "enabled" }
            : {
                state: "disabled",
                reason:
                  mediaCommandStateRef.current.pasteBlockedReason ??
                  "Copy a node before pasting",
              },
        execute: () => {
          const nodeId = mediaCommandStateRef.current.onNodePaste();
          if (nodeId) {
            setPalettePanelOpen(false);
            setGroupsPanelOpen(false);
            setSelectionPanelOpen(false);
            setSelectedNodeId(nodeId);
          }
        },
      },
      {
        id: "media.flow.save",
        title: "Save workflow revision",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("media.flow.save"),
            runtimes: ["tauri"],
            allowIn: [
              "document",
              "text-entry",
              "interactive-control",
              "command-surface",
            ],
          },
        ],
        palette: "visible",
        availability: () => {
          const state = mediaCommandStateRef.current;
          return state.hasUnsavedChanges && !state.revisionLoading
            ? { state: "enabled" }
            : {
                state: "disabled",
                reason: state.revisionLoading
                  ? "A revision is being saved"
                  : "No unsaved workflow changes",
              };
        },
        execute: () => mediaCommandStateRef.current.onSaveRevision(),
      },
      {
        id: "media.flow.open",
        title: "Open saved workflow",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () => {
          const state = mediaCommandStateRef.current;
          return !state.savedFlowsLoading && state.savedFlows.length > 0
            ? { state: "enabled" }
            : {
                state: "disabled",
                reason: state.savedFlowsLoading
                  ? "Saved workflows are loading"
                  : "No saved workflows",
              };
        },
        children: () => ({
          id: "media-flow-open",
          title: "Open saved workflow",
          searchPlaceholder: "Choose workflow",
          groups: [
            {
              id: "workflows",
              items: mediaCommandStateRef.current.savedFlows.map(
                (savedFlow) => ({
                  id: savedFlow.flowId,
                  title: savedFlow.name,
                  keywords: [`revision ${savedFlow.headRevisionNumber}`],
                  current:
                    mediaCommandStateRef.current.flow.id === savedFlow.flowId,
                  execute: () =>
                    mediaCommandStateRef.current.onOpenSavedFlow(
                      savedFlow.flowId,
                    ),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "media.flow.saved.refresh",
        title: "Refresh saved workflows",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () =>
          mediaCommandStateRef.current.savedFlowsLoading
            ? { state: "disabled", reason: "Saved workflows are loading" }
            : { state: "enabled" },
        execute: () => mediaCommandStateRef.current.onRefreshSavedFlows(),
      },
      {
        id: "media.flow.history.refresh",
        title: "Refresh workflow history",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () =>
          mediaCommandStateRef.current.revisionLoading
            ? { state: "disabled", reason: "Workflow history is loading" }
            : { state: "enabled" },
        execute: () => mediaCommandStateRef.current.onRefreshHistory(),
      },
      {
        id: "media.flow.revision.restore",
        title: "Restore workflow revision",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () =>
          (mediaCommandStateRef.current.history?.revisions.length ?? 0) > 0 &&
          !mediaCommandStateRef.current.revisionLoading
            ? { state: "enabled" }
            : {
                state: "disabled",
                reason: "No workflow revisions are available",
              },
        children: () => ({
          id: "media-flow-revision-restore",
          title: "Restore workflow revision",
          searchPlaceholder: "Choose revision",
          groups: [
            {
              id: "revisions",
              items:
                mediaCommandStateRef.current.history?.revisions.map(
                  (revision) => ({
                    id: revision.revisionId,
                    title: `Revision ${revision.revisionNumber}`,
                    keywords: [revision.createdAt],
                    execute: () =>
                      mediaCommandStateRef.current.onRestoreRevision(revision),
                  }),
                ) ?? [],
            },
          ],
        }),
      },
      {
        id: "media.flow.run",
        title: "Run workflow",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        shortcuts: [{ chord: getDefaultCommandShortcut("media.flow.run") }],
        palette: "visible",
        availability: () => {
          const state = mediaCommandStateRef.current;
          return !state.revisionLoading &&
            !state.localRunPending &&
            !state.remoteRunPending &&
            (state.localRunSupported || state.remoteRunSupported)
            ? { state: "enabled" }
            : {
                state: "disabled",
                reason:
                  state.localRunPending || state.remoteRunPending
                    ? "A workflow run is already starting"
                    : "This workflow has no available executor",
              };
        },
        execute: () => {
          const state = mediaCommandStateRef.current;
          if (state.localRunSupported) state.onRunLocalFlow();
          else if (state.remoteRunSupported)
            state.setRemoteConfirmationOpen(true);
        },
      },
      {
        id: "media.flow.run-local",
        title: "Run workflow locally",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () => {
          const state = mediaCommandStateRef.current;
          return state.localRunSupported &&
            !state.localRunPending &&
            !state.revisionLoading
            ? { state: "enabled" }
            : {
                state: "disabled",
                reason: state.localRunPending
                  ? "A local run is already starting"
                  : state.localRunDescription,
              };
        },
        execute: () => mediaCommandStateRef.current.onRunLocalFlow(),
      },
      {
        id: "media.flow.run-remote.review",
        title: "Review remote workflow run",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () => {
          const state = mediaCommandStateRef.current;
          return state.remoteRunSupported &&
            !state.remoteRunPending &&
            !state.revisionLoading
            ? { state: "enabled" }
            : {
                state: "disabled",
                reason: state.remoteRunPending
                  ? "A remote run is already starting"
                  : state.remoteRunDescription,
              };
        },
        execute: () =>
          mediaCommandStateRef.current.setRemoteConfirmationOpen(true),
      },
      {
        id: "media.flow.import.inspect",
        title: "Import workflow",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () => {
          const state = mediaCommandStateRef.current;
          return state.portabilitySupported && !state.portabilityLoading
            ? { state: "enabled" }
            : {
                state: "disabled",
                reason: state.portabilityLoading
                  ? "A portability operation is running"
                  : "Workflow import requires the desktop app",
              };
        },
        execute: () => mediaCommandStateRef.current.onInspectImport(),
      },
      {
        id: "media.flow.import.apply",
        title: "Apply reviewed workflow import",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () =>
          mediaCommandStateRef.current.importInspection &&
          !mediaCommandStateRef.current.portabilityLoading
            ? { state: "enabled" }
            : { state: "disabled", reason: "No reviewed import is ready" },
        execute: () => mediaCommandStateRef.current.onImportReviewed(),
      },
      {
        id: "media.flow.export",
        title: "Export workflow revision",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () => {
          const state = mediaCommandStateRef.current;
          return state.portabilitySupported &&
            Boolean(state.history?.head) &&
            !state.hasUnsavedChanges &&
            !state.portabilityLoading
            ? { state: "enabled" }
            : {
                state: "disabled",
                reason: state.hasUnsavedChanges
                  ? "Save the workflow before exporting"
                  : "No saved revision is available",
              };
        },
        execute: () => mediaCommandStateRef.current.onExportRevision(),
      },
      {
        id: "media.flow.panel.select",
        title: "Open workflow panel",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        children: () => ({
          id: "media-flow-panel",
          title: "Workflow panel",
          searchPlaceholder: "Choose panel",
          numericSelection: true,
          groups: [
            {
              id: "panels",
              items: (
                [
                  ["templates", "Templates"],
                  ["variables", "Variables and presets"],
                  ["groups", "Groups"],
                  ["selection", "Selection"],
                  ["portability", "Import"],
                  ["history", "Revision history"],
                  ["plan", "Runtime plan"],
                ] as const
              ).map(([panel, title], index) => ({
                id: panel,
                title,
                numericKey: String(index + 1) as
                  | "1"
                  | "2"
                  | "3"
                  | "4"
                  | "5"
                  | "6"
                  | "7",
                availability:
                  panel === "history" &&
                  (mediaCommandStateRef.current.history?.revisions.length ??
                    0) === 0
                    ? {
                        state: "disabled" as const,
                        reason: "No revision history",
                      }
                    : panel === "portability" &&
                        !mediaCommandStateRef.current.portabilitySupported
                      ? {
                          state: "disabled" as const,
                          reason: "Workflow import requires the desktop app",
                        }
                      : ({ state: "enabled" } as const),
                execute: () =>
                  mediaCommandStateRef.current.toggleFlowPanel(panel),
              })),
            },
          ],
        }),
      },
      {
        id: "media.flow.run-overlay.clear",
        title: "Close run details",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () =>
          mediaCommandStateRef.current.runOverlay
            ? { state: "enabled" }
            : { state: "disabled", reason: "No run details are open" },
        execute: () => mediaCommandStateRef.current.onRunOverlayClear(),
      },
    ],
    [mediaCommandStateRef],
  );
  useOptionalRegisterCommands(mediaCommands);
  const undoShortcut = useOptionalCommandShortcut("media.flow.undo");
  const redoShortcut = useOptionalCommandShortcut("media.flow.redo");
  const copyShortcut = useOptionalCommandShortcut("media.selection.copy");
  const pasteShortcut = useOptionalCommandShortcut("media.flow.paste");

  useEffect(() => {
    const handleKeyboardShortcut = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (
        event.key === "Escape" &&
        (palettePanelOpen ||
          selectionPanelOpen ||
          variablesPanelOpen ||
          templatesPanelOpen)
      ) {
        setPalettePanelOpen(false);
        setSelectionPanelOpen(false);
        setVariablesPanelOpen(false);
        setTemplatesPanelOpen(false);
        return;
      }
    };
    window.addEventListener("keydown", handleKeyboardShortcut);
    return () => window.removeEventListener("keydown", handleKeyboardShortcut);
  }, [
    palettePanelOpen,
    selectionPanelOpen,
    variablesPanelOpen,
    templatesPanelOpen,
  ]);

  useEffect(() => {
    if (!templatesPanelOpen) return;
    if (
      planPanelOpen ||
      historyPanelOpen ||
      portabilityPanelOpen ||
      palettePanelOpen ||
      groupsPanelOpen ||
      variablesPanelOpen ||
      selectionPanelOpen ||
      selectedNode !== undefined
    ) {
      setTemplatesPanelOpen(false);
    }
  }, [
    groupsPanelOpen,
    historyPanelOpen,
    palettePanelOpen,
    planPanelOpen,
    portabilityPanelOpen,
    selectedNode,
    selectionPanelOpen,
    templatesPanelOpen,
    variablesPanelOpen,
  ]);

  const isValidConnection = useCallback(
    (connection: Connection | Edge): boolean => {
      if (!connection.sourceHandle || !connection.targetHandle) return false;
      return inspectMediaFlowConnection(flow, {
        fromNodeId: connection.source,
        fromPortId: connection.sourceHandle,
        toNodeId: connection.target,
        toPortId: connection.targetHandle,
      }).valid;
    },
    [flow],
  );

  const handleConnect = useCallback(
    (connection: Connection): void => {
      if (!connection.sourceHandle || !connection.targetHandle) return;
      onConnectPorts({
        fromNodeId: connection.source,
        fromPortId: connection.sourceHandle,
        toNodeId: connection.target,
        toPortId: connection.targetHandle,
      });
    },
    [onConnectPorts],
  );

  useLayoutEffect(() => {
    const preservePositions =
      previousCanvasLayoutKey.current === canvasLayoutKey;
    setCanvasNodes((nodes) =>
      reconcileMediaCanvasNodes(nodes, projectedCanvasNodes, preservePositions),
    );
    setCanvasEdges((edges) =>
      reconcileMediaCanvasEdges(edges, projectedCanvasEdges),
    );
    previousCanvasLayoutKey.current = canvasLayoutKey;
  }, [
    canvasLayoutKey,
    projectedCanvasEdges,
    projectedCanvasNodes,
    setCanvasEdges,
    setCanvasNodes,
  ]);

  useEffect(() => {
    setFollowRun(runOverlay !== null);
    lastFollowedActiveNodes.current = "";
  }, [runOverlay?.id]);

  useEffect(() => {
    if (
      !followRun ||
      !activeNodeSignature ||
      activeNodeSignature === lastFollowedActiveNodes.current
    ) {
      return;
    }
    lastFollowedActiveNodes.current = activeNodeSignature;
    const activeNodeIds = new Set(
      visualRunOverlayProjection?.activeNodeIds ?? [],
    );
    const activeNodes = canvasNodes.filter((node) =>
      activeNodeIds.has(node.id),
    );
    if (activeNodes.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      void flowInstance.current?.fitView({
        nodes: activeNodes,
        padding: 0.8,
        duration: 260,
        maxZoom: 1.15,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeNodeSignature,
    canvasNodes,
    followRun,
    visualRunOverlayProjection,
  ]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void flowInstance.current?.fitView({
        padding: FLOW_CANVAS_FIT_PADDING,
        duration: 180,
        maxZoom: FLOW_CANVAS_FIT_MAX_ZOOM,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panelOpen, topologyKey]);

  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    setHistoryRevision((revision) => revision + 1);
    setSelectedNodeId((current) =>
      current && flow.nodes.some((node) => node.id === current)
        ? current
        : null,
    );
  }, [flow.nodes, topologyKey]);

  useEffect(() => {
    setSelectedNodeIds((current) =>
      current.filter(
        (nodeId) =>
          flow.nodes.some((node) => node.id === nodeId) &&
          !collapsedNodeIds.has(nodeId),
      ),
    );
  }, [collapsedNodeIds, flow.nodes]);

  const commitLayout = useCallback(
    (nextLayout: MediaFlowLayout): void => {
      const nodesUnchanged =
        nextLayout.nodes.length === layout.nodes.length &&
        nextLayout.nodes.every((entry, index) => {
          const current = layout.nodes[index];
          return (
            current?.nodeId === entry.nodeId &&
            current.x === entry.x &&
            current.y === entry.y
          );
        });
      const groupsUnchanged =
        nextLayout.groups.length === layout.groups.length &&
        nextLayout.groups.every((group, index) => {
          const current = layout.groups[index];
          return (
            current?.id === group.id &&
            current.label === group.label &&
            current.color === group.color &&
            current.collapsed === group.collapsed &&
            current.nodeIds.length === group.nodeIds.length &&
            current.nodeIds.every(
              (nodeId, nodeIndex) => nodeId === group.nodeIds[nodeIndex],
            )
          );
        });
      const commentsUnchanged =
        nextLayout.comments.length === layout.comments.length &&
        nextLayout.comments.every((comment, index) => {
          const current = layout.comments[index];
          return (
            current?.id === comment.id &&
            current.body === comment.body &&
            current.color === comment.color &&
            current.x === comment.x &&
            current.y === comment.y &&
            current.width === comment.width &&
            current.height === comment.height
          );
        });
      if (nodesUnchanged && groupsUnchanged && commentsUnchanged) {
        return;
      }

      undoStack.current = [...undoStack.current.slice(-99), layout];
      redoStack.current = [];
      onLayoutChange(nextLayout);
      setHistoryRevision((revision) => revision + 1);
    },
    [layout, onLayoutChange],
  );

  const handleSelectionChange = useCallback(
    ({ nodes }: OnSelectionChangeParams<MediaCanvasNode, Edge>): void => {
      setSelectedNodeIds(
        nodes.flatMap((node) => (node.type === "mediaNode" ? [node.id] : [])),
      );
    },
    [],
  );

  const applyCanvasSelection = useCallback(
    (nodeIds: readonly string[]): void => {
      const visibleNodeIds = new Set(
        flow.nodes
          .filter((node) => !collapsedNodeIds.has(node.id))
          .map((node) => node.id),
      );
      const nextNodeIds = nodeIds.filter((nodeId) =>
        visibleNodeIds.has(nodeId),
      );
      const nextNodeIdSet = new Set(nextNodeIds);
      setSelectedNodeIds(nextNodeIds);
      setSelectedNodeId(null);
      setCanvasNodes((nodes) =>
        nodes.map((node) =>
          node.type === "mediaNode"
            ? { ...node, selected: nextNodeIdSet.has(node.id) }
            : node,
        ),
      );
    },
    [collapsedNodeIds, flow.nodes, setCanvasNodes],
  );

  const selectAllFlowNodes = useCallback((): void => {
    const nodeIds = flow.nodes
      .filter((node) => !collapsedNodeIds.has(node.id))
      .map((node) => node.id);
    applyCanvasSelection(nodeIds);
  }, [applyCanvasSelection, collapsedNodeIds, flow.nodes]);

  const groupedNodeIds = useMemo(
    () => new Set(layout.groups.flatMap((group) => group.nodeIds)),
    [layout.groups],
  );
  const selectedGroupConflict = selectedNodeIds.find((nodeId) =>
    groupedNodeIds.has(nodeId),
  );
  const canGroupSelection =
    selectedNodeIds.length >= 2 && selectedGroupConflict === undefined;

  const groupSelectedNodes = useCallback((): void => {
    try {
      const result = addMediaFlowLayoutGroup({
        layout,
        nodeIds: selectedNodeIds,
      });
      commitLayout(result.layout);
      setSelectedNodeIds([]);
      setLayoutNotice(
        `Created ${result.groupId} with ${selectedNodeIds.length} nodes.`,
      );
      setSelectedNodeId(null);
      setPlanPanelOpen(false);
      setHistoryPanelOpen(false);
      setPortabilityPanelOpen(false);
      setPalettePanelOpen(false);
      setSelectionPanelOpen(false);
      setVariablesPanelOpen(false);
      setGroupsPanelOpen(true);
    } catch (error: unknown) {
      setLayoutNotice(
        error instanceof Error
          ? error.message
          : "The selected nodes could not be grouped.",
      );
    }
  }, [commitLayout, layout, selectedNodeIds]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<MediaCanvasNode>[]): void => {
      applyCanvasNodeChanges(changes);
      const completedPositions = new Map(
        changes.flatMap((change) =>
          change.type === "position" &&
          change.position &&
          change.dragging !== true
            ? [[change.id, change.position] as const]
            : [],
        ),
      );
      if (completedPositions.size === 0) {
        return;
      }
      commitLayout({
        ...layout,
        nodes: layout.nodes.map((entry) => {
          const position = completedPositions.get(entry.nodeId);
          return position ? { ...entry, x: position.x, y: position.y } : entry;
        }),
        comments: layout.comments.map((comment) => {
          const position = completedPositions.get(
            `layout-comment:${comment.id}`,
          );
          return position
            ? { ...comment, x: position.x, y: position.y }
            : comment;
        }),
      });
    },
    [applyCanvasNodeChanges, commitLayout, layout],
  );

  const autoLayout = useCallback((): void => {
    commitLayout({
      ...createMediaFlowLayout(flow),
      groups: layout.groups,
      comments: layout.comments,
    });
  }, [commitLayout, flow, layout.comments, layout.groups]);

  const undoLayout = useCallback((): void => {
    const previous = undoStack.current.at(-1);
    if (!previous) {
      return;
    }
    undoStack.current = undoStack.current.slice(0, -1);
    redoStack.current = [...redoStack.current.slice(-99), layout];
    onLayoutChange(previous);
    setHistoryRevision((revision) => revision + 1);
  }, [layout, onLayoutChange]);

  const redoLayout = useCallback((): void => {
    const next = redoStack.current.at(-1);
    if (!next) {
      return;
    }
    redoStack.current = redoStack.current.slice(0, -1);
    undoStack.current = [...undoStack.current.slice(-99), layout];
    onLayoutChange(next);
    setHistoryRevision((revision) => revision + 1);
  }, [layout, onLayoutChange]);
  const layoutCommandStateRef = useRef({
    autoLayout,
    canGroupSelection,
    commitLayout,
    flow,
    groupSelectedNodes,
    layout,
    onNodeRemove,
    redoLayout,
    selectAllFlowNodes,
    selectedNodeId,
    selectedNodeIds,
    setGroupsPanelOpen,
    setSelectedNodeId,
    setSelectedNodeIds,
    undoLayout,
  });
  layoutCommandStateRef.current = {
    autoLayout,
    canGroupSelection,
    commitLayout,
    flow,
    groupSelectedNodes,
    layout,
    onNodeRemove,
    redoLayout,
    selectAllFlowNodes,
    selectedNodeId,
    selectedNodeIds,
    setGroupsPanelOpen,
    setSelectedNodeId,
    setSelectedNodeIds,
    undoLayout,
  };
  const layoutCommands = useMemo<readonly CommandDefinition[]>(
    () => [
      {
        id: "media.layout.undo",
        title: "Undo layout change",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () =>
          undoStack.current.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "Nothing to undo in the layout" },
        execute: () => layoutCommandStateRef.current.undoLayout(),
      },
      {
        id: "media.layout.redo",
        title: "Redo layout change",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () =>
          redoStack.current.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "Nothing to redo in the layout" },
        execute: () => layoutCommandStateRef.current.redoLayout(),
      },
      {
        id: "media.layout.auto",
        title: "Auto-layout workflow",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        execute: () => layoutCommandStateRef.current.autoLayout(),
      },
      {
        id: "media.selection.select-all",
        title: "Select all workflow nodes",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("media.selection.select-all"),
            runtimes: ["tauri"],
          },
        ],
        palette: "visible",
        availability: () =>
          layoutCommandStateRef.current.flow.nodes.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "The workflow has no nodes" },
        execute: () => layoutCommandStateRef.current.selectAllFlowNodes(),
      },
      {
        id: "media.selection.delete",
        title: "Delete selected workflow nodes",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        shortcuts: [
          { chord: getDefaultCommandShortcut("media.selection.delete") },
          {
            chord: getDefaultCommandShortcut(
              "media.selection.delete-backspace",
            ),
          },
        ],
        palette: "visible",
        availability: () => {
          const state = layoutCommandStateRef.current;
          return state.selectedNodeIds.length > 0 || state.selectedNodeId
            ? { state: "enabled" }
            : { state: "disabled", reason: "Select one or more nodes" };
        },
        execute: () => {
          const state = layoutCommandStateRef.current;
          const nodeIds =
            state.selectedNodeIds.length > 0
              ? state.selectedNodeIds
              : state.selectedNodeId
                ? [state.selectedNodeId]
                : [];
          nodeIds.forEach((nodeId) => state.onNodeRemove(nodeId));
          state.setSelectedNodeIds([]);
          state.setSelectedNodeId(null);
        },
      },
      {
        id: "media.selection.group",
        title: "Group selected workflow nodes",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () =>
          layoutCommandStateRef.current.canGroupSelection
            ? { state: "enabled" }
            : {
                state: "disabled",
                reason: "Select at least two ungrouped nodes",
              },
        execute: () => layoutCommandStateRef.current.groupSelectedNodes(),
      },
      {
        id: "media.layout.group.remove",
        title: "Remove visual group",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () =>
          layoutCommandStateRef.current.layout.groups.length > 0
            ? { state: "enabled" }
            : { state: "disabled", reason: "No visual groups" },
        children: () => ({
          id: "media-layout-group-remove",
          title: "Remove visual group",
          searchPlaceholder: "Choose group",
          groups: [
            {
              id: "groups",
              items: layoutCommandStateRef.current.layout.groups.map(
                (group) => ({
                  id: group.id,
                  title: group.label,
                  execute: () => {
                    const state = layoutCommandStateRef.current;
                    state.commitLayout(
                      removeMediaFlowLayoutGroup(state.layout, group.id),
                    );
                  },
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "media.layout.comment.add",
        title: "Add canvas comment",
        group: "Media",
        scope: { kind: "view", ownerId: "media" },
        palette: "visible",
        availability: () =>
          layoutCommandStateRef.current.layout.comments.length < 64
            ? { state: "enabled" }
            : { state: "disabled", reason: "The canvas has 64 comments" },
        execute: () => {
          const state = layoutCommandStateRef.current;
          state.commitLayout(
            addMediaFlowLayoutComment({ layout: state.layout }).layout,
          );
          state.setGroupsPanelOpen(true);
        },
      },
    ],
    [layoutCommandStateRef],
  );
  useOptionalRegisterCommands(layoutCommands);

  const runPending = localRunPending || remoteRunPending;
  const runSupported = localRunSupported || remoteRunSupported;
  const runDescription = localRunSupported
    ? localRunDescription
    : remoteRunSupported
      ? remoteRunDescription
      : localRunDescription || remoteRunDescription;
  const planErrors = plan.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  const firstPlanError = planErrors[0] ?? null;
  const fixFirstPlanError = (): void => {
    if (!firstPlanError?.nodeId) {
      setPlanPanelOpen(true);
      return;
    }
    setPlanPanelOpen(false);
    setHistoryPanelOpen(false);
    setPortabilityPanelOpen(false);
    setPalettePanelOpen(false);
    setGroupsPanelOpen(false);
    setSelectionPanelOpen(false);
    setVariablesPanelOpen(false);
    setTemplatesPanelOpen(false);
    setSelectedNodeId(firstPlanError.nodeId);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-950">
      <header className="grid shrink-0 gap-3 border-b border-slate-800/80 px-3 py-3 sm:px-6 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <GitBranch className="h-4 w-4 text-cyan-300" />
            <span className="max-w-72 truncate">{flow.name}</span>
            {hasUnsavedChanges ? (
              <span className="text-[10px] font-medium text-amber-300">
                Unsaved changes
              </span>
            ) : history?.head ? (
              <span className="text-[10px] font-normal text-slate-500">
                Revision {history.head.headRevisionNumber}
              </span>
            ) : null}
            {plan.status !== "ready" ? (
              <button
                type="button"
                aria-expanded={planPanelOpen}
                onClick={fixFirstPlanError}
                className="rounded text-[10px] font-medium text-rose-300 outline-none hover:text-rose-200 focus-visible:ring-2 focus-visible:ring-rose-300/40"
              >
                Review {planErrors.length || "preflight"} issue
                {planErrors.length === 1 ? "" : "s"}
              </button>
            ) : null}
          </div>
          {revisionNotice ? (
            <p
              className="mt-1 text-[10px] text-cyan-300"
              role="status"
              aria-live="polite"
            >
              {revisionNotice}
            </p>
          ) : null}
          {layoutNotice ? (
            <p
              className="mt-1 text-[10px] text-cyan-300"
              role="status"
              aria-live="polite"
            >
              {layoutNotice}
            </p>
          ) : null}
        </div>
        <div className="flex max-w-full items-center gap-2 overflow-x-auto pb-1 xl:justify-end xl:pb-0">
          <div
            className="flex items-center"
            aria-label="Semantic editing controls"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Undo semantic change"
              aria-keyshortcuts={undoShortcut?.ariaKeyShortcuts}
              title={`Undo semantic change${undoShortcut ? ` (${undoShortcut.label})` : ""}`}
              disabled={!canUndoSemantic}
              onClick={onUndoSemantic}
              className="text-cyan-300/70 hover:bg-cyan-400/10 hover:text-cyan-200"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Redo semantic change"
              aria-keyshortcuts={redoShortcut?.ariaKeyShortcuts}
              title={`Redo semantic change${redoShortcut ? ` (${redoShortcut.label})` : ""}`}
              disabled={!canRedoSemantic}
              onClick={onRedoSemantic}
              className="text-cyan-300/70 hover:bg-cyan-400/10 hover:text-cyan-200"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={
                clipboardLabel ? `Paste ${clipboardLabel}` : "Paste copied node"
              }
              aria-keyshortcuts={pasteShortcut?.ariaKeyShortcuts}
              title={
                canPasteNode
                  ? `Paste ${clipboardLabel ?? "copied node"}${pasteShortcut ? ` (${pasteShortcut.label})` : ""}`
                  : (pasteBlockedReason ?? "Copy a node before pasting")
              }
              disabled={!canPasteNode}
              onClick={() => {
                const nodeId = onNodePaste();
                if (nodeId) {
                  setGroupsPanelOpen(false);
                  setSelectionPanelOpen(false);
                  setSelectedNodeId(nodeId);
                }
              }}
              className="text-cyan-300/70 hover:bg-cyan-400/10 hover:text-cyan-200"
            >
              <ClipboardPaste className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div
            className="flex items-center"
            aria-label="Canvas selection controls"
          >
            <button
              type="button"
              aria-label={`Manage node selection · ${selectedNodeIds.length}`}
              aria-expanded={selectionPanelOpen}
              title="Choose an exact set of semantic nodes"
              onClick={() => {
                setSelectedNodeId(null);
                setPlanPanelOpen(false);
                setHistoryPanelOpen(false);
                setPortabilityPanelOpen(false);
                setPalettePanelOpen(false);
                setGroupsPanelOpen(false);
                setVariablesPanelOpen(false);
                setSelectionPanelOpen((open) => !open);
              }}
              className="rounded-md px-2 py-1 text-[9px] tabular-nums text-violet-300/70 transition-colors hover:bg-violet-400/10 hover:text-violet-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/30"
            >
              Select
              {selectedNodeIds.length > 0 ? ` · ${selectedNodeIds.length}` : ""}
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Select all visible flow nodes"
              title="Select all visible semantic nodes"
              onClick={selectAllFlowNodes}
              className="text-violet-300/70 hover:bg-violet-400/10 hover:text-violet-200"
            >
              <Box className="h-3.5 w-3.5" />
            </Button>
            {selectedNodeIds.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Copy ${selectedNodeIds.length} selected nodes`}
                aria-keyshortcuts={copyShortcut?.ariaKeyShortcuts}
                title={`Copy selected semantic nodes and their internal connections${copyShortcut ? ` (${copyShortcut.label})` : ""}`}
                disabled={selectedNodeIds.length === 0}
                onClick={() => onNodesCopy(selectedNodeIds)}
                className="text-violet-300/70 hover:bg-violet-400/10 hover:text-violet-200"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            {selectedNodeIds.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Group ${selectedNodeIds.length} selected nodes`}
                title={
                  selectedGroupConflict
                    ? "A selected node already belongs to a visual group"
                    : selectedNodeIds.length < 2
                      ? "Select at least two nodes"
                      : "Create a layout-only visual group"
                }
                disabled={!canGroupSelection}
                onClick={groupSelectedNodes}
                className="text-violet-300/70 hover:bg-violet-400/10 hover:text-violet-200"
              >
                <Group className="h-3.5 w-3.5" />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Manage canvas organization · ${layout.groups.length} groups · ${layout.comments.length} comments`}
              aria-expanded={groupsPanelOpen}
              title="Manage visual groups and canvas comments"
              onClick={() => {
                setSelectedNodeId(null);
                setPlanPanelOpen(false);
                setHistoryPanelOpen(false);
                setPortabilityPanelOpen(false);
                setPalettePanelOpen(false);
                setSelectionPanelOpen(false);
                setVariablesPanelOpen(false);
                setGroupsPanelOpen((open) => !open);
              }}
              className="text-violet-300/70 hover:bg-violet-400/10 hover:text-violet-200"
            >
              <Group className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div
            className="flex items-center"
            aria-label="Layout history controls"
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Undo layout change"
              disabled={undoStack.current.length === 0}
              onClick={undoLayout}
              className="text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Redo layout change"
              disabled={redoStack.current.length === 0}
              onClick={redoLayout}
              className="text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Auto-layout flow"
              onClick={autoLayout}
              className="text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            >
              <LayoutDashboard className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <SavedWorkflowPicker
              flow={flow}
              savedFlows={savedFlows}
              loading={savedFlowsLoading}
              onOpen={onOpenSavedFlow}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh saved workflows"
              disabled={savedFlowsLoading}
              onClick={onRefreshSavedFlows}
              className="text-slate-500 hover:bg-slate-800 hover:text-slate-200"
            >
              <RefreshCw
                className={cn(
                  "h-3.5 w-3.5",
                  savedFlowsLoading && "animate-spin",
                )}
              />
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Browse built-in flow templates"
            aria-expanded={templatesPanelOpen}
            onClick={() => {
              if (templatesPanelOpen) {
                setTemplatesPanelOpen(false);
                return;
              }
              setSelectedNodeId(null);
              setPlanPanelOpen(false);
              setHistoryPanelOpen(false);
              setPortabilityPanelOpen(false);
              setPalettePanelOpen(false);
              setGroupsPanelOpen(false);
              setSelectionPanelOpen(false);
              setVariablesPanelOpen(false);
              setTemplatesPanelOpen(true);
            }}
            className="h-8 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100"
          >
            <LayoutTemplate className="h-3.5 w-3.5" />
            Templates
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Manage variables and presets · ${flow.variables.length} variables · ${flow.presets.length} presets`}
            aria-expanded={variablesPanelOpen}
            onClick={() => {
              setSelectedNodeId(null);
              setPlanPanelOpen(false);
              setHistoryPanelOpen(false);
              setPortabilityPanelOpen(false);
              setPalettePanelOpen(false);
              setGroupsPanelOpen(false);
              setSelectionPanelOpen(false);
              setTemplatesPanelOpen(false);
              setVariablesPanelOpen((open) => !open);
            }}
            className="h-8 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100"
          >
            <Braces className="h-3.5 w-3.5" />
            Variables · {flow.variables.length}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={openCommandPage ? undefined : palettePanelOpen}
            title="Add node"
            onClick={(event) => {
              if (openCommandPage) {
                openCommandPage(nodeCommandPage, {
                  presentation: "popover",
                  anchor: event.currentTarget,
                });
              } else if (palettePanelOpen) {
                setPalettePanelOpen(false);
              } else {
                openNodePalette();
              }
            }}
            className="h-8 border-cyan-400/25 bg-cyan-400/5 text-xs text-cyan-200 hover:bg-cyan-400/10"
          >
            <Plus className="h-3.5 w-3.5" />
            Add node
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={portabilityPanelOpen}
            disabled={portabilityLoading}
            onClick={() => {
              setSelectedNodeId(null);
              setPlanPanelOpen(false);
              setHistoryPanelOpen(false);
              setGroupsPanelOpen(false);
              setPalettePanelOpen(false);
              setSelectionPanelOpen(false);
              setVariablesPanelOpen(false);
              setPortabilityPanelOpen((open) => !open);
            }}
            className="h-8 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100"
          >
            <FileUp className="h-3.5 w-3.5" />
            Import
          </Button>
          {portabilitySupported && history?.head && !hasUnsavedChanges ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={portabilityLoading}
              title="Export the current immutable head revision"
              onClick={onExportRevision}
              className="h-8 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              {portabilityLoading ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileDown className="h-3.5 w-3.5" />
              )}
              Export
            </Button>
          ) : null}
          {hasUnsavedChanges || revisionLoading ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={revisionLoading || !hasUnsavedChanges}
              onClick={onSaveRevision}
              className="h-8 border-cyan-400/25 bg-cyan-400/5 text-xs text-cyan-200 hover:bg-cyan-400/10"
            >
              {revisionLoading ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {revisionLoading
                ? "Saving…"
                : history?.head
                  ? "Save revision"
                  : "Save first revision"}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            aria-describedby="media-run-description"
            disabled={runPending || revisionLoading || !runSupported}
            title={runDescription}
            onClick={() => {
              if (localRunSupported) onRunLocalFlow();
              else if (remoteRunSupported) setRemoteConfirmationOpen(true);
            }}
            className="h-9 bg-cyan-500 px-4 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:bg-slate-800 disabled:text-slate-500"
          >
            {runPending ? (
              <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : remoteRunSupported && !localRunSupported ? (
              <Cloud className="h-4 w-4" />
            ) : (
              <CirclePlay className="h-4 w-4" />
            )}
            {runPending ? "Running…" : "Run"}
          </Button>
          <span id="media-run-description" className="sr-only">
            {runDescription}
          </span>
          {(history?.revisions.length ?? 0) > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={historyPanelOpen}
              onClick={() => {
                setSelectedNodeId(null);
                setPlanPanelOpen(false);
                setPortabilityPanelOpen(false);
                setGroupsPanelOpen(false);
                setPalettePanelOpen(false);
                setSelectionPanelOpen(false);
                setVariablesPanelOpen(false);
                setHistoryPanelOpen((open) => !open);
              }}
              className="h-8 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <History className="h-3.5 w-3.5" />
              History · {history?.revisions.length ?? 0}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={planPanelOpen}
            onClick={() => toggleFlowPanel("plan")}
            className="h-8 text-xs text-slate-400 hover:bg-slate-900 hover:text-slate-100"
          >
            {planPanelOpen ? (
              <PanelRightClose className="h-3.5 w-3.5" />
            ) : (
              <PanelRightOpen className="h-3.5 w-3.5" />
            )}
            Runtime plan · {plan.steps.length}
          </Button>
        </div>
      </header>

      {firstPlanError ? (
        <section
          role="alert"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-rose-400/20 bg-rose-400/5 px-3 py-2 sm:px-6"
        >
          <p className="min-w-0 text-xs text-rose-100">
            {firstPlanError.code === "PROMPT_REQUIRED"
              ? "Prompt is required."
              : firstPlanError.message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={fixFirstPlanError}
            className="h-8 shrink-0 border-rose-300/30 bg-rose-300/5 text-rose-100 hover:bg-rose-300/10"
          >
            Fix
          </Button>
        </section>
      ) : null}

      {runOverlay && runOverlayProjection ? (
        <section
          aria-label="Run status"
          className="shrink-0 border-b border-cyan-400/15 bg-cyan-400/[0.045] px-6 py-3"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn(
                    "capitalize",
                    runOverlay.status === "completed"
                      ? "border-emerald-300/30 text-emerald-200"
                      : runOverlay.status === "failed"
                        ? "border-rose-300/35 text-rose-200"
                        : runOverlay.status === "waiting-for-review"
                          ? "border-fuchsia-300/35 text-fuchsia-200"
                          : "border-cyan-300/25 text-cyan-200",
                  )}
                >
                  {runOverlay.status.replaceAll("-", " ")}
                </Badge>
                <p className="min-w-0 break-words text-[11px] leading-4 font-semibold text-slate-200">
                  {runOverlay.flowName}
                </p>
              </div>
              <p className="mt-1 text-[9px] leading-4 text-slate-500">
                {Math.round(runOverlay.progress * 100)}% ·{" "}
                {runOverlay.assets.length} output
                {runOverlay.assets.length === 1 ? "" : "s"}
              </p>
              <p
                aria-live="polite"
                className="mt-1 text-[10px] font-medium text-cyan-100/85"
              >
                {activeNodeSummary
                  ? `Current flow: ${activeNodeSummary}`
                  : runOverlay.status === "completed"
                    ? "Flow complete"
                    : `Current flow: ${runOverlay.currentStep}`}
              </p>
              {!runOverlayProjection.exactFlowMatch ? (
                <p
                  role="status"
                  className="mt-2 flex items-start gap-1.5 text-[9px] leading-4 text-amber-200/80"
                >
                  <CircleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    This run uses a different workflow revision, so only
                    matching nodes are shown.
                  </span>
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={followRun}
                onClick={() => {
                  lastFollowedActiveNodes.current = "";
                  setFollowRun((current) => !current);
                }}
                className={cn(
                  "h-8 border-slate-700 bg-slate-950/50 text-xs hover:bg-slate-900",
                  followRun ? "text-cyan-200" : "text-slate-400",
                )}
              >
                <LocateFixed className="h-3.5 w-3.5" /> Follow run
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRunOverlayClear}
                className="h-8 border-slate-700 bg-slate-950/50 text-xs text-slate-300 hover:bg-slate-900"
              >
                <PanelRightClose className="h-3.5 w-3.5" /> Close
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      <div
        className={cn(
          "relative grid min-h-0 flex-1",
          panelOpen
            ? "grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px]"
            : "grid-cols-1",
        )}
      >
        <div data-command-focus="document" className="relative min-h-0">
          <FlowCanvas<MediaCanvasNode, MediaCanvasEdge>
            providerKey={flow.id}
            nodes={canvasNodes}
            edges={canvasEdges}
            nodeTypes={NODE_TYPES}
            onInit={(instance) => {
              flowInstance.current = instance;
              window.requestAnimationFrame(() => {
                void instance.fitView({
                  padding: FLOW_CANVAS_FIT_PADDING,
                  maxZoom: FLOW_CANVAS_FIT_MAX_ZOOM,
                });
              });
            }}
            onNodesChange={handleNodesChange}
            onSelectionChange={handleSelectionChange}
            onConnect={handleConnect}
            isValidConnection={isValidConnection}
            onNodeClick={(_event, node) => {
              if (node.type === "mediaComment") {
                setSelectedNodeId(null);
                setPlanPanelOpen(false);
                setHistoryPanelOpen(false);
                setPortabilityPanelOpen(false);
                setPalettePanelOpen(false);
                setSelectionPanelOpen(false);
                setVariablesPanelOpen(false);
                setGroupsPanelOpen(true);
                return;
              }
              if (node.type !== "mediaNode") return;
              setPlanPanelOpen(false);
              setHistoryPanelOpen(false);
              setPortabilityPanelOpen(false);
              setGroupsPanelOpen(false);
              setPalettePanelOpen(false);
              setSelectionPanelOpen(false);
              setVariablesPanelOpen(false);
              setSelectedNodeId(node.id);
            }}
            onPaneClick={() => setSelectedNodeId(null)}
            onMoveStart={(event) => {
              if (event) setFollowRun(false);
            }}
            deleteKeyCode={[]}
            nodesDraggable
            nodesConnectable
            elementsSelectable
            selectionOnDrag
            multiSelectionKeyCode={["Control", "Meta"]}
            miniMapNodeColor={(node) =>
              node.type === "mediaNode"
                ? {
                    source: "#38bdf8",
                    task: "#a78bfa",
                    operation: "#22d3ee",
                    control: "#fbbf24",
                    output: "#34d399",
                    runtime: "#64748b",
                  }[(node.data as MediaCanvasNodeData).layer]
                : "#475569"
            }
            aria-label="Editable semantic media workflow"
          />
        </div>

        {variablesPanelOpen ? (
          <MediaFlowVariablesPanel
            flow={flow}
            onChange={onFlowVariablesChange}
            onClose={() => setVariablesPanelOpen(false)}
          />
        ) : templatesPanelOpen ? (
          <MediaFlowTemplatesPanel
            models={models}
            hasUnsavedChanges={hasUnsavedChanges}
            onApply={onTemplateApply}
            onClose={() => setTemplatesPanelOpen(false)}
          />
        ) : selectionPanelOpen ? (
          <NodeSelectionPanel
            flow={flow}
            layout={layout}
            selectedNodeIds={selectedNodeIds}
            onChange={applyCanvasSelection}
            onClose={() => setSelectionPanelOpen(false)}
          />
        ) : selectedNode ? (
          <NodeInspector
            node={selectedNode}
            flow={flow}
            plan={plan}
            models={models}
            addons={addons}
            assets={assets}
            assetMetadata={assetMetadata}
            onNodeConfigChange={onNodeConfigChange}
            onNodeConfigPatch={onNodeConfigPatch}
            onNodeLabelChange={onNodeLabelChange}
            onConnectPorts={onConnectPorts}
            onDisconnectInput={onDisconnectInput}
            onDisconnectConnection={disconnectConnection}
            onNodeCopy={onNodeCopy}
            onNodeRemove={onNodeRemove}
            onClose={() => setSelectedNodeId(null)}
          />
        ) : palettePanelOpen ? (
          <NodePalettePanel
            flow={flow}
            onAdd={(nodeType) => {
              const nodeId = onNodeAdd(nodeType);
              if (nodeId) {
                setPalettePanelOpen(false);
                setSelectedNodeId(nodeId);
              }
            }}
            onClose={() => setPalettePanelOpen(false)}
          />
        ) : groupsPanelOpen ? (
          <VisualGroupsPanel
            flow={flow}
            layout={layout}
            onChange={(nextLayout) => {
              commitLayout(nextLayout);
              setLayoutNotice(
                "Updated canvas organization without changing execution identity.",
              );
            }}
            onClose={() => setGroupsPanelOpen(false)}
          />
        ) : historyPanelOpen ? (
          <RevisionHistoryPanel
            history={history}
            loading={revisionLoading}
            onRefresh={onRefreshHistory}
            onRestore={onRestoreRevision}
          />
        ) : portabilityPanelOpen ? (
          <FlowPortabilityPanel
            inspection={importInspection}
            loading={portabilityLoading}
            supported={portabilitySupported}
            onInspect={onInspectImport}
            onImport={onImportReviewed}
            onDismiss={() => {
              setPortabilityPanelOpen(false);
              onDismissImport();
            }}
          />
        ) : planPanelOpen ? (
          <aside className="absolute inset-y-0 right-0 z-20 min-h-0 w-[min(360px,calc(100%-2rem))] overflow-y-auto border-l border-slate-800/80 bg-slate-950/95 p-5 shadow-2xl xl:static xl:w-auto xl:bg-slate-950/90 xl:shadow-none">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
                <Sparkles className="h-4 w-4 text-violet-300" />
                Runtime expansion
              </div>
              <span className="text-[10px] text-slate-600">
                {plan.steps.length} steps
              </span>
            </div>
            {planErrors.length > 0 ? (
              <section className="mt-4" aria-label="Flow errors">
                <div className="text-[10px] font-bold tracking-[0.14em] text-rose-300 uppercase">
                  Fix before running
                </div>
                <ul className="mt-2 space-y-2">
                  {planErrors.map((diagnostic) => {
                    const node = diagnostic.nodeId
                      ? flow.nodes.find(
                          (entry) => entry.id === diagnostic.nodeId,
                        )
                      : null;
                    return (
                      <li
                        key={`${diagnostic.code}-${diagnostic.nodeId ?? "flow"}-${diagnostic.message}`}
                      >
                        <button
                          type="button"
                          disabled={!node}
                          onClick={() => {
                            if (!node) return;
                            setPlanPanelOpen(false);
                            setSelectedNodeId(node.id);
                          }}
                          className="w-full rounded-xl border border-rose-400/20 bg-rose-400/5 p-3 text-left text-[10px] leading-4 text-rose-100 enabled:hover:bg-rose-400/10 disabled:cursor-default"
                        >
                          <span className="block font-medium">
                            {diagnostic.message}
                          </span>
                          {diagnostic.action ? (
                            <span className="mt-1 block text-rose-200/70">
                              {diagnostic.action}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
            <div className="mt-4 space-y-2">
              {plan.steps.map((step, index) => (
                <div
                  key={step.id}
                  className="rounded-xl border border-slate-800 bg-slate-900/45 p-3"
                >
                  <div className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate-700 bg-slate-950 text-[10px] text-slate-400">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium text-slate-200">
                        {step.label}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-slate-500">
                        {step.target === "remote" ? (
                          <Cloud className="h-3 w-3" />
                        ) : (
                          <Cpu className="h-3 w-3" />
                        )}
                        {step.target}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900/35 p-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                {plan.status === "ready" ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                ) : (
                  <CircleAlert className="h-4 w-4 text-rose-300" />
                )}
                Preflight contract
              </div>
              <dl className="mt-3 space-y-2 text-[11px]">
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Target</dt>
                  <dd className="text-slate-300">
                    {plan.preflight.target ?? "Unresolved"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Outputs</dt>
                  <dd className="text-slate-300">
                    {plan.preflight.estimatedOutputs}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Candidates</dt>
                  <dd className="text-slate-300">
                    {plan.preflight.generatedCandidates}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Human review</dt>
                  <dd className="text-slate-300">
                    {plan.preflight.requiresHumanReview ? "Required" : "No"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-slate-500">Remote request</dt>
                  <dd className="text-slate-300">
                    {plan.preflight.requiresRemoteRequest ? "Required" : "No"}
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-[10px] leading-4 text-slate-500">
                {plan.preflight.privacySummary}
              </p>
            </div>
          </aside>
        ) : null}
      </div>
      <Dialog
        open={remoteConfirmationOpen}
        onOpenChange={setRemoteConfirmationOpen}
      >
        <DialogContent className="max-h-[min(760px,calc(100vh-28px))] w-[min(680px,calc(100vw-28px))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden border-amber-400/20 bg-slate-950 p-0 text-slate-100 sm:max-w-none">
          <DialogHeader className="border-b border-slate-800 px-6 py-5 pr-12 text-left">
            <DialogTitle className="flex items-center gap-2 text-lg text-white">
              <ShieldCheck className="h-5 w-5 text-amber-300" />
              Confirm GPT Image 2 edit
            </DialogTitle>
            <DialogDescription className="text-xs leading-5 text-slate-400">
              {remoteRunMode === "browser-preview"
                ? "This preview sends no data to OpenAI and cannot incur a provider charge."
                : `This sends ${remoteUploadManifest.length} image${remoteUploadManifest.length === 1 ? "" : "s"}${remoteMaskIncluded ? " and a mask" : ""} to OpenAI in one paid request.`}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-6 py-5">
            <div>
              <div className="text-[10px] font-semibold tracking-[0.12em] text-slate-400 uppercase">
                Inputs
              </div>
              <ul className="mt-2 space-y-2">
                {remoteUploadManifest.map((item, index) => (
                  <li
                    key={`${item.assetId}:${index}`}
                    className="rounded-xl border border-slate-800 bg-slate-900/35 p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs font-medium text-slate-200">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-400/10 text-[9px] text-amber-200">
                          {index + 1}
                        </span>
                        {item.role === "base"
                          ? "Base image"
                          : `${item.role} reference`}
                      </div>
                      <Badge
                        variant="outline"
                        className="border-slate-700 text-[9px] text-slate-400"
                      >
                        influence {Math.round(item.influence * 100)}%
                      </Badge>
                    </div>
                    <div className="mt-2 text-[10px] text-slate-500">
                      <span>{formatByteSize(item.byteSize)}</span>
                    </div>
                  </li>
                ))}
                {remoteMaskIncluded ? (
                  <li className="rounded-xl border border-slate-800 bg-slate-900/35 p-3 text-xs font-medium text-slate-200">
                    Painted mask
                  </li>
                ) : null}
              </ul>
            </div>

            {remoteRunMode !== "browser-preview" ? (
              <div className="mt-4 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-[11px] leading-5 text-amber-100/75">
                Your prompt and inputs are sent to OpenAI. If submission status
                is uncertain, retrying may create another billable request.
              </div>
            ) : null}
          </div>
          <DialogFooter className="border-t border-slate-800 px-6 py-4">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRemoteConfirmationOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={remoteRunPending || !remoteRunSupported}
                onClick={() => {
                  setRemoteConfirmationOpen(false);
                  onRunRemoteEdit();
                }}
                className="bg-amber-300 text-slate-950 hover:bg-amber-200"
              >
                <Cloud className="h-4 w-4" />
                {remoteRunMode === "browser-preview"
                  ? "Run preview"
                  : `Upload ${remoteUploadFileCount} files & run`}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
