import { useMemo, type RefObject } from "react";
import type { InstructionManagementControls } from "@machdoch/client-ui/instructions";
import { getDefaultCommandShortcut } from "@machdoch/media-studio/tauri/ui/commands/command-defaults.js";
import { useOptionalRegisterCommands } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import {
  asPaletteCommands,
  type CommandDefinition,
  type CommandPageItem,
} from "@machdoch/media-studio/tauri/ui/commands/command-types.js";
import {
  openExternalUrl,
  type InstructionProfileView,
  type InstructionWorkspaceView,
  type WorkspaceGitAction,
} from "../runtime";
import type { WorkspaceManagementControls } from "./types";
import type { WorkspaceGitControls } from "./use-workspace-git";
import { workspaceGitRepositoryLabel } from "./workspace-git-model";
import {
  getManagedWorkspaceName,
  getManagedWorkspaceTags,
  profileIsAutomaticForWorkspace,
  type ManagedWorkspaceView,
} from "./workspace-management-model";
import type {
  WorkspaceDetailSection,
  WorkspaceGitSection,
} from "./workspace-view-preferences";

export interface WorkspaceCommandState {
  setup: InstructionManagementControls;
  workspaceSetup: WorkspaceManagementControls;
  activeWorkspaceRoot: string | null;
  activeWorkspaceConfigured: boolean;
  workspaces: readonly ManagedWorkspaceView[];
  profiles: readonly InstructionProfileView[];
  selectedWorkspaceKey: string | null;
  selectedWorkspace: ManagedWorkspaceView | null;
  selectedInstructionWorkspace: InstructionWorkspaceView | null;
  git: WorkspaceGitControls;
  gitSection: WorkspaceGitSection;
  workspaceSettingsDirty: boolean;
  instructionLibraryAvailable: boolean;
  tagDraftPending: boolean;
  displayNameError: string | null;
  addWorkspace: (root?: string) => Promise<void>;
  selectWorkspace: (workspaceKey: string) => void;
  selectSection: (section: WorkspaceDetailSection) => void;
  selectGitSection: (section: WorkspaceGitSection) => void;
  refreshWorkspaces: () => void;
  saveWorkspaceSettings: () => void;
  relinkWorkspace: () => Promise<void>;
  removeWorkspace: () => Promise<void>;
  setRootProfileAssignment: (profileId: string, assigned: boolean) => void;
  removeScopedProfileAssignment: (
    profileId: string,
    path: string,
    profileIds: readonly string[],
  ) => void;
}

const GIT_SECTION_TITLES: readonly [WorkspaceGitSection, string][] = [
  ["changes", "Changes"],
  ["branches", "Branches"],
  ["stashes", "Stashes"],
  ["history", "History"],
  ["pull-requests", "Pull requests"],
  ["remotes", "Remotes"],
];

const SHORTCUT_SURFACES = [
  "document",
  "text-entry",
  "interactive-control",
  "command-surface",
] as const;

export const useWorkspaceCommands = (
  stateRef: RefObject<WorkspaceCommandState>,
): void => {
  const commands = useMemo<readonly CommandDefinition[]>(() => {
    const scope = {
      kind: "view" as const,
      ownerId: "workspaces",
      viewId: "workspaces",
    };
    const state = () => stateRef.current;
    const numericKey = (index: number): CommandPageItem["numericKey"] =>
      index < 9 ? (`${index + 1}` as CommandPageItem["numericKey"]) : undefined;
    const selectedAvailability = () =>
      state().selectedWorkspace
        ? { state: "enabled" as const }
        : { state: "hidden" as const };
    const gitAvailability = (action: WorkspaceGitAction) => {
      const current = state();
      if (!current.selectedWorkspace) return { state: "hidden" as const };
      return current.git.isActionBlocked(action) || !current.git.overview
        ? { state: "disabled" as const, reason: "Git is unavailable or busy." }
        : { state: "enabled" as const };
    };
    const runGit = (
      ...args: Parameters<WorkspaceGitControls["runAction"]>
    ): void => {
      state().selectSection("git");
      void state().git.runAction(...args);
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
            allowIn: SHORTCUT_SURFACES,
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
            allowIn: SHORTCUT_SURFACES,
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
          (state().git.repositories?.repositories.length ?? 0) > 1
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "workspaces.git.repository.select.page",
          title: "Choose Git repository",
          searchPlaceholder: "Search repositories",
          groups: [
            {
              id: "repositories",
              items: (state().git.repositories?.repositories ?? []).map(
                (repository) => ({
                  id: repository.repositoryRoot,
                  title: workspaceGitRepositoryLabel(repository),
                  keywords: [repository.repositoryRoot],
                  current:
                    state().git.repositoryRoot === repository.repositoryRoot,
                  availability: state().git.busy
                    ? { state: "disabled", reason: "Git is busy." }
                    : { state: "enabled" },
                  execute: () => {
                    state().selectSection("git");
                    state().git.selectRepository(repository.repositoryRoot);
                  },
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
              items: GIT_SECTION_TITLES.map(([value, title], index) => ({
                id: value,
                title,
                current: state().gitSection === value,
                numericKey: numericKey(index),
                execute: () => {
                  state().selectSection("git");
                  state().selectGitSection(value);
                },
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
            : state().git.busy
              ? { state: "disabled", reason: "Git is busy." }
              : { state: "enabled" },
        execute: () => void state().git.refresh(),
      },
      {
        id: "workspaces.git.fetch",
        title: "Fetch Git repository",
        group: "Workspace Git",
        scope,
        availability: () => gitAvailability("fetch"),
        execute: () => runGit("fetch"),
      },
      {
        id: "workspaces.git.pull",
        title: "Pull Git repository",
        group: "Workspace Git",
        scope,
        availability: () => {
          const available = gitAvailability("pull");
          if (available.state !== "enabled") return available;
          return state().git.overview?.upstream
            ? available
            : { state: "disabled", reason: "No upstream branch." };
        },
        execute: () => runGit("pull"),
      },
      {
        id: "workspaces.git.push",
        title: "Push Git branch",
        group: "Workspace Git",
        scope,
        availability: () => {
          const available = gitAvailability("push");
          if (available.state !== "enabled") return available;
          return state().git.overview?.remotes.length
            ? available
            : { state: "disabled", reason: "No Git remote." };
        },
        execute: () => runGit("push"),
      },
      {
        id: "workspaces.git.restack",
        title: "Restack Git branches",
        group: "Workspace Git",
        scope,
        availability: () => gitAvailability("restack"),
        execute: () => runGit("restack"),
      },
      {
        id: "workspaces.git.pull-requests.submit",
        title: "Submit pull requests",
        group: "Workspace Git",
        scope,
        availability: () => gitAvailability("submit-pull-requests"),
        execute: () => runGit("submit-pull-requests"),
      },
      {
        id: "workspaces.git.stash",
        title: "Stash Git changes",
        group: "Workspace Git",
        scope,
        availability: () => {
          const available = gitAvailability("stash-push");
          if (available.state !== "enabled") return available;
          return state().git.overview?.clean
            ? { state: "disabled", reason: "Nothing to stash." }
            : available;
        },
        execute: () => runGit("stash-push", { includeUntracked: true }),
      },
      {
        id: "workspaces.git.branch.switch",
        title: "Switch Git branch",
        group: "Workspace Git",
        scope,
        availability: () => gitAvailability("checkout"),
        children: () => ({
          id: "workspaces.git.branch.switch.page",
          title: "Switch Git branch",
          searchPlaceholder: "Search branches",
          groups: [
            {
              id: "local",
              label: "Local",
              items: (state().git.overview?.localBranches ?? []).map(
                (branch) => ({
                  id: branch.name,
                  title: branch.name,
                  current: branch.current,
                  availability: branch.current
                    ? { state: "disabled", reason: "Current branch." }
                    : { state: "enabled" },
                  execute: () =>
                    runGit("checkout", { branchName: branch.name }),
                }),
              ),
            },
            {
              id: "remote",
              label: "Remote",
              items: (state().git.overview?.remoteBranches ?? []).map(
                (branch) => ({
                  id: branch.name,
                  title: branch.name,
                  execute: () =>
                    runGit("checkout-remote", { branchName: branch.name }),
                }),
              ),
            },
          ],
        }),
      },
      {
        id: "workspaces.git.remote.remove",
        title: "Remove Git remote",
        group: "Workspace Git",
        scope,
        availability: () => gitAvailability("remove-remote"),
        children: () => ({
          id: "workspaces.git.remote.remove.page",
          title: "Remove Git remote",
          searchPlaceholder: "Search remotes",
          groups: [
            {
              id: "remotes",
              items: (state().git.overview?.remotes ?? []).map((remote) => ({
                id: remote.name,
                title: remote.name,
                keywords: [remote.fetchUrl ?? "", remote.pushUrl ?? ""],
                execute: () => {
                  if (window.confirm(`Remove Git remote ${remote.name}?`)) {
                    runGit("remove-remote", { remoteName: remote.name });
                  }
                },
              })),
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
          (state().git.pullRequests?.items.length ?? 0) > 0
            ? { state: "enabled" }
            : { state: "hidden" },
        children: () => ({
          id: "workspaces.git.pull-request.open.page",
          title: "Open pull request",
          searchPlaceholder: "Search pull requests",
          groups: [
            {
              id: "pull-requests",
              items: (state().git.pullRequests?.items ?? []).map(
                (pullRequest) => ({
                  id: `${pullRequest.number}`,
                  title: `#${pullRequest.number} ${pullRequest.title}`,
                  keywords: [pullRequest.headBranch, pullRequest.baseBranch],
                  execute: () => void openExternalUrl(pullRequest.url),
                }),
              ),
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
                    : !profile.enabled && !rootAssigned
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
  }, [stateRef]);
  useOptionalRegisterCommands(commands);
};
