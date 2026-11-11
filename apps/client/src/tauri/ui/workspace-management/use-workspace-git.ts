import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadWorkspaceGitOverview,
  loadWorkspaceGitRepositories,
  loadWorkspaceGitRepositoriesStatus,
  loadWorkspacePullRequests,
  runWorkspaceGitAction,
  switchWorkspaceGitBranches,
  type WorkspaceGitAction,
  type WorkspaceGitActionOptions,
  type WorkspaceGitOverview,
  type WorkspaceGitRepositoriesStatus,
  type WorkspaceGitRepositoryDiscovery,
  type WorkspacePullRequestOverview,
} from "../runtime";
import {
  isWorkspaceGitStagingAction,
  optimisticWorkspaceGitStaging,
  selectWorkspaceGitRepository,
  workspaceGitActionChangesFiles,
  workspaceGitActionDoneLabel,
  workspaceGitActionUsesRemote,
  workspaceGitRepositoryLabel,
  workspaceGitRepositoryStatusFromOverview,
} from "./workspace-git-model";
import {
  nextWorkspaceGitSequence,
  workspaceGitSummaryFromOverview,
  workspaceGitSummaryStore,
} from "./workspace-git-summary-store";
import { workspaceGitBranchStatusStore } from "./workspace-git-branch-status-store";
import { workspaceGitChangeMonitor } from "./workspace-git-change-monitor";
import { createWorkspaceRootKey } from "./workspace-management-model";
import {
  readWorkspaceViewPreferences,
  withRememberedRepository,
  withWorkspaceGitScope,
  workspaceGitScope,
  writeWorkspaceViewPreferences,
  type WorkspaceGitScope,
} from "./workspace-view-preferences";

interface WorkspaceGitViewState {
  workspaceKey: string | null;
  scope: WorkspaceGitScope;
  repositories: WorkspaceGitRepositoryDiscovery | null;
  repositoriesError: string | null;
  repositoriesStatus: WorkspaceGitRepositoriesStatus | null;
  repositoriesStatusLoading: boolean;
  repositoriesStatusError: string | null;
  repositoryRoot: string | null;
  overview: WorkspaceGitOverview | null;
  loading: boolean;
  error: string | null;
  pullRequests: WorkspacePullRequestOverview | null;
  pullRequestsLoading: boolean;
  pullRequestsError: string | null;
}

export interface WorkspaceGitFeedback {
  id: number;
  tone: "success" | "error";
  text: string;
  action: WorkspaceGitAction;
  options: WorkspaceGitActionOptions;
}

export interface WorkspaceGitFetchAllProgress {
  completed: number;
  total: number;
}

interface ScopedValue<T> {
  workspaceKey: string;
  repositoryRoot: string;
  value: T;
}

interface Snapshot<T> {
  value: T;
  sequence: number;
}

const FOCUS_REFRESH_INTERVAL_MS = 4_000;
const PREFETCHED_OVERVIEWS = 8;
const FETCH_ALL_CONCURRENCY = 3;
const ALL_REPOSITORIES = "";

const discoveryCache = new Map<string, WorkspaceGitRepositoryDiscovery>();
const repositoriesStatusCache = new Map<
  string,
  Snapshot<WorkspaceGitRepositoriesStatus>
>();
const overviewCache = new Map<string, Snapshot<WorkspaceGitOverview>>();
const pullRequestCache = new Map<string, WorkspacePullRequestOverview>();

const repositoryKey = (repositoryRoot: string): string =>
  createWorkspaceRootKey(repositoryRoot);

const sameRepository = (left: string | null, right: string | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    repositoryKey(left) === repositoryKey(right));

const storeSnapshot = <T>(
  cache: Map<string, Snapshot<T>>,
  key: string,
  value: T,
  sequence: number,
): boolean => {
  if (sequence < (cache.get(key)?.sequence ?? 0)) return false;
  cache.set(key, { value, sequence });
  return true;
};

const cachedOverview = (
  repositoryRoot: string,
): WorkspaceGitOverview | undefined =>
  overviewCache.get(repositoryKey(repositoryRoot))?.value;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const discoveryFromStatus = (
  status: WorkspaceGitRepositoriesStatus,
): WorkspaceGitRepositoryDiscovery => ({
  workspaceRoot: status.workspaceRoot,
  repositories: status.repositories.map(({ repositoryRoot, relativePath }) => ({
    repositoryRoot,
    relativePath,
  })),
  scanLimited: status.scanLimited,
  issues: status.issues,
});

const withRepositoryStatus = (
  status: WorkspaceGitRepositoriesStatus | null,
  overview: WorkspaceGitOverview,
): WorkspaceGitRepositoriesStatus | null => {
  if (!status) return null;
  const key = repositoryKey(overview.repositoryRoot);
  return {
    ...status,
    repositories: status.repositories.map((repository) =>
      repositoryKey(repository.repositoryRoot) === key
        ? workspaceGitRepositoryStatusFromOverview(
            overview,
            repository.relativePath,
          )
        : repository,
    ),
  };
};

const initialRepositoryRoot = (
  workspaceRoot: string,
  workspaceKey: string,
  discovery: WorkspaceGitRepositoryDiscovery | undefined,
): string => {
  const remembered =
    readWorkspaceViewPreferences().repositoryRoots[workspaceKey];
  if (!discovery) return remembered ?? workspaceRoot;
  return (
    selectWorkspaceGitRepository(
      discovery.repositories,
      remembered,
      workspaceRoot,
    )?.repositoryRoot ?? workspaceRoot
  );
};

const createInitialState = (
  workspaceRoot: string | null,
): WorkspaceGitViewState => {
  if (!workspaceRoot) {
    return {
      workspaceKey: null,
      scope: "all",
      repositories: null,
      repositoriesError: null,
      repositoriesStatus: null,
      repositoriesStatusLoading: false,
      repositoriesStatusError: null,
      repositoryRoot: null,
      overview: null,
      loading: false,
      error: null,
      pullRequests: null,
      pullRequestsLoading: false,
      pullRequestsError: null,
    };
  }
  const workspaceKey = createWorkspaceRootKey(workspaceRoot);
  const repositories = discoveryCache.get(workspaceKey);
  const repositoryRoot = initialRepositoryRoot(
    workspaceRoot,
    workspaceKey,
    repositories,
  );
  const scope = workspaceGitScope(readWorkspaceViewPreferences(), workspaceKey);
  return {
    workspaceKey,
    scope,
    repositories: repositories ?? null,
    repositoriesError: null,
    repositoriesStatus:
      repositoriesStatusCache.get(workspaceKey)?.value ?? null,
    repositoriesStatusLoading: scope === "all",
    repositoriesStatusError: null,
    repositoryRoot,
    overview: cachedOverview(repositoryRoot) ?? null,
    loading: scope === "repository",
    error: null,
    pullRequests: pullRequestCache.get(repositoryKey(repositoryRoot)) ?? null,
    pullRequestsLoading: false,
    pullRequestsError: null,
  };
};

export function useWorkspaceGit(
  workspaceRoot: string | null,
  {
    filesDirty = false,
    onFilesChanged,
  }: { filesDirty?: boolean; onFilesChanged?: () => void } = {},
) {
  const workspaceKey = workspaceRoot
    ? createWorkspaceRootKey(workspaceRoot)
    : null;
  const [state, setState] = useState(() => createInitialState(workspaceRoot));
  let current = state;
  if (state.workspaceKey !== workspaceKey) {
    current = createInitialState(workspaceRoot);
    setState(current);
  }
  const [pendingAction, setPendingAction] =
    useState<ScopedValue<WorkspaceGitAction> | null>(null);
  const [feedback, setFeedback] =
    useState<ScopedValue<WorkspaceGitFeedback> | null>(null);
  const [fetchingRepositories, setFetchingRepositories] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [fetchAllProgress, setFetchAllProgress] =
    useState<WorkspaceGitFetchAllProgress | null>(null);

  const workspaceRootRef = useRef(workspaceRoot);
  workspaceRootRef.current = workspaceRoot;
  const repositoryRootRef = useRef(current.repositoryRoot);
  repositoryRootRef.current = current.repositoryRoot;
  const scopeRef = useRef(current.scope);
  scopeRef.current = current.scope;
  const filesDirtyRef = useRef(filesDirty);
  filesDirtyRef.current = filesDirty;
  const onFilesChangedRef = useRef(onFilesChanged);
  onFilesChangedRef.current = onFilesChanged;
  const overviewRequestRef = useRef(0);
  const statusRequestRef = useRef(0);
  const pullRequestRequestRef = useRef(0);
  const actionLockRef = useRef(false);
  const localActionRunsRef = useRef(0);
  const reloadAfterActionRef = useRef(false);
  const fetchingRef = useRef(new Set<string>());
  const lastOverviewLoadRef = useRef(0);
  const feedbackIdRef = useRef(0);
  const prefetchRunRef = useRef(0);

  const updateScoped = useCallback(
    (
      scopeWorkspaceKey: string,
      scopeRepositoryRoot: string | null,
      update: (current: WorkspaceGitViewState) => WorkspaceGitViewState,
    ): void => {
      setState((current) =>
        current.workspaceKey === scopeWorkspaceKey &&
        (scopeRepositoryRoot === null ||
          sameRepository(current.repositoryRoot, scopeRepositoryRoot))
          ? update(current)
          : current,
      );
    },
    [],
  );

  const applyOverview = useCallback(
    (
      root: string,
      repositoryRoot: string,
      overview: WorkspaceGitOverview,
      sequence: number,
    ): void => {
      const scopeKey = createWorkspaceRootKey(root);
      const key = repositoryKey(repositoryRoot);
      if (!storeSnapshot(overviewCache, key, overview, sequence)) return;
      if (key === scopeKey) {
        workspaceGitSummaryStore.publish(
          root,
          workspaceGitSummaryFromOverview(overview),
          sequence,
        );
      }
      const cachedStatus = repositoriesStatusCache.get(scopeKey);
      const status = withRepositoryStatus(
        cachedStatus?.value ?? null,
        overview,
      );
      if (status && cachedStatus) {
        repositoriesStatusCache.set(scopeKey, {
          value: status,
          sequence: Math.max(cachedStatus.sequence, sequence),
        });
      }
      updateScoped(scopeKey, null, (current) => ({
        ...current,
        ...(status ? { repositoriesStatus: status } : {}),
        ...(sameRepository(current.repositoryRoot, repositoryRoot)
          ? { overview, loading: false, error: null }
          : {}),
      }));
    },
    [updateScoped],
  );

  const updateFetching = useCallback((key: string, active: boolean): void => {
    if (active) fetchingRef.current.add(key);
    else fetchingRef.current.delete(key);
    setFetchingRepositories(new Set(fetchingRef.current));
  }, []);

  const loadOverview = useCallback(
    async (root: string, repositoryRoot: string): Promise<void> => {
      const requestId = ++overviewRequestRef.current;
      const sequence = nextWorkspaceGitSequence();
      const scopeKey = createWorkspaceRootKey(root);
      lastOverviewLoadRef.current = Date.now();
      updateScoped(scopeKey, repositoryRoot, (current) => ({
        ...current,
        loading: true,
      }));
      try {
        const overview = await loadWorkspaceGitOverview(root, repositoryRoot);
        if (requestId === overviewRequestRef.current) {
          applyOverview(root, repositoryRoot, overview, sequence);
        } else {
          storeSnapshot(
            overviewCache,
            repositoryKey(repositoryRoot),
            overview,
            sequence,
          );
        }
      } catch (error) {
        if (requestId === overviewRequestRef.current) {
          updateScoped(scopeKey, repositoryRoot, (current) => ({
            ...current,
            error: errorMessage(error),
          }));
        }
      } finally {
        if (requestId === overviewRequestRef.current) {
          updateScoped(scopeKey, repositoryRoot, (current) => ({
            ...current,
            loading: false,
          }));
        }
      }
    },
    [applyOverview, updateScoped],
  );

  const prefetchOverviews = useCallback(
    async (root: string, status: WorkspaceGitRepositoriesStatus) => {
      const run = ++prefetchRunRef.current;
      const scopeKey = createWorkspaceRootKey(root);
      const candidates = [...status.repositories]
        .filter(
          (repository) =>
            !repository.error && !cachedOverview(repository.repositoryRoot),
        )
        .sort((left, right) => right.totalChanges - left.totalChanges)
        .slice(0, PREFETCHED_OVERVIEWS);
      for (const repository of candidates) {
        const activeRoot = workspaceRootRef.current;
        if (
          run !== prefetchRunRef.current ||
          !activeRoot ||
          createWorkspaceRootKey(activeRoot) !== scopeKey ||
          actionLockRef.current
        ) {
          return;
        }
        try {
          const sequence = nextWorkspaceGitSequence();
          storeSnapshot(
            overviewCache,
            repositoryKey(repository.repositoryRoot),
            await loadWorkspaceGitOverview(root, repository.repositoryRoot),
            sequence,
          );
        } catch {
          return;
        }
      }
    },
    [],
  );

  const loadRepositoriesStatus = useCallback(
    async (root: string, rescan: boolean): Promise<void> => {
      const requestId = ++statusRequestRef.current;
      const sequence = nextWorkspaceGitSequence();
      const scopeKey = createWorkspaceRootKey(root);
      lastOverviewLoadRef.current = Date.now();
      updateScoped(scopeKey, null, (current) => ({
        ...current,
        repositoriesStatusLoading: true,
      }));
      try {
        const status = await loadWorkspaceGitRepositoriesStatus(root, {
          refresh: rescan,
        });
        const discovery = discoveryFromStatus(status);
        discoveryCache.set(scopeKey, discovery);
        if (
          !storeSnapshot(repositoriesStatusCache, scopeKey, status, sequence)
        ) {
          return;
        }
        const rootStatus = status.repositories.find(
          (repository) => repository.relativePath === ".",
        );
        if (rootStatus && !rootStatus.error) {
          workspaceGitSummaryStore.publish(
            root,
            {
              branch: rootStatus.branch,
              detached: rootStatus.detached,
              ...(rootStatus.upstream ? { upstream: rootStatus.upstream } : {}),
              ahead: rootStatus.ahead,
              behind: rootStatus.behind,
              changes: rootStatus.totalChanges,
              conflicts: rootStatus.conflictedCount,
            },
            sequence,
          );
        }
        if (requestId !== statusRequestRef.current) return;
        const selectedRoot =
          selectWorkspaceGitRepository(
            discovery.repositories,
            repositoryRootRef.current,
            readWorkspaceViewPreferences().repositoryRoots[scopeKey],
            root,
          )?.repositoryRoot ?? null;
        repositoryRootRef.current = selectedRoot;
        updateScoped(scopeKey, null, (current) => ({
          ...current,
          repositories: discovery,
          repositoriesError: null,
          repositoriesStatus: status,
          repositoriesStatusError: null,
          repositoryRoot: selectedRoot,
          overview: selectedRoot
            ? (cachedOverview(selectedRoot) ?? current.overview)
            : null,
        }));
        if (discovery.repositories.length === 1 && selectedRoot) {
          await loadOverview(root, selectedRoot);
        } else {
          void prefetchOverviews(root, status);
        }
      } catch (error) {
        if (requestId === statusRequestRef.current) {
          updateScoped(scopeKey, null, (current) => ({
            ...current,
            repositoriesStatusError: errorMessage(error),
          }));
        }
      } finally {
        if (requestId === statusRequestRef.current) {
          updateScoped(scopeKey, null, (current) => ({
            ...current,
            repositoriesStatusLoading: false,
          }));
        }
      }
    },
    [loadOverview, prefetchOverviews, updateScoped],
  );

  const loadPullRequests = useCallback(
    async (root: string, repositoryRoot: string): Promise<void> => {
      const requestId = ++pullRequestRequestRef.current;
      const scopeKey = createWorkspaceRootKey(root);
      updateScoped(scopeKey, repositoryRoot, (current) => ({
        ...current,
        pullRequestsLoading: true,
        pullRequestsError: null,
      }));
      try {
        const pullRequests = await loadWorkspacePullRequests(
          root,
          repositoryRoot,
        );
        pullRequestCache.set(repositoryKey(repositoryRoot), pullRequests);
        if (requestId === pullRequestRequestRef.current) {
          updateScoped(scopeKey, repositoryRoot, (current) => ({
            ...current,
            pullRequests,
          }));
        }
      } catch (error) {
        if (requestId === pullRequestRequestRef.current) {
          updateScoped(scopeKey, repositoryRoot, (current) => ({
            ...current,
            pullRequestsError: errorMessage(error),
          }));
        }
      } finally {
        if (requestId === pullRequestRequestRef.current) {
          updateScoped(scopeKey, repositoryRoot, (current) => ({
            ...current,
            pullRequestsLoading: false,
          }));
        }
      }
    },
    [updateScoped],
  );

  const loadRepository = useCallback(
    async (root: string, rescan: boolean): Promise<void> => {
      const preferredRoot = repositoryRootRef.current;
      const scopeKey = createWorkspaceRootKey(root);
      const preferredOverview = preferredRoot
        ? loadOverview(root, preferredRoot)
        : Promise.resolve();
      try {
        const discovery = await loadWorkspaceGitRepositories(root, {
          refresh: rescan,
        });
        discoveryCache.set(scopeKey, discovery);
        const selectedRoot =
          selectWorkspaceGitRepository(
            discovery.repositories,
            repositoryRootRef.current,
            readWorkspaceViewPreferences().repositoryRoots[scopeKey],
            root,
          )?.repositoryRoot ?? null;
        updateScoped(scopeKey, null, (current) => {
          const repositoryChanged = !sameRepository(
            current.repositoryRoot,
            selectedRoot,
          );
          return {
            ...current,
            repositories: discovery,
            repositoriesError: null,
            repositoryRoot: selectedRoot,
            ...(repositoryChanged
              ? {
                  overview: selectedRoot
                    ? (cachedOverview(selectedRoot) ?? null)
                    : null,
                  error: null,
                  loading: selectedRoot !== null,
                  pullRequests: selectedRoot
                    ? (pullRequestCache.get(repositoryKey(selectedRoot)) ??
                      null)
                    : null,
                  pullRequestsError: null,
                }
              : {}),
          };
        });
        repositoryRootRef.current = selectedRoot;
        if (selectedRoot && !sameRepository(selectedRoot, preferredRoot)) {
          await loadOverview(root, selectedRoot);
        }
      } catch (error) {
        updateScoped(scopeKey, null, (current) => ({
          ...current,
          repositoriesError: errorMessage(error),
        }));
      }
      await preferredOverview;
    },
    [loadOverview, updateScoped],
  );

  const showsRepositoriesStatus = useCallback(
    (root: string): boolean =>
      scopeRef.current === "all" &&
      discoveryCache.get(createWorkspaceRootKey(root))?.repositories.length !==
        1,
    [],
  );

  const load = useCallback(
    async (rescan: boolean): Promise<void> => {
      const root = workspaceRootRef.current;
      if (!root) return;
      if (showsRepositoriesStatus(root)) {
        await loadRepositoriesStatus(root, rescan);
      } else {
        await loadRepository(root, rescan);
      }
    },
    [loadRepository, loadRepositoriesStatus, showsRepositoriesStatus],
  );

  const refresh = useCallback(() => load(true), [load]);

  const reload = useCallback((): void => {
    const root = workspaceRootRef.current;
    const repositoryRoot = repositoryRootRef.current;
    if (!root || actionLockRef.current) return;
    if (showsRepositoriesStatus(root)) {
      void loadRepositoriesStatus(root, false);
    } else if (repositoryRoot) {
      void loadOverview(root, repositoryRoot);
    }
  }, [loadOverview, loadRepositoriesStatus, showsRepositoriesStatus]);

  useEffect(() => {
    if (workspaceRoot) void load(false);
  }, [load, workspaceRoot]);

  useEffect(() => {
    const refreshOnFocus = (): void => {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastOverviewLoadRef.current >= FOCUS_REFRESH_INTERVAL_MS
      ) {
        reload();
      }
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [reload]);

  useEffect(() => {
    if (!workspaceRoot) return;
    const watchedKey = createWorkspaceRootKey(workspaceRoot);
    const unwatch = workspaceGitChangeMonitor.watch(workspaceRoot);
    const unsubscribe = workspaceGitChangeMonitor.subscribe((changedRoot) => {
      if (createWorkspaceRootKey(changedRoot) === watchedKey) reload();
    });
    return () => {
      unsubscribe();
      unwatch();
    };
  }, [reload, workspaceRoot]);

  const selectRepository = useCallback(
    (repositoryRoot: string): void => {
      const root = workspaceRootRef.current;
      if (!root) return;
      if (
        sameRepository(repositoryRoot, repositoryRootRef.current) &&
        scopeRef.current === "repository"
      ) {
        return;
      }
      const scopeKey = createWorkspaceRootKey(root);
      repositoryRootRef.current = repositoryRoot;
      scopeRef.current = "repository";
      prefetchRunRef.current += 1;
      writeWorkspaceViewPreferences((current) =>
        withWorkspaceGitScope(
          withRememberedRepository(current, scopeKey, repositoryRoot),
          scopeKey,
          "repository",
        ),
      );
      const cached = cachedOverview(repositoryRoot) ?? null;
      updateScoped(scopeKey, null, (current) => ({
        ...current,
        scope: "repository",
        repositoryRoot,
        overview: cached,
        loading: cached === null,
        error: null,
        pullRequests:
          pullRequestCache.get(repositoryKey(repositoryRoot)) ?? null,
        pullRequestsError: null,
        pullRequestsLoading: false,
      }));
      void loadOverview(root, repositoryRoot);
    },
    [loadOverview, updateScoped],
  );

  const showAllRepositories = useCallback((): void => {
    const root = workspaceRootRef.current;
    if (!root || scopeRef.current === "all") return;
    const scopeKey = createWorkspaceRootKey(root);
    scopeRef.current = "all";
    writeWorkspaceViewPreferences((current) =>
      withWorkspaceGitScope(current, scopeKey, "all"),
    );
    updateScoped(scopeKey, null, (current) => ({
      ...current,
      scope: "all",
      repositoriesStatus:
        repositoriesStatusCache.get(scopeKey)?.value ??
        current.repositoriesStatus,
    }));
    void loadRepositoriesStatus(root, false);
  }, [loadRepositoriesStatus, updateScoped]);

  const ensurePullRequests = useCallback((): void => {
    const root = workspaceRootRef.current;
    const repositoryRoot = repositoryRootRef.current;
    if (!root || !repositoryRoot) return;
    void loadPullRequests(root, repositoryRoot);
  }, [loadPullRequests]);

  const fetchRemotes = useCallback(
    async (root: string, repositoryRoot: string): Promise<boolean> => {
      const key = repositoryKey(repositoryRoot);
      if (actionLockRef.current || fetchingRef.current.has(key)) return false;
      const scope = {
        workspaceKey: createWorkspaceRootKey(root),
        repositoryRoot,
      };
      const localActionRunsAtStart = localActionRunsRef.current;
      updateFetching(key, true);
      setFeedback(null);
      try {
        const overview = await runWorkspaceGitAction(
          root,
          repositoryRoot,
          "fetch",
        );
        const selectedRoot = workspaceRootRef.current;
        const selected =
          selectedRoot !== null &&
          createWorkspaceRootKey(selectedRoot) === scope.workspaceKey &&
          sameRepository(repositoryRootRef.current, repositoryRoot);
        if (localActionRunsRef.current === localActionRunsAtStart) {
          if (selected) overviewRequestRef.current += 1;
          applyOverview(
            root,
            repositoryRoot,
            overview,
            nextWorkspaceGitSequence(),
          );
        } else if (selected && actionLockRef.current) {
          reloadAfterActionRef.current = true;
        } else if (selected) {
          void loadOverview(root, repositoryRoot);
        }
        pullRequestCache.delete(key);
        if (selected) void loadPullRequests(root, repositoryRoot);
        workspaceGitBranchStatusStore.invalidate(root);
        const success: ScopedValue<WorkspaceGitFeedback> = {
          ...scope,
          value: {
            id: ++feedbackIdRef.current,
            tone: "success",
            text: workspaceGitActionDoneLabel("fetch"),
            action: "fetch",
            options: {},
          },
        };
        setFeedback((current) =>
          current?.value.tone === "error" ? current : success,
        );
        return true;
      } catch (error) {
        setFeedback({
          ...scope,
          value: {
            id: ++feedbackIdRef.current,
            tone: "error",
            text: errorMessage(error),
            action: "fetch",
            options: {},
          },
        });
        return false;
      } finally {
        updateFetching(key, false);
        workspaceGitChangeMonitor.sync(root);
      }
    },
    [applyOverview, loadOverview, loadPullRequests, updateFetching],
  );

  const fetchAllRepositories = useCallback(async (): Promise<boolean> => {
    const root = workspaceRootRef.current;
    if (!root || actionLockRef.current || fetchAllProgress) return false;
    const scopeKey = createWorkspaceRootKey(root);
    const repositories =
      discoveryCache.get(scopeKey)?.repositories ??
      current.repositories?.repositories ??
      [];
    if (repositories.length === 0) return false;
    const failures: string[] = [];
    let completed = 0;
    let next = 0;
    setFeedback(null);
    setFetchAllProgress({ completed, total: repositories.length });
    const worker = async (): Promise<void> => {
      while (next < repositories.length) {
        const repository = repositories[next++]!;
        const key = repositoryKey(repository.repositoryRoot);
        updateFetching(key, true);
        try {
          const overview = await runWorkspaceGitAction(
            root,
            repository.repositoryRoot,
            "fetch",
          );
          applyOverview(
            root,
            repository.repositoryRoot,
            overview,
            nextWorkspaceGitSequence(),
          );
          pullRequestCache.delete(key);
        } catch (error) {
          failures.push(
            `${workspaceGitRepositoryLabel(repository)}: ${errorMessage(error)}`,
          );
        } finally {
          updateFetching(key, false);
          completed += 1;
          setFetchAllProgress({ completed, total: repositories.length });
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(FETCH_ALL_CONCURRENCY, repositories.length) },
        worker,
      ),
    );
    setFetchAllProgress(null);
    workspaceGitBranchStatusStore.invalidate(root);
    workspaceGitChangeMonitor.sync(root);
    setFeedback({
      workspaceKey: scopeKey,
      repositoryRoot: ALL_REPOSITORIES,
      value: {
        id: ++feedbackIdRef.current,
        tone: failures.length > 0 ? "error" : "success",
        text:
          failures.length > 0
            ? failures.join("\n")
            : workspaceGitActionDoneLabel("fetch"),
        action: "fetch",
        options: {},
      },
    });
    return failures.length === 0;
  }, [applyOverview, current.repositories, fetchAllProgress, updateFetching]);

  const runLocked = useCallback(
    async (
      action: WorkspaceGitAction,
      options: WorkspaceGitActionOptions,
      execute: (
        root: string,
        repositoryRoot: string,
      ) => Promise<WorkspaceGitOverview>,
      successText = workspaceGitActionDoneLabel(action),
    ): Promise<boolean> => {
      const root = workspaceRootRef.current;
      const repositoryRoot = repositoryRootRef.current;
      if (!root || !repositoryRoot) return false;
      if (
        actionLockRef.current ||
        (workspaceGitActionUsesRemote(action) &&
          fetchingRef.current.has(repositoryKey(repositoryRoot)))
      ) {
        return false;
      }
      const changesFiles = workspaceGitActionChangesFiles(action);
      if (
        changesFiles &&
        filesDirtyRef.current &&
        !window.confirm(
          "Run this Git action with unsaved changes? Your draft will be kept.",
        )
      ) {
        return false;
      }
      const scope = {
        workspaceKey: createWorkspaceRootKey(root),
        repositoryRoot,
      };
      actionLockRef.current = true;
      localActionRunsRef.current += 1;
      overviewRequestRef.current += 1;
      setPendingAction({ ...scope, value: action });
      setFeedback(null);
      if (isWorkspaceGitStagingAction(action)) {
        updateScoped(scope.workspaceKey, repositoryRoot, (current) =>
          current.overview
            ? {
                ...current,
                overview: optimisticWorkspaceGitStaging(
                  current.overview,
                  action,
                  options.paths,
                ),
              }
            : current,
        );
      }
      try {
        const overview = await execute(root, repositoryRoot);
        applyOverview(
          root,
          repositoryRoot,
          overview,
          nextWorkspaceGitSequence(),
        );
        if (changesFiles) onFilesChangedRef.current?.();
        if (workspaceGitActionUsesRemote(action)) {
          pullRequestCache.delete(repositoryKey(repositoryRoot));
          void loadPullRequests(root, repositoryRoot);
        }
        setFeedback({
          ...scope,
          value: {
            id: ++feedbackIdRef.current,
            tone: "success",
            text: successText,
            action,
            options,
          },
        });
        return true;
      } catch (error) {
        setFeedback({
          ...scope,
          value: {
            id: ++feedbackIdRef.current,
            tone: "error",
            text: errorMessage(error),
            action,
            options,
          },
        });
        void loadOverview(root, repositoryRoot);
        return false;
      } finally {
        actionLockRef.current = false;
        setPendingAction(null);
        workspaceGitBranchStatusStore.invalidate(root);
        workspaceGitChangeMonitor.sync(root);
        if (reloadAfterActionRef.current) {
          reloadAfterActionRef.current = false;
          void loadOverview(root, repositoryRoot);
        }
      }
    },
    [applyOverview, loadOverview, loadPullRequests, updateScoped],
  );

  const runAction = useCallback(
    (
      action: WorkspaceGitAction,
      options: WorkspaceGitActionOptions = {},
    ): Promise<boolean> => {
      const root = workspaceRootRef.current;
      const repositoryRoot = repositoryRootRef.current;
      if (action === "fetch" && root && repositoryRoot) {
        return fetchRemotes(root, repositoryRoot);
      }
      return runLocked(action, options, (activeRoot, activeRepositoryRoot) =>
        runWorkspaceGitAction(
          activeRoot,
          activeRepositoryRoot,
          action,
          options,
        ),
      );
    },
    [fetchRemotes, runLocked],
  );

  const switchBranch = useCallback(
    (branchName: string): Promise<boolean> => {
      const repositoryRoot = repositoryRootRef.current;
      const overview = repositoryRoot
        ? cachedOverview(repositoryRoot)
        : undefined;
      if (!overview || overview.clean) {
        return runAction("checkout", { branchName });
      }
      return runLocked(
        "checkout",
        { branchName },
        async (root, activeRepositoryRoot) => {
          const [result] = await switchWorkspaceGitBranches(
            root,
            [
              {
                repositoryRoot: activeRepositoryRoot,
                branchName,
                create: false,
              },
            ],
            true,
          );
          if (result?.error) throw new Error(result.error);
          return loadWorkspaceGitOverview(root, activeRepositoryRoot);
        },
        `Stashed changes and switched to ${branchName}`,
      );
    },
    [runAction, runLocked],
  );

  const dismissFeedback = useCallback(() => setFeedback(null), []);

  const multipleRepositories =
    (current.repositories?.repositories.length ??
      current.repositoriesStatus?.repositories.length ??
      0) > 1;
  const scope: WorkspaceGitScope =
    current.scope === "all" &&
    (multipleRepositories ||
      (current.repositories === null && current.repositoriesStatus === null))
      ? "all"
      : "repository";
  const scopedRepositoryRoot =
    scope === "all" ? ALL_REPOSITORIES : current.repositoryRoot;
  const inScope = <T>(value: ScopedValue<T> | null): T | null =>
    value &&
    value.workspaceKey === workspaceKey &&
    sameRepository(value.repositoryRoot, scopedRepositoryRoot)
      ? value.value
      : null;

  const selectedRepository = current.repositories
    ? selectWorkspaceGitRepository(
        current.repositories.repositories,
        current.repositoryRoot,
      )
    : null;
  const busy = pendingAction !== null || fetchAllProgress !== null;
  const fetching =
    current.repositoryRoot !== null &&
    fetchingRepositories.has(repositoryKey(current.repositoryRoot));

  return {
    workspaceRoot,
    scope,
    repositories: current.repositories,
    repositoriesError: current.repositoriesError,
    repositoriesStatus: current.repositoriesStatus,
    repositoriesStatusLoading: current.repositoriesStatusLoading,
    repositoriesStatusError: current.repositoriesStatusError,
    repositoryRoot: current.repositoryRoot,
    selectedRepository,
    overview: current.overview,
    loading: current.loading,
    error: current.error,
    pullRequests: current.pullRequests,
    pullRequestsLoading: current.pullRequestsLoading,
    pullRequestsError: current.pullRequestsError,
    pendingAction: inScope(pendingAction),
    busy,
    fetching,
    fetchingRepositories,
    fetchAllProgress,
    isActionBlocked: (action: WorkspaceGitAction): boolean =>
      busy || (fetching && workspaceGitActionUsesRemote(action)),
    feedback: inScope(feedback),
    discoveryNotice: current.repositories?.scanLimited
      ? "Repository scan limit reached. Some repositories may be missing."
      : (current.repositories?.issues[0] ?? null),
    refresh,
    reload,
    selectRepository,
    showAllRepositories,
    ensurePullRequests,
    runAction,
    switchBranch,
    fetchAllRepositories,
    dismissFeedback,
  };
}

export type WorkspaceGitControls = ReturnType<typeof useWorkspaceGit>;
