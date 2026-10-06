import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadWorkspaceGitOverview,
  loadWorkspaceGitRepositories,
  loadWorkspacePullRequests,
  runWorkspaceGitAction,
  type WorkspaceGitAction,
  type WorkspaceGitOverview,
  type WorkspaceGitRepositoryDiscovery,
  type WorkspacePullRequestOverview,
} from "../runtime";
import {
  selectWorkspaceGitRepository,
  workspaceGitActionChangesFiles,
  workspaceGitOverviewForSelection,
} from "./workspace-git-model";
import {
  startExclusiveWorkspaceOperation,
  type WorkspaceOperationLock,
} from "./workspace-operation-lock";
type GitSection = "status" | "branches" | "remotes" | "pull-requests";
export function useWorkspaceGit(
  workspaceRoot: string | null,
  workspaceToolsDirty: boolean,
  onFilesChanged: () => void,
) {
  const [gitSection, setGitSection] = useState<GitSection>("status");
  const [gitOverview, setGitOverview] = useState<WorkspaceGitOverview | null>(
    null,
  );
  const [gitRepositories, setGitRepositories] =
    useState<WorkspaceGitRepositoryDiscovery | null>(null);
  const [gitRepositoriesLoading, setGitRepositoriesLoading] = useState(false);
  const [gitRepositoriesError, setGitRepositoriesError] = useState<
    string | null
  >(null);
  const [selectedGitRepositoryRoot, setSelectedGitRepositoryRoot] = useState<
    string | null
  >(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitAction, setGitAction] = useState<WorkspaceGitAction | null>(null);
  const [pullRequests, setPullRequests] =
    useState<WorkspacePullRequestOverview | null>(null);
  const [pullRequestsLoading, setPullRequestsLoading] = useState(false);
  const [pullRequestsError, setPullRequestsError] = useState<string | null>(
    null,
  );
  const [branchName, setBranchName] = useState("");
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");

  const selectedGitRepositoryRootRef = useRef<string | null>(null);
  const gitOverviewWorkspaceRootRef = useRef<string | null>(null);
  const gitRepositoriesRequestRef = useRef(0);
  const gitOverviewRequestRef = useRef(0);
  const gitActionRequestRef = useRef(0);
  const pullRequestRef = useRef(0);
  const gitActionLockRef = useRef<WorkspaceOperationLock>({ pending: false });

  const selectedRootRef = useRef(workspaceRoot);
  selectedRootRef.current = workspaceRoot;
  selectedGitRepositoryRootRef.current = selectedGitRepositoryRoot;

  const refreshGitOverview = useCallback(
    async (
      repositoryRoot = selectedGitRepositoryRootRef.current,
    ): Promise<void> => {
      const workspaceRoot = selectedRootRef.current;
      if (!workspaceRoot || !repositoryRoot) {
        gitOverviewRequestRef.current += 1;
        gitOverviewWorkspaceRootRef.current = null;
        setGitOverview(null);
        setGitError(null);
        setGitLoading(false);
        return;
      }
      const requestId = ++gitOverviewRequestRef.current;
      setGitLoading(true);
      setGitError(null);
      try {
        const overview = await loadWorkspaceGitOverview(
          workspaceRoot,
          repositoryRoot,
        );
        if (
          requestId === gitOverviewRequestRef.current &&
          selectedRootRef.current === workspaceRoot &&
          selectedGitRepositoryRootRef.current === repositoryRoot
        ) {
          gitOverviewWorkspaceRootRef.current = workspaceRoot;
          setGitOverview(overview);
        }
      } catch (error) {
        if (
          requestId === gitOverviewRequestRef.current &&
          selectedRootRef.current === workspaceRoot &&
          selectedGitRepositoryRootRef.current === repositoryRoot
        ) {
          gitOverviewWorkspaceRootRef.current = null;
          setGitOverview(null);
          setGitError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (
          requestId === gitOverviewRequestRef.current &&
          selectedRootRef.current === workspaceRoot &&
          selectedGitRepositoryRootRef.current === repositoryRoot
        ) {
          setGitLoading(false);
        }
      }
    },
    [],
  );

  const refreshGitRepositories = useCallback(async (): Promise<
    string | null
  > => {
    const workspaceRoot = selectedRootRef.current;
    if (!workspaceRoot) {
      gitRepositoriesRequestRef.current += 1;
      gitOverviewRequestRef.current += 1;
      selectedGitRepositoryRootRef.current = null;
      setGitRepositories(null);
      setSelectedGitRepositoryRoot(null);
      gitOverviewWorkspaceRootRef.current = null;
      setGitOverview(null);
      setGitError(null);
      setGitLoading(false);
      return null;
    }
    const requestId = ++gitRepositoriesRequestRef.current;
    setGitRepositoriesLoading(true);
    setGitRepositoriesError(null);
    const rootOverview = selectedGitRepositoryRootRef.current
      ? null
      : loadWorkspaceGitOverview(workspaceRoot, workspaceRoot)
          .then((overview) => {
            if (
              requestId === gitRepositoriesRequestRef.current &&
              selectedRootRef.current === workspaceRoot &&
              !selectedGitRepositoryRootRef.current
            ) {
              selectedGitRepositoryRootRef.current = overview.repositoryRoot;
              setSelectedGitRepositoryRoot(overview.repositoryRoot);
              gitOverviewWorkspaceRootRef.current = workspaceRoot;
              setGitOverview(overview);
            }
            return overview;
          })
          .catch(() => null);
    try {
      const discovery = await loadWorkspaceGitRepositories(workspaceRoot);
      if (
        requestId !== gitRepositoriesRequestRef.current ||
        selectedRootRef.current !== workspaceRoot
      ) {
        return null;
      }
      const selectedRepository = selectWorkspaceGitRepository(
        discovery.repositories,
        selectedGitRepositoryRootRef.current,
      );
      const nextRepositoryRoot = selectedRepository?.repositoryRoot ?? null;
      const repositoryChanged =
        nextRepositoryRoot !== selectedGitRepositoryRootRef.current;
      setGitRepositories(discovery);
      selectedGitRepositoryRootRef.current = nextRepositoryRoot;
      setSelectedGitRepositoryRoot(nextRepositoryRoot);
      if (repositoryChanged) {
        gitOverviewRequestRef.current += 1;
        gitOverviewWorkspaceRootRef.current = null;
        setGitOverview(null);
        setGitLoading(false);
        setGitError(null);
        pullRequestRef.current += 1;
        setPullRequests(null);
        setPullRequestsLoading(false);
        setPullRequestsError(null);
      }
      if (!nextRepositoryRoot) {
        gitOverviewRequestRef.current += 1;
        gitOverviewWorkspaceRootRef.current = null;
        setGitOverview(null);
        setGitError(null);
        setGitLoading(false);
        return null;
      }
      if (rootOverview && nextRepositoryRoot === discovery.workspaceRoot) {
        const overview = await rootOverview;
        if (overview?.repositoryRoot === nextRepositoryRoot) {
          if (
            requestId === gitRepositoriesRequestRef.current &&
            selectedRootRef.current === workspaceRoot &&
            selectedGitRepositoryRootRef.current === nextRepositoryRoot
          ) {
            gitOverviewWorkspaceRootRef.current = workspaceRoot;
            setGitOverview(overview);
          }
          return nextRepositoryRoot;
        }
      }
      await refreshGitOverview(nextRepositoryRoot);
      return nextRepositoryRoot;
    } catch (error) {
      if (
        requestId === gitRepositoriesRequestRef.current &&
        selectedRootRef.current === workspaceRoot
      ) {
        setGitRepositoriesError(
          error instanceof Error ? error.message : String(error),
        );
      }
      return null;
    } finally {
      if (
        requestId === gitRepositoriesRequestRef.current &&
        selectedRootRef.current === workspaceRoot
      ) {
        setGitRepositoriesLoading(false);
      }
    }
  }, [refreshGitOverview]);

  useEffect(() => {
    gitRepositoriesRequestRef.current += 1;
    gitOverviewRequestRef.current += 1;
    gitActionRequestRef.current += 1;
    pullRequestRef.current += 1;
    selectedGitRepositoryRootRef.current = null;
    gitOverviewWorkspaceRootRef.current = null;
    setGitRepositories(null);
    setGitRepositoriesLoading(false);
    setGitRepositoriesError(null);
    setSelectedGitRepositoryRoot(null);
    setGitAction(null);
    setGitOverview(null);
    setGitLoading(false);
    setGitError(null);
    setPullRequests(null);
    setPullRequestsLoading(false);
    setPullRequestsError(null);
    void refreshGitRepositories();
  }, [refreshGitRepositories, workspaceRoot]);

  const refreshPullRequests = useCallback(
    async (
      repositoryRoot = selectedGitRepositoryRootRef.current,
    ): Promise<void> => {
      const workspaceRoot = selectedRootRef.current;
      if (!workspaceRoot || !repositoryRoot) return;
      const requestId = ++pullRequestRef.current;
      setPullRequestsLoading(true);
      setPullRequestsError(null);
      try {
        const overview = await loadWorkspacePullRequests(
          workspaceRoot,
          repositoryRoot,
        );
        if (
          requestId === pullRequestRef.current &&
          selectedRootRef.current === workspaceRoot &&
          selectedGitRepositoryRootRef.current === repositoryRoot
        ) {
          setPullRequests(overview);
        }
      } catch (error) {
        if (
          requestId === pullRequestRef.current &&
          selectedRootRef.current === workspaceRoot &&
          selectedGitRepositoryRootRef.current === repositoryRoot
        ) {
          setPullRequests(null);
          setPullRequestsError(
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        if (
          requestId === pullRequestRef.current &&
          selectedRootRef.current === workspaceRoot &&
          selectedGitRepositoryRootRef.current === repositoryRoot
        ) {
          setPullRequestsLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (
      gitSection === "pull-requests" &&
      gitOverview &&
      !pullRequests &&
      !pullRequestsLoading &&
      !pullRequestsError
    ) {
      void refreshPullRequests();
    }
  }, [
    gitOverview,
    gitSection,
    pullRequests,
    pullRequestsError,
    pullRequestsLoading,
    refreshPullRequests,
  ]);

  const runGitAction = async (
    action: WorkspaceGitAction,
    options: {
      branchName?: string;
      remoteName?: string;
      remoteUrl?: string;
    } = {},
  ): Promise<void> => {
    const repositoryRoot = selectedGitRepositoryRootRef.current;
    if (
      !workspaceRoot ||
      !repositoryRoot ||
      gitOverviewWorkspaceRootRef.current !== workspaceRoot ||
      gitOverview?.repositoryRoot !== repositoryRoot ||
      gitActionLockRef.current.pending
    )
      return;
    const operation = startExclusiveWorkspaceOperation(
      gitActionLockRef.current,
      async () => {
        const changesFiles = workspaceGitActionChangesFiles(action);
        if (
          changesFiles &&
          workspaceToolsDirty &&
          !window.confirm(
            "Run this Git action with unsaved changes? Your draft will be kept.",
          )
        ) {
          return;
        }
        const actionWorkspaceRoot = workspaceRoot;
        const actionRequestId = ++gitActionRequestRef.current;
        gitOverviewRequestRef.current += 1;
        setGitAction(action);
        setGitError(null);
        try {
          const overview = await runWorkspaceGitAction(
            actionWorkspaceRoot,
            repositoryRoot,
            action,
            options,
          );
          if (
            actionRequestId === gitActionRequestRef.current &&
            selectedRootRef.current === actionWorkspaceRoot &&
            selectedGitRepositoryRootRef.current === repositoryRoot
          ) {
            gitOverviewRequestRef.current += 1;
            gitOverviewWorkspaceRootRef.current = actionWorkspaceRoot;
            setGitOverview(overview);
            if (changesFiles) {
              onFilesChanged();
            }
            setBranchName("");
            setRemoteName("");
            setRemoteUrl("");
            if (
              action === "fetch" ||
              action === "pull" ||
              action === "add-remote" ||
              action === "remove-remote"
            ) {
              pullRequestRef.current += 1;
              setPullRequests(null);
              setPullRequestsLoading(false);
              setPullRequestsError(null);
            }
          }
        } catch (error) {
          if (
            actionRequestId === gitActionRequestRef.current &&
            selectedRootRef.current === actionWorkspaceRoot &&
            selectedGitRepositoryRootRef.current === repositoryRoot
          ) {
            setGitError(error instanceof Error ? error.message : String(error));
          }
        } finally {
          if (
            actionRequestId === gitActionRequestRef.current &&
            selectedRootRef.current === actionWorkspaceRoot &&
            selectedGitRepositoryRootRef.current === repositoryRoot
          ) {
            setGitAction(null);
          }
        }
      },
    );
    if (operation) await operation;
  };

  const selectedGitRepository = selectWorkspaceGitRepository(
    gitRepositories?.repositories ?? [],
    selectedGitRepositoryRoot,
  );
  const selectedGitOverview = workspaceGitOverviewForSelection(
    gitOverview,
    gitOverviewWorkspaceRootRef.current,
    workspaceRoot,
    selectedGitRepositoryRoot,
  );
  const gitBusy = gitRepositoriesLoading || gitLoading;
  const gitDiscoveryNotice = gitRepositories?.scanLimited
    ? "Repository scan limit reached. Some repositories may be missing."
    : (gitRepositories?.issues[0] ?? null);

  const selectGitRepository = (repositoryRoot: string): void => {
    if (repositoryRoot === selectedGitRepositoryRootRef.current) return;
    gitOverviewRequestRef.current += 1;
    pullRequestRef.current += 1;
    selectedGitRepositoryRootRef.current = repositoryRoot;
    setSelectedGitRepositoryRoot(repositoryRoot);
    gitOverviewWorkspaceRootRef.current = null;
    setGitOverview(null);
    setGitLoading(false);
    setGitError(null);
    setPullRequests(null);
    setPullRequestsLoading(false);
    setPullRequestsError(null);
    setBranchName("");
    setRemoteName("");
    setRemoteUrl("");
    void refreshGitOverview(repositoryRoot);
  };

  const refreshGit = async (): Promise<void> => {
    const repositoryRoot = await refreshGitRepositories();
    if (gitSection === "pull-requests" && repositoryRoot) {
      await refreshPullRequests(repositoryRoot);
    }
  };

  const removeRemote = (name: string): void => {
    if (!window.confirm(`Remove Git remote ${name}?`)) return;
    void runGitAction("remove-remote", { remoteName: name });
  };

  return {
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
    refreshGitOverview,
    refreshGit,
    refreshPullRequests,
    runGitAction,
    selectGitRepository,
    removeRemote,
  };
}
export type WorkspaceGitControls = ReturnType<typeof useWorkspaceGit>;
