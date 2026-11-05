import {
  APP_CONTROL_LEVEL,
  useAppControlView,
} from "@machdoch/media-studio/tauri/ui/app-control/use-app-control.js";
import type { WorkspaceGitSummary } from "../runtime";
import {
  createWorkspaceRootKey,
  getManagedWorkspaceName,
  getManagedWorkspaceTags,
  type ManagedWorkspaceView,
} from "./workspace-management-model";
import {
  WORKSPACE_DETAIL_SECTIONS,
  WORKSPACE_GIT_SECTIONS,
  type WorkspaceDetailSection,
  type WorkspaceGitSection,
} from "./workspace-view-preferences";

const SECTION_LABELS: Readonly<Record<WorkspaceDetailSection, string>> = {
  git: "Git",
  files: "Files",
  run: "Run",
  knowledge: "Knowledge",
  research: "Research",
  memory: "Memory",
  settings: "Settings",
};

const LISTED_WORKSPACES = 40;

export interface WorkspaceViewControlOptions {
  workspaces: readonly ManagedWorkspaceView[];
  selectedWorkspace: ManagedWorkspaceView | null;
  section: WorkspaceDetailSection;
  gitSection: WorkspaceGitSection;
  gitSummary: WorkspaceGitSummary | null | undefined;
  draftDirty: boolean;
  busy: boolean;
  onSelectWorkspace: (workspaceKey: string) => void;
  onSelectSection: (section: WorkspaceDetailSection) => void;
  onSelectGitSection: (section: WorkspaceGitSection) => void;
}

export function useWorkspaceViewControl({
  workspaces,
  selectedWorkspace,
  section,
  gitSection,
  gitSummary,
  draftDirty,
  busy,
  onSelectWorkspace,
  onSelectSection,
  onSelectGitSection,
}: WorkspaceViewControlOptions): void {
  useAppControlView("workspaces", APP_CONTROL_LEVEL.view, {
    location: selectedWorkspace
      ? [getManagedWorkspaceName(selectedWorkspace), SECTION_LABELS[section]]
      : [],
    workspaceRoot: selectedWorkspace?.root ?? null,
    state: () => ({
      selectedWorkspace: selectedWorkspace
        ? {
            name: getManagedWorkspaceName(selectedWorkspace),
            root: selectedWorkspace.root,
            tags: getManagedWorkspaceTags(selectedWorkspace),
            git: gitSummary ?? null,
          }
        : null,
      section,
      ...(section === "git" ? { gitSection } : {}),
      ...(draftDirty ? { unsavedChanges: true } : {}),
      workspaces: workspaces.slice(0, LISTED_WORKSPACES).map((workspace) => ({
        name: getManagedWorkspaceName(workspace),
        root: workspace.root,
      })),
    }),
    actions: [
      {
        id: "workspaces.select",
        description:
          "Show a known workspace in Workspace Management. Quick Chat then works in that workspace.",
        effect: "write",
        input: {
          type: "object",
          properties: { root: { type: "string", minLength: 1 } },
          required: ["root"],
        },
        run: (input) => {
          const key = createWorkspaceRootKey(String(input.root));
          const workspace = workspaces.find(
            (candidate) => candidate.key === key,
          );
          if (!workspace)
            throw new Error(
              "That folder is not a known workspace. Use a root from the view state.",
            );
          if (busy && workspace.key !== selectedWorkspace?.key)
            throw new Error(
              "Workspace Management is saving. Retry when it finishes.",
            );
          if (draftDirty && workspace.key !== selectedWorkspace?.key)
            throw new Error(
              "The current workspace has unsaved changes; ask the user to save or discard them first.",
            );
          onSelectWorkspace(workspace.key);
          return { name: getManagedWorkspaceName(workspace) };
        },
      },
      {
        id: "workspaces.open_section",
        description:
          "Show a section of the selected workspace, optionally a Git sub-section.",
        effect: "write",
        input: {
          type: "object",
          properties: {
            section: { type: "string", enum: WORKSPACE_DETAIL_SECTIONS },
            gitSection: { type: "string", enum: WORKSPACE_GIT_SECTIONS },
          },
          required: ["section"],
        },
        run: (input) => {
          if (!selectedWorkspace) throw new Error("Select a workspace first.");
          onSelectSection(input.section as WorkspaceDetailSection);
          if (input.gitSection)
            onSelectGitSection(input.gitSection as WorkspaceGitSection);
          return {
            section: SECTION_LABELS[input.section as WorkspaceDetailSection],
          };
        },
      },
    ],
  });
}
