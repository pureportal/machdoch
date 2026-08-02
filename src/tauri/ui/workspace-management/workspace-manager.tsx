import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowDownToLine,
  Check,
  CircleDot,
  ExternalLink,
  CloudDownload,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitPullRequest,
  LoaderCircle,
  Network,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { Input } from "../components/ui/input";
import { SearchField } from "../components/ui/search-field";
import { cn } from "../lib/utils";
import {
  loadWorkspaceGitOverview,
  openExternalUrl,
  runWorkspaceGitAction,
  type InstructionMutationInput,
  type InstructionProfileView,
  type InstructionWorkspaceView,
  type WorkspaceGitAction,
  type WorkspaceGitOverview,
} from "../runtime";
import type { InstructionSettingsControls } from "../chat-session/components/settings-dialog-panels/types";
import { TagEditor } from "../instruction-management/tag-editor";

type GitSection = "status" | "branches" | "remotes" | "pull-requests";

const workspaceName = (workspace: InstructionWorkspaceView): string =>
  workspace.displayName ??
  workspace.root.split(/[\\/]/u).filter(Boolean).at(-1) ??
  workspace.root;

const workspaceTags = (workspace: InstructionWorkspaceView): string[] =>
  workspace.tags ?? [];

const profileIsEnabled = (profile: InstructionProfileView): boolean =>
  profile.enabled !== false;

const profileSourcesForWorkspace = (
  profile: InstructionProfileView,
  workspace: InstructionWorkspaceView,
): string[] => {
  const manual = workspace.scopes.some((scope) =>
    scope.profiles.includes(profile.id),
  );
  const automatic = (profile.automaticWorkspaceIds ?? []).includes(
    workspace.id,
  );
  return [
    ...(profile.global ? ["Global"] : []),
    ...(manual ? ["Manual"] : []),
    ...(automatic ? ["Automatic"] : []),
    ...(!profileIsEnabled(profile) ? ["Disabled"] : []),
  ];
};

const SourceBadges = ({ labels }: { labels: string[] }): JSX.Element | null =>
  labels.length === 0 ? null : (
    <div className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <Badge
          key={label}
          variant={label === "Disabled" ? "destructive" : "outline"}
          className="px-1.5 py-0 text-[10px]"
        >
          {label}
        </Badge>
      ))}
    </div>
  );

const GitStatusView = ({
  overview,
}: {
  overview: WorkspaceGitOverview;
}): JSX.Element => (
  <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[
        ["Staged", overview.stagedCount],
        ["Changed", overview.unstagedCount],
        ["Untracked", overview.untrackedCount],
        ["Conflicts", overview.conflictedCount],
      ].map(([label, value]) => (
        <div
          key={label}
          className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"
        >
          <p className="text-xs text-slate-500">{label}</p>
          <p className="mt-1 text-xl font-semibold text-slate-100">{value}</p>
        </div>
      ))}
    </div>
    {overview.headCommit ? (
      <div className="flex min-w-0 items-start gap-3 rounded-lg border border-slate-800 bg-slate-950/45 p-3">
        <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-slate-500" />
        <div className="min-w-0">
          <p className="truncate text-sm text-slate-200">
            {overview.headCommit.subject}
          </p>
          <p className="mt-1 truncate text-xs text-slate-500">
            {overview.headCommit.shortHash} · {overview.headCommit.author} ·{" "}
            {new Date(overview.headCommit.authoredAt).toLocaleString()}
          </p>
        </div>
      </div>
    ) : null}
    {overview.changes.length === 0 ? (
      <EmptyState icon={Check} title="Working tree clean" size="compact" />
    ) : (
      <div className="overflow-hidden rounded-lg border border-slate-800">
        <div className="max-h-80 overflow-y-auto">
          {overview.changes.map((change, index) => (
            <div
              key={`${change.status}:${change.path}:${index}`}
              className="flex min-w-0 items-center gap-3 border-b border-slate-900 px-3 py-2 last:border-b-0"
            >
              <code className="w-7 shrink-0 text-xs text-sky-300">
                {change.status}
              </code>
              <code className="min-w-0 flex-1 truncate text-xs text-slate-300">
                {change.path}
              </code>
            </div>
          ))}
        </div>
        {overview.changesTruncated ? (
          <p className="border-t border-slate-800 px-3 py-2 text-xs text-slate-500">
            Showing the first {overview.changes.length} changes.
          </p>
        ) : null}
      </div>
    )}
  </div>
);

export const WorkspaceManager = ({
  setup,
  activeWorkspaceRoot,
}: {
  setup: InstructionSettingsControls;
  activeWorkspaceRoot: string | null;
}): JSX.Element => {
  const registry = setup.registry;
  const workspaces = registry?.workspaces ?? [];
  const profiles = registry?.profiles ?? [];
  const [query, setQuery] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );
  const [displayName, setDisplayName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [gitSection, setGitSection] = useState<GitSection>("status");
  const [gitOverview, setGitOverview] = useState<WorkspaceGitOverview | null>(
    null,
  );
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitAction, setGitAction] = useState<WorkspaceGitAction | null>(null);
  const [branchName, setBranchName] = useState("");
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");

  useEffect(() => {
    void setup.onRefresh();
  }, [setup.onRefresh]);

  useEffect(() => {
    if (
      selectedWorkspaceId &&
      workspaces.some((workspace) => workspace.id === selectedWorkspaceId)
    ) {
      return;
    }
    const active = workspaces.find(
      (workspace) =>
        activeWorkspaceRoot &&
        workspace.root.toLocaleLowerCase() ===
          activeWorkspaceRoot.toLocaleLowerCase(),
    );
    setSelectedWorkspaceId(active?.id ?? workspaces[0]?.id ?? null);
  }, [activeWorkspaceRoot, selectedWorkspaceId, workspaces]);

  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ??
    null;

  useEffect(() => {
    if (!selectedWorkspace) return;
    setDisplayName(
      selectedWorkspace.displayName ?? workspaceName(selectedWorkspace),
    );
    setTags([...workspaceTags(selectedWorkspace)]);
  }, [selectedWorkspace]);

  const refreshGit = useCallback(async (): Promise<void> => {
    if (!selectedWorkspace) {
      setGitOverview(null);
      setGitError(null);
      return;
    }
    setGitLoading(true);
    setGitError(null);
    try {
      setGitOverview(await loadWorkspaceGitOverview(selectedWorkspace.root));
    } catch (error) {
      setGitOverview(null);
      setGitError(error instanceof Error ? error.message : String(error));
    } finally {
      setGitLoading(false);
    }
  }, [selectedWorkspace]);

  useEffect(() => {
    void refreshGit();
  }, [refreshGit]);

  const mutate = async (input: InstructionMutationInput): Promise<boolean> =>
    (await setup.onManualSave(input)) !== false;

  const chooseDirectory = async (): Promise<string | null> => {
    const result = await open({ directory: true, multiple: false });
    return typeof result === "string" ? result : null;
  };

  const addWorkspace = async (root?: string): Promise<void> => {
    if (!registry) return;
    const selectedRoot = root ?? (await chooseDirectory());
    if (!selectedRoot) return;
    await mutate({
      operation: "workspace-register",
      root: selectedRoot,
      expectedRevision: registry.revision,
    });
  };

  const runGitAction = async (
    action: WorkspaceGitAction,
    options: {
      branchName?: string;
      remoteName?: string;
      remoteUrl?: string;
    } = {},
  ): Promise<void> => {
    if (!selectedWorkspace) return;
    setGitAction(action);
    setGitError(null);
    try {
      setGitOverview(
        await runWorkspaceGitAction(selectedWorkspace.root, action, options),
      );
      setBranchName("");
      setRemoteName("");
      setRemoteUrl("");
    } catch (error) {
      setGitError(error instanceof Error ? error.message : String(error));
    } finally {
      setGitAction(null);
    }
  };

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredWorkspaces = useMemo(
    () =>
      workspaces.filter((workspace) =>
        !normalizedQuery
          ? true
          : [
              workspaceName(workspace),
              workspace.root,
              ...workspaceTags(workspace),
            ]
              .join(" ")
              .toLocaleLowerCase()
              .includes(normalizedQuery),
      ),
    [normalizedQuery, workspaces],
  );
  const activeWorkspaceRegistered = workspaces.some(
    (workspace) =>
      activeWorkspaceRoot &&
      workspace.root.toLocaleLowerCase() ===
        activeWorkspaceRoot.toLocaleLowerCase(),
  );

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-950">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-900 px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">Workspaces</h1>
          <p className="mt-1 text-xs text-slate-500">
            {workspaces.length} configured
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeWorkspaceRoot && !activeWorkspaceRegistered ? (
            <Button
              size="sm"
              variant="outline"
              disabled={setup.saving || !registry}
              onClick={() => void addWorkspace(activeWorkspaceRoot)}
            >
              <FolderPlus className="size-4" />
              Add current
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={setup.saving || !registry}
            onClick={() => void addWorkspace()}
          >
            <Plus className="size-4" />
            Workspace
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={setup.loading}
            aria-label="Refresh workspaces"
            onClick={() => void setup.onRefresh()}
          >
            <RefreshCw
              className={cn("size-4", setup.loading && "animate-spin")}
            />
          </Button>
        </div>
      </header>

      {setup.message ? (
        <div
          role="status"
          className={cn(
            "shrink-0 border-b px-6 py-2 text-sm",
            setup.message.tone === "error"
              ? "border-red-950 bg-red-950/30 text-red-200"
              : "border-slate-900 bg-slate-900/35 text-slate-300",
          )}
        >
          {setup.message.text}
        </div>
      ) : null}

      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(12rem,35vh)_minmax(0,1fr)] lg:grid-cols-[20rem_minmax(0,1fr)] lg:grid-rows-1">
        <aside className="flex min-h-0 flex-col border-r border-slate-900">
          <div className="border-b border-slate-900 p-4">
            <SearchField
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search workspaces"
              placeholder="Search workspaces"
              className="h-9 border-slate-800 bg-slate-950"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {setup.loading && !registry ? (
              <div className="grid h-32 place-items-center">
                <LoaderCircle className="size-5 animate-spin text-slate-500" />
              </div>
            ) : filteredWorkspaces.length === 0 ? (
              <EmptyState
                icon={FolderGit2}
                title="No workspaces"
                size="compact"
                action={
                  <Button
                    size="sm"
                    disabled={!registry}
                    onClick={() => void addWorkspace()}
                  >
                    <Plus className="size-4" />
                    Workspace
                  </Button>
                }
              />
            ) : (
              <div className="space-y-1">
                {filteredWorkspaces.map((workspace) => {
                  const selected = workspace.id === selectedWorkspaceId;
                  const active =
                    activeWorkspaceRoot?.toLocaleLowerCase() ===
                    workspace.root.toLocaleLowerCase();
                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      onClick={() => setSelectedWorkspaceId(workspace.id)}
                      className={cn(
                        "w-full rounded-lg border px-3 py-2.5 text-left",
                        selected
                          ? "border-sky-800/70 bg-sky-950/25"
                          : "border-transparent hover:border-slate-800 hover:bg-slate-900/55",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <FolderGit2 className="size-4 shrink-0 text-slate-500" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-200">
                          {workspaceName(workspace)}
                        </span>
                        {active ? (
                          <CircleDot className="size-3.5 text-sky-300" />
                        ) : null}
                      </div>
                      <p className="mt-1 truncate pl-6 text-[11px] text-slate-600">
                        {workspace.root}
                      </p>
                      {workspaceTags(workspace).length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1 pl-6">
                          {workspaceTags(workspace)
                            .slice(0, 4)
                            .map((tag) => (
                              <Badge
                                key={tag.toLocaleLowerCase()}
                                variant="outline"
                                className="px-1.5 py-0 text-[10px]"
                              >
                                {tag}
                              </Badge>
                            ))}
                        </div>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        <section className="min-h-0 min-w-0 overflow-y-auto">
          {!selectedWorkspace || !registry ? (
            <div className="grid h-full min-h-64 place-items-center p-6">
              <EmptyState icon={FolderGit2} title="Select a workspace" />
            </div>
          ) : (
            <div className="mx-auto w-full max-w-6xl space-y-6 p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-slate-100">
                    {workspaceName(selectedWorkspace)}
                  </h2>
                  <p className="mt-1 break-all font-mono text-xs text-slate-500">
                    {selectedWorkspace.root}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={setup.saving}
                    onClick={async () => {
                      const root = await chooseDirectory();
                      if (!root) return;
                      void mutate({
                        operation: "workspace-relink",
                        workspaceId: selectedWorkspace.id,
                        root,
                        expectedRevision: registry.revision,
                      });
                    }}
                  >
                    Relink
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={setup.saving}
                    aria-label="Remove workspace"
                    onClick={() => {
                      const hasAssignments = selectedWorkspace.scopes.some(
                        (scope) => scope.profiles.length > 0,
                      );
                      if (
                        hasAssignments &&
                        !window.confirm(
                          "Remove this workspace and its manual instruction assignments?",
                        )
                      ) {
                        return;
                      }
                      void mutate({
                        operation: "workspace-unregister",
                        workspaceId: selectedWorkspace.id,
                        confirmAssignedRemoval: hasAssignments,
                        expectedRevision: registry.revision,
                      });
                    }}
                  >
                    <Trash2 className="size-4 text-red-300" />
                  </Button>
                </div>
              </div>

              <section className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/20 p-4 md:grid-cols-[minmax(12rem,0.65fr)_minmax(0,1.35fr)_auto] md:items-end">
                <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                  Name
                  <Input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    className="h-9 border-slate-800 bg-slate-950"
                  />
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                  Tags
                  <TagEditor value={tags} onChange={setTags} />
                </label>
                <Button
                  size="sm"
                  disabled={setup.saving || !displayName.trim()}
                  onClick={() =>
                    void mutate({
                      operation: "workspace-update",
                      workspaceId: selectedWorkspace.id,
                      displayName,
                      tags,
                      expectedRevision: registry.revision,
                    })
                  }
                >
                  <Save className="size-4" />
                  Save
                </Button>
              </section>

              <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/20">
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-3">
                  <GitBranch className="size-4 text-sky-300" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium text-slate-100">
                        {gitOverview?.branch ?? "Git"}
                      </h3>
                      {gitOverview ? (
                        <Badge
                          variant={gitOverview.clean ? "outline" : "secondary"}
                        >
                          {gitOverview.clean
                            ? "Clean"
                            : `${gitOverview.changes.length} changed`}
                        </Badge>
                      ) : null}
                      {gitOverview?.ahead ? (
                        <Badge variant="outline">↑ {gitOverview.ahead}</Badge>
                      ) : null}
                      {gitOverview?.behind ? (
                        <Badge variant="outline">↓ {gitOverview.behind}</Badge>
                      ) : null}
                    </div>
                    {gitOverview?.upstream ? (
                      <p className="mt-1 text-xs text-slate-500">
                        {gitOverview.upstream}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={gitLoading || gitAction !== null}
                    onClick={() => void runGitAction("fetch")}
                  >
                    {gitAction === "fetch" ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <CloudDownload className="size-4" />
                    )}
                    Fetch
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      gitLoading || gitAction !== null || !gitOverview?.upstream
                    }
                    onClick={() => void runGitAction("pull")}
                  >
                    {gitAction === "pull" ? (
                      <LoaderCircle className="size-4 animate-spin" />
                    ) : (
                      <ArrowDownToLine className="size-4" />
                    )}
                    Pull
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={gitLoading || gitAction !== null}
                    aria-label="Refresh Git"
                    onClick={() => void refreshGit()}
                  >
                    <RefreshCw
                      className={cn("size-4", gitLoading && "animate-spin")}
                    />
                  </Button>
                </div>

                <div
                  role="tablist"
                  aria-label="Git workspace views"
                  className="flex overflow-x-auto border-b border-slate-800 px-2"
                >
                  {(
                    [
                      ["status", "Status", GitFork],
                      ["branches", "Branches", GitBranch],
                      ["remotes", "Remotes", Network],
                      ["pull-requests", "Pull requests", GitPullRequest],
                    ] as const
                  ).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={gitSection === value}
                      onClick={() => setGitSection(value)}
                      className={cn(
                        "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs",
                        gitSection === value
                          ? "border-sky-400 text-sky-200"
                          : "border-transparent text-slate-500 hover:text-slate-200",
                      )}
                    >
                      <Icon className="size-3.5" />
                      {label}
                    </button>
                  ))}
                </div>

                <div className="p-4">
                  {gitLoading && !gitOverview ? (
                    <div className="grid h-40 place-items-center">
                      <LoaderCircle className="size-5 animate-spin text-slate-500" />
                    </div>
                  ) : gitError && !gitOverview ? (
                    <EmptyState
                      icon={Unplug}
                      title="Git unavailable"
                      description={gitError}
                    />
                  ) : gitOverview ? (
                    <>
                      {gitError ? (
                        <p
                          role="alert"
                          className="mb-4 rounded-lg border border-red-900/60 bg-red-950/25 px-3 py-2 text-sm text-red-200"
                        >
                          {gitError}
                        </p>
                      ) : null}
                      {gitSection === "status" ? (
                        <GitStatusView overview={gitOverview} />
                      ) : null}
                      {gitSection === "branches" ? (
                        <div className="grid gap-4 xl:grid-cols-2">
                          <div className="space-y-2">
                            <div className="flex gap-2">
                              <Input
                                value={branchName}
                                onChange={(event) =>
                                  setBranchName(event.target.value)
                                }
                                placeholder="New branch"
                                className="h-9 border-slate-800 bg-slate-950"
                              />
                              <Button
                                size="sm"
                                disabled={
                                  gitAction !== null || !branchName.trim()
                                }
                                onClick={() =>
                                  void runGitAction("create-branch", {
                                    branchName,
                                  })
                                }
                              >
                                <Plus className="size-4" />
                                Create
                              </Button>
                            </div>
                            {gitOverview.localBranches.map((branch) => (
                              <div
                                key={branch.name}
                                className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-800 px-3 py-2"
                              >
                                <GitBranch className="size-3.5 shrink-0 text-slate-500" />
                                <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                                  {branch.name}
                                </span>
                                <code className="text-[11px] text-slate-600">
                                  {branch.commit}
                                </code>
                                {branch.current ? (
                                  <Badge variant="outline">Current</Badge>
                                ) : (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={gitAction !== null}
                                    onClick={() =>
                                      void runGitAction("checkout", {
                                        branchName: branch.name,
                                      })
                                    }
                                  >
                                    Switch
                                  </Button>
                                )}
                              </div>
                            ))}
                          </div>
                          <div className="space-y-2">
                            {gitOverview.remoteBranches.length === 0 ? (
                              <EmptyState
                                icon={GitBranch}
                                title="No remote branches"
                                size="compact"
                              />
                            ) : (
                              gitOverview.remoteBranches.map((branch) => (
                                <div
                                  key={branch.name}
                                  className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-800 px-3 py-2"
                                >
                                  <Network className="size-3.5 shrink-0 text-slate-500" />
                                  <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                                    {branch.name}
                                  </span>
                                  <code className="text-[11px] text-slate-600">
                                    {branch.commit}
                                  </code>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={gitAction !== null}
                                    onClick={() =>
                                      void runGitAction("checkout-remote", {
                                        branchName: branch.name,
                                      })
                                    }
                                  >
                                    Track
                                  </Button>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      ) : null}
                      {gitSection === "remotes" ? (
                        <div className="space-y-3">
                          <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
                            <Input
                              value={remoteName}
                              onChange={(event) =>
                                setRemoteName(event.target.value)
                              }
                              placeholder="Name"
                              className="h-9 border-slate-800 bg-slate-950"
                            />
                            <Input
                              value={remoteUrl}
                              onChange={(event) =>
                                setRemoteUrl(event.target.value)
                              }
                              placeholder="Remote URL"
                              className="h-9 border-slate-800 bg-slate-950"
                            />
                            <Button
                              size="sm"
                              disabled={
                                gitAction !== null ||
                                !remoteName.trim() ||
                                !remoteUrl.trim()
                              }
                              onClick={() =>
                                void runGitAction("add-remote", {
                                  remoteName,
                                  remoteUrl,
                                })
                              }
                            >
                              <Plus className="size-4" />
                              Add
                            </Button>
                          </div>
                          {gitOverview.remotes.length === 0 ? (
                            <EmptyState
                              icon={Network}
                              title="No remotes"
                              size="compact"
                            />
                          ) : (
                            gitOverview.remotes.map((remote) => (
                              <div
                                key={remote.name}
                                className="flex min-w-0 items-start gap-3 rounded-lg border border-slate-800 p-3"
                              >
                                <Network className="mt-0.5 size-4 shrink-0 text-slate-500" />
                                <div className="min-w-0 flex-1">
                                  <p className="text-sm font-medium text-slate-200">
                                    {remote.name}
                                  </p>
                                  <p className="mt-1 break-all font-mono text-xs text-slate-500">
                                    {remote.fetchUrl ?? remote.pushUrl}
                                  </p>
                                </div>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  disabled={gitAction !== null}
                                  aria-label={`Remove ${remote.name}`}
                                  onClick={() => {
                                    if (
                                      !window.confirm(
                                        `Remove Git remote ${remote.name}?`,
                                      )
                                    )
                                      return;
                                    void runGitAction("remove-remote", {
                                      remoteName: remote.name,
                                    });
                                  }}
                                >
                                  <Trash2 className="size-4 text-red-300" />
                                </Button>
                              </div>
                            ))
                          )}
                        </div>
                      ) : null}
                      {gitSection === "pull-requests" ? (
                        !gitOverview.pullRequests.available ? (
                          <EmptyState
                            icon={GitPullRequest}
                            title="Pull requests unavailable"
                            description={gitOverview.pullRequests.reason}
                            size="compact"
                          />
                        ) : gitOverview.pullRequests.items.length === 0 ? (
                          <EmptyState
                            icon={GitPullRequest}
                            title="No open pull requests"
                            size="compact"
                          />
                        ) : (
                          <div className="space-y-2">
                            {gitOverview.pullRequests.items.map(
                              (pullRequest) => (
                                <button
                                  key={pullRequest.number}
                                  type="button"
                                  onClick={() =>
                                    void openExternalUrl(pullRequest.url)
                                  }
                                  className="flex w-full min-w-0 items-start gap-3 rounded-lg border border-slate-800 p-3 text-left hover:border-slate-700 hover:bg-slate-950/50"
                                >
                                  <GitPullRequest className="mt-0.5 size-4 shrink-0 text-emerald-300" />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm text-slate-200">
                                      #{pullRequest.number} {pullRequest.title}
                                    </p>
                                    <p className="mt-1 truncate text-xs text-slate-500">
                                      {pullRequest.headBranch} →{" "}
                                      {pullRequest.baseBranch}
                                    </p>
                                  </div>
                                  {pullRequest.draft ? (
                                    <Badge variant="outline">Draft</Badge>
                                  ) : null}
                                  <ExternalLink className="size-3.5 text-slate-600" />
                                </button>
                              ),
                            )}
                          </div>
                        )
                      ) : null}
                    </>
                  ) : null}
                </div>
              </section>

              <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-medium text-slate-200">
                    Instructions
                  </h3>
                  <span className="text-xs text-slate-500">
                    {
                      profiles.filter(
                        (profile) =>
                          profileSourcesForWorkspace(
                            profile,
                            selectedWorkspace,
                          ).some((source) => source !== "Disabled") &&
                          profileIsEnabled(profile),
                      ).length
                    }{" "}
                    effective
                  </span>
                </div>
                {profiles.length === 0 ? (
                  <EmptyState
                    icon={FolderGit2}
                    title="No library instructions"
                    size="compact"
                  />
                ) : (
                  <div className="grid gap-2 md:grid-cols-2">
                    {profiles.map((profile) => {
                      const rootScope = selectedWorkspace.scopes.find(
                        (scope) => scope.path === ".",
                      );
                      const rootAssigned =
                        rootScope?.profiles.includes(profile.id) ?? false;
                      const folderScopes = selectedWorkspace.scopes.filter(
                        (scope) =>
                          scope.path !== "." &&
                          scope.profiles.includes(profile.id),
                      );
                      const labels = profileSourcesForWorkspace(
                        profile,
                        selectedWorkspace,
                      );
                      return (
                        <div
                          key={profile.id}
                          className="min-w-0 rounded-lg border border-slate-800 bg-slate-950/45 px-3 py-2.5"
                        >
                          <label className="flex min-w-0 items-start gap-2">
                            <input
                              type="checkbox"
                              checked={rootAssigned}
                              disabled={
                                setup.saving ||
                                (profile.global && !rootAssigned)
                              }
                              onChange={(event) => {
                                const current = rootScope?.profiles ?? [];
                                void mutate({
                                  operation: "scope-set",
                                  workspaceId: selectedWorkspace.id,
                                  scopePath: ".",
                                  profileIds: event.target.checked
                                    ? [...current, profile.id]
                                    : current.filter(
                                        (id) => id !== profile.id,
                                      ),
                                  expectedRevision: registry.revision,
                                });
                              }}
                              className="mt-0.5 accent-sky-500"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm text-slate-200">
                                {profile.name}
                              </p>
                              <div className="mt-1.5">
                                <SourceBadges labels={labels} />
                              </div>
                            </div>
                          </label>
                          {folderScopes.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-1.5 pl-6">
                              {folderScopes.map((scope) => (
                                <button
                                  key={scope.path}
                                  type="button"
                                  disabled={setup.saving}
                                  aria-label={`Remove ${profile.name} from ${scope.path}`}
                                  onClick={() =>
                                    void mutate({
                                      operation: "scope-set",
                                      workspaceId: selectedWorkspace.id,
                                      scopePath: scope.path,
                                      profileIds: scope.profiles.filter(
                                        (profileId) => profileId !== profile.id,
                                      ),
                                      expectedRevision: registry.revision,
                                    })
                                  }
                                  className="flex min-w-0 max-w-full items-center gap-1 rounded-md border border-slate-800 px-2 py-1 font-mono text-[10px] text-slate-400 hover:border-slate-700 hover:text-slate-200 disabled:opacity-50"
                                >
                                  <span className="truncate">{scope.path}</span>
                                  <X className="size-3 shrink-0" />
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}
        </section>
      </div>
    </main>
  );
};
