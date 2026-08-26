import { Handle, type HandleProps } from "@xyflow/react";
import type { ComponentPropsWithoutRef, JSX, ReactNode } from "react";

import { cn } from "../lib/utils";
import { ControlTooltip } from "../components/ui/tooltip";
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
    className={cn(
      "relative w-64 rounded-2xl border px-4 py-3 shadow-2xl shadow-black/30 outline-none backdrop-blur-sm transition-[border-color,box-shadow,filter,opacity]",
      selected && FLOW_SELECTED_NODE_CLASS_NAME,
      className,
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

export interface FlowPortProps extends Omit<
  HandleProps,
  "className" | "title"
> {
  tone: FlowPortTone;
  className?: string;
  tooltip?: ReactNode;
}

export const FlowPort = ({
  className,
  tone,
  tooltip,
  ...props
}: FlowPortProps): JSX.Element => {
  const handle = (
    <Handle
      {...props}
      className={cn(
        "!h-3 !w-3 !border-2 !border-slate-950 !shadow-[0_0_0_1px_rgba(226,232,240,0.24),0_0_10px_rgba(2,6,23,0.75)] transition-[box-shadow] hover:!shadow-[0_0_0_2px_rgba(224,242,254,0.72),0_0_14px_rgba(125,211,252,0.65)]",
        FLOW_PORT_PRESENTATIONS[tone].handleClassName,
        className,
      )}
    />
  );

  return tooltip ? (
    <ControlTooltip content={tooltip}>{handle}</ControlTooltip>
  ) : (
    handle
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
    className={cn(
      "h-2 w-2 shrink-0 rounded-full ring-1 ring-slate-950/90 shadow-[0_0_8px_rgba(2,6,23,0.75)]",
      FLOW_PORT_PRESENTATIONS[tone].dotClassName,
      className,
    )}
  />
);
