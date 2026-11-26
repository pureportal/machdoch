import type {
  InstructionProfileView,
  InstructionTagRule,
  InstructionWorkspaceView,
} from "@machdoch/fleet-protocol/instruction-contract";
import {
  instructionTagRuleMatches,
  normalizeInstructionTagRule,
} from "@machdoch/fleet-protocol/instruction-tags";
import type { FileFilter } from "./types";

export type InstructionActivation = "global" | "tag-match" | "manual";

export const INSTRUCTION_FILE_FILTERS: readonly FileFilter[] = [
  "all",
  "global",
  "tag-match",
  "manual",
  "disabled",
];

export const INSTRUCTION_FILE_FILTER_LABELS: Record<FileFilter, string> = {
  all: "All",
  global: "Global",
  "tag-match": "By tag",
  manual: "Manual",
  disabled: "Disabled",
};

export const instructionActivation = ({
  global,
  match,
}: {
  global: boolean;
  match?: InstructionTagRule | null;
}): InstructionActivation =>
  global ? "global" : match ? "tag-match" : "manual";

const fileMatchesFilter = (
  file: InstructionProfileView,
  filter: FileFilter,
): boolean => {
  if (filter === "all") return true;
  if (filter === "disabled") return !file.enabled;
  return instructionActivation(file) === filter;
};

export const filterInstructionFiles = (
  files: readonly InstructionProfileView[],
  filter: FileFilter,
  query: string,
): InstructionProfileView[] => {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return files.filter((file) => {
    if (!fileMatchesFilter(file, filter)) return false;
    const haystack = [file.name, file.description ?? "", ...file.tags]
      .join(" ")
      .toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
};

export const countInstructionFiles = (
  files: readonly InstructionProfileView[],
): Record<FileFilter, number> =>
  Object.fromEntries(
    INSTRUCTION_FILE_FILTERS.map((filter) => [
      filter,
      files.filter((file) => fileMatchesFilter(file, filter)).length,
    ]),
  ) as Record<FileFilter, number>;

export interface InstructionWorkspaceReach {
  workspace: InstructionWorkspaceView;
  name: string;
  via: InstructionActivation;
}

export const instructionWorkspaceName = (
  workspace: InstructionWorkspaceView,
): string =>
  workspace.displayName ??
  workspace.root.split(/[\\/]/u).filter(Boolean).at(-1) ??
  workspace.root;

const validRule = (
  rule: InstructionTagRule | null,
): InstructionTagRule | null => {
  if (rule === null) return null;
  try {
    return normalizeInstructionTagRule(rule);
  } catch {
    return null;
  }
};

export const instructionWorkspaceReach = (
  profile: {
    id: string | null;
    global: boolean;
    match: InstructionTagRule | null;
  },
  workspaces: readonly InstructionWorkspaceView[],
): InstructionWorkspaceReach[] => {
  const rule = profile.global ? null : validRule(profile.match);
  const profileId = profile.id;
  return workspaces.flatMap((workspace): InstructionWorkspaceReach[] => {
    const via: InstructionActivation | null = profile.global
      ? "global"
      : rule && instructionTagRuleMatches(rule, workspace.tags)
        ? "tag-match"
        : profileId !== null &&
            workspace.scopes.some((scope) => scope.profiles.includes(profileId))
          ? "manual"
          : null;
    return via
      ? [{ workspace, name: instructionWorkspaceName(workspace), via }]
      : [];
  });
};
