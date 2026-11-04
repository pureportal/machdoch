import {
  CircleDot,
  FolderGit2,
  FolderPlus,
  LoaderCircle,
  Plus,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { instructionTagKey } from "@machdoch/fleet-protocol/instruction-tags";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { SearchField } from "@machdoch/media-studio/tauri/ui/components/ui/search-field.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { WorkspaceGitSummaryBadge } from "./workspace-git-summary-badge";
import { useWorkspaceGitSummary } from "./workspace-git-summary-store";
import {
  getManagedWorkspaceName,
  getManagedWorkspaceTags,
  type ManagedWorkspaceView,
} from "./workspace-management-model";

const WorkspaceRow = ({
  workspace,
  selected,
  active,
  disabled,
  onSelect,
}: {
  workspace: ManagedWorkspaceView;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
}): JSX.Element => {
  const summary = useWorkspaceGitSummary(workspace.root)?.summary;
  const tags = getManagedWorkspaceTags(workspace);
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      title={workspace.root}
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60",
        selected
          ? "border-sky-800/70 bg-sky-950/30"
          : "border-transparent hover:border-slate-800 hover:bg-slate-900/55",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      <div className="flex items-center gap-2">
        <FolderGit2
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0",
            selected ? "text-sky-300" : "text-slate-500",
          )}
        />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-200">
          {getManagedWorkspaceName(workspace)}
        </span>
        {active ? (
          <CircleDot
            aria-label="Open in chat"
            className="size-3.5 shrink-0 text-sky-300"
          />
        ) : null}
      </div>
      <div className="mt-1 pl-6">
        {summary ? (
          <WorkspaceGitSummaryBadge summary={summary} />
        ) : (
          <p className="truncate text-[11px] text-slate-600">
            {workspace.root}
          </p>
        )}
      </div>
      {tags.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-6">
          {tags.slice(0, 4).map((tag) => (
            <span
              key={instructionTagKey(tag)}
              className="text-[10px] text-slate-500"
            >
              #{tag}
            </span>
          ))}
        </div>
      ) : null}
    </button>
  );
};

export const WorkspaceSidebar = ({
  workspaces,
  selectedWorkspaceKey,
  activeWorkspaceKey,
  activeWorkspaceRoot,
  loading,
  refreshing,
  busy,
  selectionLocked,
  onSelect,
  onAdd,
  onRefresh,
}: {
  workspaces: readonly ManagedWorkspaceView[];
  selectedWorkspaceKey: string | null;
  activeWorkspaceKey: string | null;
  activeWorkspaceRoot: string | null;
  loading: boolean;
  refreshing: boolean;
  busy: boolean;
  selectionLocked: boolean;
  onSelect: (workspaceKey: string) => void;
  onAdd: (root?: string) => void;
  onRefresh: () => void;
}): JSX.Element => {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () =>
      workspaces.filter(
        (workspace) =>
          !normalizedQuery ||
          [
            getManagedWorkspaceName(workspace),
            workspace.root,
            ...getManagedWorkspaceTags(workspace),
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedQuery),
      ),
    [normalizedQuery, workspaces],
  );
  const activeConfigured =
    activeWorkspaceKey !== null &&
    workspaces.some((workspace) => workspace.key === activeWorkspaceKey);

  return (
    <aside className="flex min-h-0 flex-col border-b border-slate-900 bg-slate-950 lg:border-r lg:border-b-0">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-slate-900 px-3">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">
          Workspaces
        </h1>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Add workspace"
          disabled={busy}
          onClick={() => onAdd()}
        >
          <Plus className="size-4" />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh workspaces"
          disabled={busy || selectionLocked}
          onClick={onRefresh}
        >
          <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
        </Button>
      </header>
      <div className="shrink-0 p-2">
        <SearchField
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search workspaces"
          placeholder="Search"
          className="h-8 border-slate-800 bg-slate-950 text-xs"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {activeWorkspaceRoot && !activeConfigured ? (
          <button
            type="button"
            disabled={busy}
            title={activeWorkspaceRoot}
            onClick={() => onAdd(activeWorkspaceRoot)}
            className="mb-1 flex w-full items-center gap-2 rounded-lg border border-dashed border-slate-800 px-3 py-2 text-left text-xs text-slate-400 hover:border-slate-700 hover:text-slate-200 disabled:opacity-50"
          >
            <FolderPlus aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Add current workspace
            </span>
          </button>
        ) : null}
        {loading && workspaces.length === 0 ? (
          <div
            role="status"
            aria-label="Loading workspaces"
            className="grid h-32 place-items-center"
          >
            <LoaderCircle className="size-5 animate-spin text-slate-500" />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={FolderGit2}
            title={
              workspaces.length === 0
                ? "No workspaces"
                : "No matching workspaces"
            }
            size="compact"
            action={
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => (workspaces.length > 0 ? setQuery("") : onAdd())}
              >
                {workspaces.length === 0 ? <Plus className="size-4" /> : null}
                {workspaces.length === 0 ? "Add workspace" : "Clear search"}
              </Button>
            }
          />
        ) : (
          <div className="space-y-0.5">
            {filtered.map((workspace) => {
              const selected = workspace.key === selectedWorkspaceKey;
              return (
                <WorkspaceRow
                  key={workspace.key}
                  workspace={workspace}
                  selected={selected}
                  active={workspace.key === activeWorkspaceKey}
                  disabled={selectionLocked && !selected}
                  onSelect={() => onSelect(workspace.key)}
                />
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
};
