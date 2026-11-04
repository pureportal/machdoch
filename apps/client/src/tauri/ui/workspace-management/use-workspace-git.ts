import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadWorkspaceGitOverview,
  loadWorkspaceGitRepositories,
  loadWorkspacePullRequests,
  runWorkspaceGitAction,
  type WorkspaceGitAction,
  type WorkspaceGitActionOptions,
  type WorkspaceGitOverview,
  type WorkspaceGitRepositoryDiscovery,
  type WorkspacePullRequestOverview,
} from "../runtime";
import {
  selectWorkspaceGitRepository,
  workspaceGitActionChangesFiles,
  workspaceGitActionChangesPullRequests,
  workspaceGitActionDoneLabel,
} from "./workspace-git-model";
import {
  workspaceGitSummaryFromOverview,
  workspaceGitSummaryStore,
} from "./workspace-git-summary-store";
import { createWorkspaceRootKey } from "./workspace-management-model";
import {
  readWorkspaceViewPreferences,
  withRememberedRepository,
  writeWorkspaceViewPreferences,
} from "./workspace-view-preferences";

interface WorkspaceGitViewState {
  workspaceKey: string | null;
  repositories: WorkspaceGitRepositoryDiscovery | null;
  repositoriesError: string | null;
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

interface ScopedValue<T> {
  workspaceKey: string;
  repositoryRoot: string;
  value: T;
}

const FOCUS_REFRESH_INTERVAL_MS = 4_000;

const discoveryCache = new Map<string, WorkspaceGitRepositoryDiscovery>();
const overviewCache = new Map<string, WorkspaceGitOverview>();
const pullRequestCache = new Map<string, WorkspacePullRequestOverview>();

const repositoryKey = (repositoryRoot: string): string =>
  createWorkspaceRootKey(repositoryRoot);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
      repositories: null,
      repositoriesError: null,
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
  return {
    workspaceKey,
    repositories: repositories ?? null,
    repositoriesError: null,
    repositoryRoot,
    overview: overviewCache.get(repositoryKey(repositoryRoot)) ?? null,
    loading: true,
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

  const workspaceRootRef = useRef(workspaceRoot);
  workspaceRootRef.current = workspaceRoot;
  const repositoryRootRef = useRef(current.repositoryRoot);
  repositoryRootRef.current = current.repositoryRoot;
  const filesDirtyRef = useRef(filesDirty);
  filesDirtyRef.current = filesDirty;
  const onFilesChangedRef = useRef(onFilesChanged);
  onFilesChangedRef.current = onFilesChanged;
  const overviewRequestRef = useRef(0);
  const pullRequestRequestRef = useRef(0);
  const actionLockRef = useRef(false);
  const lastOverviewLoadRef = useRef(0);
  const feedbackIdRef = useRef(0);

  const updateScoped = useCallback(
    (
      scopeWorkspaceKey: string,
      scopeRepositoryRoot: string | null,
      update: (current: WorkspaceGitViewState) => WorkspaceGitViewState,
    ): void => {
      setState((current) =>
        current.workspaceKey === scopeWorkspaceKey &&
        (scopeRepositoryRoot === null ||
          current.repositoryRoot === scopeRepositoryRoot)
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
    ): void => {
      overviewCache.set(repositoryKey(repositoryRoot), overview);
      if (repositoryKey(repositoryRoot) === createWorkspaceRootKey(root)) {
        workspaceGitSummaryStore.publish(
          root,
          workspaceGitSummaryFromOverview(overview),
        );
      }
      updateScoped(createWorkspaceRootKey(root), repositoryRoot, (current) => ({
        ...current,
        overview,
        error: null,
      }));
    },
    [updateScoped],
  );

  const loadOverview = useCallback(
    async (root: string, repositoryRoot: string): Promise<void> => {
      const requestId = ++overviewRequestRef.current;
      const scopeKey = createWorkspaceRootKey(root);
      lastOverviewLoadRef.current = Date.now();
      updateScoped(scopeKey, repositoryRoot, (current) => ({
        ...current,
        loading: true,
      }));
      try {
        const overview = await loadWorkspaceGitOverview(root, repositoryRoot);
        if (requestId === overviewRequestRef.current) {
          applyOverview(root, repositoryRoot, overview);
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

  const refresh = useCallback(async (): Promise<void> => {
    const root = workspaceRootRef.current;
    const preferredRoot = repositoryRootRef.current;
    if (!root) return;
    const scopeKey = createWorkspaceRootKey(root);
    const preferredOverview = preferredRoot
      ? loadOverview(root, preferredRoot)
      : Promise.resolve();
    try {
      const discovery = await loadWorkspaceGitRepositories(root);
      discoveryCache.set(scopeKey, discovery);
      const selectedRoot =
        selectWorkspaceGitRepository(
          discovery.repositories,
          repositoryRootRef.current,
          readWorkspaceViewPreferences().repositoryRoots[scopeKey],
          root,
        )?.repositoryRoot ?? null;
      updateScoped(scopeKey, null, (current) => {
        const repositoryChanged = current.repositoryRoot !== selectedRoot;
        return {
          ...current,
          repositories: discovery,
          repositoriesError: null,
          repositoryRoot: selectedRoot,
          ...(repositoryChanged
            ? {
                overview: selectedRoot
                  ? (overviewCache.get(repositoryKey(selectedRoot)) ?? null)
                  : null,
                error: null,
                loading: selectedRoot !== null,
                pullRequests: selectedRoot
                  ? (pullRequestCache.get(repositoryKey(selectedRoot)) ?? null)
                  : null,
                pullRequestsError: null,
              }
            : {}),
        };
      });
      if (selectedRoot && selectedRoot !== preferredRoot) {
        repositoryRootRef.current = selectedRoot;
        await loadOverview(root, selectedRoot);
      }
    } catch (error) {
      updateScoped(scopeKey, null, (current) => ({
        ...current,
        repositoriesError: errorMessage(error),
      }));
    }
    await preferredOverview;
  }, [loadOverview, updateScoped]);

  useEffect(() => {
    if (workspaceRoot) void refresh();
  }, [refresh, workspaceRoot]);

  useEffect(() => {
    const refreshOnFocus = (): void => {
      const root = workspaceRootRef.current;
      const repositoryRoot = repositoryRootRef.current;
      if (
        !root ||
        !repositoryRoot ||
        document.visibilityState !== "visible" ||
        actionLockRef.current ||
        Date.now() - lastOverviewLoadRef.current < FOCUS_REFRESH_INTERVAL_MS
      ) {
        return;
      }
      void loadOverview(root, repositoryRoot);
    };
    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnFocus);
    return () => {
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnFocus);
    };
  }, [loadOverview]);

  const selectRepository = useCallback(
    (repositoryRoot: string): void => {
      const root = workspaceRootRef.current;
      if (!root || repositoryRoot === repositoryRootRef.current) return;
      const scopeKey = createWorkspaceRootKey(root);
      repositoryRootRef.current = repositoryRoot;
      writeWorkspaceViewPreferences((current) =>
        withRememberedRepository(current, scopeKey, repositoryRoot),
      );
      updateScoped(scopeKey, null, (current) => ({
        ...current,
        repositoryRoot,
        overview: overviewCache.get(repositoryKey(repositoryRoot)) ?? null,
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

  const ensurePullRequests = useCallback((): void => {
    const root = workspaceRootRef.current;
    const repositoryRoot = repositoryRootRef.current;
    if (!root || !repositoryRoot) return;
    void loadPullRequests(root, repositoryRoot);
  }, [loadPullRequests]);

  const reload = useCallback((): void => {
    const root = workspaceRootRef.current;
    const repositoryRoot = repositoryRootRef.current;
    if (!root || !repositoryRoot || actionLockRef.current) return;
    void loadOverview(root, repositoryRoot);
  }, [loadOverview]);

  const runAction = useCallback(
    async (
      action: WorkspaceGitAction,
      options: WorkspaceGitActionOptions = {},
    ): Promise<boolean> => {
      const root = workspaceRootRef.current;
      const repositoryRoot = repositoryRootRef.current;
      if (!root || !repositoryRoot || actionLockRef.current) return false;
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
      overviewRequestRef.current += 1;
      setPendingAction({ ...scope, value: action });
      setFeedback(null);
      try {
        const overview = await runWorkspaceGitAction(
          root,
          repositoryRoot,
          action,
          options,
        );
        applyOverview(root, repositoryRoot, overview);
        if (changesFiles) onFilesChangedRef.current?.();
        if (workspaceGitActionChangesPullRequests(action)) {
          pullRequestCache.delete(repositoryKey(repositoryRoot));
          void loadPullRequests(root, repositoryRoot);
        }
        setFeedback({
          ...scope,
          value: {
            id: ++feedbackIdRef.current,
            tone: "success",
            text: workspaceGitActionDoneLabel(action),
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
      }
    },
    [applyOverview, loadOverview, loadPullRequests],
  );

  const dismissFeedback = useCallback(() => setFeedback(null), []);

  const inScope = <T>(value: ScopedValue<T> | null): T | null =>
    value &&
    value.workspaceKey === workspaceKey &&
    value.repositoryRoot === current.repositoryRoot
      ? value.value
      : null;

  const selectedRepository = current.repositories
    ? selectWorkspaceGitRepository(
        current.repositories.repositories,
        current.repositoryRoot,
      )
    : null;

  return {
    workspaceRoot,
    repositories: current.repositories,
    repositoriesError: current.repositoriesError,
    repositoryRoot: current.repositoryRoot,
    selectedRepository,
    overview: current.overview,
    loading: current.loading,
    error: current.error,
    pullRequests: current.pullRequests,
    pullRequestsLoading: current.pullRequestsLoading,
    pullRequestsError: current.pullRequestsError,
    pendingAction: inScope(pendingAction),
    busy: pendingAction !== null,
    feedback: inScope(feedback),
    discoveryNotice: current.repositories?.scanLimited
      ? "Repository scan limit reached. Some repositories may be missing."
      : (current.repositories?.issues[0] ?? null),
    refresh,
    reload,
    selectRepository,
    ensurePullRequests,
    runAction,
    dismissFeedback,
  };
}

export type WorkspaceGitControls = ReturnType<typeof useWorkspaceGit>;
