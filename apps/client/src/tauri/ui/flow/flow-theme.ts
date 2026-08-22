import type { Edge } from "@xyflow/react";
import type { CSSProperties } from "react";

export const FLOW_EDGE_TYPE = "flow";

export const FLOW_CANVAS_MIN_ZOOM = 0.3;
export const FLOW_CANVAS_MAX_ZOOM = 1.8;
export const FLOW_CANVAS_FIT_PADDING = 0.2;
export const FLOW_CANVAS_FIT_MAX_ZOOM = 1;

export const FLOW_SELECTED_NODE_CLASS_NAME =
  "!ring-2 !ring-sky-200/90 !ring-offset-2 !ring-offset-slate-950 !shadow-[0_0_0_1px_rgba(224,242,254,0.9),0_0_0_6px_rgba(56,189,248,0.2),0_0_30px_rgba(14,165,233,0.4)]";

export type FlowPortTone =
  | "slate"
  | "sky"
  | "fuchsia"
  | "emerald"
  | "orange"
  | "amber"
  | "rose"
  | "cyan"
  | "violet"
  | "lime"
  | "teal";

export interface FlowPortPresentation {
  color: string;
  handleClassName: string;
  dotClassName: string;
}

export const FLOW_PORT_PRESENTATIONS: Record<
  FlowPortTone,
  FlowPortPresentation
> = {
  slate: {
    color: "#cbd5e1",
    handleClassName: "!bg-slate-300",
    dotClassName: "bg-slate-300",
  },
  sky: {
    color: "#7dd3fc",
    handleClassName: "!bg-sky-300",
    dotClassName: "bg-sky-300",
  },
  fuchsia: {
    color: "#f0abfc",
    handleClassName: "!bg-fuchsia-300",
    dotClassName: "bg-fuchsia-300",
  },
  emerald: {
    color: "#6ee7b7",
    handleClassName: "!bg-emerald-300",
    dotClassName: "bg-emerald-300",
  },
  orange: {
    color: "#fdba74",
    handleClassName: "!bg-orange-300",
    dotClassName: "bg-orange-300",
  },
  amber: {
    color: "#fcd34d",
    handleClassName: "!bg-amber-300",
    dotClassName: "bg-amber-300",
  },
  rose: {
    color: "#fda4af",
    handleClassName: "!bg-rose-300",
    dotClassName: "bg-rose-300",
  },
  cyan: {
    color: "#67e8f9",
    handleClassName: "!bg-cyan-300",
    dotClassName: "bg-cyan-300",
  },
  violet: {
    color: "#c4b5fd",
    handleClassName: "!bg-violet-300",
    dotClassName: "bg-violet-300",
  },
  lime: {
    color: "#bef264",
    handleClassName: "!bg-lime-300",
    dotClassName: "bg-lime-300",
  },
  teal: {
    color: "#5eead4",
    handleClassName: "!bg-teal-300",
    dotClassName: "bg-teal-300",
  },
};

export type FlowEdgeEmphasis = "default" | "medium" | "strong";

export interface FlowEdgeStyleOptions {
  emphasis?: FlowEdgeEmphasis;
  muted?: boolean;
}

export const getFlowEdgeStyle = (
  tone: FlowPortTone,
  options: FlowEdgeStyleOptions = {},
): CSSProperties => {
  const emphasis = options.emphasis ?? "default";

  return {
    stroke: FLOW_PORT_PRESENTATIONS[tone].color,
    strokeWidth:
      emphasis === "strong" ? 2.75 : emphasis === "medium" ? 2.1 : 1.65,
    opacity: options.muted ? 0.42 : 1,
  };
};

export interface CreateFlowCanvasEdgeOptions<
  EdgeData extends Record<string, unknown>,
> extends FlowEdgeStyleOptions {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  tone: FlowPortTone;
  data?: EdgeData;
  animated?: boolean;
  hidden?: boolean;
  selected?: boolean;
}

export const createFlowCanvasEdge = <
  EdgeData extends Record<string, unknown> = Record<string, unknown>,
>({
  animated = false,
  data,
  emphasis,
  hidden = false,
  id,
  muted,
  selected = false,
  source,
  sourceHandle,
  target,
  targetHandle,
  tone,
}: CreateFlowCanvasEdgeOptions<EdgeData>): Edge<
  EdgeData,
  typeof FLOW_EDGE_TYPE
> => ({
  id,
  type: FLOW_EDGE_TYPE,
  source,
  target,
  ...(sourceHandle !== undefined ? { sourceHandle } : {}),
  ...(targetHandle !== undefined ? { targetHandle } : {}),
  ...(data !== undefined ? { data } : {}),
  animated,
  hidden,
  selected,
  style: getFlowEdgeStyle(tone, { emphasis, muted }),
});
