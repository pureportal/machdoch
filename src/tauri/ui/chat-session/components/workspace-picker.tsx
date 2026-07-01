import { Check, FolderOpen, FolderPlus, X } from "lucide-react";
import { useState, type JSX } from "react";
import { Button } from "../../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { getWorkspaceLabel } from "../_helpers/session-shell";

export interface WorkspacePickerProps {
  currentWorkspace: string | null;
  workspaceLabel: string;
  recentWorkspaces: string[];
  hasActiveWorkspace: boolean;
  buttonAriaLabel?: string;
  buttonClassName?: string;
  onSelectWorkspace: (workspace: string) => void;
  onRemoveWorkspace: (workspace: string) => void;
  onChooseNewWorkspace: () => Promise<void>;
}

const createWorkspaceKey = (workspace: string): string => {
  return workspace.trim().replace(/\\/gu, "/").toLowerCase();
};

const WorkspaceButtonContent = ({
  hasActiveWorkspace,
  workspaceLabel,
}: Pick<
  WorkspacePickerProps,
  "hasActiveWorkspace" | "workspaceLabel"
>): JSX.Element => (
  <>
    <FolderOpen
      className={cn(
        "mr-2 h-3.5 w-3.5",
        hasActiveWorkspace ? "text-sky-300" : "text-slate-500",
      )}
    />
    {workspaceLabel}
  </>
);

export const WorkspacePicker = ({
  currentWorkspace,
  workspaceLabel,
  recentWorkspaces,
  hasActiveWorkspace,
  buttonAriaLabel,
  buttonClassName,
  onSelectWorkspace,
  onRemoveWorkspace,
  onChooseNewWorkspace,
}: WorkspacePickerProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const currentWorkspaceKey = currentWorkspace
    ? createWorkspaceKey(currentWorkspace)
    : null;
  const resolvedButtonClassName = buttonClassName
    ? cn(
        buttonClassName,
        hasActiveWorkspace &&
          "border-sky-500/20 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15",
      )
    : cn(
        "h-8 rounded-full border-slate-800 bg-slate-950/70 px-3 text-xs font-medium text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100",
        "app-composer-toolbar-pill",
        hasActiveWorkspace &&
          "border-sky-500/20 bg-sky-500/10 text-sky-100 hover:bg-sky-500/15",
      );

  if (recentWorkspaces.length === 0) {
    return (
      <Button
        type="button"
        variant="outline"
        aria-label={buttonAriaLabel}
        onClick={() => {
          void onChooseNewWorkspace();
        }}
        className={resolvedButtonClassName}
      >
        <WorkspaceButtonContent
          hasActiveWorkspace={hasActiveWorkspace}
          workspaceLabel={workspaceLabel}
        />
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={buttonAriaLabel}
          className={resolvedButtonClassName}
        >
          <WorkspaceButtonContent
            hasActiveWorkspace={hasActiveWorkspace}
            workspaceLabel={workspaceLabel}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-96 rounded-3xl border-slate-800 bg-slate-950/95 p-4 shadow-2xl backdrop-blur-xl"
      >
        <div className="grid gap-3">
          <div className="grid gap-1">
            <p className="text-xs font-semibold tracking-[0.18em] text-slate-500 uppercase">
              Workspaces
            </p>
            <p className="text-sm leading-5 text-slate-400">
              Pick a recent folder or choose a different workspace.
            </p>
          </div>

          <div className="grid max-h-72 gap-2 overflow-y-auto pr-1">
            {recentWorkspaces.map((workspace) => {
              const workspaceKey = createWorkspaceKey(workspace);
              const workspaceLabel = getWorkspaceLabel(workspace);
              const selected = currentWorkspaceKey === workspaceKey;

              return (
                <div
                  key={workspaceKey}
                  className={cn(
                    "group grid w-full grid-cols-[minmax(0,1fr)_2rem] items-center gap-1 rounded-2xl border p-1.5 transition-all",
                    selected
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-100"
                      : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                  )}
                >
                  <button
                    type="button"
                    title={workspace}
                    onClick={() => {
                      setOpen(false);
                      onSelectWorkspace(workspace);
                    }}
                    className="flex min-w-0 items-center gap-3 rounded-xl px-1.5 py-1 text-left outline-none transition-colors hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-sky-300">
                      <FolderOpen className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-100">
                        {workspaceLabel}
                      </p>
                      <p className="truncate text-xs leading-5 text-slate-500">
                        {workspace}
                      </p>
                    </div>
                    {selected ? (
                      <Check className="h-4 w-4 shrink-0 text-sky-300" />
                    ) : null}
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={`Remove ${workspaceLabel} from workspace list`}
                        onClick={() => {
                          onRemoveWorkspace(workspace);
                        }}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-slate-500 opacity-70 outline-none transition-colors hover:bg-rose-500/10 hover:text-rose-200 hover:opacity-100 focus-visible:bg-rose-500/10 focus-visible:text-rose-200 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-rose-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left">Remove from list</TooltipContent>
                  </Tooltip>
                </div>
              );
            })}
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setOpen(false);
              void onChooseNewWorkspace();
            }}
            className="h-10 justify-start rounded-2xl border-slate-800 bg-slate-950/70 px-3 text-sm text-slate-300 shadow-none hover:bg-slate-900 hover:text-slate-100"
          >
            <FolderPlus className="mr-2 h-4 w-4 text-slate-500" />
            Choose new workspace folder
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
