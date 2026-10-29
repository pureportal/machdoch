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
  Images,
  Octagon,
  Package,
  Play,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
  Variable,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type {
  RalphBlockType,
  RalphExecutionOutput,
  RalphFlowBlock,
  RalphUtilityType,
} from "../../../../core/ralph.js";
import { FLOW_NODE_TONE_CLASS_NAMES, type FlowPortTone } from "@machdoch/product-ui/flow/flow-theme";

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
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.emerald,
        badgeClassName: "text-emerald-300",
        miniMapColor: "#34d399",
        badgeLabel: "START",
      };
    case "PROMPT":
      return {
        icon: MessageSquareText,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.sky,
        badgeClassName: "text-sky-300",
        miniMapColor: "#38bdf8",
        badgeLabel: "PROMPT",
      };
    case "VALIDATOR":
      return {
        icon: ShieldCheck,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.lime,
        badgeClassName: "text-lime-300",
        miniMapColor: "#7a9a61",
        badgeLabel: "VALIDATE",
      };
    case "DECISION":
      return {
        icon: GitBranch,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.fuchsia,
        badgeClassName: "text-fuchsia-300",
        miniMapColor: "#e879f9",
        badgeLabel: "DECIDE",
      };
    case "PACK":
      return {
        icon: Package,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.amber,
        badgeClassName: "text-amber-300",
        miniMapColor: "#fbbf24",
        badgeLabel: "PACK",
      };
    case "ASK_USER":
      return {
        icon: ClipboardCheck,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.teal,
        badgeClassName: "text-teal-300",
        miniMapColor: "#2dd4bf",
        badgeLabel: "ASK USER",
      };
    case "INTERVIEW":
      return {
        icon: MessageSquareText,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.rose,
        badgeClassName: "text-rose-300",
        miniMapColor: "#fb7185",
        badgeLabel: "INTERVIEW",
      };
    case "UTILITY":
      return {
        icon: Wrench,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.cyan,
        badgeClassName: "text-cyan-300",
        miniMapColor: "#22d3ee",
        badgeLabel: "UTILITY",
      };
    case "MCP_TOOL":
    case "MCP_RESOURCE":
    case "MCP_PROMPT":
      return {
        icon: Globe2,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.violet,
        badgeClassName: "text-violet-300",
        miniMapColor: "#a78bfa",
        badgeLabel: "MCP",
      };
    case "MEDIA_FLOW":
      return {
        icon: Images,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.orange,
        badgeClassName: "text-orange-300",
        miniMapColor: "#fb923c",
        badgeLabel: "MEDIA FLOW",
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
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.slate,
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
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.teal,
        badgeClassName: "text-teal-200",
        miniMapColor: "#2dd4bf",
        badgeLabel: "WAIT",
      };
    case "HTTP_FETCH":
      return {
        icon: Download,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.blue,
        badgeClassName: "text-blue-200",
        miniMapColor: "#60a5fa",
        badgeLabel: "FETCH",
      };
    case "POLL":
      return {
        icon: RefreshCw,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.cyan,
        badgeClassName: "text-cyan-200",
        miniMapColor: "#22d3ee",
        badgeLabel: "POLL",
      };
    case "CONDITION":
      return {
        icon: GitBranch,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.fuchsia,
        badgeClassName: "text-fuchsia-200",
        miniMapColor: "#e879f9",
        badgeLabel: "CONDITION",
      };
    case "RUN_COMMAND":
      return {
        icon: Terminal,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.zinc,
        badgeClassName: "text-zinc-200",
        miniMapColor: "#a1a1aa",
        badgeLabel: "COMMAND",
      };
    case "READ_FILE":
      return {
        icon: FileText,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.sky,
        badgeClassName: "text-sky-200",
        miniMapColor: "#38bdf8",
        badgeLabel: "READ",
      };
    case "WRITE_FILE":
      return {
        icon: FilePlus,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.orange,
        badgeClassName: "text-orange-200",
        miniMapColor: "#fb923c",
        badgeLabel: "WRITE",
      };
    case "READ_JSON":
      return {
        icon: FileJson,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.cyan,
        badgeClassName: "text-cyan-200",
        miniMapColor: "#22d3ee",
        badgeLabel: "READ JSON",
      };
    case "READ_JSONL":
    case "QUERY_JSONL":
      return {
        icon: FileJson,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.cyan,
        badgeClassName: "text-cyan-200",
        miniMapColor: "#22d3ee",
        badgeLabel: type === "QUERY_JSONL" ? "QUERY JSONL" : "READ JSONL",
      };
    case "WRITE_JSON":
    case "PATCH_JSON":
    case "APPEND_JSONL":
      return {
        icon: FileJson,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.emerald,
        badgeClassName: "text-emerald-200",
        miniMapColor: "#34d399",
        badgeLabel:
          type === "PATCH_JSON"
            ? "PATCH JSON"
            : type === "APPEND_JSONL"
              ? "JSONL"
              : "WRITE JSON",
      };
    case "FILE_EXISTS":
      return {
        icon: FileText,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.indigo,
        badgeClassName: "text-indigo-200",
        miniMapColor: "#818cf8",
        badgeLabel: "EXISTS",
      };
    case "DELETE_FILE":
      return {
        icon: Trash2,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.red,
        badgeClassName: "text-red-200",
        miniMapColor: "#f87171",
        badgeLabel: "DELETE",
      };
    case "MOVE_FILE":
    case "ARCHIVE_FILE":
      return {
        icon: FileText,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.amber,
        badgeClassName: "text-amber-200",
        miniMapColor: "#f59e0b",
        badgeLabel: type === "ARCHIVE_FILE" ? "ARCHIVE" : "MOVE",
      };
    case "LOOP_COUNTER":
      return {
        icon: RefreshCw,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.indigo,
        badgeClassName: "text-indigo-200",
        miniMapColor: "#818cf8",
        badgeLabel: "COUNTER",
      };
    case "PROMPT_JSON":
      return {
        icon: Braces,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.violet,
        badgeClassName: "text-violet-200",
        miniMapColor: "#a78bfa",
        badgeLabel: "AI JSON",
      };
    case "VALIDATOR_JSON":
      return {
        icon: ShieldCheck,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.lime,
        badgeClassName: "text-lime-200",
        miniMapColor: "#7a9a61",
        badgeLabel: "JSON VALID",
      };
    case "ASSESS_JSON_TASKS":
      return {
        icon: ClipboardCheck,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.blue,
        badgeClassName: "text-blue-200",
        miniMapColor: "#60a5fa",
        badgeLabel: "TASK STATE",
      };
    case "SELECT_JSON_TASK":
      return {
        icon: ClipboardCheck,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.cyan,
        badgeClassName: "text-cyan-200",
        miniMapColor: "#22d3ee",
        badgeLabel: "TASK PICK",
      };
    case "MARK_JSON_TASK":
      return {
        icon: ClipboardCheck,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.lime,
        badgeClassName: "text-lime-200",
        miniMapColor: "#7a9a61",
        badgeLabel: "TASK MARK",
      };
    case "CHANGE_SCOPE_GUARD":
      return {
        icon: ShieldCheck,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.rose,
        badgeClassName: "text-rose-200",
        miniMapColor: "#fb7185",
        badgeLabel: "SCOPE GUARD",
      };
    case "SCAN_SCOPE_EVIDENCE":
      return {
        icon: FileSearch,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.sky,
        badgeClassName: "text-sky-200",
        miniMapColor: "#38bdf8",
        badgeLabel: "SCOPE SCAN",
      };
    case "UPDATE_SCOPE_REGISTRY":
      return {
        icon: FileJson,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.emerald,
        badgeClassName: "text-emerald-200",
        miniMapColor: "#34d399",
        badgeLabel: "SCOPE JSON",
      };
    case "BEGIN_SCOPE_CYCLE":
      return {
        icon: RefreshCw,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.cyan,
        badgeClassName: "text-cyan-200",
        miniMapColor: "#22d3ee",
        badgeLabel: "SCOPE CYCLE",
      };
    case "SELECT_SCOPE":
      return {
        icon: GitBranch,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.cyan,
        badgeClassName: "text-cyan-200",
        miniMapColor: "#22d3ee",
        badgeLabel: "SCOPE PICK",
      };
    case "MARK_SCOPE_RESULT":
      return {
        icon: ClipboardCheck,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.lime,
        badgeClassName: "text-lime-200",
        miniMapColor: "#7a9a61",
        badgeLabel: "SCOPE MARK",
      };
    case "SEARCH_FILES":
      return {
        icon: FileSearch,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.purple,
        badgeClassName: "text-purple-200",
        miniMapColor: "#c084fc",
        badgeLabel: "SEARCH",
      };
    case "RUN_CHECK":
      return {
        icon: ClipboardCheck,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.lime,
        badgeClassName: "text-lime-200",
        miniMapColor: "#7a9a61",
        badgeLabel: "CHECK",
      };
    case "UI_ANALYZE":
      return {
        icon: Globe2,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.teal,
        badgeClassName: "text-teal-200",
        miniMapColor: "#14b8a6",
        badgeLabel: "UI",
      };
    case "GIT_STATUS":
      return {
        icon: GitBranch,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.amber,
        badgeClassName: "text-amber-200",
        miniMapColor: "#f59e0b",
        badgeLabel: "GIT",
      };
    case "GIT_SNAPSHOT":
    case "GIT_DIFF_SUMMARY":
      return {
        icon: GitBranch,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.amber,
        badgeClassName: "text-amber-200",
        miniMapColor: "#f59e0b",
        badgeLabel: type === "GIT_SNAPSHOT" ? "GIT SNAP" : "GIT DIFF",
      };
    case "DETECT_PROJECT_COMMANDS":
      return {
        icon: Terminal,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.zinc,
        badgeClassName: "text-zinc-200",
        miniMapColor: "#a1a1aa",
        badgeLabel: "COMMANDS",
      };
    case "SET_VARIABLE":
      return {
        icon: Variable,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.pink,
        badgeClassName: "text-pink-200",
        miniMapColor: "#f472b6",
        badgeLabel: "SET VAR",
      };
    case "TRANSFORM_JSON":
      return {
        icon: Braces,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.violet,
        badgeClassName: "text-violet-200",
        miniMapColor: "#a78bfa",
        badgeLabel: "JSON MAP",
      };
    case "VALIDATE_JSON":
      return {
        icon: FileJson,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.green,
        badgeClassName: "text-green-200",
        miniMapColor: "#4ade80",
        badgeLabel: "SCHEMA",
      };
    case "FINAL_REPORT":
      return {
        icon: ClipboardCheck,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.teal,
        badgeClassName: "text-teal-200",
        miniMapColor: "#14b8a6",
        badgeLabel: "REPORT",
      };
    case "NOTIFY":
      return {
        icon: Bell,
        nodeClassName: FLOW_NODE_TONE_CLASS_NAMES.rose,
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

const RALPH_POSITIVE_OUTPUTS = new Set([
  "SUCCESS",
  "DONE",
  "COMPLETE",
  "READY",
  "SELECTED",
  "EXISTS",
  "MATCH",
  "IN_SCOPE",
]);

const RALPH_CAUTION_OUTPUTS = new Set([
  "CONTINUE",
  "RETRY",
  "PARTIAL",
  "REVIEW_REQUIRED",
  "INCOMPLETE",
  "INCONCLUSIVE",
  "LIMIT_REACHED",
]);

const RALPH_NEUTRAL_OUTPUTS = new Set([
  "EMPTY",
  "MISSING",
  "NOT_FOUND",
  "NO_MATCH",
  "UNAVAILABLE",
]);

const RALPH_FAILURE_OUTPUTS = new Set([
  "ERROR",
  "FAILED",
  "INVALID",
  "BLOCKED",
  "OUT_OF_SCOPE",
]);

export const getRalphOutputTone = (
  output: RalphExecutionOutput,
): FlowPortTone => {
  const normalizedOutput = output.trim().toUpperCase();

  if (
    RALPH_FAILURE_OUTPUTS.has(normalizedOutput) ||
    normalizedOutput.endsWith("_ERROR")
  ) {
    return "rose";
  }
  if (RALPH_POSITIVE_OUTPUTS.has(normalizedOutput)) {
    return "emerald";
  }
  if (normalizedOutput === "TIMEOUT") {
    return "orange";
  }
  if (RALPH_CAUTION_OUTPUTS.has(normalizedOutput)) {
    return "amber";
  }
  if (RALPH_NEUTRAL_OUTPUTS.has(normalizedOutput)) {
    return "slate";
  }
  if (normalizedOutput === "CANCELLED") {
    return "violet";
  }

  return "cyan";
};
