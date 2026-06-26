import {
  BaseEdge,
  Handle,
  NodeResizer,
  Position,
  getSmoothStepPath,
  type EdgeProps,
  type EdgeTypes,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import { AlertTriangle, FileText, LayoutGrid, LockKeyhole } from "lucide-react";
import type { JSX } from "react";

import type { RalphAnnotationTone } from "../../../../core/ralph.js";
import { cn } from "../../lib/utils";
import {
  RALPH_GROUP_COLLAPSED_HEIGHT,
  type RalphCanvasEdge,
  type RalphCanvasNode,
  type RalphNodeData,
} from "../_helpers/ralph-canvas-layout.helper";
import {
  RALPH_GROUP_MIN_SIZE,
  RALPH_NOTE_MIN_SIZE,
} from "../_helpers/validate-flow-locally.helper";
import { getBlockVisual } from "../_helpers/get-ralph-block-visual.helper";
import { getBlockNodePreview } from "../_helpers/get-ralph-node-preview.helper";

const getAnnotationToneClassName = (
  tone: RalphAnnotationTone | undefined,
): string => {
  switch (tone) {
    case "amber":
      return "border-amber-400/45 bg-amber-950/50 text-amber-50";
    case "sky":
      return "border-sky-400/45 bg-sky-950/50 text-sky-50";
    case "lime":
      return "border-lime-400/45 bg-lime-950/50 text-lime-50";
    case "rose":
      return "border-rose-400/45 bg-rose-950/50 text-rose-50";
    case "violet":
      return "border-violet-400/45 bg-violet-950/50 text-violet-50";
    case "slate":
    default:
      return "border-slate-600/70 bg-slate-900/70 text-slate-100";
  }
};

const getAnnotationAccentClassName = (
  tone: RalphAnnotationTone | undefined,
): string => {
  switch (tone) {
    case "amber":
      return "bg-amber-300";
    case "sky":
      return "bg-sky-300";
    case "lime":
      return "bg-lime-300";
    case "rose":
      return "bg-rose-300";
    case "violet":
      return "bg-violet-300";
    case "slate":
    default:
      return "bg-slate-400";
  }
};

const RALPH_SELECTED_NODE_CLASS_NAME =
  "ring-2 ring-cyan-100/95 ring-offset-2 ring-offset-slate-950 shadow-[0_0_0_1px_rgba(240,249,255,0.95),0_0_0_6px_rgba(34,211,238,0.22),0_0_30px_rgba(34,211,238,0.48)]";

const RALPH_SELECTED_RESIZER_LINE_CLASS_NAME = "!border-cyan-100/90";
const RALPH_SELECTED_RESIZER_HANDLE_CLASS_NAME =
  "!h-2.5 !w-2.5 !border-cyan-100 !bg-slate-950 !shadow-[0_0_12px_rgba(34,211,238,0.75)]";

const RalphNodeLockBadge = ({
  data,
}: {
  data: RalphNodeData;
}): JSX.Element | null => {
  const isDirectlyLocked = data.block.locked ?? false;

  if (!isDirectlyLocked && !data.lockedByGroupId) {
    return null;
  }

  const label = isDirectlyLocked
    ? "Locked"
    : `Locked by parent group ${data.lockedByGroupId}`;

  return (
    <div
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "pointer-events-none absolute top-2 right-2 z-10 flex h-6 w-6 items-center justify-center rounded-md border shadow-lg shadow-black/35",
        isDirectlyLocked
          ? "border-cyan-200/70 bg-cyan-950/90 text-cyan-100"
          : "border-dashed border-amber-200/65 bg-slate-950/90 text-amber-100",
      )}
    >
      <LockKeyhole className="h-3.5 w-3.5" />
      {!isDirectlyLocked ? (
        <LayoutGrid className="absolute -right-1 -bottom-1 h-3 w-3 rounded-full border border-slate-950 bg-slate-950 p-0.5 text-amber-200" />
      ) : null}
    </div>
  );
};

const RalphNoteNode = ({
  data,
  selected,
}: {
  data: RalphNodeData;
  selected?: boolean;
}): JSX.Element => {
  const block = data.block;

  if (block.type !== "NOTE") {
    return <></>;
  }

  const isSelected = selected || data.selected;

  return (
    <div
      className={cn(
        "relative flex h-full min-h-[120px] w-full min-w-[180px] flex-col overflow-hidden rounded-lg border shadow-lg shadow-black/20",
        getAnnotationToneClassName(block.tone),
        isSelected && RALPH_SELECTED_NODE_CLASS_NAME,
      )}
    >
      <RalphNodeLockBadge data={data} />
      <NodeResizer
        isVisible={isSelected && !block.locked && !data.lockedByGroupId}
        minWidth={RALPH_NOTE_MIN_SIZE.width}
        minHeight={RALPH_NOTE_MIN_SIZE.height}
        lineClassName={RALPH_SELECTED_RESIZER_LINE_CLASS_NAME}
        handleClassName={RALPH_SELECTED_RESIZER_HANDLE_CLASS_NAME}
        onResizeEnd={(_, params) => {
          data.onResizeEnd?.(
            block.id,
            {
              width: Math.round(params.width),
              height: Math.round(params.height),
            },
            {
              x: Math.round(params.x),
              y: Math.round(params.y),
            },
          );
        }}
      />
      <div className={cn("h-1 shrink-0", getAnnotationAccentClassName(block.tone))} />
      <div className="flex min-w-0 items-center justify-between gap-2 px-3 py-2 pr-10">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-3.5 w-3.5 shrink-0 text-white/70" />
          <span className="truncate text-xs font-semibold">{block.title}</span>
        </div>
        <span className="shrink-0 rounded border border-white/10 bg-black/20 px-1.5 py-0.5 text-[0.58rem] font-bold uppercase tracking-wide text-white/55">
          Note
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-3 pb-3 text-xs leading-5 text-white/72">
        <div className="line-clamp-5 whitespace-pre-wrap">
          {block.text.trim() || "Empty note"}
        </div>
      </div>
      {block.tags && block.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1 px-3 pb-3">
          {block.tags.slice(0, 4).map((tag) => (
            <span
              key={tag}
              className="max-w-full truncate rounded border border-white/10 bg-black/20 px-1.5 py-0.5 text-[0.58rem] font-medium leading-3 text-white/60"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
      {data.issueCount > 0 ? (
        <div className="absolute right-2 bottom-2 flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[0.62rem] font-semibold text-amber-100">
          <AlertTriangle className="h-3 w-3" />
          {data.issueCount}
        </div>
      ) : null}
    </div>
  );
};

const RalphGroupNode = ({
  data,
  selected,
}: {
  data: RalphNodeData;
  selected?: boolean;
}): JSX.Element => {
  const block = data.block;

  if (block.type !== "GROUP") {
    return <></>;
  }

  const isSelected = selected || data.selected;

  return (
    <div
      className={cn(
        "relative flex h-full min-h-[180px] w-full min-w-[280px] flex-col rounded-lg border border-dashed shadow-inner shadow-black/25",
        getAnnotationToneClassName(block.tone),
        isSelected && RALPH_SELECTED_NODE_CLASS_NAME,
      )}
    >
      <RalphNodeLockBadge data={data} />
      <NodeResizer
        isVisible={isSelected && !block.locked && !data.lockedByGroupId}
        minWidth={RALPH_GROUP_MIN_SIZE.width}
        minHeight={block.collapsed ? RALPH_GROUP_COLLAPSED_HEIGHT : RALPH_GROUP_MIN_SIZE.height}
        lineClassName={RALPH_SELECTED_RESIZER_LINE_CLASS_NAME}
        handleClassName={RALPH_SELECTED_RESIZER_HANDLE_CLASS_NAME}
        onResizeEnd={(_, params) => {
          data.onResizeEnd?.(
            block.id,
            {
              width: Math.round(params.width),
              height: Math.round(params.height),
            },
            {
              x: Math.round(params.x),
              y: Math.round(params.y),
            },
          );
        }}
      />
      <div className={cn("absolute inset-y-0 left-0 w-1 rounded-l-lg", getAnnotationAccentClassName(block.tone))} />
      <div className="flex min-w-0 items-center justify-between gap-3 rounded-t-lg border-b border-white/10 bg-black/20 px-3 py-2 pr-10">
        <div className="flex min-w-0 items-center gap-2">
          <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-white/65" />
          <span className="truncate text-xs font-semibold">{block.title}</span>
        </div>
        <span className="shrink-0 text-[0.62rem] font-medium text-white/45">
          {data.derivedChildIds.length} child block(s)
        </span>
      </div>
      <div className="pointer-events-none min-h-0 flex-1 p-3 text-xs text-white/45">
        {block.collapsed ? (
          <span>Collapsed group</span>
        ) : block.description ? (
          <span className="line-clamp-3 whitespace-pre-wrap">{block.description}</span>
        ) : null}
      </div>
    </div>
  );
};

const RalphBlockNode = ({
  data,
  selected,
}: NodeProps<RalphCanvasNode>): JSX.Element => {
  if (data.block.type === "NOTE") {
    return <RalphNoteNode data={data} selected={selected} />;
  }

  if (data.block.type === "GROUP") {
    return <RalphGroupNode data={data} selected={selected} />;
  }

  const visual = getBlockVisual(data.block);
  const preview = getBlockNodePreview(data.block);
  const Icon = visual.icon;
  const isSelected = selected || data.selected;

  return (
    <div
      className={cn(
        "relative rounded-lg border px-3 py-3 shadow-lg shadow-black/25",
        data.block.type === "UTILITY" ? "w-72" : "w-64",
        visual.nodeClassName,
        data.active &&
          "ring-2 ring-lime-300/70 shadow-[0_0_20px_rgba(122,154,97,0.2)]",
        isSelected && RALPH_SELECTED_NODE_CLASS_NAME,
      )}
    >
      <RalphNodeLockBadge data={data} />
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2.5 !w-2.5 !border-slate-950 !bg-slate-300"
        style={{ left: 0, transform: "translateY(-50%)" }}
      />
      <div className="flex min-w-0 items-center justify-between gap-3 pr-8">
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

export const RALPH_NODE_TYPES = {
  ralphBlock: RalphBlockNode,
} satisfies NodeTypes;

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

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={18}
    />
  );
};

export const RALPH_EDGE_TYPES = {
  ralphRoute: RalphRouteEdge,
} satisfies EdgeTypes;
