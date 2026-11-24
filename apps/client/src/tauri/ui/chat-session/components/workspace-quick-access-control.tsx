import { FolderGit2, FolderOpen, GitBranch, PanelsTopLeft } from "lucide-react";
import { useEffect, useRef, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { openWorkspaceFile, openWorkspacePath } from "../../runtime";
import { useWorkspaceGit } from "../../workspace-management/use-workspace-git";
import type { WorkspaceGitPathAction } from "../../workspace-management/workspace-git-changes";
import { WorkspaceGitPanel } from "../../workspace-management/workspace-git-panel";
import {
  useWorkspaceGitSummary,
  workspaceGitSummaryStore,
} from "../../workspace-management/workspace-git-summary-store";
import { createWorkspaceRootKey } from "../../workspace-management/workspace-management-model";
import {
  readWorkspaceViewPreferences,
  writeWorkspaceViewPreferences,
  type WorkspaceGitSection,
} from "../../workspace-management/workspace-view-preferences";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const workspaceName = (root: string): string =>
  root.split(/[\\/]/u).filter(Boolean).at(-1) ?? root;

const QuickAccessBody = ({
  workspaceRoot,
  onOpenWorkspaces,
}: {
  workspaceRoot: string;
  onOpenWorkspaces?: () => void;
}): JSX.Element => {
  const [gitSection, setGitSection] = useState(
    () => readWorkspaceViewPreferences().gitSection,
  );
  const [openError, setOpenError] = useState<string | null>(null);
  const git = useWorkspaceGit(workspaceRoot, { section: gitSection });

  const selectGitSection = (next: WorkspaceGitSection): void => {
    setGitSection(next);
    writeWorkspaceViewPreferences((current) => ({
      ...current,
      gitSection: next,
    }));
  };
  const openPath = (
    relativePath: string,
    action: WorkspaceGitPathAction,
  ): void => {
    setOpenError(null);
    void (
      action === "open"
        ? openWorkspaceFile(workspaceRoot, relativePath)
        : openWorkspacePath(workspaceRoot, relativePath)
    ).catch((error: unknown) => setOpenError(errorMessage(error)));
  };

  return (
    <>
      <DialogHeader className="flex-row items-center gap-2 space-y-0 border-b border-slate-800/80 py-2 pr-12 pl-4 text-left">
        <DialogTitle className="min-w-0 truncate text-sm">
          {workspaceName(workspaceRoot)}
        </DialogTitle>
        <span className="flex-1" />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Open folder"
          onClick={() => openPath(".", "reveal")}
        >
          <FolderOpen className="size-4" />
        </Button>
        {onOpenWorkspaces ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onOpenWorkspaces}
          >
            <PanelsTopLeft className="size-4" />
            Open in Workspaces
          </Button>
        ) : null}
      </DialogHeader>
      {openError ? (
        <p
          role="alert"
          className="border-b border-red-950 bg-red-950/30 px-4 py-2 text-xs text-red-200"
        >
          {openError}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <WorkspaceGitPanel
          controls={git}
          section={gitSection}
          onSectionChange={selectGitSection}
          onOpenPath={openPath}
          className="min-h-0 flex-1"
        />
      </div>
    </>
  );
};

export const WorkspaceQuickAccessControl = ({
  workspaceRoot,
  primaryTaskRunning,
  onOpenWorkspaces,
}: {
  workspaceRoot: string | null | undefined;
  primaryTaskRunning: boolean;
  onOpenWorkspaces?: () => boolean;
}): JSX.Element | null => {
  const normalizedRoot = workspaceRoot?.trim() || null;
  const summary = useWorkspaceGitSummary(normalizedRoot)?.summary;
  const [open, setOpen] = useState(false);
  const previousTaskRunningRef = useRef(primaryTaskRunning);

  useEffect(() => {
    if (
      previousTaskRunningRef.current &&
      !primaryTaskRunning &&
      normalizedRoot
    ) {
      workspaceGitSummaryStore.request(normalizedRoot, { force: true });
    }
    previousTaskRunningRef.current = primaryTaskRunning;
  }, [normalizedRoot, primaryTaskRunning]);

  useEffect(() => {
    setOpen(false);
  }, [normalizedRoot]);

  if (!normalizedRoot) return null;

  const openWorkspaces = onOpenWorkspaces
    ? (): void => {
        setOpen(false);
        writeWorkspaceViewPreferences((current) => ({
          ...current,
          section: "git",
          selectedWorkspaceKey: createWorkspaceRootKey(normalizedRoot),
        }));
        onOpenWorkspaces();
      }
    : undefined;

  const label = summary
    ? `Workspace, branch ${summary.branch}${summary.changes ? `, ${summary.changes} changed` : ""}`
    : "Workspace";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={label}
          className="h-7 max-w-48 shrink-0 gap-1.5 rounded-lg px-2 text-[11px] text-slate-300 hover:bg-slate-900 hover:text-white"
        >
          {summary ? (
            <>
              <GitBranch aria-hidden="true" className="size-3.5 text-sky-300" />
              <span className="min-w-0 truncate">{summary.branch}</span>
              {summary.changes ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 leading-4",
                    summary.conflicts
                      ? "bg-red-500/15 text-red-300"
                      : "bg-amber-500/15 text-amber-200",
                  )}
                >
                  {summary.changes}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <FolderGit2 aria-hidden="true" className="size-3.5" />
              <span>Git</span>
            </>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[min(48rem,calc(100dvh-2rem))] w-[min(76rem,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden rounded-2xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl shadow-black/50 sm:max-w-none"
      >
        {open ? (
          <QuickAccessBody
            workspaceRoot={normalizedRoot}
            onOpenWorkspaces={openWorkspaces}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
