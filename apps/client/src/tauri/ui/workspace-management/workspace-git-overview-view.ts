import type {
  WorkspaceGitOverview,
  WorkspaceGitOverviewSection,
} from "@machdoch/fleet-protocol/workspace-contract";
import type { WorkspaceGitOverviewView } from "../runtime";
import type { WorkspaceGitSection } from "./workspace-view-preferences";

const SECTION_DATA: Partial<
  Record<WorkspaceGitSection, WorkspaceGitOverviewSection[]>
> = {
  changes: ["numstat"],
  stashes: ["stashes"],
  worktrees: ["worktrees"],
};

export const workspaceGitOverviewView = (
  section: WorkspaceGitSection,
): Required<WorkspaceGitOverviewView> => ({
  sections: ["branches", ...(SECTION_DATA[section] ?? [])],
  untrackedFiles: section === "changes" ? "all" : "normal",
});

export const workspaceGitOverviewCovers = (
  overview: WorkspaceGitOverview,
  view: Required<WorkspaceGitOverviewView>,
): boolean =>
  view.sections.every((section) => overview.sections.includes(section)) &&
  (view.untrackedFiles === "normal" || overview.untrackedFiles === "all");

const KEPT_SECTIONS: Partial<
  Record<
    WorkspaceGitOverviewSection,
    (target: WorkspaceGitOverview, source: WorkspaceGitOverview) => void
  >
> = {
  branches: (target, source) => {
    target.localBranches = source.localBranches;
    target.remoteBranches = source.remoteBranches;
  },
  recentCommits: (target, source) => {
    target.recentCommits = source.recentCommits;
  },
  stashes: (target, source) => {
    target.stashes = source.stashes;
  },
  worktrees: (target, source) => {
    target.worktrees = source.worktrees;
  },
};

export const mergeWorkspaceGitOverview = (
  previous: WorkspaceGitOverview | undefined,
  next: WorkspaceGitOverview,
): WorkspaceGitOverview => {
  if (!previous || previous.branch !== next.branch) return next;
  const merged = { ...next, sections: [...next.sections] };
  for (const section of previous.sections) {
    const keep = KEPT_SECTIONS[section];
    if (!keep || merged.sections.includes(section)) continue;
    keep(merged, previous);
    merged.sections.push(section);
  }
  return merged;
};
