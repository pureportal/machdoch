import { LayoutGrid, Redo2, Undo2 } from "lucide-react";
import type { JSX } from "react";

export interface FlowToolbarAction {
  label: string;
  disabled: boolean;
  onClick: () => void;
  keyShortcuts?: string | undefined;
}

export interface FlowHistoryControlsProps {
  undo: FlowToolbarAction;
  redo: FlowToolbarAction;
  layout?: FlowToolbarAction;
}

export const FlowHistoryControls = ({
  undo,
  redo,
  layout,
}: FlowHistoryControlsProps): JSX.Element => (
  <div className="flow-history-controls flex items-center gap-0.5">
    {[
      { action: undo, Icon: Undo2 },
      { action: redo, Icon: Redo2 },
      ...(layout ? [{ action: layout, Icon: LayoutGrid }] : []),
    ].map(({ action, Icon }) => (
      <button
        key={action.label}
        type="button"
        aria-label={action.label}
        aria-keyshortcuts={action.keyShortcuts}
        title={action.label}
        disabled={action.disabled}
        onClick={action.onClick}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-300 transition-colors hover:bg-slate-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 disabled:pointer-events-none disabled:opacity-30"
      >
        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    ))}
  </div>
);
