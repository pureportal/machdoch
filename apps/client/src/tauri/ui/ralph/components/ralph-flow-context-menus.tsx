import {
  RalphContextMenuButton,
  RalphAddBlockContextMenuButton,
  RalphCanvasSubmenu,
  renderWorkflowBlockButtons,
  renderMcpBlockButtons,
} from "./ralph-context-menu-controls";
import {
  ClipboardPaste,
  Copy,
  FolderOpen,
  Globe2,
  LayoutGrid,
  Plus,
  Route,
  Trash2,
} from "lucide-react";
import type { JSX } from "react";

import type {
  RalphBlockType,
  RalphFlow,
  RalphFlowScope,
  RalphFlowSummary,
  RalphPosition,
} from "../../../../core/ralph.js";
import { getFlowSummaryScope } from "../_helpers/upsert-flow-summary.helper";
import {
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
    selectedId === flow.id &&
    selectedScope === flowScope &&
    draftFlow?.id === flow.id;
  const mutationDisabled =
    baseDisabled ||
    activeFlowRuns.length > 0 ||
    isGenerationTargetingFlow(flow);
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
      className="fixed z-[130] w-56 app-menu-surface"
      style={{ left: flowListMenu.left, top: flowListMenu.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="app-menu-label min-w-0">
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
      <div className="app-menu-separator" />
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
      <div className="app-menu-separator" />
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
      <div className="app-menu-separator" />
      <RalphContextMenuButton
        label="Delete"
        onClick={() => void deleteFlow(flow)}
        options={{ disabled: deleteDisabled, danger: true, icon: Trash2 }}
      />
    </div>
  );
};

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
      ? (draftFlow?.blocks.find((block) => block.id === canvasMenu.blockId) ??
        null)
      : null;
  const menuEdge =
    canvasMenu.type === "edge"
      ? (draftFlow?.edges.find((edge) => edge.id === canvasMenu.edgeId) ?? null)
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
      className="fixed z-[120] w-56 overflow-visible app-menu-surface"
      style={{ left: canvasMenu.left, top: canvasMenu.top }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {canvasMenu.type === "pane" ? (
        <>
          <div className="app-menu-label">Canvas</div>
          <RalphCanvasSubmenu
            label="Add block"
            icon={Plus}
            iconClassName="text-cyan-300"
            side={submenuSide}
          >
            {renderWorkflowBlockButtons((type) =>
              addBlock(type, canvasMenu.position),
            )}
          </RalphCanvasSubmenu>
          <RalphCanvasSubmenu
            label="Add visual"
            icon={LayoutGrid}
            iconClassName="text-slate-300"
            side={submenuSide}
          >
            <RalphAddBlockContextMenuButton
              label="Note"
              type="NOTE"
              onClick={() => addBlock("NOTE", canvasMenu.position)}
            />
            <RalphAddBlockContextMenuButton
              label="Group"
              type="GROUP"
              onClick={() => addBlock("GROUP", canvasMenu.position)}
            />
          </RalphCanvasSubmenu>
          <RalphCanvasSubmenu
            label="Add MCP"
            icon={Globe2}
            iconClassName="text-violet-300"
            side={submenuSide}
          >
            {renderMcpBlockButtons((type) =>
              addBlock(type, canvasMenu.position),
            )}
          </RalphCanvasSubmenu>
          <div className="app-menu-separator" />
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
          <div className="app-menu-label">Route {menuEdge.fromOutput}</div>
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
