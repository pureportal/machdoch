import {
  Braces,
  FileText,
  Route,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
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

  const sectionIcons = {
    content: FileText,
    behavior: Settings2,
    execution: SlidersHorizontal,
    advanced: Braces,
    routes: Route,
  } as const;

  return (
    <div className="border-b border-slate-800/70 bg-slate-950/95 px-3 py-2">
      <div
        className="grid min-w-0 gap-1 rounded-lg border border-slate-800/70 bg-slate-900/55 p-1"
        style={{
          gridTemplateColumns: `repeat(${sections.length}, minmax(0, 1fr))`,
        }}
      >
        {sections.map((section) => {
          const isActive = activeSection === section.id;
          const Icon = sectionIcons[section.id];
          const routeBadge =
            section.id === "routes" && missingRouteCount > 0
              ? missingRouteCount
              : null;
          const sectionLabel = section.label;

          return (
            <button
              key={section.id}
              type="button"
              aria-label={section.id === "routes" ? "Route map" : section.label}
              aria-pressed={isActive}
              title={section.id === "routes" ? "Route map" : section.label}
              onClick={() => onSelectSection(section.id)}
              className={cn(
                "relative flex h-8 min-w-0 items-center justify-center gap-0.5 rounded-md px-1 text-[0.68rem] font-semibold transition",
                isActive
                  ? "bg-cyan-500/15 text-cyan-50 shadow-sm ring-1 ring-cyan-400/30"
                  : "text-slate-400 hover:bg-slate-800/80 hover:text-slate-100",
              )}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">{sectionLabel}</span>
              {routeBadge ? (
                <span className="absolute -right-1 -top-1 min-w-4 rounded-full border border-slate-900 bg-amber-500/25 px-1 text-center text-[0.6rem] leading-4 text-amber-100">
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
