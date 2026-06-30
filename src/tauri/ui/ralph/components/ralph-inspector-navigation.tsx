import { Route } from "lucide-react";
import type { JSX } from "react";

import type {
  RalphFlowBlock,
  RalphFlowEdge,
} from "../../../../core/ralph.js";
import { cn } from "../../lib/utils";
import type { RalphInspectorSectionId } from "../_helpers/ralph-flow-editor-options.helper";

interface RalphInspectorSection {
  id: RalphInspectorSectionId;
  label: string;
}

interface RalphInspectorSectionTabsProps {
  sections: readonly RalphInspectorSection[];
  activeSection: RalphInspectorSectionId;
  missingRouteCount: number;
  onSelectSection: (sectionId: RalphInspectorSectionId) => void;
}

export const RalphInspectorSectionTabs = ({
  sections,
  activeSection,
  missingRouteCount,
  onSelectSection,
}: RalphInspectorSectionTabsProps): JSX.Element | null => {
  if (sections.length <= 1) {
    return null;
  }

  return (
    <div className="border-b border-slate-800/70 bg-slate-950/95 px-3 py-2">
      <div className="flex min-w-0 gap-1 overflow-x-auto rounded-lg bg-slate-900/45 p-1 [scrollbar-width:thin]">
        {sections.map((section) => {
          const isActive = activeSection === section.id;
          const routeBadge =
            section.id === "routes" && missingRouteCount > 0
              ? missingRouteCount
              : null;
          const sectionLabel =
            section.id === "routes" ? "Route map" : section.label;

          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onSelectSection(section.id)}
              className={cn(
                "flex h-8 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs font-semibold transition",
                isActive
                  ? "bg-slate-800 text-white shadow-sm ring-1 ring-cyan-400/25"
                  : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-100",
              )}
            >
              {sectionLabel}
              {routeBadge ? (
                <span className="rounded-full bg-amber-500/20 px-1.5 text-[0.65rem] text-amber-100">
                  {routeBadge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
};

interface RalphSelectedRouteSummaryProps {
  outputs: readonly string[];
  routesByOutput: ReadonlyMap<string, RalphFlowEdge>;
  blocks: readonly RalphFlowBlock[] | undefined;
  missingRouteCount: number;
  connectedRouteCount: number;
  onOpenRoutes: () => void;
}

export const RalphSelectedRouteSummary = ({
  outputs,
  routesByOutput,
  blocks,
  missingRouteCount,
  connectedRouteCount,
  onOpenRoutes,
}: RalphSelectedRouteSummaryProps): JSX.Element | null => {
  if (outputs.length === 0) {
    return null;
  }

  return (
    <button
      type="button"
      data-ralph-inspector-section="routes-summary"
      onClick={onOpenRoutes}
      className={cn(
        "grid gap-2 rounded-lg px-3 py-2 text-left text-xs ring-1 transition",
        missingRouteCount > 0
          ? "bg-amber-500/10 ring-amber-400/30 hover:bg-amber-500/15"
          : "bg-slate-950/70 ring-slate-800/70 hover:bg-slate-900/70",
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 font-semibold text-slate-200">
          <Route className="h-3.5 w-3.5 shrink-0 text-sky-300" />
          <span className="truncate">Route summary</span>
        </span>
        <span
          className={cn(
            "shrink-0 font-medium",
            missingRouteCount > 0 ? "text-amber-100" : "text-slate-500",
          )}
        >
          {connectedRouteCount}/{outputs.length} connected
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {outputs.map((output) => {
          const edge = routesByOutput.get(output);
          const targetBlock = edge
            ? blocks?.find((block) => block.id === edge.to) ?? null
            : null;

          return (
            <span
              key={output}
              className={cn(
                "max-w-full truncate rounded border px-2 py-1 font-mono text-[0.68rem]",
                edge
                  ? "border-emerald-400/20 bg-emerald-500/10 text-emerald-100"
                  : "border-amber-400/25 bg-amber-500/10 text-amber-100",
              )}
            >
              {output}
              {" -> "}
              {targetBlock ? targetBlock.title : edge ? "missing" : "unconnected"}
            </span>
          );
        })}
      </div>
    </button>
  );
};
