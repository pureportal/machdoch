import { ChevronRight, type LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import type { RalphBlockType } from "../../../../core/ralph.js";
import { cn } from "../../lib/utils";
import { getBlockTone } from "../_helpers/get-ralph-block-visual.helper";
import { MCP_BLOCK_ACTIONS } from "../_helpers/ralph-flow-editor-options.helper";

interface RalphCanvasMenuButtonOptions {
  disabled?: boolean;
  danger?: boolean;
  icon?: LucideIcon;
  iconClassName?: string;
  key?: string;
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
      className="app-menu-item w-full"
      data-variant={options.danger ? "destructive" : undefined}
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
        className="app-menu-item w-full"
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
          "invisible pointer-events-none absolute top-0 z-[140] max-h-[min(24rem,calc(100vh-1rem))] w-56 overflow-y-auto app-menu-surface opacity-0 [scrollbar-width:thin] group-hover/submenu:pointer-events-auto group-hover/submenu:visible group-hover/submenu:opacity-100 group-focus-within/submenu:pointer-events-auto group-focus-within/submenu:visible group-focus-within/submenu:opacity-100",
          side === "left" ? "right-full mr-1" : "left-full ml-1",
        )}
      >
        {children}
      </div>
    </div>
  );
};

export const renderWorkflowBlockButtons = (
  addBlock: (type: RalphBlockType) => void,
): JSX.Element => (
  <>
    <RalphAddBlockContextMenuButton
      label="Prompt"
      type="PROMPT"
      onClick={() => addBlock("PROMPT")}
    />
    <RalphAddBlockContextMenuButton
      label="Validator"
      type="VALIDATOR"
      onClick={() => addBlock("VALIDATOR")}
    />
    <RalphAddBlockContextMenuButton
      label="Decision"
      type="DECISION"
      onClick={() => addBlock("DECISION")}
    />
    <RalphAddBlockContextMenuButton
      label="Pack"
      type="PACK"
      onClick={() => addBlock("PACK")}
    />
    <RalphAddBlockContextMenuButton
      label="Utility"
      type="UTILITY"
      onClick={() => addBlock("UTILITY")}
    />
    <RalphAddBlockContextMenuButton
      label="Media Flow"
      type="MEDIA_FLOW"
      onClick={() => addBlock("MEDIA_FLOW")}
    />
    <RalphAddBlockContextMenuButton
      label="End"
      type="END"
      onClick={() => addBlock("END")}
    />
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
