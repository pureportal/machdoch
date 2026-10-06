import { CopyContextMenu } from "@machdoch/media-studio/tauri/ui/components/ui/copy-context-menu.js";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Check,
  CircleDot,
  FolderGit2,
  FolderPlus,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Trash2,
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
import { MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH } from "@machdoch/fleet-protocol/instruction-limits";
import { hasUnpairedUtf16Surrogate } from "@machdoch/fleet-protocol/unicode";
import {
  instructionTagKey,
  instructionTagRuleMatches,
} from "@machdoch/fleet-protocol/instruction-tags";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { SearchField } from "@machdoch/media-studio/tauri/ui/components/ui/search-field.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import { getDefaultCommandShortcut } from "@machdoch/media-studio/tauri/ui/commands/command-defaults.js";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import {
  asPaletteCommands,
  type CommandDefinition,
  type CommandPageItem,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  openExternalUrl,
  type InstructionMutationInput,
  type InstructionProfileView,
  type InstructionWorkspaceView,
} from "../runtime";
import type { InstructionManagementControls } from "@machdoch/client-ui/instructions";
import { hasAsciiControlCharacter } from "@machdoch/client-ui/instructions";
import { TagEditor } from "@machdoch/client-ui/instructions";
import {
  createManagedWorkspaceViews,
  createWorkspaceRootKey,
  getManagedWorkspaceName,
  getManagedWorkspaceTags,
} from "./workspace-management-model";
import {
  WorkspaceDetailNavigation,
  type WorkspaceDetailSection,
  workspaceDetailPanelId,
  workspaceDetailTabId,
} from "./workspace-detail-navigation";
import { WorkspaceGitPanel } from "./workspace-git-panel";
import { useWorkspaceGit } from "./use-workspace-git";
import { WorkspaceMemoryPanel } from "./workspace-memory-panel";
import { WorkspaceReasoningBankPanel } from "./workspace-reasoning-bank-panel";
import type { WorkspaceManagementControls } from "./types";
import { workspaceGitRepositoryLabel } from "./workspace-git-model";
import { WorkspaceTools } from "./workspace-tools";
import { WorkspaceRunPanel } from "./workspace-run-panel";
import { WorkspaceConfigurationSettings } from "./workspace-configuration-settings";
import { WorkspaceMcpSettings } from "./workspace-mcp-settings";

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
  onChooseDirectory,
  onSelectedWorkspaceChange,
}: {
  setup: InstructionManagementControls;
  workspaceSetup: WorkspaceManagementControls;
  activeWorkspaceRoot: string | null;
  onDirtyChange?: (dirty: boolean) => void;
  onChooseDirectory?: () => Promise<string | null>;
  onSelectedWorkspaceChange?: (workspaceRoot: string | null) => void;
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
  const [workspaceSection, setWorkspaceSection] =
    useState<WorkspaceDetailSection>("output");
  const [workspaceToolsDirty, setWorkspaceToolsDirty] = useState(false);
  const [workspaceRunDirty, setWorkspaceRunDirty] = useState(false);
  const [workspaceConfigurationBusy, setWorkspaceConfigurationBusy] =
    useState(false);
  const [workspaceMcpDirty, setWorkspaceMcpDirty] = useState(false);
  const [workspaceSettingsResetToken, setWorkspaceSettingsResetToken] =
    useState(0);
  const [workspaceToolsRefreshToken, setWorkspaceToolsRefreshToken] =
    useState(0);
  const [workspaceMemoryEntries, setWorkspaceMemoryEntries] = useState<
    Awaited<ReturnType<WorkspaceManagementControls["onLoadMemory"]>>
  >([]);
  const [workspaceMemoryRoot, setWorkspaceMemoryRoot] = useState<string | null>(
    null,
  );
  const [workspaceMemoryLoading, setWorkspaceMemoryLoading] = useState(false);
  const [workspaceMemoryError, setWorkspaceMemoryError] = useState<
    string | null
  >(null);
  const [workspaceMemoryForgetting, setWorkspaceMemoryForgetting] =
    useState(false);
  const [workspaceActionError, setWorkspaceActionError] = useState<
    string | null
  >(null);

  const runWorkspaceAction = async (
    action: () => Promise<void>,
  ): Promise<void> => {
    setWorkspaceActionError(null);
    try {
      await action();
    } catch (error) {
      setWorkspaceActionError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const displayNameErrorId = useId();
  const pendingTagMessageId = useId();
  const selectedRootRef = useRef<string | null>(null);
  const previousActiveWorkspaceKeyRef = useRef<string | null>(null);
  const hydratedWorkspaceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    void setup.onRefresh();
  }, [setup.onRefresh]);

  useEffect(() => {
    const activeWorkspaceKey = activeWorkspaceRoot
      ? createWorkspaceRootKey(activeWorkspaceRoot)
      : null;
    const activeWorkspaceChanged =
      previousActiveWorkspaceKeyRef.current !== activeWorkspaceKey;
    previousActiveWorkspaceKeyRef.current = activeWorkspaceKey;
    const active = workspaces.find(
      (workspace) => workspace.key === activeWorkspaceKey,
    );

    if (activeWorkspaceChanged && active) {
      setSelectedWorkspaceKey(active.key);
      return;
    }

    if (
      selectedWorkspaceKey &&
      workspaces.some((workspace) => workspace.key === selectedWorkspaceKey)
    ) {
      return;
    }
    setSelectedWorkspaceKey(active?.key ?? workspaces[0]?.key ?? null);
  }, [activeWorkspaceRoot, selectedWorkspaceKey, workspaces]);

  const selectedWorkspace =
    workspaces.find((workspace) => workspace.key === selectedWorkspaceKey) ??
    null;
  useEffect(() => {
    onSelectedWorkspaceChange?.(selectedWorkspace?.root ?? null);
  }, [onSelectedWorkspaceChange, selectedWorkspace?.root]);
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
  const workspaceDraftDirty =
    workspaceSettingsDirty ||
    workspaceToolsDirty ||
    workspaceRunDirty ||
    workspaceMcpDirty;

  useEffect(() => {
    onDirtyChange?.(workspaceDraftDirty);
  }, [onDirtyChange, workspaceDraftDirty]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const gitControls = useWorkspaceGit(
    selectedWorkspace?.root ?? null,
    workspaceToolsDirty,
    () => setWorkspaceToolsRefreshToken((current) => current + 1),
  );
  const {
    gitSection,
    setGitSection,
    gitRepositories,
    selectedGitRepositoryRoot,
    selectedGitOverview,
    gitAction,
    gitBusy,
    pullRequests,
    branchName,
    remoteName,
    remoteUrl,
    refreshGitOverview,
    refreshGit,
    refreshPullRequests,
    runGitAction,
    selectGitRepository,
    removeRemote,
  } = gitControls;

  selectedRootRef.current = selectedWorkspace?.root ?? null;

  useEffect(() => {
    if (workspaceSection !== "memory") return;

    const workspaceRoot = selectedWorkspace?.root;
    if (!workspaceRoot) {
      setWorkspaceMemoryEntries([]);
      setWorkspaceMemoryRoot(null);
      setWorkspaceMemoryError(null);
      setWorkspaceMemoryLoading(false);
      return;
    }

    let cancelled = false;
    setWorkspaceMemoryLoading(true);
    setWorkspaceMemoryError(null);
    setWorkspaceMemoryEntries([]);
    setWorkspaceMemoryRoot(null);

    void workspaceSetup
      .onLoadMemory(workspaceRoot)
      .then((entries) => {
        if (!cancelled && selectedRootRef.current === workspaceRoot) {
          setWorkspaceMemoryEntries(entries);
          setWorkspaceMemoryRoot(workspaceRoot);
        }
      })
      .catch((error) => {
        if (!cancelled && selectedRootRef.current === workspaceRoot) {
          setWorkspaceMemoryError(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        if (!cancelled && selectedRootRef.current === workspaceRoot) {
          setWorkspaceMemoryLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedWorkspace?.root, workspaceSection, workspaceSetup.onLoadMemory]);

  const forgetWorkspaceMemory = useCallback(
    async (id: string): Promise<void> => {
      const workspaceRoot = selectedRootRef.current;
      if (!workspaceRoot) return;

      setWorkspaceMemoryForgetting(true);
      setWorkspaceMemoryError(null);
      try {
        const entries = await workspaceSetup.onForgetMemory(workspaceRoot, id);
        if (selectedRootRef.current === workspaceRoot) {
          setWorkspaceMemoryEntries(entries);
          setWorkspaceMemoryRoot(workspaceRoot);
        }
      } catch (error) {
        if (selectedRootRef.current === workspaceRoot) {
          setWorkspaceMemoryError(
            error instanceof Error ? error.message : String(error),
          );
        }
      } finally {
        setWorkspaceMemoryForgetting(false);
      }
    },
    [workspaceSetup.onForgetMemory],
  );

  useEffect(() => {
    const snapshot = selectedWorkspaceFormSnapshotRef.current;
    hydratedWorkspaceKeyRef.current = snapshot?.key ?? null;
    setDisplayName(snapshot?.displayName ?? "");
    setTags(snapshot?.tags ?? []);
    setTagDraftPending(false);
  }, [registry?.revision, selectedWorkspace?.key]);

  const mutate = async (input: InstructionMutationInput): Promise<boolean> =>
    (await setup.onSave(input)) !== false;

  const chooseDirectory = async (): Promise<string | null> => {
    if (onChooseDirectory) return await onChooseDirectory();
    const result = await open({ directory: true, multiple: false });
    return typeof result === "string" ? result : null;
  };

  const addWorkspace = (root?: string): Promise<void> =>
    runWorkspaceAction(async () => {
      const selectedRoot = root ?? (await chooseDirectory());
      if (!selectedRoot) return;
      await workspaceSetup.onAdd(selectedRoot);
    });

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
  const confirmDiscardWorkspaceDraft = (action: string): boolean =>
    !workspaceDraftDirty ||
    window.confirm(`Discard unsaved changes and ${action}?`);

  const selectWorkspace = (workspaceKey: string): void => {
    if (workspaceKey === selectedWorkspaceKey) return;
    if (workspaceConfigurationBusy) return;
    if (!confirmDiscardWorkspaceDraft("switch workspaces")) {
      return;
    }
    setWorkspaceToolsDirty(false);
    setWorkspaceRunDirty(false);
    setWorkspaceConfigurationBusy(false);
    setWorkspaceMcpDirty(false);
    setWorkspaceSettingsResetToken((current) => current + 1);
    setTagDraftPending(false);
    setSelectedWorkspaceKey(workspaceKey);
  };

  const refreshWorkspaces = (): void => {
    if (setup.saving || workspaceConfigurationBusy) return;
    if (!confirmDiscardWorkspaceDraft("refresh")) return;
    setDisplayName(savedDisplayName);
    setTags([...savedTags]);
    setWorkspaceConfigurationBusy(false);
    setWorkspaceMcpDirty(false);
    setWorkspaceSettingsResetToken((current) => current + 1);
    setTagDraftPending(false);
    void setup.onRefresh();
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

  const relinkWorkspace = (): Promise<void> =>
    runWorkspaceAction(async () => {
      if (
        !selectedWorkspace ||
        setup.saving ||
        workspaceSetup.loading ||
        workspaceConfigurationBusy ||
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
      setWorkspaceRunDirty(false);
      setWorkspaceConfigurationBusy(false);
      setWorkspaceMcpDirty(false);
      setWorkspaceSettingsResetToken((current) => current + 1);
      setTagDraftPending(false);
    });

  const removeWorkspace = (): Promise<void> =>
    runWorkspaceAction(async () => {
      if (
        !selectedWorkspace ||
        setup.saving ||
        workspaceSetup.loading ||
        workspaceConfigurationBusy ||
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
      await workspaceSetup.onRemove(selectedWorkspace.root);
      setWorkspaceToolsDirty(false);
      setWorkspaceRunDirty(false);
      setTagDraftPending(false);
    });

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
            runtimes: ["tauri", "browser"],
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
            runtimes: ["tauri", "browser"],
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
    <main className="app-management-view flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-950">
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
            Add workspace
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={
              setup.loading || setup.saving || workspaceConfigurationBusy
            }
            aria-label="Refresh workspaces"
            onClick={refreshWorkspaces}
          >
            <RefreshCw
              className={cn("size-4", setup.loading && "animate-spin")}
            />
          </Button>
        </div>
      </header>

      {workspaceActionError ? (
        <div
          role="alert"
          className="shrink-0 border-b border-red-950 bg-red-950/30 px-6 py-2 text-sm text-red-200"
        >
          {workspaceActionError}
        </div>
      ) : null}
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

      <div className="app-management-panes grid min-h-0 min-w-0 flex-1 grid-rows-[10rem_minmax(0,1fr)] lg:grid-cols-[16rem_minmax(0,1fr)] lg:grid-rows-1 xl:grid-cols-[20rem_minmax(0,1fr)]">
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
              <div
                role="status"
                aria-label="Loading workspaces"
                className="grid h-32 place-items-center"
              >
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
                    onClick={() => {
                      if (workspaces.length > 0) setQuery("");
                      else void addWorkspace();
                    }}
                  >
                    {workspaces.length === 0 ? (
                      <Plus className="size-4" />
                    ) : null}
                    {workspaces.length === 0 ? "Add workspace" : "Clear search"}
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
                      disabled={workspaceConfigurationBusy && !selected}
                      title={
                        workspaceConfigurationBusy && !selected
                          ? "Workspace settings are saving."
                          : undefined
                      }
                      onClick={() => selectWorkspace(workspace.key)}
                      className={cn(
                        "w-full rounded-lg border px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60",
                        selected
                          ? "border-sky-800/70 bg-sky-950/25"
                          : "border-transparent hover:border-slate-800 hover:bg-slate-900/55",
                        "disabled:cursor-not-allowed disabled:opacity-50",
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
            <div className="mx-auto w-full max-w-360 space-y-4 p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/20 px-4 py-3.5">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-slate-100">
                    {getManagedWorkspaceName(selectedWorkspace)}
                  </h2>
                  <CopyContextMenu
                    values={[
                      {
                        label: "Copy workspace path",
                        value: selectedWorkspace.root,
                      },
                    ]}
                  >
                    <p className="mt-1 break-all font-mono text-xs text-slate-500">
                      {selectedWorkspace.root}
                    </p>
                  </CopyContextMenu>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      setup.saving ||
                      workspaceSetup.loading ||
                      workspaceConfigurationBusy ||
                      !instructionLibraryAvailable
                    }
                    tooltip={
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
                      workspaceConfigurationBusy ||
                      !instructionLibraryAvailable
                    }
                    tooltip={
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

              <WorkspaceDetailNavigation
                activeSection={workspaceSection}
                onSectionChange={setWorkspaceSection}
              />

              <div
                id={workspaceDetailPanelId(workspaceSection)}
                role="tabpanel"
                aria-labelledby={workspaceDetailTabId(workspaceSection)}
                className="space-y-4 outline-none"
                tabIndex={0}
              >
                <div
                  hidden={
                    workspaceSection !== "output" &&
                    workspaceSection !== "configuration"
                  }
                >
                  <WorkspaceRunPanel
                    workspaceRoot={selectedWorkspace.root}
                    view={
                      workspaceSection === "configuration"
                        ? "configuration"
                        : "output"
                    }
                    onDocumentDirtyChange={setWorkspaceRunDirty}
                    onConfigurationRequired={() =>
                      setWorkspaceSection("configuration")
                    }
                  />
                </div>

                <div hidden={workspaceSection !== "files"}>
                  <WorkspaceTools
                    key={selectedWorkspace.key}
                    workspaceRoot={selectedWorkspace.root}
                    refreshToken={workspaceToolsRefreshToken}
                    onDirtyChange={setWorkspaceToolsDirty}
                    onWorkspaceMutation={refreshWorkspaceState}
                  />
                </div>

                {workspaceSection === "memory" && selectedWorkspace ? (
                  <div className="space-y-4">
                    <WorkspaceMemoryPanel
                      entries={workspaceMemoryEntries}
                      sourceSessions={workspaceSetup.memorySourceSessions}
                      loading={
                        workspaceMemoryLoading &&
                        workspaceMemoryRoot !== selectedWorkspace.root
                      }
                      disabled={
                        workspaceMemoryLoading || workspaceMemoryForgetting
                      }
                      error={workspaceMemoryError}
                      onForget={forgetWorkspaceMemory}
                    />
                    <WorkspaceReasoningBankPanel
                      key={selectedWorkspace.key}
                      workspaceRoot={selectedWorkspace.root}
                    />
                  </div>
                ) : null}

                <div
                  hidden={workspaceSection !== "settings"}
                  className="space-y-4"
                >
                  <SubmitShortcut asChild>
                    <section className="grid gap-4 rounded-xl border border-slate-800 bg-slate-900/20 p-4 md:grid-cols-[minmax(12rem,0.65fr)_minmax(0,1.35fr)_auto] md:items-end">
                      <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                        Name
                        <Input
                          value={displayName}
                          maxLength={
                            MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH * 2
                          }
                          disabled={
                            setup.saving || !instructionLibraryAvailable
                          }
                          aria-invalid={displayNameError !== null}
                          aria-describedby={
                            displayNameError && workspaceSettingsDirty
                              ? displayNameErrorId
                              : undefined
                          }
                          onChange={(event) =>
                            setDisplayName(event.target.value)
                          }
                          className="h-9 border-slate-800 bg-slate-950"
                        />
                      </label>
                      <label className="grid gap-1.5 text-xs font-medium text-slate-400">
                        Tags
                        <TagEditor
                          value={tags}
                          disabled={
                            setup.saving || !instructionLibraryAvailable
                          }
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
                        {...SUBMIT_SHORTCUT_ACTION_PROPS}
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
                  </SubmitShortcut>

                  <WorkspaceConfigurationSettings
                    key={`workspace-configuration-${selectedWorkspace.key}-${workspaceSettingsResetToken}`}
                    workspaceRoot={selectedWorkspace.root}
                    workspaceLabel={getManagedWorkspaceName(selectedWorkspace)}
                    workspaceMemoryDefaultEnabled={
                      workspaceSetup.workspaceMemoryDefaultEnabled
                    }
                    onBusyChange={setWorkspaceConfigurationBusy}
                    onSaved={workspaceSetup.onConfigurationChanged}
                  />

                  <WorkspaceMcpSettings
                    key={`workspace-mcp-${selectedWorkspace.key}-${workspaceSettingsResetToken}`}
                    workspaceRoot={selectedWorkspace.root}
                    onDirtyChange={setWorkspaceMcpDirty}
                  />
                </div>

                {workspaceSection === "git" ? (
                  <WorkspaceGitPanel
                    workspaceRoot={selectedWorkspace.root}
                    controls={gitControls}
                  />
                ) : null}

                {workspaceSection === "settings" ? (
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
                                  active
                                    ? "border-sky-900/80"
                                    : "border-slate-800",
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
                                      active
                                        ? "text-sky-300"
                                        : "text-slate-600",
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
                ) : null}
              </div>
            </div>
          )}
        </section>
      </div>
    </main>
  );
};
