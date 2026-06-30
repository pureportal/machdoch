import {
  ChevronRight,
  ClipboardPaste,
  Copy,
  FolderOpen,
  Globe2,
  LayoutGrid,
  Plus,
  Route,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { JSX, ReactNode } from "react";

import type {
  RalphBlockType,
  RalphFlow,
  RalphFlowScope,
  RalphFlowSummary,
  RalphPosition,
} from "../../../../core/ralph.js";
import { cn } from "../../lib/utils";
import { getBlockTone } from "../_helpers/get-ralph-block-visual.helper";
import { getFlowSummaryScope } from "../_helpers/upsert-flow-summary.helper";
import {
  MCP_BLOCK_ACTIONS,
  RALPH_CONTEXT_MENU_MARGIN,
  RALPH_CONTEXT_MENU_WIDTH,
  RALPH_CONTEXT_SUBMENU_WIDTH,
} from "../_helpers/ralph-flow-editor-options.helper";
import type { ActiveRalphRun } from "../_helpers/ralph-active-run-progress.helper";
import { RalphNodeContextMenuContent } from "./ralph-node-context-menu-content";

export type RalphCanvasMenu =
  | {
      type: "pane";
      left: number;
      top: number;
      position: RalphPosition;
    }
  | {
      type: "node";
      left: number;
      top: number;
      blockId: string;
    }
  | {
      type: "edge";
      left: number;
      top: number;
      edgeId: string;
    };

export interface RalphFlowListMenu {
  left: number;
  top: number;
  flow: RalphFlowSummary;
}

interface RalphCanvasMenuButtonOptions {
  disabled?: boolean;
  danger?: boolean;
  icon?: LucideIcon;
  iconClassName?: string;
  key?: string;
}

interface RalphFlowListContextMenuProps {
  flowListMenu: RalphFlowListMenu | null;
  workspaceRoot: string | null;
  loading: boolean;
  selectedId: string | null;
  selectedScope: RalphFlowScope;
  draftFlow: RalphFlow | null;
  getFlowActiveRuns: (flow: RalphFlowSummary) => ActiveRalphRun[];
  isGenerationTargetingFlow: (flow: RalphFlowSummary) => boolean;
  openFlowInExplorer: (flow: RalphFlowSummary) => void | Promise<void>;
  copyOrMoveFlowToScope: (
    flow: RalphFlowSummary,
    targetScope: RalphFlowScope,
    operation: "copy" | "move",
  ) => void | Promise<void>;
  deleteFlow: (flow: RalphFlowSummary) => void | Promise<void>;
}

interface RalphCanvasContextMenuProps {
  canvasMenu: RalphCanvasMenu | null;
  draftFlow: RalphFlow | null;
  hasCopiedBlock: boolean;
  addBlock: (type: RalphBlockType, position?: RalphPosition) => void;
  addBlockAfter: (blockId: string, type: RalphBlockType) => void;
  pasteCopiedBlock: (position?: RalphPosition) => void;
  cleanFlowLayout: () => void;
  setBlockLocked: (blockId: string, locked: boolean) => void;
  copyBlock: (blockId: string) => void;
  duplicateBlock: (blockId: string) => void;
  deleteSelectedBlock: () => void;
  removeEdge: (edgeId: string) => void;
}

export const RalphContextMenuButton = ({
  label,
  onClick,
  options = {},
}: {
  label: string;
  onClick: () => void;
  options?: RalphCanvasMenuButtonOptions;
}): JSX.Element => {
  const Icon = options.icon;

  return (
    <button
      key={options.key}
      type="button"
      role="menuitem"
      disabled={options.disabled}
      onClick={onClick}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs font-medium outline-none",
        options.disabled
          ? "cursor-not-allowed text-slate-600"
          : options.danger
            ? "text-rose-100 hover:bg-rose-500/10"
            : "text-slate-200 hover:bg-slate-800",
      )}
    >
      {Icon ? (
        <Icon className={cn("h-3.5 w-3.5 shrink-0", options.iconClassName)} />
      ) : null}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
};

export const RalphAddBlockContextMenuButton = ({
  label,
  type,
  onClick,
  menuKey,
}: {
  label: string;
  type: RalphBlockType;
  onClick: () => void;
  menuKey?: string;
}): JSX.Element => {
  const tone = getBlockTone(type);

  return (
    <RalphContextMenuButton
      label={label}
      onClick={onClick}
      options={{
        key: menuKey,
        icon: tone.icon,
        iconClassName: tone.badgeClassName,
      }}
    />
  );
};

export const RalphCanvasSubmenu = ({
  label,
  children,
  icon: Icon,
  iconClassName,
  side = "right",
}: {
  label: string;
  children: ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  side?: "left" | "right";
}): JSX.Element => {
  return (
    <div className="group/submenu relative" role="none">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        onClick={(event) => event.preventDefault()}
        className="flex h-8 w-full items-center gap-2 rounded px-2 text-left text-xs font-medium text-slate-200 outline-none hover:bg-slate-800 focus:bg-slate-800"
      >
        {Icon ? (
          <Icon className={cn("h-3.5 w-3.5 shrink-0", iconClassName)} />
        ) : null}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-slate-500",
            side === "left" && "rotate-180",
          )}
        />
      </button>
      <div
        role="menu"
        className={cn(
          "invisible pointer-events-none absolute top-0 z-[140] max-h-[min(24rem,calc(100vh-1rem))] w-56 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950 p-1.5 opacity-0 shadow-2xl shadow-black/45 [scrollbar-width:thin] group-hover/submenu:pointer-events-auto group-hover/submenu:visible group-hover/submenu:opacity-100 group-focus-within/submenu:pointer-events-auto group-focus-within/submenu:visible group-focus-within/submenu:opacity-100",
          side === "left" ? "right-full mr-1" : "left-full ml-1",
        )}
      >
        {children}
      </div>
    </div>
  );
};

export const RalphFlowListContextMenu = ({
  flowListMenu,
  workspaceRoot,
  loading,
  selectedId,
  selectedScope,
  draftFlow,
  getFlowActiveRuns,
  isGenerationTargetingFlow,
  openFlowInExplorer,
  copyOrMoveFlowToScope,
  deleteFlow,
}: RalphFlowListContextMenuProps): JSX.Element | null => {
  if (!flowListMenu) {
    return null;
  }

  const flow = flowListMenu.flow;
  const flowScope = getFlowSummaryScope(flow);
  const activeFlowRuns = getFlowActiveRuns(flow);
  const baseDisabled = !workspaceRoot || !flow.path || loading;
  const isSelectedOpenFlow =
    selectedId === flow.id && selectedScope === flowScope && draftFlow?.id === flow.id;
  const mutationDisabled =
    baseDisabled || activeFlowRuns.length > 0 || isGenerationTargetingFlow(flow);
  const deleteDisabled =
    !workspaceRoot ||
    loading ||
    activeFlowRuns.length > 0 ||
    (!flow.path && !isSelectedOpenFlow);
  const globalScope: RalphFlowScope = "user";
  const workspaceScope: RalphFlowScope = "workspace";

  return (
    <div
      role="menu"
      className="fixed z-[130] w-56 rounded-lg border border-slate-700 bg-slate-950 p-1.5 shadow-2xl shadow-black/45"
      style={{ left: flowListMenu.left, top: flowListMenu.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="min-w-0 px-2 pb-1 pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
        <span className="block truncate">{flow.name}</span>
      </div>
      <RalphContextMenuButton
        label="Open in Explorer"
        onClick={() => void openFlowInExplorer(flow)}
        options={{
          disabled: baseDisabled,
          icon: FolderOpen,
          iconClassName: "text-cyan-300",
        }}
      />
      <div className="my-1 h-px bg-slate-800" />
      <RalphContextMenuButton
        label="Copy to global"
        onClick={() => void copyOrMoveFlowToScope(flow, globalScope, "copy")}
        options={{
          disabled: baseDisabled || flowScope === globalScope,
          icon: Copy,
          iconClassName: "text-sky-300",
        }}
      />
      <RalphContextMenuButton
        label="Copy to workspace"
        onClick={() => void copyOrMoveFlowToScope(flow, workspaceScope, "copy")}
        options={{
          disabled: baseDisabled || flowScope === workspaceScope,
          icon: Copy,
          iconClassName: "text-emerald-300",
        }}
      />
      <div className="my-1 h-px bg-slate-800" />
      <RalphContextMenuButton
        label="Move to global"
        onClick={() => void copyOrMoveFlowToScope(flow, globalScope, "move")}
        options={{
          disabled: mutationDisabled || flowScope === globalScope,
          icon: Route,
          iconClassName: "text-sky-300",
        }}
      />
      <RalphContextMenuButton
        label="Move to workspace"
        onClick={() => void copyOrMoveFlowToScope(flow, workspaceScope, "move")}
        options={{
          disabled: mutationDisabled || flowScope === workspaceScope,
          icon: Route,
          iconClassName: "text-emerald-300",
        }}
      />
      <div className="my-1 h-px bg-slate-800" />
      <RalphContextMenuButton
        label="Delete"
        onClick={() => void deleteFlow(flow)}
        options={{ disabled: deleteDisabled, danger: true, icon: Trash2 }}
      />
    </div>
  );
};

export const renderWorkflowBlockButtons = (
  addBlock: (type: RalphBlockType) => void,
): JSX.Element => (
  <>
    <RalphAddBlockContextMenuButton label="Prompt" type="PROMPT" onClick={() => addBlock("PROMPT")} />
    <RalphAddBlockContextMenuButton label="Validator" type="VALIDATOR" onClick={() => addBlock("VALIDATOR")} />
    <RalphAddBlockContextMenuButton label="Decision" type="DECISION" onClick={() => addBlock("DECISION")} />
    <RalphAddBlockContextMenuButton label="Pack" type="PACK" onClick={() => addBlock("PACK")} />
    <RalphAddBlockContextMenuButton label="Utility" type="UTILITY" onClick={() => addBlock("UTILITY")} />
    <RalphAddBlockContextMenuButton label="End" type="END" onClick={() => addBlock("END")} />
  </>
);

export const renderMcpBlockButtons = (
  addBlock: (type: RalphBlockType) => void,
): JSX.Element => (
  <>
    {MCP_BLOCK_ACTIONS.map((action) => (
      <RalphAddBlockContextMenuButton
        key={action.type}
        label={action.label}
        type={action.type}
        onClick={() => addBlock(action.type)}
        menuKey={action.type}
      />
    ))}
  </>
);

export const RalphCanvasContextMenu = ({
  canvasMenu,
  draftFlow,
  hasCopiedBlock,
  addBlock,
  addBlockAfter,
  pasteCopiedBlock,
  cleanFlowLayout,
  setBlockLocked,
  copyBlock,
  duplicateBlock,
  deleteSelectedBlock,
  removeEdge,
}: RalphCanvasContextMenuProps): JSX.Element | null => {
  if (!canvasMenu) {
    return null;
  }

  const menuBlock =
    canvasMenu.type === "node"
      ? draftFlow?.blocks.find((block) => block.id === canvasMenu.blockId) ?? null
      : null;
  const menuEdge =
    canvasMenu.type === "edge"
      ? draftFlow?.edges.find((edge) => edge.id === canvasMenu.edgeId) ?? null
      : null;
  const submenuSide =
    typeof window !== "undefined" &&
    canvasMenu.left +
      RALPH_CONTEXT_MENU_WIDTH +
      RALPH_CONTEXT_SUBMENU_WIDTH +
      RALPH_CONTEXT_MENU_MARGIN >
      window.innerWidth
      ? "left"
      : "right";

  return (
    <div
      role="menu"
      className="fixed z-[120] w-56 overflow-visible rounded-lg border border-slate-700 bg-slate-950 p-1.5 shadow-2xl shadow-black/45"
      style={{ left: canvasMenu.left, top: canvasMenu.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {canvasMenu.type === "pane" ? (
        <>
          <div className="px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Canvas
          </div>
          <RalphCanvasSubmenu
            label="Add block"
            icon={Plus}
            iconClassName="text-cyan-300"
            side={submenuSide}
          >
            {renderWorkflowBlockButtons((type) => addBlock(type, canvasMenu.position))}
          </RalphCanvasSubmenu>
          <RalphCanvasSubmenu
            label="Add visual"
            icon={LayoutGrid}
            iconClassName="text-slate-300"
            side={submenuSide}
          >
            <RalphAddBlockContextMenuButton label="Note" type="NOTE" onClick={() => addBlock("NOTE", canvasMenu.position)} />
            <RalphAddBlockContextMenuButton label="Group" type="GROUP" onClick={() => addBlock("GROUP", canvasMenu.position)} />
          </RalphCanvasSubmenu>
          <RalphCanvasSubmenu
            label="Add MCP"
            icon={Globe2}
            iconClassName="text-violet-300"
            side={submenuSide}
          >
            {renderMcpBlockButtons((type) => addBlock(type, canvasMenu.position))}
          </RalphCanvasSubmenu>
          <div className="my-1 border-t border-slate-800" />
          <RalphContextMenuButton
            label="Paste block"
            onClick={() => pasteCopiedBlock(canvasMenu.position)}
            options={{ disabled: !hasCopiedBlock, icon: ClipboardPaste }}
          />
          <RalphContextMenuButton
            label="Clean layout"
            onClick={cleanFlowLayout}
            options={{ disabled: !draftFlow, icon: LayoutGrid }}
          />
        </>
      ) : null}

      {canvasMenu.type === "node" && menuBlock ? (
        <RalphNodeContextMenuContent
          menuBlock={menuBlock}
          submenuSide={submenuSide}
          addBlock={addBlock}
          addBlockAfter={addBlockAfter}
          setBlockLocked={setBlockLocked}
          copyBlock={copyBlock}
          duplicateBlock={duplicateBlock}
          deleteSelectedBlock={deleteSelectedBlock}
        />
      ) : null}

      {canvasMenu.type === "edge" && menuEdge ? (
        <>
          <div className="px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Route {menuEdge.fromOutput}
          </div>
          <RalphContextMenuButton
            label="Remove route"
            onClick={() => removeEdge(menuEdge.id)}
            options={{ danger: true, icon: Trash2 }}
          />
          <RalphContextMenuButton
            label="Clean layout"
            onClick={cleanFlowLayout}
            options={{ disabled: !draftFlow, icon: LayoutGrid }}
          />
        </>
      ) : null}
    </div>
  );
};
