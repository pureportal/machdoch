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
  Globe2,
  LayoutGrid,
  LockKeyhole,
  LockKeyholeOpen,
  Plus,
  Trash2,
} from "lucide-react";
import type { JSX } from "react";

import type {
  RalphBlockType,
  RalphFlowBlock,
  RalphPosition,
} from "../../../../core/ralph.js";
import {
  RALPH_CANVAS_X_GAP,
  RALPH_CANVAS_Y_GAP,
} from "../_helpers/ralph-canvas-layout.helper";

interface RalphNodeContextMenuContentProps {
  menuBlock: RalphFlowBlock;
  submenuSide: "left" | "right";
  addBlock: (type: RalphBlockType, position?: RalphPosition) => void;
  addBlockAfter: (blockId: string, type: RalphBlockType) => void;
  setBlockLocked: (blockId: string, locked: boolean) => void;
  copyBlock: (blockId: string) => void;
  duplicateBlock: (blockId: string) => void;
  deleteSelectedBlock: () => void;
}

export const RalphNodeContextMenuContent = ({
  menuBlock,
  submenuSide,
  addBlock,
  addBlockAfter,
  setBlockLocked,
  copyBlock,
  duplicateBlock,
  deleteSelectedBlock,
}: RalphNodeContextMenuContentProps): JSX.Element => (
  <>
    <div className="app-menu-label">{menuBlock.title}</div>
    <RalphCanvasSubmenu
      label="Add after"
      icon={Plus}
      iconClassName="text-cyan-300"
      side={submenuSide}
    >
      {renderWorkflowBlockButtons((type) => addBlockAfter(menuBlock.id, type))}
    </RalphCanvasSubmenu>
    <RalphCanvasSubmenu
      label="Add nearby"
      icon={LayoutGrid}
      iconClassName="text-slate-300"
      side={submenuSide}
    >
      <RalphAddBlockContextMenuButton
        label="Note"
        type="NOTE"
        onClick={() =>
          addBlock("NOTE", {
            x: (menuBlock.position?.x ?? 0) + RALPH_CANVAS_X_GAP,
            y: (menuBlock.position?.y ?? 0) + RALPH_CANVAS_Y_GAP,
          })
        }
      />
      <RalphAddBlockContextMenuButton
        label="Group"
        type="GROUP"
        onClick={() =>
          addBlock("GROUP", {
            x: menuBlock.position?.x ?? 0,
            y: (menuBlock.position?.y ?? 0) + RALPH_CANVAS_Y_GAP,
          })
        }
      />
    </RalphCanvasSubmenu>
    <RalphCanvasSubmenu
      label="Add MCP after"
      icon={Globe2}
      iconClassName="text-violet-300"
      side={submenuSide}
    >
      {renderMcpBlockButtons((type) => addBlockAfter(menuBlock.id, type))}
    </RalphCanvasSubmenu>
    <div className="app-menu-separator" />
    <RalphContextMenuButton
      label={menuBlock.locked ? "Unlock node" : "Lock node"}
      onClick={() => setBlockLocked(menuBlock.id, !(menuBlock.locked ?? false))}
      options={{
        icon: menuBlock.locked ? LockKeyholeOpen : LockKeyhole,
        iconClassName: menuBlock.locked ? "text-amber-200" : "text-cyan-200",
      }}
    />
    <RalphContextMenuButton
      label="Copy block"
      onClick={() => copyBlock(menuBlock.id)}
      options={{ icon: Copy }}
    />
    <RalphContextMenuButton
      label="Duplicate block"
      onClick={() => duplicateBlock(menuBlock.id)}
      options={{
        disabled: menuBlock.type === "START",
        icon: ClipboardPaste,
      }}
    />
    <RalphContextMenuButton
      label="Delete block"
      onClick={deleteSelectedBlock}
      options={{
        disabled: menuBlock.type === "START",
        danger: true,
        icon: Trash2,
      }}
    />
  </>
);
