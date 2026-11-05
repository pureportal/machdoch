import { open } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
  Brain,
  FileCode2,
  FolderGit2,
  GitBranch,
  Play,
  Search,
  Settings2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH } from "@machdoch/fleet-protocol/instruction-limits";
import { hasUnpairedUtf16Surrogate } from "@machdoch/fleet-protocol/unicode";
import {
  hasAsciiControlCharacter,
  type InstructionManagementControls,
} from "@machdoch/client-ui/instructions";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import {
  openWorkspaceFile,
  openWorkspacePath,
  type InstructionMutationInput,
} from "../runtime";
import type { WorkspaceManagementControls } from "./types";
import {
  useWorkspaceCommands,
  type WorkspaceCommandState,
} from "./use-workspace-commands";
import { useWorkspaceGit } from "./use-workspace-git";
import { WorkspaceDetailHeader } from "./workspace-detail-header";
import type { WorkspaceGitPathAction } from "./workspace-git-changes";
import { WorkspaceGitPanel } from "./workspace-git-panel";
import { useWorkspaceGitSummary } from "./workspace-git-summary-store";
import { WorkspaceKnowledgePanel } from "./workspace-knowledge-panel";
import {
  createManagedWorkspaceViews,
  createWorkspaceRootKey,
  getManagedWorkspaceName,
  getManagedWorkspaceTags,
} from "./workspace-management-model";
import { WorkspaceMemorySection } from "./workspace-memory-section";
import { WorkspaceResearchPanel } from "./workspace-research-panel";
import { WorkspaceRunPanel } from "./workspace-run-panel";
import { WorkspaceSettingsPanel } from "./workspace-settings-panel";
import { WorkspaceSidebar } from "./workspace-sidebar";
import {
  WorkspaceTabList,
  workspaceTabId,
  workspaceTabPanelId,
  type WorkspaceTab,
} from "./workspace-tab-list";
import { WorkspaceTools } from "./workspace-tools";
import {
  readWorkspaceViewPreferences,
  reconcileWorkspaceSelection,
  writeWorkspaceViewPreferences,
  type WorkspaceDetailSection,
  type WorkspaceGitSection,
} from "./workspace-view-preferences";
import { useWorkspaceViewControl } from "./use-workspace-view-control";

const DETAIL_SCOPE = "workspace-detail";

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const displayNameErrorFor = (name: string): string | null => {
  if (!name) return "Enter a name.";
  if (Array.from(name).length > MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH) {
    return `Name cannot exceed ${MAX_INSTRUCTION_WORKSPACE_DISPLAY_NAME_LENGTH} characters.`;
  }
  if (hasAsciiControlCharacter(name))
    return "Name cannot contain control characters.";
  if (hasUnpairedUtf16Surrogate(name))
    return "Name must contain valid Unicode text.";
  return null;
};

const detailTabs = (
  gitChanges: number | undefined,
): WorkspaceTab<WorkspaceDetailSection>[] => [
  { value: "git", label: "Git", icon: GitBranch, count: gitChanges },
  { value: "files", label: "Files", icon: FileCode2 },
  { value: "run", label: "Run", icon: Play },
  { value: "knowledge", label: "Knowledge", icon: Search },
  { value: "research", label: "Research", icon: BookOpen },
  { value: "memory", label: "Memory", icon: Brain },
  { value: "settings", label: "Settings", icon: Settings2 },
];

const SectionFrame = ({
  active,
  fill,
  children,
}: {
  active: boolean;
  fill?: boolean;
  children: ReactNode;
}): JSX.Element => (
  <div
    className={cn(
      !active && "hidden",
      active && fill && "flex min-h-[30rem] flex-1 flex-col",
    )}
  >
    {children}
  </div>
);

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
  const activeWorkspaceKey = activeWorkspaceRoot
    ? createWorkspaceRootKey(activeWorkspaceRoot)
    : null;

  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<
    string | null
  >(
    () =>
      reconcileWorkspaceSelection(
        readWorkspaceViewPreferences(),
        null,
        activeWorkspaceKey,
        workspaces.map((workspace) => workspace.key),
      ).selection,
  );
  const [section, setSection] = useState(
    () => readWorkspaceViewPreferences().section,
  );
  const [gitSection, setGitSection] = useState(
    () => readWorkspaceViewPreferences().gitSection,
  );
  const [visited, setVisited] = useState(() => ({
    workspaceKey: selectedWorkspaceKey,
    sections: new Set<WorkspaceDetailSection>([section]),
  }));
  let visitedSections = visited.sections;
  if (
    visited.workspaceKey !== selectedWorkspaceKey ||
    !visited.sections.has(section)
  ) {
    visitedSections = new Set(
      visited.workspaceKey === selectedWorkspaceKey
        ? [...visited.sections, section]
        : [section],
    );
    setVisited({
      workspaceKey: selectedWorkspaceKey,
      sections: visitedSections,
    });
  }

  const [displayName, setDisplayName] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraftPending, setTagDraftPending] = useState(false);
  const [workspaceToolsDirty, setWorkspaceToolsDirty] = useState(false);
  const [workspaceRunDirty, setWorkspaceRunDirty] = useState(false);
  const [workspaceConfigurationBusy, setWorkspaceConfigurationBusy] =
    useState(false);
  const [workspaceMcpDirty, setWorkspaceMcpDirty] = useState(false);
  const [workspaceResearchDirty, setWorkspaceResearchDirty] = useState(false);
  const [workspaceSettingsResetToken, setWorkspaceSettingsResetToken] =
    useState(0);
  const [workspaceToolsRefreshToken, setWorkspaceToolsRefreshToken] =
    useState(0);
  const [workspaceActionError, setWorkspaceActionError] = useState<
    string | null
  >(null);
  const hydratedWorkspaceKeyRef = useRef<string | null>(null);

  useEffect(() => {
    void setup.onRefresh();
  }, [setup.onRefresh]);

  useEffect(() => {
    const reconciled = reconcileWorkspaceSelection(
      readWorkspaceViewPreferences(),
      selectedWorkspaceKey,
      activeWorkspaceKey,
      workspaces.map((workspace) => workspace.key),
    );
    if (reconciled.selection !== selectedWorkspaceKey) {
      setSelectedWorkspaceKey(reconciled.selection);
    }
    writeWorkspaceViewPreferences(() => reconciled.preferences);
  }, [activeWorkspaceKey, selectedWorkspaceKey, workspaces]);

  const selectedWorkspace =
    workspaces.find((workspace) => workspace.key === selectedWorkspaceKey) ??
    null;
  const selectedRoot = selectedWorkspace?.root ?? null;
  useEffect(() => {
    onSelectedWorkspaceChange?.(selectedRoot);
  }, [onSelectedWorkspaceChange, selectedRoot]);

  const selectedInstructionWorkspace =
    selectedWorkspace?.instructionWorkspace ?? null;
  const savedDisplayName = selectedWorkspace
    ? (selectedInstructionWorkspace?.displayName ??
      getManagedWorkspaceName(selectedWorkspace))
    : "";
  const savedTags = selectedWorkspace
    ? getManagedWorkspaceTags(selectedWorkspace)
    : [];
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
  const displayNameError = displayNameErrorFor(normalizedDisplayName);
  const workspaceSettingsDirty = Boolean(
    selectedWorkspace &&
    hydratedWorkspaceKeyRef.current === selectedWorkspace.key &&
    (tagDraftPending ||
      normalizedDisplayName !== savedDisplayName.trim().normalize("NFKC") ||
      !sameStrings(tags, savedTags)),
  );
  const workspaceDraftDirty =
    workspaceResearchDirty ||
    workspaceSettingsDirty ||
    workspaceToolsDirty ||
    workspaceRunDirty ||
    workspaceMcpDirty;

  useEffect(() => {
    onDirtyChange?.(workspaceDraftDirty);
  }, [onDirtyChange, workspaceDraftDirty]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    const snapshot = selectedWorkspaceFormSnapshotRef.current;
    hydratedWorkspaceKeyRef.current = snapshot?.key ?? null;
    setDisplayName(snapshot?.displayName ?? "");
    setTags(snapshot?.tags ?? []);
    setTagDraftPending(false);
  }, [registry?.revision, selectedWorkspace?.key]);

  const refreshFiles = useCallback(
    () => setWorkspaceToolsRefreshToken((current) => current + 1),
    [],
  );
  const git = useWorkspaceGit(selectedRoot, {
    filesDirty: workspaceToolsDirty,
    onFilesChanged: refreshFiles,
  });
  const gitSummary = useWorkspaceGitSummary(selectedRoot)?.summary;

  const selectSection = useCallback((next: WorkspaceDetailSection): void => {
    setSection(next);
    writeWorkspaceViewPreferences((current) =>
      current.section === next ? current : { ...current, section: next },
    );
  }, []);

  const selectGitSection = useCallback((next: WorkspaceGitSection): void => {
    setGitSection(next);
    writeWorkspaceViewPreferences((current) =>
      current.gitSection === next ? current : { ...current, gitSection: next },
    );
  }, []);

  const runWorkspaceAction = async (
    action: () => Promise<void>,
  ): Promise<void> => {
    setWorkspaceActionError(null);
    try {
      await action();
    } catch (error) {
      setWorkspaceActionError(errorMessage(error));
    }
  };

  const mutate = async (input: InstructionMutationInput): Promise<boolean> =>
    (await setup.onSave(input)) !== false;

  const chooseDirectory = async (): Promise<string | null> => {
    if (onChooseDirectory) return await onChooseDirectory();
    const result = await open({ directory: true, multiple: false });
    return typeof result === "string" ? result : null;
  };

  const addWorkspace = (root?: string): Promise<void> =>
    runWorkspaceAction(async () => {
      const chosenRoot = root ?? (await chooseDirectory());
      if (!chosenRoot) return;
      await workspaceSetup.onAdd(chosenRoot);
    });

  const activeWorkspaceConfigured = workspaces.some(
    (workspace) => workspace.key === activeWorkspaceKey,
  );
  const instructionLibraryError =
    registry?.libraryError ??
    (registry?.recovery?.primaryValid === false
      ? (registry.recovery.errorMessage ?? "Instruction library unavailable.")
      : null);
  const instructionLibraryAvailable =
    registry !== null && instructionLibraryError === null;
  const confirmDiscardWorkspaceDraft = (action: string): boolean =>
    !workspaceDraftDirty ||
    window.confirm(`Discard unsaved changes and ${action}?`);

  const resetDrafts = (): void => {
    setWorkspaceToolsDirty(false);
    setWorkspaceRunDirty(false);
    setWorkspaceConfigurationBusy(false);
    setWorkspaceMcpDirty(false);
    setWorkspaceSettingsResetToken((current) => current + 1);
    setTagDraftPending(false);
  };

  const selectWorkspace = (workspaceKey: string): void => {
    if (workspaceKey === selectedWorkspaceKey || workspaceConfigurationBusy)
      return;
    if (!confirmDiscardWorkspaceDraft("switch workspaces")) return;
    resetDrafts();
    setSelectedWorkspaceKey(workspaceKey);
    writeWorkspaceViewPreferences((current) => ({
      ...current,
      selectedWorkspaceKey: workspaceKey,
    }));
  };

  useWorkspaceViewControl({
    workspaces,
    selectedWorkspace,
    section,
    gitSection,
    gitSummary,
    draftDirty: workspaceDraftDirty,
    busy: workspaceConfigurationBusy,
    onSelectWorkspace: selectWorkspace,
    onSelectSection: selectSection,
    onSelectGitSection: selectGitSection,
  });

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
    void git.refresh();
  };

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

  const manageDisabled =
    setup.saving ||
    workspaceSetup.loading ||
    workspaceConfigurationBusy ||
    !instructionLibraryAvailable;

  const relinkWorkspace = (): Promise<void> =>
    runWorkspaceAction(async () => {
      if (
        !selectedWorkspace ||
        manageDisabled ||
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
      resetDrafts();
    });

  const removeWorkspace = (): Promise<void> =>
    runWorkspaceAction(async () => {
      if (!selectedWorkspace || manageDisabled) return;
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

  const openPath = (
    relativePath: string,
    action: WorkspaceGitPathAction,
  ): void => {
    if (!selectedRoot) return;
    setWorkspaceActionError(null);
    void (
      action === "open"
        ? openWorkspaceFile(selectedRoot, relativePath)
        : openWorkspacePath(selectedRoot, relativePath)
    ).catch((error: unknown) => setWorkspaceActionError(errorMessage(error)));
  };

  const commandState: WorkspaceCommandState = {
    setup,
    workspaceSetup,
    activeWorkspaceRoot,
    activeWorkspaceConfigured,
    workspaces,
    profiles,
    selectedWorkspaceKey,
    selectedWorkspace,
    selectedInstructionWorkspace,
    git,
    gitSection,
    workspaceSettingsDirty,
    instructionLibraryAvailable,
    tagDraftPending,
    displayNameError,
    addWorkspace,
    selectWorkspace,
    selectSection,
    selectGitSection,
    refreshWorkspaces,
    saveWorkspaceSettings,
    relinkWorkspace,
    removeWorkspace,
    setRootProfileAssignment,
    removeScopedProfileAssignment,
  };
  const commandStateRef = useRef(commandState);
  commandStateRef.current = commandState;
  useWorkspaceCommands(commandStateRef);

  const workspaceBusy = setup.saving || workspaceSetup.loading;

  return (
    <main className="app-management-view flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-950">
      <div className="app-management-panes grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,12rem)_minmax(0,1fr)] lg:grid-cols-[17rem_minmax(0,1fr)] lg:grid-rows-1 xl:grid-cols-[19rem_minmax(0,1fr)]">
        <WorkspaceSidebar
          workspaces={workspaces}
          selectedWorkspaceKey={selectedWorkspaceKey}
          activeWorkspaceKey={activeWorkspaceKey}
          activeWorkspaceRoot={activeWorkspaceRoot}
          loading={workspaceSetup.loading}
          refreshing={setup.loading}
          busy={workspaceBusy}
          selectionLocked={workspaceConfigurationBusy}
          onSelect={selectWorkspace}
          onAdd={(root) => void addWorkspace(root)}
          onRefresh={refreshWorkspaces}
        />

        <section className="flex min-h-0 min-w-0 flex-col">
          {workspaceActionError ? (
            <div
              role="alert"
              className="shrink-0 border-b border-red-950 bg-red-950/30 px-4 py-2 text-sm text-red-200"
            >
              {workspaceActionError}
            </div>
          ) : null}
          {setup.message ? (
            <div
              role={setup.message.tone === "error" ? "alert" : "status"}
              className={cn(
                "shrink-0 border-b px-4 py-2 text-sm",
                setup.message.tone === "error"
                  ? "border-red-950 bg-red-950/30 text-red-200"
                  : "border-slate-900 bg-slate-900/35 text-slate-300",
              )}
            >
              {setup.message.text}
            </div>
          ) : null}

          {!selectedWorkspace ? (
            <div className="grid min-h-64 flex-1 place-items-center p-6">
              <EmptyState icon={FolderGit2} title="Select a workspace" />
            </div>
          ) : (
            <>
              <WorkspaceDetailHeader
                workspace={selectedWorkspace}
                manageDisabled={manageDisabled}
                onOpenFolder={() => openPath(".", "reveal")}
                onRelink={() => void relinkWorkspace()}
                onRemove={() => void removeWorkspace()}
              />
              <WorkspaceTabList
                scope={DETAIL_SCOPE}
                label="Workspace sections"
                tabs={detailTabs(gitSummary?.changes)}
                value={section}
                onChange={selectSection}
                className="shrink-0 border-b border-slate-900 px-2"
              />
              <div
                id={workspaceTabPanelId(DETAIL_SCOPE, section)}
                role="tabpanel"
                aria-labelledby={workspaceTabId(DETAIL_SCOPE, section)}
                className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 outline-none"
              >
                {visitedSections.has("git") ? (
                  <SectionFrame active={section === "git"} fill>
                    <WorkspaceGitPanel
                      controls={git}
                      section={gitSection}
                      onSectionChange={selectGitSection}
                      onOpenPath={openPath}
                      className="min-h-0 flex-1"
                    />
                  </SectionFrame>
                ) : null}
                {visitedSections.has("files") ? (
                  <SectionFrame active={section === "files"} fill>
                    <WorkspaceTools
                      key={selectedWorkspace.key}
                      workspaceRoot={selectedWorkspace.root}
                      refreshToken={workspaceToolsRefreshToken}
                      onDirtyChange={setWorkspaceToolsDirty}
                      onWorkspaceMutation={git.reload}
                    />
                  </SectionFrame>
                ) : null}
                {visitedSections.has("run") ? (
                  <SectionFrame active={section === "run"} fill>
                    <WorkspaceRunPanel
                      workspaceRoot={selectedWorkspace.root}
                      onDocumentDirtyChange={setWorkspaceRunDirty}
                    />
                  </SectionFrame>
                ) : null}
                {visitedSections.has("knowledge") ? (
                  <SectionFrame active={section === "knowledge"}>
                    <WorkspaceKnowledgePanel
                      key={selectedWorkspace.key}
                      workspaceRoot={selectedWorkspace.root}
                    />
                  </SectionFrame>
                ) : null}
                {visitedSections.has("research") ? (
                  <SectionFrame active={section === "research"}>
                    <WorkspaceResearchPanel
                      key={`${selectedWorkspace.key}:${workspaceSettingsResetToken}`}
                      workspaceRoot={selectedWorkspace.root}
                      onDirtyChange={setWorkspaceResearchDirty}
                    />
                  </SectionFrame>
                ) : null}
                {section === "memory" ? (
                  <WorkspaceMemorySection
                    key={selectedWorkspace.key}
                    workspaceRoot={selectedWorkspace.root}
                    workspaceSetup={workspaceSetup}
                  />
                ) : null}
                {visitedSections.has("settings") ? (
                  <SectionFrame active={section === "settings"}>
                    <WorkspaceSettingsPanel
                      workspace={selectedWorkspace}
                      setup={setup}
                      workspaceSetup={workspaceSetup}
                      resetToken={workspaceSettingsResetToken}
                      identity={{
                        displayName,
                        tags,
                        tagDraftPending,
                        displayNameError,
                        dirty: workspaceSettingsDirty,
                        onDisplayNameChange: setDisplayName,
                        onTagsChange: setTags,
                        onTagDraftPendingChange: setTagDraftPending,
                        onSave: saveWorkspaceSettings,
                      }}
                      profiles={profiles}
                      libraryError={instructionLibraryError}
                      libraryAvailable={instructionLibraryAvailable}
                      onAssign={setRootProfileAssignment}
                      onRemoveScoped={removeScopedProfileAssignment}
                      onConfigurationBusyChange={setWorkspaceConfigurationBusy}
                      onMcpDirtyChange={setWorkspaceMcpDirty}
                    />
                  </SectionFrame>
                ) : null}
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
};
