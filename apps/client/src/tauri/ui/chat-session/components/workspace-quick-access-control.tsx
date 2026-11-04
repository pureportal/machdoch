import {
  FileCode2,
  FolderGit2,
  FolderOpen,
  GitBranch,
  PanelsTopLeft,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
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
  WorkspaceTabList,
  workspaceTabId,
  workspaceTabPanelId,
} from "../../workspace-management/workspace-tab-list";
import { WorkspaceTools } from "../../workspace-management/workspace-tools";
import {
  readWorkspaceViewPreferences,
  writeWorkspaceViewPreferences,
  type WorkspaceGitSection,
} from "../../workspace-management/workspace-view-preferences";

type QuickAccessTab = "git" | "files";

const QUICK_ACCESS_SCOPE = "workspace-quick-access";

let lastQuickAccessTab: QuickAccessTab = "git";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const workspaceName = (root: string): string =>
  root.split(/[\\/]/u).filter(Boolean).at(-1) ?? root;

const QuickAccessBody = ({
  workspaceRoot,
  onFilesDirtyChange,
  onOpenWorkspaces,
}: {
  workspaceRoot: string;
  onFilesDirtyChange: (dirty: boolean) => void;
  onOpenWorkspaces?: (tab: QuickAccessTab) => void;
}): JSX.Element => {
  const [tab, setTab] = useState<QuickAccessTab>(lastQuickAccessTab);
  const [gitSection, setGitSection] = useState(
    () => readWorkspaceViewPreferences().gitSection,
  );
  const [filesDirty, setFilesDirty] = useState(false);
  const [filesRefreshToken, setFilesRefreshToken] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);
  const git = useWorkspaceGit(workspaceRoot, {
    filesDirty,
    onFilesChanged: () => setFilesRefreshToken((current) => current + 1),
  });

  const selectTab = (next: QuickAccessTab): void => {
    lastQuickAccessTab = next;
    setTab(next);
  };
  const selectGitSection = (next: WorkspaceGitSection): void => {
    setGitSection(next);
    writeWorkspaceViewPreferences((current) => ({
      ...current,
      gitSection: next,
    }));
  };
  const updateFilesDirty = useCallback(
    (dirty: boolean): void => {
      setFilesDirty(dirty);
      onFilesDirtyChange(dirty);
    },
    [onFilesDirtyChange],
  );
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
        <WorkspaceTabList
          scope={QUICK_ACCESS_SCOPE}
          label="Workspace views"
          tabs={[
            {
              value: "git",
              label: "Git",
              icon: GitBranch,
              count: git.overview?.totalChanges,
            },
            { value: "files", label: "Files", icon: FileCode2 },
          ]}
          value={tab}
          onChange={selectTab}
          className="ml-2"
        />
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
            onClick={() => onOpenWorkspaces(tab)}
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
      <div
        id={workspaceTabPanelId(QUICK_ACCESS_SCOPE, tab)}
        role="tabpanel"
        aria-labelledby={workspaceTabId(QUICK_ACCESS_SCOPE, tab)}
        className="flex min-h-0 flex-1 flex-col p-3"
      >
        <div
          className={cn(
            tab === "git" ? "flex min-h-0 flex-1 flex-col" : "hidden",
          )}
        >
          <WorkspaceGitPanel
            controls={git}
            section={gitSection}
            onSectionChange={selectGitSection}
            onOpenPath={openPath}
            className="min-h-0 flex-1"
          />
        </div>
        {tab === "files" || filesDirty ? (
          <div
            className={cn(
              tab === "files" ? "flex min-h-0 flex-1 flex-col" : "hidden",
            )}
          >
            <WorkspaceTools
              workspaceRoot={workspaceRoot}
              refreshToken={filesRefreshToken}
              onDirtyChange={updateFilesDirty}
              onWorkspaceMutation={git.reload}
            />
          </div>
        ) : null}
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
  const [filesDirty, setFilesDirty] = useState(false);
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
    setFilesDirty(false);
  }, [normalizedRoot]);

  if (!normalizedRoot) return null;

  const handleOpenChange = (nextOpen: boolean): boolean => {
    if (
      !nextOpen &&
      filesDirty &&
      !window.confirm("Discard your unsaved changes?")
    ) {
      return false;
    }
    setOpen(nextOpen);
    if (!nextOpen) setFilesDirty(false);
    return true;
  };

  const openWorkspaces = onOpenWorkspaces
    ? (tab: QuickAccessTab): void => {
        if (!handleOpenChange(false)) return;
        writeWorkspaceViewPreferences((current) => ({
          ...current,
          section: tab,
          selectedWorkspaceKey: createWorkspaceRootKey(normalizedRoot),
        }));
        onOpenWorkspaces();
      }
    : undefined;

  const label = summary
    ? `Workspace, branch ${summary.branch}${summary.changes ? `, ${summary.changes} changed` : ""}`
    : "Workspace";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => void handleOpenChange(nextOpen)}
    >
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
              <span>Files</span>
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
            onFilesDirtyChange={setFilesDirty}
            onOpenWorkspaces={openWorkspaces}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
