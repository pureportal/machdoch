import type { JSX } from "react";
import {
  ArrowDownToLine,
  CloudDownload,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitFork,
  GitPullRequest,
  LoaderCircle,
  Network,
  Plus,
  RefreshCw,
  Trash2,
  Unplug,
} from "lucide-react";
import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import { Badge } from "@machdoch/media-studio/tauri/ui/components/ui/badge.js";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import { openExternalUrl } from "../runtime";
import { WorkspaceGitStatus } from "./workspace-git-status";
import { workspaceGitRepositoryLabel } from "./workspace-git-model";
import type { WorkspaceGitControls } from "./use-workspace-git";
export function WorkspaceGitPanel({
  workspaceRoot,
  controls,
}: {
  workspaceRoot: string;
  controls: WorkspaceGitControls;
}): JSX.Element {
  const {
    gitSection,
    setGitSection,
    gitRepositories,
    gitRepositoriesLoading,
    gitRepositoriesError,
    selectedGitRepositoryRoot,
    selectedGitRepository,
    selectedGitOverview,
    gitLoading,
    gitError,
    gitAction,
    gitBusy,
    gitDiscoveryNotice,
    pullRequests,
    pullRequestsLoading,
    pullRequestsError,
    branchName,
    setBranchName,
    remoteName,
    setRemoteName,
    remoteUrl,
    setRemoteUrl,
    refreshGit,
    refreshPullRequests,
    runGitAction,
    selectGitRepository,
    removeRemote,
  } = controls;
  return (
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/20">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-3">
        <GitBranch className="size-4 text-sky-300" />
        <div className="min-w-0 basis-48 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {(gitRepositories?.repositories.length ?? 0) > 1 ? (
              <select
                aria-label="Git repository"
                value={selectedGitRepositoryRoot ?? ""}
                disabled={gitBusy || gitAction !== null}
                onChange={(event) =>
                  selectGitRepository(event.currentTarget.value)
                }
                className="h-8 min-w-0 max-w-full rounded-md border border-slate-700 bg-slate-950 px-2 font-mono text-xs text-slate-200 outline-none focus-visible:border-sky-500 focus-visible:ring-1 focus-visible:ring-sky-500/50 disabled:opacity-50"
              >
                {gitRepositories?.repositories.map((repository) => (
                  <option
                    key={repository.repositoryRoot}
                    value={repository.repositoryRoot}
                  >
                    {workspaceGitRepositoryLabel(repository)}
                  </option>
                ))}
              </select>
            ) : (
              <h3 className="truncate text-sm font-medium text-slate-100">
                {selectedGitRepository
                  ? workspaceGitRepositoryLabel(selectedGitRepository)
                  : "Git"}
              </h3>
            )}
            {selectedGitOverview ? (
              <Badge
                variant={selectedGitOverview.clean ? "outline" : "secondary"}
              >
                {selectedGitOverview.clean
                  ? "Clean"
                  : `${selectedGitOverview.totalChanges} changed`}
              </Badge>
            ) : null}
            {selectedGitOverview?.ahead ? (
              <Badge variant="outline">↑ {selectedGitOverview.ahead}</Badge>
            ) : null}
            {selectedGitOverview?.behind ? (
              <Badge variant="outline">↓ {selectedGitOverview.behind}</Badge>
            ) : null}
          </div>
          {selectedGitOverview ? (
            <p className="mt-1 truncate text-xs text-slate-500">
              {selectedGitOverview.branch}
              {selectedGitOverview.upstream
                ? ` · ${selectedGitOverview.upstream}`
                : ""}
            </p>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={
            gitBusy || gitAction !== null || selectedGitOverview === null
          }
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
            gitBusy || gitAction !== null || !selectedGitOverview?.upstream
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
          disabled={gitBusy || gitAction !== null}
          aria-label="Refresh Git"
          onClick={() => void refreshGit()}
        >
          <RefreshCw className={cn("size-4", gitBusy && "animate-spin")} />
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
            id={`workspace-git-tab-${value}`}
            aria-controls={`workspace-git-panel-${value}`}
            aria-selected={gitSection === value}
            tabIndex={gitSection === value ? 0 : -1}
            onClick={() => setGitSection(value)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              ) {
                return;
              }
              event.preventDefault();
              const tabs = Array.from(
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                ) ?? [],
              );
              const currentIndex = tabs.indexOf(event.currentTarget);
              const nextIndex =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : event.key === "ArrowRight"
                      ? (currentIndex + 1) % tabs.length
                      : (currentIndex - 1 + tabs.length) % tabs.length;
              tabs[nextIndex]?.focus();
              tabs[nextIndex]?.click();
            }}
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

      <div
        id={`workspace-git-panel-${gitSection}`}
        role="tabpanel"
        aria-labelledby={`workspace-git-tab-${gitSection}`}
        className="p-4"
      >
        {gitRepositoriesLoading && !gitRepositories && !selectedGitOverview ? (
          <div className="grid h-40 place-items-center">
            <LoaderCircle className="size-5 animate-spin text-slate-500" />
          </div>
        ) : gitRepositoriesError && !gitRepositories && !selectedGitOverview ? (
          <EmptyState
            icon={Unplug}
            title="Git unavailable"
            description={gitRepositoriesError}
          />
        ) : gitRepositories?.repositories.length === 0 ? (
          <EmptyState
            icon={gitRepositories.issues.length > 0 ? Unplug : FolderGit2}
            title={
              gitRepositories.issues.length > 0
                ? "Repositories unavailable"
                : "No Git repositories"
            }
            description={gitDiscoveryNotice ?? undefined}
          />
        ) : gitLoading && !selectedGitOverview ? (
          <div className="grid h-40 place-items-center">
            <LoaderCircle className="size-5 animate-spin text-slate-500" />
          </div>
        ) : gitError && !selectedGitOverview ? (
          <EmptyState
            icon={Unplug}
            title="Repository unavailable"
            description={gitError}
          />
        ) : selectedGitOverview ? (
          <>
            {gitRepositoriesError ? (
              <p
                role="alert"
                className="mb-4 rounded-lg border border-red-900/60 bg-red-950/25 px-3 py-2 text-sm text-red-200"
              >
                {gitRepositoriesError}
              </p>
            ) : gitDiscoveryNotice ? (
              <p
                role="status"
                className="mb-4 rounded-lg border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-sm text-amber-200"
              >
                {gitDiscoveryNotice}
              </p>
            ) : null}
            {gitError ? (
              <p
                role="alert"
                className="mb-4 rounded-lg border border-red-900/60 bg-red-950/25 px-3 py-2 text-sm text-red-200"
              >
                {gitError}
              </p>
            ) : null}
            {gitSection === "status" ? (
              <WorkspaceGitStatus
                workspaceRoot={workspaceRoot}
                repositoryRoot={
                  selectedGitRepository?.repositoryRoot ??
                  selectedGitOverview.repositoryRoot
                }
                overview={selectedGitOverview}
              />
            ) : null}
            {gitSection === "branches" ? (
              <div className="grid gap-4 xl:grid-cols-2">
                <div className="space-y-2">
                  <SubmitShortcut asChild>
                    <div className="flex gap-2">
                      <Input
                        value={branchName}
                        onChange={(event) => setBranchName(event.target.value)}
                        placeholder="New branch"
                        className="h-9 min-w-0 border-slate-800 bg-slate-950"
                      />
                      <Button
                        size="sm"
                        disabled={gitAction !== null || !branchName.trim()}
                        onClick={() =>
                          void runGitAction("create-branch", {
                            branchName,
                          })
                        }
                        {...SUBMIT_SHORTCUT_ACTION_PROPS}
                      >
                        <Plus className="size-4" />
                        Create
                      </Button>
                    </div>
                  </SubmitShortcut>
                  {selectedGitOverview.localBranches.map((branch) => (
                    <div
                      key={branch.name}
                      className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-slate-800 px-3 py-2"
                    >
                      <GitBranch className="size-3.5 shrink-0 text-slate-500" />
                      <CopyContextMenu
                        values={[
                          {
                            label: "Copy branch name",
                            value: branch.name,
                          },
                        ]}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                          {branch.name}
                        </span>
                      </CopyContextMenu>
                      <CopyContextMenu
                        values={[
                          {
                            label: "Copy commit",
                            value: branch.commit,
                          },
                        ]}
                      >
                        <code className="text-[11px] text-slate-600">
                          {branch.commit}
                        </code>
                      </CopyContextMenu>
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
                  {selectedGitOverview.remoteBranches.length === 0 ? (
                    <EmptyState
                      icon={GitBranch}
                      title="No remote branches"
                      size="compact"
                    />
                  ) : (
                    selectedGitOverview.remoteBranches.map((branch) => (
                      <div
                        key={branch.name}
                        className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-800 px-3 py-2"
                      >
                        <Network className="size-3.5 shrink-0 text-slate-500" />
                        <CopyContextMenu
                          values={[
                            {
                              label: "Copy branch name",
                              value: branch.name,
                            },
                          ]}
                        >
                          <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
                            {branch.name}
                          </span>
                        </CopyContextMenu>
                        <CopyContextMenu
                          values={[
                            {
                              label: "Copy commit",
                              value: branch.commit,
                            },
                          ]}
                        >
                          <code className="text-[11px] text-slate-600">
                            {branch.commit}
                          </code>
                        </CopyContextMenu>
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
                <SubmitShortcut asChild>
                  <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
                    <Input
                      value={remoteName}
                      onChange={(event) => setRemoteName(event.target.value)}
                      placeholder="Name"
                      className="h-9 border-slate-800 bg-slate-950"
                    />
                    <Input
                      value={remoteUrl}
                      onChange={(event) => setRemoteUrl(event.target.value)}
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
                      {...SUBMIT_SHORTCUT_ACTION_PROPS}
                    >
                      <Plus className="size-4" />
                      Add
                    </Button>
                  </div>
                </SubmitShortcut>
                {selectedGitOverview.remotes.length === 0 ? (
                  <EmptyState
                    icon={Network}
                    title="No remotes"
                    size="compact"
                  />
                ) : (
                  selectedGitOverview.remotes.map((remote) => (
                    <div
                      key={remote.name}
                      className="flex min-w-0 items-start gap-3 rounded-lg border border-slate-800 p-3"
                    >
                      <Network className="mt-0.5 size-4 shrink-0 text-slate-500" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-slate-200">
                          {remote.name}
                        </p>
                        <CopyContextMenu
                          values={[
                            {
                              label: "Copy fetch URL",
                              value: remote.fetchUrl ?? "",
                            },
                            {
                              label: "Copy push URL",
                              value: remote.pushUrl ?? "",
                            },
                          ]}
                        >
                          <p className="mt-1 break-all font-mono text-xs text-slate-500">
                            {remote.fetchUrl ?? remote.pushUrl}
                          </p>
                        </CopyContextMenu>
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={gitAction !== null}
                        aria-label={`Remove ${remote.name}`}
                        onClick={() => removeRemote(remote.name)}
                      >
                        <Trash2 className="size-4 text-red-300" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            ) : null}
            {gitSection === "pull-requests" ? (
              pullRequestsLoading && !pullRequests ? (
                <div className="grid h-36 place-items-center">
                  <LoaderCircle className="size-5 animate-spin text-slate-500" />
                </div>
              ) : pullRequestsError ? (
                <EmptyState
                  icon={GitPullRequest}
                  title="Pull requests unavailable"
                  description={pullRequestsError}
                  size="compact"
                  action={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void refreshPullRequests()}
                    >
                      <RefreshCw className="size-3.5" />
                      Retry
                    </Button>
                  }
                />
              ) : pullRequests && !pullRequests.available ? (
                <EmptyState
                  icon={GitPullRequest}
                  title="Pull requests unavailable"
                  description={pullRequests.reason}
                  size="compact"
                />
              ) : pullRequests?.items.length === 0 ? (
                <EmptyState
                  icon={GitPullRequest}
                  title="No open pull requests"
                  size="compact"
                />
              ) : (
                <div className="space-y-2">
                  {pullRequests?.items.map((pullRequest) => (
                    <button
                      key={pullRequest.number}
                      type="button"
                      onClick={() => void openExternalUrl(pullRequest.url)}
                      className="flex w-full min-w-0 items-start gap-3 rounded-lg border border-slate-800 p-3 text-left hover:border-slate-700 hover:bg-slate-950/50"
                    >
                      <GitPullRequest className="mt-0.5 size-4 shrink-0 text-emerald-300" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-slate-200">
                          #{pullRequest.number} {pullRequest.title}
                        </p>
                        <p className="mt-1 truncate text-xs text-slate-500">
                          {pullRequest.headBranch} → {pullRequest.baseBranch}
                        </p>
                      </div>
                      {pullRequest.draft ? (
                        <Badge variant="outline">Draft</Badge>
                      ) : null}
                      <ExternalLink className="size-3.5 text-slate-600" />
                    </button>
                  ))}
                </div>
              )
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
