import {
  Globe2,
  Images,
  LayoutGrid,
  Redo2,
  Route,
  SlidersHorizontal,
  Undo2,
} from "lucide-react";
import type { JSX } from "react";

import type { RalphBlockType, RalphFlowScope } from "../../../../core/ralph.js";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import {
  BLOCK_ACTIONS,
  MCP_BLOCK_ACTIONS,
} from "../_helpers/ralph-flow-editor-options.helper";
import { getBlockTone } from "../_helpers/get-ralph-block-visual.helper";

interface RalphFlowEditorToolbarProps {
  flowTitle: string;
  selectedScope: RalphFlowScope;
  selectedScopeLabel: string;
  hasSelectedFlow: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canCleanLayout: boolean;
  canShowInspector: boolean;
  flowHasStart: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onCleanLayout: () => void;
  onShowInspector: () => void;
  onAddBlock: (type: RalphBlockType) => void;
}

export const RalphFlowEditorToolbar = ({
  flowTitle,
  selectedScope,
  selectedScopeLabel,
  hasSelectedFlow,
  canUndo,
  canRedo,
  canCleanLayout,
  canShowInspector,
  flowHasStart,
  onUndo,
  onRedo,
  onCleanLayout,
  onShowInspector,
  onAddBlock,
}: RalphFlowEditorToolbarProps): JSX.Element => {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 border-b border-slate-800 bg-slate-950/80 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Route className="h-4 w-4 shrink-0 text-sky-300" />
        <span className="hidden truncate text-sm font-semibold text-white min-[1450px]:inline">
          {flowTitle}
        </span>
        {hasSelectedFlow ? (
          <span
            className={cn(
              "hidden shrink-0 rounded border px-1.5 py-0.5 text-[0.62rem] font-semibold uppercase tracking-[0.12em] min-[1450px]:inline",
              selectedScope === "user"
                ? "border-sky-400/30 bg-sky-500/10 text-sky-100"
                : "border-slate-700 bg-slate-900 text-slate-400",
            )}
          >
            {selectedScopeLabel}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <div className="flex items-center gap-0.5 rounded-lg border border-slate-800 bg-slate-900/45 p-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                aria-label="Undo Ralph edit"
                title="Undo Ralph edit (Ctrl+Z)"
                disabled={!canUndo}
                onClick={onUndo}
                className="h-7 w-7 rounded-md p-0 text-xs text-slate-300 hover:bg-slate-800 hover:text-white disabled:text-slate-700"
              >
                <Undo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Undo · Ctrl+Z</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                aria-label="Redo Ralph edit"
                title="Redo Ralph edit (Ctrl+Shift+Z)"
                disabled={!canRedo}
                onClick={onRedo}
                className="h-7 w-7 rounded-md p-0 text-xs text-slate-300 hover:bg-slate-800 hover:text-white disabled:text-slate-700"
              >
                <Redo2 className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Redo · Ctrl+Shift+Z</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                aria-label="Clean Ralph layout"
                title="Clean Ralph layout (Ctrl+L)"
                disabled={!canCleanLayout}
                onClick={onCleanLayout}
                className="h-7 w-7 rounded-md p-0 text-xs text-slate-300 hover:bg-slate-800 hover:text-white disabled:text-slate-700"
              >
                <LayoutGrid className="h-4 w-4 text-slate-300" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Clean layout · Ctrl+L</TooltipContent>
          </Tooltip>
          {canShowInspector ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label="Show block settings"
                  title="Show block settings"
                  onClick={onShowInspector}
                  className="h-7 w-7 rounded-md p-0 text-xs text-slate-300 hover:bg-slate-800 hover:text-white"
                >
                  <SlidersHorizontal className="h-4 w-4 text-slate-300" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Show settings</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
        <div className="flex items-center gap-0.5 rounded-lg border border-slate-800 bg-slate-900/45 p-1">
          <span className="hidden px-1 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500 2xl:inline">
            Add
          </span>
          {BLOCK_ACTIONS.map((action) => {
            const tone = getBlockTone(action.type);
            const Icon = tone.icon;

            return (
              <Tooltip key={action.type}>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`Add ${action.label} block`}
                    title={`Add ${action.label} block`}
                    disabled={action.type === "START" && flowHasStart}
                    onClick={() => onAddBlock(action.type)}
                    className="h-7 w-7 rounded-md p-0 text-slate-300 hover:bg-slate-800 hover:text-white disabled:text-slate-700"
                  >
                    <Icon className={cn("h-4 w-4", tone.badgeClassName)} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{action.label}</TooltipContent>
              </Tooltip>
            );
          })}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label="Add integration block"
                    title="Add integration block"
                    className="h-7 w-7 rounded-md p-0 text-slate-300 hover:bg-slate-800 hover:text-white"
                  >
                    <Globe2 className="h-4 w-4 text-violet-300" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Integrations</TooltipContent>
            </Tooltip>
            <DropdownMenuContent
              align="end"
              sideOffset={5}
              className="z-[90] min-w-36 rounded-md border border-slate-700 bg-slate-950 p-1 text-slate-100 shadow-xl shadow-black/30"
            >
              <DropdownMenuItem
                onSelect={() => onAddBlock("MEDIA_FLOW")}
                className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs font-medium text-orange-200 outline-none focus:bg-orange-500/15 focus:text-orange-100"
              >
                <Images className="h-3.5 w-3.5 shrink-0 text-orange-300" />
                <span className="min-w-0 truncate">Media Studio flow</span>
              </DropdownMenuItem>
              {MCP_BLOCK_ACTIONS.map((action) => (
                <DropdownMenuItem
                  key={action.type}
                  onSelect={() => onAddBlock(action.type)}
                  className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs font-medium text-slate-300 outline-none focus:bg-violet-500/15 focus:text-violet-100"
                >
                  <Globe2 className="h-3.5 w-3.5 shrink-0 text-violet-300" />
                  <span className="min-w-0 truncate">{action.label}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
};
