import {
  Handle,
  Position,
  useNodeId,
  useUpdateNodeInternals,
  type HandleProps,
} from "@xyflow/react";
import {
  useLayoutEffect,
  type ComponentPropsWithoutRef,
  type JSX,
  type ReactNode,
} from "react";

import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  FLOW_PORT_PRESENTATIONS,
  FLOW_SELECTED_NODE_CLASS_NAME,
  type FlowPortTone,
} from "./flow-theme";

export interface FlowNodeShellProps extends ComponentPropsWithoutRef<"div"> {
  selected?: boolean;
}

export const FlowNodeShell = ({
  children,
  className,
  selected = false,
  ...props
}: FlowNodeShellProps): JSX.Element => (
  <div
    {...props}
    className={twMerge(
      clsx(
        "relative w-64 rounded-2xl border px-4 py-3 shadow-2xl shadow-black/30 outline-none backdrop-blur-sm transition-[border-color,box-shadow,filter,opacity]",
        selected && FLOW_SELECTED_NODE_CLASS_NAME,
        className,
      ),
    )}
  >
    {children}
  </div>
);

export interface FlowNodeHeaderProps {
  category: string;
  label: string;
  icon: ReactNode;
}

export const FlowNodeHeader = ({
  category,
  label,
  icon,
}: FlowNodeHeaderProps): JSX.Element => (
  <div className="min-w-0">
    <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
      <span className="truncate text-[10px] font-bold tracking-[0.13em] uppercase opacity-60">
        {category}
      </span>
      {icon}
    </div>
    <div className="truncate text-sm font-semibold">{label}</div>
  </div>
);

export interface FlowNodePort {
  id?: string;
  label: string;
  tone: FlowPortTone;
  required?: boolean;
  description?: string;
}

export interface FlowNodePortsProps {
  inputs: readonly FlowNodePort[];
  outputs: readonly FlowNodePort[];
}

const FlowPortRow = ({
  port,
  type,
}: {
  port: FlowNodePort;
  type: HandleProps["type"];
}): JSX.Element => (
  <div
    className={twMerge(
      clsx(
        "flow-port-row relative flex min-h-5 min-w-0 items-center text-[10px] font-semibold leading-4 text-current",
        type === "target" ? "pl-4" : "justify-end pr-4",
      ),
    )}
  >
    <span className="truncate opacity-80" title={port.label}>
      {port.label}
      {port.required ? " *" : ""}
    </span>
    <Handle
      {...(port.id !== undefined ? { id: port.id } : {})}
      type={type}
      position={type === "target" ? Position.Left : Position.Right}
      aria-label={
        port.description ??
        port.label + (type === "target" ? " input" : " output")
      }
      title={port.description}
      style={type === "target" ? { left: -6 } : { right: -6 }}
      className={twMerge(
        clsx(
          "!h-3 !w-3 !border-2 !border-slate-950 !shadow-[0_0_0_1px_rgba(226,232,240,0.24),0_0_10px_rgba(2,6,23,0.75)] transition-[box-shadow] hover:!shadow-[0_0_0_2px_rgba(224,242,254,0.72),0_0_14px_rgba(125,211,252,0.65)]",
          FLOW_PORT_PRESENTATIONS[port.tone].handleClassName,
        ),
      )}
    />
  </div>
);

export const FlowNodePorts = ({
  inputs,
  outputs,
}: FlowNodePortsProps): JSX.Element | null => {
  const nodeId = useNodeId();
  const updateNodeInternals = useUpdateNodeInternals();
  const signature = JSON.stringify([inputs, outputs]);
  useLayoutEffect(() => {
    if (nodeId) updateNodeInternals(nodeId);
  }, [nodeId, signature, updateNodeInternals]);

  if (inputs.length === 0 && outputs.length === 0) return null;

  return (
    <div className="flow-node-ports mt-3 grid grid-cols-2 gap-4 border-t border-white/10 pt-2">
      <div className="grid min-w-0 content-start gap-1.5">
        {inputs.map((port) => (
          <FlowPortRow key={port.id ?? port.label} port={port} type="target" />
        ))}
      </div>
      <div className="grid min-w-0 content-start gap-1.5">
        {outputs.map((port) => (
          <FlowPortRow key={port.id ?? port.label} port={port} type="source" />
        ))}
      </div>
    </div>
  );
};

export interface FlowPortDotProps extends ComponentPropsWithoutRef<"span"> {
  tone: FlowPortTone;
}

export const FlowPortDot = ({
  className,
  tone,
  ...props
}: FlowPortDotProps): JSX.Element => (
  <span
    {...props}
    className={twMerge(
      clsx(
        "h-2 w-2 shrink-0 rounded-full ring-1 ring-slate-950/90 shadow-[0_0_8px_rgba(2,6,23,0.75)]",
        FLOW_PORT_PRESENTATIONS[tone].dotClassName,
        className,
      ),
    )}
  />
);
