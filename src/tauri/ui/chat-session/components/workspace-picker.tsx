import { Check, FolderOpen, FolderPlus } from "lucide-react";
import { useState, type JSX } from "react";
import { Button } from "../../components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
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
              const selected = currentWorkspaceKey === createWorkspaceKey(workspace);

              return (
                <button
                  key={createWorkspaceKey(workspace)}
                  type="button"
                  title={workspace}
                  onClick={() => {
                    setOpen(false);
                    onSelectWorkspace(workspace);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left transition-all",
                    selected
                      ? "border-sky-500/30 bg-sky-500/10 text-sky-100"
                      : "border-slate-800 bg-slate-900/70 text-slate-300 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100",
                  )}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-sky-300">
                    <FolderOpen className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-slate-100">
                      {getWorkspaceLabel(workspace)}
                    </p>
                    <p className="truncate text-xs leading-5 text-slate-500">
                      {workspace}
                    </p>
                  </div>
                  {selected ? <Check className="h-4 w-4 text-sky-300" /> : null}
                </button>
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
