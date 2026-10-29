import {
  Background,
  BaseEdge,
  ConnectionLineType,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type MiniMapProps,
  type Node,
  type ReactFlowProps,
} from "@xyflow/react";
import {
  useMemo,
  useEffect,
  useRef,
  type CSSProperties,
  type JSX,
  type Key,
  type ReactNode,
} from "react";

import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import "./flow-canvas.css";
import {
  FLOW_CANVAS_FIT_MAX_ZOOM,
  FLOW_CANVAS_FIT_PADDING,
  FLOW_CANVAS_MAX_ZOOM,
  FLOW_CANVAS_MIN_ZOOM,
  FLOW_EDGE_TYPE,
} from "./flow-theme";

const getEdgeStrokeWidth = (style: CSSProperties | undefined): number =>
  typeof style?.strokeWidth === "number" ? style.strokeWidth : 1.65;

const FlowEdge = ({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerEnd,
  selected,
  style,
}: EdgeProps): JSX.Element => {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 10,
    offset: 20,
  });
  const strokeWidth = getEdgeStrokeWidth(style);

  return (
    <>
      <BaseEdge
        id={`${id}-underlay`}
        path={edgePath}
        interactionWidth={0}
        style={{
          ...style,
          stroke: "#020617",
          strokeWidth: strokeWidth + 4,
          opacity:
            typeof style?.opacity === "number" ? style.opacity * 0.8 : 0.8,
        }}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        {...(markerEnd ? { markerEnd } : {})}
        interactionWidth={20}
        style={{
          ...style,
          stroke: selected ? "#e0f2fe" : style?.stroke,
          strokeWidth: selected ? Math.max(strokeWidth, 3) : strokeWidth,
          filter: selected
            ? "drop-shadow(0 0 5px rgba(56, 189, 248, 0.9))"
            : style?.filter,
        }}
      />
    </>
  );
};

export const FLOW_EDGE_TYPES = {
  [FLOW_EDGE_TYPE]: FlowEdge,
} satisfies EdgeTypes;

const FlowInitialViewport = ({
  options,
}: {
  options: ReactFlowProps["fitViewOptions"];
}): null => {
  const initialized = useNodesInitialized();
  const { fitView, viewportInitialized } = useReactFlow();
  const fitted = useRef(false);
  useEffect(() => {
    if (!initialized || !viewportInitialized || fitted.current) return;
    const frame = requestAnimationFrame(() => {
      fitted.current = true;
      void fitView(options);
    });
    return () => cancelAnimationFrame(frame);
  }, [initialized, viewportInitialized, fitView, options]);
  return null;
};

type CanonicalReactFlowProps<
  NodeType extends Node,
  EdgeType extends Edge,
> = Omit<
  ReactFlowProps<NodeType, EdgeType>,
  | "children"
  | "className"
  | "colorMode"
  | "connectionLineStyle"
  | "connectionLineType"
  | "defaultEdgeOptions"
  | "edgeTypes"
  | "fitViewOptions"
  | "maxZoom"
  | "minZoom"
  | "proOptions"
>;

export interface FlowCanvasProps<
  NodeType extends Node,
  EdgeType extends Edge,
> extends CanonicalReactFlowProps<NodeType, EdgeType> {
  children?: ReactNode;
  className?: string;
  defaultEdgeOptions?: ReactFlowProps<NodeType, EdgeType>["defaultEdgeOptions"];
  edgeTypes?: EdgeTypes;
  fitViewOptions?: ReactFlowProps<NodeType, EdgeType>["fitViewOptions"];
  minZoom?: number;
  miniMapNodeColor?: MiniMapProps<NodeType>["nodeColor"];
  providerKey?: Key;
  showControls?: boolean;
  showMiniMap?: boolean;
}

export function FlowCanvas<NodeType extends Node, EdgeType extends Edge>({
  children,
  className,
  defaultEdgeOptions,
  edgeTypes,
  fitView = true,
  fitViewOptions,
  minZoom = FLOW_CANVAS_MIN_ZOOM,
  miniMapNodeColor = "#475569",
  providerKey,
  showControls = true,
  showMiniMap = true,
  ...props
}: FlowCanvasProps<NodeType, EdgeType>): JSX.Element {
  const resolvedEdgeTypes = useMemo(
    () => ({ ...FLOW_EDGE_TYPES, ...edgeTypes }),
    [edgeTypes],
  );
  const resolvedFitViewOptions = useMemo(
    () => ({
      padding: FLOW_CANVAS_FIT_PADDING,
      maxZoom: FLOW_CANVAS_FIT_MAX_ZOOM,
      ...fitViewOptions,
    }),
    [fitViewOptions],
  );
  return (
    <ReactFlowProvider key={providerKey}>
      <ReactFlow<NodeType, EdgeType>
        selectionOnDrag
        multiSelectionKeyCode={["Control", "Meta"]}
        {...props}
        className={twMerge(
          clsx(
            "app-flow-canvas bg-slate-950 bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.055),transparent_34%)]",
            className,
          ),
        )}
        colorMode="dark"
        connectionLineStyle={{ stroke: "#7dd3fc", strokeWidth: 2 }}
        connectionLineType={ConnectionLineType.SmoothStep}
        defaultEdgeOptions={{
          ...defaultEdgeOptions,
          type: FLOW_EDGE_TYPE,
        }}
        edgeTypes={resolvedEdgeTypes}
        fitViewOptions={resolvedFitViewOptions}
        minZoom={minZoom}
        maxZoom={FLOW_CANVAS_MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
      >
        {fitView ? (
          <FlowInitialViewport options={resolvedFitViewOptions} />
        ) : null}
        {children}
        <Background gap={24} size={1} color="#1e293b" />
        {showMiniMap ? (
          <MiniMap<NodeType>
            pannable
            zoomable
            position="bottom-right"
            nodeColor={miniMapNodeColor}
            nodeStrokeColor="#94a3b8"
            nodeStrokeWidth={2}
            maskColor="rgba(2, 6, 23, 0.76)"
            className="!border !border-slate-800 !bg-slate-950 !shadow-xl"
            style={{ width: 144, height: 96, backgroundColor: "#020617" }}
          />
        ) : null}
        {showControls ? (
          <Controls
            fitViewOptions={resolvedFitViewOptions}
            position="bottom-left"
            className="!border-slate-800 !bg-slate-950 !shadow-xl [&_button]:!border-slate-800 [&_button]:!bg-slate-950 [&_button]:!fill-slate-300 [&_button]:!text-slate-300 [&_button:hover]:!bg-slate-900"
          />
        ) : null}
      </ReactFlow>
    </ReactFlowProvider>
  );
}
