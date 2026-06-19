import {
  Bell,
  Braces,
  ClipboardCheck,
  Download,
  FileJson,
  FilePlus,
  FileSearch,
  FileText,
  GitBranch,
  Globe2,
  Hourglass,
  LayoutGrid,
  MessageSquareText,
  Octagon,
  Package,
  Play,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Variable,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type {
  RalphBlockType,
  RalphFlowBlock,
  RalphUtilityType,
} from "../../../../core/ralph.js";

export interface RalphBlockVisual {
  icon: LucideIcon;
  nodeClassName: string;
  badgeClassName: string;
  miniMapColor: string;
  badgeLabel: string;
}

export const getBlockTone = (type: RalphBlockType): RalphBlockVisual => {
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
        miniMapColor: "#7a9a61",
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
    case "INPUT":
      return {
        icon: ClipboardCheck,
        nodeClassName: "border-teal-400/55 bg-teal-950 text-teal-50",
        badgeClassName: "text-teal-300",
        miniMapColor: "#2dd4bf",
        badgeLabel: "INPUT",
      };
    case "INTERVIEW":
      return {
        icon: MessageSquareText,
        nodeClassName: "border-rose-400/55 bg-rose-950 text-rose-50",
        badgeClassName: "text-rose-300",
        miniMapColor: "#fb7185",
        badgeLabel: "INTERVIEW",
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
    case "NOTE":
      return {
        icon: FileText,
        nodeClassName: "border-amber-400/45 bg-amber-950/70 text-amber-50",
        badgeClassName: "text-amber-200",
        miniMapColor: "#fbbf24",
        badgeLabel: "NOTE",
      };
    case "GROUP":
      return {
        icon: LayoutGrid,
        nodeClassName: "border-slate-600/70 bg-slate-900/30 text-slate-100",
        badgeClassName: "text-slate-300",
        miniMapColor: "#475569",
        badgeLabel: "GROUP",
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

export const getUtilityTone = (type: RalphUtilityType): RalphBlockVisual => {
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
        miniMapColor: "#7a9a61",
        badgeLabel: "CHECK",
      };
    case "UI_ANALYZE":
      return {
        icon: Globe2,
        nodeClassName: "border-teal-400/60 bg-teal-950 text-teal-50",
        badgeClassName: "text-teal-200",
        miniMapColor: "#14b8a6",
        badgeLabel: "UI",
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

export const getBlockVisual = (block: RalphFlowBlock): RalphBlockVisual => {
  return block.type === "UTILITY"
    ? getUtilityTone(block.utility.type)
    : getBlockTone(block.type);
};
