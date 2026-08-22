import {
  ChevronRight,
  ClipboardPaste,
  Copy,
  Globe2,
  LayoutGrid,
  LockKeyhole,
  LockKeyholeOpen,
  Plus,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { JSX, ReactNode } from "react";

import type {
  RalphBlockType,
  RalphFlowBlock,
  RalphPosition,
} from "../../../../core/ralph.js";
import {
  RALPH_CANVAS_X_GAP,
  RALPH_CANVAS_Y_GAP,
} from "../_helpers/ralph-canvas-layout.helper";
import { getBlockTone } from "../_helpers/get-ralph-block-visual.helper";
import { MCP_BLOCK_ACTIONS } from "../_helpers/ralph-flow-editor-options.helper";
import { cn } from "../../lib/utils";

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
    <div className="px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500">
      {menuBlock.title}
    </div>
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
    <div className="my-1 border-t border-slate-800" />
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

interface RalphCanvasMenuButtonOptions {
  disabled?: boolean;
  danger?: boolean;
  icon?: LucideIcon;
  iconClassName?: string;
}

const RalphContextMenuButton = ({
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

const RalphAddBlockContextMenuButton = ({
  label,
  type,
  onClick,
}: {
  label: string;
  type: RalphBlockType;
  onClick: () => void;
}): JSX.Element => {
  const tone = getBlockTone(type);

  return (
    <RalphContextMenuButton
      label={label}
      onClick={onClick}
      options={{
        icon: tone.icon,
        iconClassName: tone.badgeClassName,
      }}
    />
  );
};

const RalphCanvasSubmenu = ({
  label,
  children,
  icon: Icon,
  iconClassName,
  side,
}: {
  label: string;
  children: ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  side: "left" | "right";
}): JSX.Element => (
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

const renderWorkflowBlockButtons = (
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

const renderMcpBlockButtons = (
  addBlock: (type: RalphBlockType) => void,
): JSX.Element => (
  <>
    {MCP_BLOCK_ACTIONS.map((action) => (
      <RalphAddBlockContextMenuButton
        key={action.type}
        label={action.label}
        type={action.type}
        onClick={() => addBlock(action.type)}
      />
    ))}
  </>
);
