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
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import { MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH } from "../../../core/instruction-system/limits.js";
import { hasUnpairedUtf16Surrogate } from "../../../shared/unicode.js";
import {
  instructionTagKey,
  instructionTagRuleMatches,
} from "../../../core/instruction-system/tag-rules.js";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { Input } from "../components/ui/input";
import { SearchField } from "../components/ui/search-field";
import { getDefaultCommandShortcut } from "../commands/command-defaults";
import { useOptionalRegisterCommands } from "../commands/command-context";
import {
  asPaletteCommands,
  type CommandDefinition,
  type CommandPageItem,
} from "../commands/command-types";
import { cn } from "../lib/utils";
import {
  loadWorkspaceGitOverview,
  loadWorkspaceGitRepositories,
  loadWorkspacePullRequests,
  openExternalUrl,
  runWorkspaceGitAction,
  type InstructionMutationInput,
  type InstructionProfileView,
  type InstructionWorkspaceView,
  type WorkspaceGitAction,
  type WorkspaceGitOverview,
  type WorkspaceGitRepositoryDiscovery,
  type WorkspacePullRequestOverview,
} from "../runtime";
import type { InstructionManagementControls } from "../instruction-management/types";
import { hasAsciiControlCharacter } from "../instruction-management/instruction-form";
import { TagEditor } from "../instruction-management/tag-editor";
import {
  createManagedWorkspaceViews,
  createWorkspaceRootKey,
  getManagedWorkspaceName,
  getManagedWorkspaceTags,
} from "./workspace-management-model";
import { WorkspaceGitStatus } from "./workspace-git-status";
import type { WorkspaceManagementControls } from "./types";
import {
  selectWorkspaceGitRepository,
  workspaceGitActionChangesFiles,
  workspaceGitOverviewForSelection,
  workspaceGitRepositoryLabel,
} from "./workspace-git-model";
import {
  startExclusiveWorkspaceOperation,
  type WorkspaceOperationLock,
} from "./workspace-operation-lock";
import { WorkspaceTools } from "./workspace-tools";

type GitSection = "status" | "branches" | "remotes" | "pull-requests";

const profileIsEnabled = (profile: InstructionProfileView): boolean =>
  profile.enabled;

const profileIsAutomaticForWorkspace = (
  profile: InstructionProfileView,
  workspace: InstructionWorkspaceView | null,
): boolean =>
  workspace !== null &&
  profile.match !== undefined &&
  instructionTagRuleMatches(profile.match, workspace.tags);

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

export const WorkspaceManager = ({
  setup,
  workspaceSetup,
  activeWorkspaceRoot,
  onDirtyChange,
}: {
  setup: InstructionManagementControls;
  workspaceSetup: WorkspaceManagementControls;
  activeWorkspaceRoot: string | null;
  onDirtyChange?: (dirty: boolean) => void;
}): JSX.Element => {
  const registry = setup.registry;
  const workspaces = useMemo(
    () =>
      createManagedWorkspaceViews(
        workspaceSetup.workspaceRoots,
        registry?.workspaces ?? [],
      ),
    [registry?.workspaces, workspaceSetup.workspaceRoots],
  );
  const profiles = registry?.profiles ?? [];
  const [query, setQuery] = useState("");
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<
    string | null
  >(null);
  const [displayName, setDisplayName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraftPending, setTagDraftPending] = useState(false);
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
  const [workspaceToolsDirty, setWorkspaceToolsDirty] = useState(false);
  const [workspaceToolsRefreshToken, setWorkspaceToolsRefreshToken] =
    useState(0);
  const displayNameErrorId = useId();
  const pendingTagMessageId = useId();
  const selectedRootRef = useRef<string | null>(null);
  const selectedGitRepositoryRootRef = useRef<string | null>(null);
  const gitOverviewWorkspaceRootRef = useRef<string | null>(null);
  const gitRepositoriesRequestRef = useRef(0);
  const gitOverviewRequestRef = useRef(0);
  const gitActionRequestRef = useRef(0);
  const pullRequestRef = useRef(0);
  const gitActionLockRef = useRef<WorkspaceOperationLock>({ pending: false });
  const hydratedWorkspaceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    void setup.onRefresh();
  }, [setup.onRefresh]);

  useEffect(() => {
    if (
      selectedWorkspaceKey &&
      workspaces.some((workspace) => workspace.key === selectedWorkspaceKey)
    ) {
      return;
    }
    const active = workspaces.find(
      (workspace) =>
        activeWorkspaceRoot &&
        workspace.key === createWorkspaceRootKey(activeWorkspaceRoot),
    );
    setSelectedWorkspaceKey(active?.key ?? workspaces[0]?.key ?? null);
  }, [activeWorkspaceRoot, selectedWorkspaceKey, workspaces]);

  const selectedWorkspace =
    workspaces.find((workspace) => workspace.key === selectedWorkspaceKey) ??
    null;
  const selectedInstructionWorkspace =
    selectedWorkspace?.instructionWorkspace ?? null;
  const savedDisplayName = selectedWorkspace
    ? (selectedInstructionWorkspace?.displayName ??
      getManagedWorkspaceName(selectedWorkspace))
    : "";
  const savedTags = selectedWorkspace
    ? getManagedWorkspaceTags(selectedWorkspace)
    : [];
  const normalizedSavedDisplayName = savedDisplayName.trim().normalize("NFKC");
  const selectedWorkspaceFormSnapshotRef = useRef<{
    key: string;
    displayName: string;
    tags: string[];
  } | null>(null);
  selectedWorkspaceFormSnapshotRef.current = selectedWorkspace
    ? {
        key: selectedWorkspace.key,
        displayName: savedDisplayName,
        tags: [...savedTags],
      }
    : null;
  const normalizedDisplayName = displayName.trim().normalize("NFKC");
  const displayNameError = !normalizedDisplayName
    ? "Enter a name."
    : Array.from(normalizedDisplayName).length >
        MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH
      ? `Name cannot exceed ${MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH} characters.`
      : hasAsciiControlCharacter(normalizedDisplayName)
        ? "Name cannot contain control characters."
        : hasUnpairedUtf16Surrogate(normalizedDisplayName)
          ? "Name must contain valid Unicode text."
          : null;
  const workspaceSettingsDirty = Boolean(
    selectedWorkspace &&
    hydratedWorkspaceKeyRef.current === selectedWorkspace.key &&
    (tagDraftPending ||
      normalizedDisplayName !== normalizedSavedDisplayName ||
      !sameStrings(tags, savedTags)),
  );
  const workspaceDraftDirty = workspaceSettingsDirty || workspaceToolsDirty;

  useEffect(() => {
    onDirtyChange?.(workspaceDraftDirty);
  }, [onDirtyChange, workspaceDraftDirty]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  selectedRootRef.current = selectedWorkspace?.root ?? null;
  selectedGitRepositoryRootRef.current = selectedGitRepositoryRoot;

  useEffect(() => {
    const snapshot = selectedWorkspaceFormSnapshotRef.current;
    hydratedWorkspaceKeyRef.current = snapshot?.key ?? null;
    setDisplayName(snapshot?.displayName ?? "");
    setTags(snapshot?.tags ?? []);
    setTagDraftPending(false);
  }, [registry?.revision, selectedWorkspace?.key]);

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
  }, [refreshGitRepositories, selectedWorkspace?.root]);

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

  const mutate = async (input: InstructionMutationInput): Promise<boolean> =>
    (await setup.onSave(input)) !== false;

  const chooseDirectory = async (): Promise<string | null> => {
    const result = await open({ directory: true, multiple: false });
    return typeof result === "string" ? result : null;
  };

  const addWorkspace = async (root?: string): Promise<void> => {
    const selectedRoot = root ?? (await chooseDirectory());
    if (!selectedRoot) return;
    workspaceSetup.onAdd(selectedRoot);
  };

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
      !selectedWorkspace ||
      !repositoryRoot ||
      gitOverviewWorkspaceRootRef.current !== selectedWorkspace.root ||
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
        const workspaceRoot = selectedWorkspace.root;
        const actionRequestId = ++gitActionRequestRef.current;
        gitOverviewRequestRef.current += 1;
        setGitAction(action);
        setGitError(null);
        try {
          const overview = await runWorkspaceGitAction(
            workspaceRoot,
            repositoryRoot,
            action,
            options,
          );
          if (
            actionRequestId === gitActionRequestRef.current &&
            selectedRootRef.current === workspaceRoot &&
            selectedGitRepositoryRootRef.current === repositoryRoot
          ) {
            gitOverviewRequestRef.current += 1;
            gitOverviewWorkspaceRootRef.current = workspaceRoot;
            setGitOverview(overview);
            if (changesFiles) {
              setWorkspaceToolsRefreshToken((current) => current + 1);
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
            selectedRootRef.current === workspaceRoot &&
            selectedGitRepositoryRootRef.current === repositoryRoot
          ) {
            setGitError(error instanceof Error ? error.message : String(error));
          }
        } finally {
          if (
            actionRequestId === gitActionRequestRef.current &&
            selectedRootRef.current === workspaceRoot &&
            selectedGitRepositoryRootRef.current === repositoryRoot
          ) {
            setGitAction(null);
          }
        }
      },
    );
    if (operation) await operation;
  };

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredWorkspaces = useMemo(
    () =>
      workspaces.filter((workspace) =>
        !normalizedQuery
          ? true
          : [
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
  const activeWorkspaceConfigured = workspaces.some(
    (workspace) =>
      activeWorkspaceRoot &&
      workspace.key === createWorkspaceRootKey(activeWorkspaceRoot),
  );
  const instructionLibraryError =
    registry?.libraryError ??
    (registry?.recovery?.primaryValid === false
      ? (registry.recovery.errorMessage ?? "Instruction library unavailable.")
      : null);
  const instructionLibraryAvailable =
    registry !== null && instructionLibraryError === null;
  const effectiveInstructionProfileCount = profiles.filter((profile) => {
    if (!profileIsEnabled(profile)) {
      return false;
    }

    const rootProfiles =
      selectedInstructionWorkspace?.scopes.find((scope) => scope.path === ".")
        ?.profiles ?? [];
    return (
      profile.global ||
      rootProfiles.includes(profile.id) ||
      profileIsAutomaticForWorkspace(profile, selectedInstructionWorkspace)
    );
  }).length;
  const selectedGitRepository = selectWorkspaceGitRepository(
    gitRepositories?.repositories ?? [],
    selectedGitRepositoryRoot,
  );
  const selectedGitOverview = workspaceGitOverviewForSelection(
    gitOverview,
    gitOverviewWorkspaceRootRef.current,
    selectedWorkspace?.root ?? null,
    selectedGitRepositoryRoot,
  );
  const gitBusy = gitRepositoriesLoading || gitLoading;
  const gitDiscoveryNotice = gitRepositories?.scanLimited
    ? "Repository scan limit reached. Some repositories may be missing."
    : (gitRepositories?.issues[0] ?? null);

  const confirmDiscardWorkspaceDraft = (action: string): boolean =>
    !workspaceDraftDirty ||
    window.confirm(`Discard unsaved changes and ${action}?`);

  const selectWorkspace = (workspaceKey: string): void => {
    if (
      workspaceKey !== selectedWorkspaceKey &&
      !confirmDiscardWorkspaceDraft("switch workspaces")
    ) {
      return;
    }
    setWorkspaceToolsDirty(false);
    setTagDraftPending(false);
    setSelectedWorkspaceKey(workspaceKey);
  };

  const refreshWorkspaces = (): void => {
    if (setup.saving) return;
    if (
      workspaceSettingsDirty &&
      !window.confirm("Discard unsaved workspace settings and refresh?")
    )
      return;
    setDisplayName(savedDisplayName);
    setTags([...savedTags]);
    setTagDraftPending(false);
    void setup.onRefresh();
  };

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

  const refreshWorkspaceState = useCallback((): void => {
    void refreshGitOverview();
  }, [refreshGitOverview]);

  const saveWorkspaceSettings = (): void => {
    if (
      !registry ||
      !selectedWorkspace ||
      !instructionLibraryAvailable ||
      setup.saving ||
      !workspaceSettingsDirty ||
      tagDraftPending ||
      displayNameError
    )
      return;
    void mutate({
      operation: "workspace-configure",
      root: selectedWorkspace.root,
      displayName,
      tags,
      expectedRevision: registry.revision,
    });
  };

  const relinkWorkspace = async (): Promise<void> => {
    if (
      !selectedWorkspace ||
      setup.saving ||
      workspaceSetup.loading ||
      !instructionLibraryAvailable ||
      !confirmDiscardWorkspaceDraft("relink this workspace")
    )
      return;
    const root = await chooseDirectory();
    if (!root) return;
    if (selectedInstructionWorkspace && registry) {
      const saved = await mutate({
        operation: "workspace-relink",
        workspaceId: selectedInstructionWorkspace.id,
        root,
        expectedRevision: registry.revision,
      });
      if (!saved) return;
    } else {
      await workspaceSetup.onRelink(selectedWorkspace.root, root);
    }
    setWorkspaceToolsDirty(false);
    setTagDraftPending(false);
  };

  const removeWorkspace = async (): Promise<void> => {
    if (
      !selectedWorkspace ||
      setup.saving ||
      workspaceSetup.loading ||
      !instructionLibraryAvailable
    )
      return;
    const hasAssignments =
      selectedInstructionWorkspace?.scopes.some(
        (scope) => scope.profiles.length > 0,
      ) ?? false;
    if (
      !window.confirm(
        hasAssignments && workspaceDraftDirty
          ? "Remove this workspace from Machdoch? Unsaved changes and manual instruction assignments will be discarded. Files on disk will not be deleted."
          : hasAssignments
            ? "Remove this workspace and its manual instruction assignments from Machdoch? Files on disk will not be deleted."
            : workspaceDraftDirty
              ? "Remove this workspace from Machdoch? Unsaved changes will be discarded. Files on disk will not be deleted."
              : "Remove this workspace from Machdoch? Files on disk will not be deleted.",
      )
    )
      return;
    if (selectedInstructionWorkspace && registry) {
      const saved = await mutate({
        operation: "workspace-remove",
        workspaceId: selectedInstructionWorkspace.id,
        confirmAssignedRemoval: hasAssignments,
        expectedRevision: registry.revision,
      });
      if (!saved) return;
    }
    setWorkspaceToolsDirty(false);
    setTagDraftPending(false);
    await workspaceSetup.onRemove(selectedWorkspace.root);
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

  const setRootProfileAssignment = (
    profileId: string,
    assigned: boolean,
  ): void => {
    if (
      !registry ||
      !selectedWorkspace ||
      setup.saving ||
      workspaceSettingsDirty ||
      !instructionLibraryAvailable
    )
      return;
    const current =
      selectedInstructionWorkspace?.scopes.find((scope) => scope.path === ".")
        ?.profiles ?? [];
    void mutate({
      operation: "workspace-configure",
      root: selectedWorkspace.root,
      displayName,
      tags,
      profileIds: assigned
        ? [...new Set([...current, profileId])]
        : current.filter((id) => id !== profileId),
      expectedRevision: registry.revision,
    });
  };

  const removeScopedProfileAssignment = (
    profileId: string,
    path: string,
    profileIds: readonly string[],
  ): void => {
    if (
      !registry ||
      !selectedInstructionWorkspace ||
      setup.saving ||
      workspaceSettingsDirty ||
      !instructionLibraryAvailable
    )
      return;
    void mutate({
      operation: "workspace-scope-set",
      workspaceId: selectedInstructionWorkspace.id,
      path,
      profileIds: profileIds.filter((id) => id !== profileId),
      expectedRevision: registry.revision,
    });
  };

  const workspaceCommandStateRef = useRef({
    setup,
    workspaceSetup,
    activeWorkspaceRoot,
    activeWorkspaceConfigured,
    workspaces,
    profiles,
    selectedWorkspaceKey,
    selectedWorkspace,
    selectedInstructionWorkspace,
    selectedGitRepositoryRoot,
    selectedGitOverview,
    gitRepositories,
    gitSection,
    gitBusy,
    gitAction,
    pullRequests,
    branchName,
    remoteName,
    remoteUrl,
    workspaceSettingsDirty,
    workspaceDraftDirty,
    instructionLibraryAvailable,
    tagDraftPending,
    displayNameError,
    addWorkspace,
    selectWorkspace,
    refreshWorkspaces,
    saveWorkspaceSettings,
    relinkWorkspace,
    removeWorkspace,
    selectGitRepository,
    refreshGit,
    setGitSection,
    runGitAction,
    refreshPullRequests,
    removeRemote,
    setRootProfileAssignment,
    removeScopedProfileAssignment,
  });
  workspaceCommandStateRef.current = {
    setup,
    workspaceSetup,
    activeWorkspaceRoot,
    activeWorkspaceConfigured,
    workspaces,
    profiles,
    selectedWorkspaceKey,
    selectedWorkspace,
    selectedInstructionWorkspace,
    selectedGitRepositoryRoot,
    selectedGitOverview,
    gitRepositories,
    gitSection,
    gitBusy,
    gitAction,
    pullRequests,
    branchName,
    remoteName,
    remoteUrl,
    workspaceSettingsDirty,
    workspaceDraftDirty,
    instructionLibraryAvailable,
    tagDraftPending,
    displayNameError,
    addWorkspace,
    selectWorkspace,
    refreshWorkspaces,
    saveWorkspaceSettings,
    relinkWorkspace,
    removeWorkspace,
    selectGitRepository,
    refreshGit,
    setGitSection,
    runGitAction,
    refreshPullRequests,
    removeRemote,
    setRootProfileAssignment,
    removeScopedProfileAssignment,
  };

  const workspaceCommands = useMemo<readonly CommandDefinition[]>(() => {
    const scope = {
      kind: "view" as const,
      ownerId: "workspaces",
      viewId: "workspaces",
    };
    const state = () => workspaceCommandStateRef.current;
    const numericKey = (index: number): CommandPageItem["numericKey"] =>
      index < 9 ? (`${index + 1}` as CommandPageItem["numericKey"]) : undefined;
    const selectedAvailability = () =>
      state().selectedWorkspace
        ? { state: "enabled" as const }
        : { state: "hidden" as const };
    const gitAvailability = () => {
      const current = state();
      if (!current.selectedWorkspace) return { state: "hidden" as const };
      return current.gitBusy ||
        current.gitAction ||
        !current.selectedGitOverview
        ? { state: "disabled" as const, reason: "Git is unavailable or busy." }
        : { state: "enabled" as const };
    };
    return asPaletteCommands([
      {
        id: "workspaces.add",
        title: "Add workspace",
        group: "Workspaces",
        scope,
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("workspaces.add"),
            runtimes: ["tauri"],
            allowIn: [
              "document",
              "text-entry",
              "interactive-control",
              "command-surface",
            ],
          },
        ],
        availability: () =>
          state().setup.saving || state().workspaceSetup.loading
            ? { state: "disabled", reason: "Workspaces are busy." }
            : { state: "enabled" },
        execute: () => void state().addWorkspace(),
      },
      {
        id: "workspaces.add-current",
        title: "Add current workspace",
        group: "Workspaces",
        scope,
        availability: () =>
          !state().activeWorkspaceRoot || state().activeWorkspaceConfigured
            ? { state: "hidden" }
            : state().setup.saving || state().workspaceSetup.loading
              ? { state: "disabled", reason: "Workspaces are busy." }
              : { state: "enabled" },
        execute: () => {
          const root = state().activeWorkspaceRoot;
          if (root) void state().addWorkspace(root);
        },
      },
      {
        id: "workspaces.select",
        title: "Select workspace",
        group: "Workspaces",
        scope,
        availability: () =>
          state().workspaces.length
            ? { state: "enabled" }
            : { state: "disabled", reason: "No configured workspaces." },
        children: () => ({
          id: "workspaces.select.page",
          title: "Select workspace",
          searchPlaceholder: "Search workspaces",
          numericSelection: true,
          groups: [
            {
              id: "workspaces",
              items: state().workspaces.map((workspace, index) => ({
                id: workspace.key,
                title: getManagedWorkspaceName(workspace),
                keywords: [
                  workspace.root,
                  ...getManagedWorkspaceTags(workspace),
                ],
                current: state().selectedWorkspaceKey === workspace.key,
                numericKey: numericKey(index),
                execute: () => state().selectWorkspace(workspace.key),
              })),
            },
          ],
        }),
      },
      {
        id: "workspaces.refresh",
        title: "Refresh workspaces",
        group: "Workspaces",
        scope,
        availability: () =>
          state().setup.loading || state().setup.saving
            ? { state: "disabled", reason: "Workspaces are busy." }
            : { state: "enabled" },
        execute: () => state().refreshWorkspaces(),
      },
      {
        id: "workspaces.settings.save",
        title: "Save workspace settings",
        group: "Workspaces",
        scope,
        shortcuts: [
          {
            chord: getDefaultCommandShortcut("workspaces.settings.save"),
            runtimes: ["tauri"],
            allowIn: [
              "document",
              "text-entry",
              "interactive-control",
              "command-surface",
            ],
          },
        ],
        availability: () => {
          const current = state();
          if (!current.selectedWorkspace) return { state: "hidden" };
          if (!current.instructionLibraryAvailable)
            return {
              state: "disabled",
              reason: "Instruction library is unavailable.",
            };
          if (current.tagDraftPending)
            return {
              state: "disabled",
              reason: "Finish editing the pending tag.",
            };
          if (current.displayNameError)
            return { state: "disabled", reason: current.displayNameError };
          return current.workspaceSettingsDirty
            ? { state: "enabled" }
            : { state: "disabled", reason: "No workspace settings to save." };
        },
        execute: () => state().saveWorkspaceSettings(),
      },
      {
        id: "workspaces.relink",
        title: "Relink workspace",
        group: "Workspaces",
        scope,
        availability: () => {
          const available = selectedAvailability();
          if (available.state !== "enabled") return available;
          return state().setup.saving ||
            state().workspaceSetup.loading ||
            !state().instructionLibraryAvailable
            ? { state: "disabled", reason: "Workspace cannot be relinked now." }
            : available;
        },
        execute: () => void state().relinkWorkspace(),
      },
      {
        id: "workspaces.remove",
        title: "Remove workspace",
        group: "Workspaces",
        scope,
        availability: () => {
          const available = selectedAvailability();
          if (available.state !== "enabled") return available;
          return state().setup.saving ||
            state().workspaceSetup.loading ||
            !state().instructionLibraryAvailable
            ? { state: "disabled", reason: "Workspace cannot be removed now." }
            : available;
        },
        execute: () => void state().removeWorkspace(),
      },
      {
        id: "workspaces.git.repository.select",
        title: "Choose Git repository",
        group: "Workspace Git",
        scope,
        availability: () =>
          (state().gitRepositories?.repositories.length ?? 0) > 0
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "workspaces.git.repository.select.page",
          title: "Choose Git repository",
          searchPlaceholder: "Search repositories",
          groups: [
            {
              id: "repositories",
              items: (state().gitRepositories?.repositories ?? []).map(
                (repository) => ({
                  id: repository.repositoryRoot,
                  title: workspaceGitRepositoryLabel(repository),
                  keywords: [repository.repositoryRoot],
                  current:
                    state().selectedGitRepositoryRoot ===
                    repository.repositoryRoot,
                  availability:
                    state().gitBusy || state().gitAction
                      ? { state: "disabled", reason: "Git is busy." }
                      : { state: "enabled" },
                  execute: () =>
                    state().selectGitRepository(repository.repositoryRoot),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "workspaces.git.section.select",
        title: "Choose Git view",
        group: "Workspace Git",
        scope,
        availability: selectedAvailability,
        children: () => ({
          id: "workspaces.git.section.select.page",
          title: "Choose Git view",
          searchPlaceholder: "Search Git views",
          numericSelection: true,
          groups: [
            {
              id: "views",
              items: (
                [
                  ["status", "Status"],
                  ["branches", "Branches"],
                  ["remotes", "Remotes"],
                  ["pull-requests", "Pull requests"],
                ] as const
              ).map(([value, title], index) => ({
                id: value,
                title,
                current: state().gitSection === value,
                numericKey: numericKey(index),
                execute: () => state().setGitSection(value),
              })),
            },
          ],
        }),
      },
      {
        id: "workspaces.git.refresh",
        title: "Refresh Git",
        group: "Workspace Git",
        scope,
        availability: () =>
          !state().selectedWorkspace
            ? { state: "hidden" }
            : state().gitBusy || state().gitAction
              ? { state: "disabled", reason: "Git is busy." }
              : { state: "enabled" },
        execute: () => void state().refreshGit(),
      },
      {
        id: "workspaces.git.fetch",
        title: "Fetch Git repository",
        group: "Workspace Git",
        scope,
        availability: gitAvailability,
        execute: () => void state().runGitAction("fetch"),
      },
      {
        id: "workspaces.git.pull",
        title: "Pull Git repository",
        group: "Workspace Git",
        scope,
        availability: () => {
          const available = gitAvailability();
          if (available.state !== "enabled") return available;
          return state().selectedGitOverview?.upstream
            ? available
            : { state: "disabled", reason: "No upstream branch." };
        },
        execute: () => void state().runGitAction("pull"),
      },
      {
        id: "workspaces.git.branch.create",
        title: "Create Git branch",
        group: "Workspace Git",
        scope,
        availability: () => {
          const available = gitAvailability();
          if (available.state !== "enabled") return available;
          return state().branchName.trim()
            ? available
            : { state: "disabled", reason: "Enter a branch name first." };
        },
        execute: () =>
          void state().runGitAction("create-branch", {
            branchName: state().branchName,
          }),
      },
      {
        id: "workspaces.git.branch.switch",
        title: "Switch Git branch",
        group: "Workspace Git",
        scope,
        availability: gitAvailability,
        children: () => ({
          id: "workspaces.git.branch.switch.page",
          title: "Switch Git branch",
          searchPlaceholder: "Search branches",
          groups: [
            {
              id: "local",
              label: "Local",
              items: (state().selectedGitOverview?.localBranches ?? []).map(
                (branch) => ({
                  id: branch.name,
                  title: branch.name,
                  current: branch.current,
                  availability: branch.current
                    ? { state: "disabled", reason: "Current branch." }
                    : { state: "enabled" },
                  execute: () =>
                    void state().runGitAction("checkout", {
                      branchName: branch.name,
                    }),
                }),
              ),
            },
            {
              id: "remote",
              label: "Remote",
              items: (state().selectedGitOverview?.remoteBranches ?? []).map(
                (branch) => ({
                  id: branch.name,
                  title: branch.name,
                  execute: () =>
                    void state().runGitAction("checkout-remote", {
                      branchName: branch.name,
                    }),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "workspaces.git.remote.add",
        title: "Add Git remote",
        group: "Workspace Git",
        scope,
        availability: () => {
          const available = gitAvailability();
          if (available.state !== "enabled") return available;
          return state().remoteName.trim() && state().remoteUrl.trim()
            ? available
            : {
                state: "disabled",
                reason: "Enter a remote name and URL first.",
              };
        },
        execute: () =>
          void state().runGitAction("add-remote", {
            remoteName: state().remoteName,
            remoteUrl: state().remoteUrl,
          }),
      },
      {
        id: "workspaces.git.remote.remove",
        title: "Remove Git remote",
        group: "Workspace Git",
        scope,
        availability: gitAvailability,
        children: () => ({
          id: "workspaces.git.remote.remove.page",
          title: "Remove Git remote",
          searchPlaceholder: "Search remotes",
          groups: [
            {
              id: "remotes",
              items: (state().selectedGitOverview?.remotes ?? []).map(
                (remote) => ({
                  id: remote.name,
                  title: remote.name,
                  keywords: [remote.fetchUrl ?? "", remote.pushUrl ?? ""],
                  execute: () => state().removeRemote(remote.name),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "workspaces.git.pull-request.open",
        title: "Open pull request",
        group: "Workspace Git",
        scope,
        availability: () =>
          (state().pullRequests?.items.length ?? 0) > 0
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "workspaces.git.pull-request.open.page",
          title: "Open pull request",
          searchPlaceholder: "Search pull requests",
          groups: [
            {
              id: "pull-requests",
              items: (state().pullRequests?.items ?? []).map((pullRequest) => ({
                id: `${pullRequest.number}`,
                title: `#${pullRequest.number} ${pullRequest.title}`,
                keywords: [pullRequest.headBranch, pullRequest.baseBranch],
                execute: () => void openExternalUrl(pullRequest.url),
              })),
            },
          ],
        }),
      },
      {
        id: "workspaces.instructions.assign",
        title: "Configure instruction assignments",
        group: "Workspaces",
        scope,
        availability: () =>
          !state().selectedWorkspace || !state().instructionLibraryAvailable
            ? { state: "hidden" }
            : state().workspaceSettingsDirty || state().setup.saving
              ? { state: "disabled", reason: "Save workspace settings first." }
              : { state: "enabled" },
        children: () => ({
          id: "workspaces.instructions.assign.page",
          title: "Configure instruction assignments",
          searchPlaceholder: "Search instruction files",
          groups: [
            {
              id: "root",
              label: "Workspace root",
              items: state().profiles.map((profile) => {
                const rootAssigned =
                  state()
                    .selectedInstructionWorkspace?.scopes.find(
                      (candidate) => candidate.path === ".",
                    )
                    ?.profiles.includes(profile.id) ?? false;
                const readOnly = profile.global || profile.match !== undefined;
                return {
                  id: profile.id,
                  title: profile.name,
                  keywords: [profile.description ?? ""],
                  current:
                    profile.global ||
                    profileIsAutomaticForWorkspace(
                      profile,
                      state().selectedInstructionWorkspace,
                    ) ||
                    rootAssigned,
                  availability: readOnly
                    ? {
                        state: "disabled",
                        reason: "This assignment is automatic.",
                      }
                    : !profileIsEnabled(profile) && !rootAssigned
                      ? {
                          state: "disabled",
                          reason: "Instruction file is disabled.",
                        }
                      : { state: "enabled" },
                  execute: () =>
                    state().setRootProfileAssignment(profile.id, !rootAssigned),
                };
              }),
            },
            {
              id: "scoped",
              label: "Nested scopes",
              items: (state().selectedInstructionWorkspace?.scopes ?? [])
                .filter((candidate) => candidate.path !== ".")
                .flatMap((candidate) =>
                  candidate.profiles.map((profileId) => {
                    const profile = state().profiles.find(
                      (item) => item.id === profileId,
                    );
                    return {
                      id: `${candidate.path}:${profileId}`,
                      title: profile
                        ? `${profile.name} — ${candidate.path}`
                        : candidate.path,
                      keywords: [candidate.path, profile?.name ?? ""],
                      execute: () =>
                        state().removeScopedProfileAssignment(
                          profileId,
                          candidate.path,
                          candidate.profiles,
                        ),
                    };
                  }),
                ),
            },
          ],
        }),
      },
    ]);
  }, []);
  useOptionalRegisterCommands(workspaceCommands);

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
          {activeWorkspaceRoot && !activeWorkspaceConfigured ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={setup.saving || workspaceSetup.loading}
              onClick={() => void addWorkspace(activeWorkspaceRoot)}
            >
              <FolderPlus className="size-4" />
              Add current
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={setup.saving || workspaceSetup.loading}
            onClick={() => void addWorkspace()}
          >
            <Plus className="size-4" />
            Workspace
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={setup.loading || setup.saving}
            aria-label="Refresh workspaces"
            onClick={refreshWorkspaces}
          >
            <RefreshCw
              className={cn("size-4", setup.loading && "animate-spin")}
            />
          </Button>
        </div>
      </header>

      {setup.message ? (
        <div
          role={setup.message.tone === "error" ? "alert" : "status"}
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

      <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[10rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)] xl:grid-rows-1">
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
            {workspaceSetup.loading && workspaces.length === 0 ? (
              <div className="grid h-32 place-items-center">
                <LoaderCircle className="size-5 animate-spin text-slate-500" />
              </div>
            ) : filteredWorkspaces.length === 0 ? (
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
                    disabled={workspaceSetup.loading}
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
                  const selected = workspace.key === selectedWorkspaceKey;
                  const active =
                    activeWorkspaceRoot !== null &&
                    createWorkspaceRootKey(activeWorkspaceRoot) ===
                      workspace.key;
                  return (
                    <button
                      key={workspace.key}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => selectWorkspace(workspace.key)}
                      className={cn(
                        "w-full rounded-lg border px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60",
                        selected
                          ? "border-sky-800/70 bg-sky-950/25"
                          : "border-transparent hover:border-slate-800 hover:bg-slate-900/55",
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <FolderGit2 className="size-4 shrink-0 text-slate-500" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-200">
                          {getManagedWorkspaceName(workspace)}
                        </span>
                        {active ? (
                          <CircleDot className="size-3.5 text-sky-300" />
                        ) : null}
                      </div>
                      <p className="mt-1 truncate pl-6 text-[11px] text-slate-600">
                        {workspace.root}
                      </p>
                      {getManagedWorkspaceTags(workspace).length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1 pl-6">
                          {getManagedWorkspaceTags(workspace)
                            .slice(0, 4)
                            .map((tag) => (
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
                })}
              </div>
            )}
          </div>
        </aside>

        <section className="min-h-0 min-w-0 overflow-y-auto">
          {!selectedWorkspace ? (
            <div className="grid h-full min-h-64 place-items-center p-6">
              <EmptyState icon={FolderGit2} title="Select a workspace" />
            </div>
          ) : (
            <div className="mx-auto w-full max-w-360 space-y-6 p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-slate-100">
                    {getManagedWorkspaceName(selectedWorkspace)}
                  </h2>
                  <p className="mt-1 break-all font-mono text-xs text-slate-500">
                    {selectedWorkspace.root}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      setup.saving ||
                      workspaceSetup.loading ||
                      !instructionLibraryAvailable
                    }
                    title={
                      instructionLibraryAvailable
                        ? undefined
                        : "Instruction library unavailable."
                    }
                    onClick={() => void relinkWorkspace()}
                  >
                    Relink
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={
                      setup.saving ||
                      workspaceSetup.loading ||
                      !instructionLibraryAvailable
                    }
                    title={
                      instructionLibraryAvailable
                        ? undefined
                        : "Instruction library unavailable."
                    }
                    aria-label="Remove workspace"
                    onClick={() => void removeWorkspace()}
                  >
                    <Trash2 className="size-4 text-red-300" />
                  </Button>
                </div>
              </div>

              <WorkspaceTools
                key={selectedWorkspace.key}
                workspaceRoot={selectedWorkspace.root}
                refreshToken={workspaceToolsRefreshToken}
                onDirtyChange={setWorkspaceToolsDirty}
                onWorkspaceMutation={refreshWorkspaceState}
              />

              <section className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/20 p-4 md:grid-cols-[minmax(12rem,0.65fr)_minmax(0,1.35fr)_auto] md:items-end">
                <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                  Name
                  <Input
                    value={displayName}
                    maxLength={
                      MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH * 2
                    }
                    disabled={setup.saving || !instructionLibraryAvailable}
                    aria-invalid={displayNameError !== null}
                    aria-describedby={
                      displayNameError && workspaceSettingsDirty
                        ? displayNameErrorId
                        : undefined
                    }
                    onChange={(event) => setDisplayName(event.target.value)}
                    className="h-9 border-slate-800 bg-slate-950"
                  />
                </label>
                <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                  Tags
                  <TagEditor
                    value={tags}
                    disabled={setup.saving || !instructionLibraryAvailable}
                    onChange={setTags}
                    onPendingChange={setTagDraftPending}
                  />
                </label>
                <Button
                  type="button"
                  size="sm"
                  disabled={
                    setup.saving ||
                    !instructionLibraryAvailable ||
                    !workspaceSettingsDirty ||
                    tagDraftPending ||
                    displayNameError !== null
                  }
                  aria-describedby={
                    tagDraftPending ? pendingTagMessageId : undefined
                  }
                  onClick={saveWorkspaceSettings}
                >
                  <Save className="size-4" />
                  Save
                </Button>
                {displayNameError && workspaceSettingsDirty ? (
                  <p
                    id={displayNameErrorId}
                    role="alert"
                    className="text-xs text-red-300 md:col-span-3"
                  >
                    {displayNameError}
                  </p>
                ) : null}
                {tagDraftPending ? (
                  <p
                    id={pendingTagMessageId}
                    className="text-xs text-slate-500 md:col-span-3"
                  >
                    Add or clear the pending tag before saving.
                  </p>
                ) : null}
              </section>

              <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/20">
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-3">
                  <GitBranch className="size-4 text-sky-300" />
                  <div className="min-w-0 flex-1">
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
                          variant={
                            selectedGitOverview.clean ? "outline" : "secondary"
                          }
                        >
                          {selectedGitOverview.clean
                            ? "Clean"
                            : `${selectedGitOverview.totalChanges} changed`}
                        </Badge>
                      ) : null}
                      {selectedGitOverview?.ahead ? (
                        <Badge variant="outline">
                          ↑ {selectedGitOverview.ahead}
                        </Badge>
                      ) : null}
                      {selectedGitOverview?.behind ? (
                        <Badge variant="outline">
                          ↓ {selectedGitOverview.behind}
                        </Badge>
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
                      gitBusy ||
                      gitAction !== null ||
                      selectedGitOverview === null
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
                      gitBusy ||
                      gitAction !== null ||
                      !selectedGitOverview?.upstream
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
                    <RefreshCw
                      className={cn("size-4", gitBusy && "animate-spin")}
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
                      id={`workspace-git-tab-${value}`}
                      aria-controls={`workspace-git-panel-${value}`}
                      aria-selected={gitSection === value}
                      tabIndex={gitSection === value ? 0 : -1}
                      onClick={() => setGitSection(value)}
                      onKeyDown={(event) => {
                        if (
                          !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                            event.key,
                          )
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
                                : (currentIndex - 1 + tabs.length) %
                                  tabs.length;
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
                  {gitRepositoriesLoading && !gitRepositories ? (
                    <div className="grid h-40 place-items-center">
                      <LoaderCircle className="size-5 animate-spin text-slate-500" />
                    </div>
                  ) : gitRepositoriesError && !gitRepositories ? (
                    <EmptyState
                      icon={Unplug}
                      title="Git unavailable"
                      description={gitRepositoriesError}
                    />
                  ) : gitRepositories?.repositories.length === 0 ? (
                    <EmptyState
                      icon={
                        gitRepositories.issues.length > 0 ? Unplug : FolderGit2
                      }
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
                          workspaceRoot={selectedWorkspace.root}
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
                            {selectedGitOverview.localBranches.map((branch) => (
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
                            {selectedGitOverview.remoteBranches.length === 0 ? (
                              <EmptyState
                                icon={GitBranch}
                                title="No remote branches"
                                size="compact"
                              />
                            ) : (
                              selectedGitOverview.remoteBranches.map(
                                (branch) => (
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
                                ),
                              )
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
                                  <p className="mt-1 break-all font-mono text-xs text-slate-500">
                                    {remote.fetchUrl ?? remote.pushUrl}
                                  </p>
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
                            ))}
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
                    {effectiveInstructionProfileCount} effective
                  </span>
                </div>
                {instructionLibraryError ? (
                  <p role="alert" className="text-sm text-red-300">
                    {instructionLibraryError}
                  </p>
                ) : !registry ? (
                  setup.loading ? (
                    <div className="grid h-24 place-items-center">
                      <LoaderCircle className="size-5 animate-spin text-slate-500" />
                    </div>
                  ) : (
                    <EmptyState
                      icon={FolderGit2}
                      title="Instruction library unavailable"
                      size="compact"
                    />
                  )
                ) : profiles.length === 0 ? (
                  <EmptyState
                    icon={FolderGit2}
                    title="No instruction files"
                    size="compact"
                  />
                ) : (
                  <div className="space-y-2">
                    {workspaceSettingsDirty ? (
                      <p className="text-xs text-slate-500">
                        Save workspace settings before changing assignments.
                      </p>
                    ) : null}
                    <div className="grid gap-2 md:grid-cols-2">
                      {profiles.map((profile) => {
                        const rootScope =
                          selectedInstructionWorkspace?.scopes.find(
                            (scope) => scope.path === ".",
                          ) ?? null;
                        const rootAssigned =
                          rootScope?.profiles.includes(profile.id) ?? false;
                        const scopedAssignments =
                          selectedInstructionWorkspace?.scopes.filter(
                            (scope) =>
                              scope.path !== "." &&
                              scope.profiles.includes(profile.id),
                          ) ?? [];
                        const automatic = profileIsAutomaticForWorkspace(
                          profile,
                          selectedInstructionWorkspace,
                        );
                        const active =
                          profileIsEnabled(profile) &&
                          (profile.global || automatic || rootAssigned);
                        const state = !profileIsEnabled(profile)
                          ? `${profile.match !== undefined ? "Tag match" : "Manual"} · Disabled`
                          : profile.global
                            ? "Always applied"
                            : profile.match !== undefined
                              ? automatic
                                ? "Tag match"
                                : "No tag match"
                              : rootAssigned
                                ? "Manual"
                                : scopedAssignments.length > 0
                                  ? `${scopedAssignments.length} scoped`
                                  : "Available";
                        const readOnly =
                          profile.global || profile.match !== undefined;
                        return (
                          <div
                            key={profile.id}
                            className={cn(
                              "min-w-0 rounded-lg border bg-slate-950/45 px-3 py-2.5",
                              active ? "border-sky-900/80" : "border-slate-800",
                              !profileIsEnabled(profile) && "opacity-55",
                            )}
                          >
                            <div className="flex min-w-0 items-start gap-2">
                              {readOnly ? (
                                <span
                                  aria-hidden="true"
                                  className={cn(
                                    "mt-0.5 grid size-4 place-items-center rounded-sm border",
                                    active
                                      ? "border-sky-500/70 text-sky-300"
                                      : "border-slate-700 text-transparent",
                                  )}
                                >
                                  <Check className="size-3" />
                                </span>
                              ) : (
                                <input
                                  type="checkbox"
                                  aria-label={`Assign ${profile.name} manually`}
                                  checked={rootAssigned}
                                  disabled={
                                    setup.saving ||
                                    workspaceSettingsDirty ||
                                    !instructionLibraryAvailable ||
                                    (!profileIsEnabled(profile) &&
                                      !rootAssigned)
                                  }
                                  onChange={(event) =>
                                    setRootProfileAssignment(
                                      profile.id,
                                      event.target.checked,
                                    )
                                  }
                                  className="mt-0.5 accent-sky-500"
                                />
                              )}
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm text-slate-200">
                                  {profile.name}
                                </p>
                                {profile.description ? (
                                  <p className="mt-1 line-clamp-2 text-xs text-slate-500">
                                    {profile.description}
                                  </p>
                                ) : null}
                              </div>
                              <span
                                className={cn(
                                  "shrink-0 text-[11px]",
                                  active ? "text-sky-300" : "text-slate-600",
                                )}
                              >
                                {state}
                              </span>
                            </div>
                            {scopedAssignments.length > 0 ? (
                              <ul className="mt-2 space-y-1 border-t border-slate-800 pt-2">
                                {scopedAssignments.map((scope) => (
                                  <li
                                    key={scope.path}
                                    className="flex min-w-0 items-center gap-1.5 pl-6"
                                  >
                                    <code className="min-w-0 flex-1 truncate text-xs text-slate-500">
                                      {scope.path}
                                    </code>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-xs"
                                      aria-label={`Remove ${profile.name} from ${scope.path}`}
                                      disabled={
                                        setup.saving ||
                                        workspaceSettingsDirty ||
                                        !instructionLibraryAvailable
                                      }
                                      onClick={() =>
                                        removeScopedProfileAssignment(
                                          profile.id,
                                          scope.path,
                                          scope.profiles,
                                        )
                                      }
                                      className="text-slate-600 hover:text-red-300"
                                    >
                                      <X />
                                    </Button>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
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
