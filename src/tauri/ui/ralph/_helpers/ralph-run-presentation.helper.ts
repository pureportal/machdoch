import {
  AlertTriangle,
  Check,
  CheckCircle2,
  FileText,
  LoaderCircle,
  MessageSquare,
  Octagon,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import type { RalphRunStatus } from "../../../../core/ralph.js";
import type {
  ActiveRalphRun,
  ActiveRalphRunStatus,
} from "./ralph-active-run-progress.helper";

export interface RalphStatusPresentation {
  icon: LucideIcon;
  className: string;
  spin?: boolean;
}

export interface RalphRunStatusPresentation extends RalphStatusPresentation {
  label: string;
  chipClassName: string;
}

export const getFlowRunStatusLabel = (
  runs: readonly ActiveRalphRun[],
): string | null => {
  if (runs.length === 0) {
    return null;
  }

  if (runs.some((run) => run.status === "stopping")) {
    return runs.length > 1 ? `${runs.length} stopping` : "Stopping";
  }

  return runs.length > 1 ? `${runs.length} running` : "Running";
};

export const getFlowStatusPresentation = (
  statusLabel: string,
): RalphStatusPresentation => {
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

  if (statusLabel === "Starter update") {
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

export const getRunStatusPresentation = (
  status: RalphRunStatus | ActiveRalphRunStatus,
): RalphRunStatusPresentation => {
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
        chipClassName:
          "border-emerald-400/30 bg-emerald-500/10 text-emerald-100",
      };
    case "blocked":
      return {
        label: "Blocked",
        icon: AlertTriangle,
        className: "text-amber-200",
        chipClassName: "border-amber-400/30 bg-amber-500/10 text-amber-100",
      };
    case "waiting-for-input":
      return {
        label: "Waiting for input",
        icon: MessageSquare,
        className: "text-teal-200",
        chipClassName: "border-teal-400/30 bg-teal-500/10 text-teal-100",
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

export const getOutputChipClassName = (output: string | undefined): string => {
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
