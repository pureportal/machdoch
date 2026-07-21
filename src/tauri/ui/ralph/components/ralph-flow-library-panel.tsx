import {
  AlertTriangle,
  LoaderCircle,
  Plus,
  RefreshCw,
  Workflow,
  X,
} from "lucide-react";
import type { JSX, MouseEvent as ReactMouseEvent } from "react";

import type {
  RalphFlow,
  RalphFlowScope,
  RalphFlowSummary,
} from "../../../../core/ralph.js";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { cn } from "../../lib/utils";
import { formatFlowSubtitle } from "../_helpers/format-ralph-flow-labels.helper";
import {
  RALPH_FLOW_LIBRARY_LABELS,
  RALPH_FLOW_LIBRARY_MODES,
  RALPH_FLOW_SCOPE_LABELS,
  type RalphFlowLibraryMode,
} from "../_helpers/normalize-ralph-flow-scope.helper";
import type { ActiveRalphRun } from "../_helpers/ralph-active-run-progress.helper";
import {
  getFlowRunStatusLabel,
  getFlowStatusPresentation,
} from "../_helpers/ralph-run-presentation.helper";
import type { RalphStarterFlowUpdate } from "../_helpers/ralph-starter-flow-presentation.helper";
import {
  getFlowSummaryScope,
  getFlowSummarySelectionKey,
} from "../_helpers/upsert-flow-summary.helper";

export type RalphFlowListRow =
  | {
      type: "heading";
      scope: RalphFlowScope;
      count: number;
    }
  | {
      type: "flow";
      flow: RalphFlowSummary;
    };

interface RalphFlowLibraryPanelProps {
  activeRunsByFlowKey: ReadonlyMap<string, readonly ActiveRalphRun[]>;
  defaultFlowActionScope: RalphFlowScope;
  dirty: boolean;
  displayFlowRows: readonly RalphFlowListRow[];
  draftFlow: RalphFlow | null;
  errorCount: number;
  flowLibraryMode: RalphFlowLibraryMode;
  flowListOpen: boolean;
  flowsLoading: boolean;
  generationCreatedFlow:
    | {
        flowId: string;
        scope: RalphFlowScope;
      }
    | null;
  loading: boolean;
  selectedFlowKey: string | null;
  selectedScope: RalphFlowScope;
  warningCount: number;
  workspaceRoot: string;
  getStarterFlowUpdate: (
    flow: RalphFlowSummary,
  ) => RalphStarterFlowUpdate | null;
  onCollapseFlowList: () => void;
  onCreateLocalFlow: (scope?: RalphFlowScope) => void;
  onFlowContextMenu: (
    event: ReactMouseEvent,
    flow: RalphFlowSummary,
  ) => void;
  onFlowLibraryModeChange?: (mode: RalphFlowLibraryMode) => void;
  onOpenFlowList: () => void;
  onOpenStarterFlowDialog: () => void;
  onRefreshFlows: () => void;
  onSelectFlow: (flow: RalphFlowSummary) => void;
  onUpgradeStarterFlow: (flow: RalphFlowSummary) => void;
}

const getFlowStatusLabel = ({
  activeFlowRuns,
  dirty,
  draftFlow,
  errorCount,
  flow,
  flowScope,
  generationCreatedFlow,
  selectedScope,
  starterUpdate,
  warningCount,
}: {
  activeFlowRuns: readonly ActiveRalphRun[];
  dirty: boolean;
  draftFlow: RalphFlow | null;
  errorCount: number;
  flow: RalphFlowSummary;
  flowScope: RalphFlowScope;
  generationCreatedFlow: RalphFlowLibraryPanelProps["generationCreatedFlow"];
  selectedScope: RalphFlowScope;
  starterUpdate: RalphStarterFlowUpdate | null;
  warningCount: number;
}): string => {
  const runStatusLabel = getFlowRunStatusLabel(activeFlowRuns);

  if (runStatusLabel) {
    return runStatusLabel;
  }

  if (starterUpdate) {
    return "Starter update";
  }

  if (
    generationCreatedFlow?.scope === flowScope &&
    generationCreatedFlow.flowId === flow.id
  ) {
    return "Generated";
  }

  if (draftFlow?.id === flow.id && selectedScope === flowScope) {
    if (dirty) {
      return "Unsaved";
    }

    if (errorCount > 0) {
      return "Errors";
    }

    if (warningCount > 0) {
      return "Warnings";
    }

    return "Ready";
  }

  return "Saved";
};

export const RalphFlowLibraryPanel = ({
  activeRunsByFlowKey,
  defaultFlowActionScope,
  dirty,
  displayFlowRows,
  draftFlow,
  errorCount,
  flowLibraryMode,
  flowListOpen,
  flowsLoading,
  generationCreatedFlow,
  getStarterFlowUpdate,
  loading,
  onCollapseFlowList,
  onCreateLocalFlow,
  onFlowContextMenu,
  onFlowLibraryModeChange,
  onOpenFlowList,
  onOpenStarterFlowDialog,
  onRefreshFlows,
  onSelectFlow,
  onUpgradeStarterFlow,
  selectedFlowKey,
  selectedScope,
  warningCount,
  workspaceRoot,
}: RalphFlowLibraryPanelProps): JSX.Element => {
  if (!flowListOpen) {
    return (
      <aside className="col-start-1 row-start-1 flex min-h-0 flex-col items-center gap-3 border-r border-slate-800 bg-slate-950/80 px-1.5 py-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Open Ralph flows"
          title="Open Ralph flows"
          onClick={onOpenFlowList}
          className="h-8 w-8 rounded-lg text-slate-400 hover:bg-slate-900 hover:text-slate-100"
        >
          <Workflow className="h-4 w-4" />
        </Button>
        <span className="origin-center rotate-90 whitespace-nowrap text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-slate-600">
          Flows
        </span>
      </aside>
    );
  }

  return (
    <aside className="col-start-1 row-start-1 grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-slate-800 bg-slate-950/85">
      <div className="grid gap-2.5 border-b border-slate-800 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold tracking-[0.16em] text-slate-300 uppercase">
            Flow library
          </span>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={flowsLoading}
              aria-label="Refresh Ralph flows"
              title="Refresh Ralph flows"
              onClick={onRefreshFlows}
              className="h-8 w-8 rounded-lg text-slate-400 hover:bg-slate-900 hover:text-slate-100"
            >
              <RefreshCw
                className={cn("h-4 w-4", flowsLoading && "animate-spin")}
              />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Collapse Ralph flows"
              title="Collapse Ralph flows"
              onClick={onCollapseFlowList}
              className="h-8 w-8 rounded-lg text-slate-500 hover:bg-slate-900 hover:text-slate-100"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1">
          {RALPH_FLOW_LIBRARY_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={flowLibraryMode === mode}
              onClick={() => onFlowLibraryModeChange?.(mode)}
              className={cn(
                "h-7 min-w-0 rounded-md px-2 text-xs font-semibold",
                flowLibraryMode === mode
                  ? mode === "user"
                    ? "bg-sky-500/20 text-sky-100"
                    : mode === "workspace"
                      ? "bg-emerald-500/20 text-emerald-100"
                      : "bg-slate-700 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
              )}
            >
              <span className="block truncate">
                {RALPH_FLOW_LIBRARY_LABELS[mode]}
              </span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!workspaceRoot}
            onClick={() => onCreateLocalFlow(defaultFlowActionScope)}
            className="h-9 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs text-slate-100 hover:bg-slate-800"
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!workspaceRoot}
            aria-label="Open starter Ralph flows"
            onClick={onOpenStarterFlowDialog}
            className="h-9 rounded-lg border-amber-400/30 bg-amber-500/10 px-3 text-xs text-amber-100 hover:bg-amber-500/15 hover:text-white"
          >
            <Workflow className="h-3.5 w-3.5" />
            Starters
          </Button>
        </div>
      </div>

      <ScrollArea
        className="min-h-0 [&_[data-slot=scroll-area-scrollbar]]:border-l-0"
        type="always"
      >
        <div className="grid p-2 pr-4">
          {flowsLoading && displayFlowRows.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 px-3 py-4 text-sm text-slate-400">
              <LoaderCircle className="h-4 w-4 animate-spin text-sky-300" />
              Loading Ralph flows...
            </div>
          ) : displayFlowRows.length === 0 ? (
            <div className="px-2 py-3 text-sm leading-5 text-slate-400">
              {workspaceRoot
                ? `No ${RALPH_FLOW_LIBRARY_LABELS[flowLibraryMode].toLowerCase()} Ralph flows found.`
                : "Choose a workspace before creating Ralph flows."}
            </div>
          ) : (
            displayFlowRows.map((row) =>
              row.type === "heading" ? (
                <div
                  key={`heading-${row.scope}`}
                  className="flex min-w-0 items-center justify-between gap-2 px-2 pb-1 pt-3 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-slate-500 first:pt-1"
                >
                  <span>{RALPH_FLOW_SCOPE_LABELS[row.scope]}</span>
                  <span>{row.count}</span>
                </div>
              ) : (
                <RalphFlowLibraryRow
                  key={getFlowSummarySelectionKey(row.flow)}
                  activeRunsByFlowKey={activeRunsByFlowKey}
                  dirty={dirty}
                  draftFlow={draftFlow}
                  errorCount={errorCount}
                  flow={row.flow}
                  generationCreatedFlow={generationCreatedFlow}
                  getStarterFlowUpdate={getStarterFlowUpdate}
                  loading={loading}
                  onContextMenu={onFlowContextMenu}
                  onSelectFlow={onSelectFlow}
                  onUpgradeStarterFlow={onUpgradeStarterFlow}
                  selectedFlowKey={selectedFlowKey}
                  selectedScope={selectedScope}
                  warningCount={warningCount}
                />
              ),
            )
          )}
        </div>
      </ScrollArea>
    </aside>
  );
};

interface RalphFlowLibraryRowProps {
  activeRunsByFlowKey: ReadonlyMap<string, readonly ActiveRalphRun[]>;
  dirty: boolean;
  draftFlow: RalphFlow | null;
  errorCount: number;
  flow: RalphFlowSummary;
  generationCreatedFlow: RalphFlowLibraryPanelProps["generationCreatedFlow"];
  getStarterFlowUpdate: (
    flow: RalphFlowSummary,
  ) => RalphStarterFlowUpdate | null;
  loading: boolean;
  onContextMenu: (event: ReactMouseEvent, flow: RalphFlowSummary) => void;
  onSelectFlow: (flow: RalphFlowSummary) => void;
  onUpgradeStarterFlow: (flow: RalphFlowSummary) => void;
  selectedFlowKey: string | null;
  selectedScope: RalphFlowScope;
  warningCount: number;
}

const RalphFlowLibraryRow = ({
  activeRunsByFlowKey,
  dirty,
  draftFlow,
  errorCount,
  flow,
  generationCreatedFlow,
  getStarterFlowUpdate,
  loading,
  onContextMenu,
  onSelectFlow,
  onUpgradeStarterFlow,
  selectedFlowKey,
  selectedScope,
  warningCount,
}: RalphFlowLibraryRowProps): JSX.Element => {
  const flowScope = getFlowSummaryScope(flow);
  const flowKey = getFlowSummarySelectionKey(flow);
  const isSelectedFlow = selectedFlowKey === flowKey;
  const canLoadFlow =
    Boolean(flow.path) || (draftFlow?.id === flow.id && selectedScope === flowScope);
  const starterUpdate = getStarterFlowUpdate(flow);
  const statusLabel = getFlowStatusLabel({
    activeFlowRuns: activeRunsByFlowKey.get(flowKey) ?? [],
    dirty,
    draftFlow,
    errorCount,
    flow,
    flowScope,
    generationCreatedFlow,
    selectedScope,
    starterUpdate,
    warningCount,
  });
  const statusPresentation = getFlowStatusPresentation(statusLabel);
  const StatusIcon = statusPresentation.icon;

  return (
    <div
      onContextMenu={(event) => onContextMenu(event, flow)}
      className={cn(
        "flex min-w-0 items-center gap-2 border-b border-slate-800/70 px-2 py-2 last:border-b-0",
        isSelectedFlow
          ? "bg-emerald-500/10"
          : canLoadFlow
            ? "hover:bg-slate-900/70"
            : "cursor-default opacity-80",
      )}
    >
      <button
        type="button"
        disabled={!canLoadFlow}
        onClick={() => onSelectFlow(flow)}
        title={flow.name}
        className="grid min-w-0 flex-1 gap-1 text-left disabled:cursor-default"
      >
        <span className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-slate-100">
            {flow.name}
          </span>
          <span
            aria-label={`Flow status: ${statusLabel}`}
            title={statusLabel}
            className={cn(
              "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-slate-800 bg-slate-950",
              statusPresentation.className,
            )}
          >
            <StatusIcon
              className={cn("h-3.5 w-3.5", statusPresentation.spin && "animate-spin")}
            />
          </span>
        </span>
        <span className="truncate text-[0.7rem] leading-4 text-slate-400">
          {formatFlowSubtitle(flow)}
        </span>
        {starterUpdate ? (
          <span className="flex min-w-0 items-center gap-1 text-[0.68rem] font-medium leading-4 text-amber-200">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">
              Starter v{starterUpdate.latestVersion} available
            </span>
          </span>
        ) : null}
      </button>
      {starterUpdate ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={loading}
          aria-label={`Upgrade ${flow.name} to starter version ${starterUpdate.latestVersion}`}
          title={`Upgrade to starter v${starterUpdate.latestVersion}`}
          onClick={() => onUpgradeStarterFlow(flow)}
          className="h-7 w-7 shrink-0 rounded-md text-amber-300 hover:bg-amber-500/10 hover:text-amber-100"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
};
