import type { InstructionWorkspaceView } from "../runtime";

export interface ManagedWorkspaceView {
  key: string;
  root: string;
  instructionWorkspace: InstructionWorkspaceView | null;
}

export const createWorkspaceRootKey = (workspaceRoot: string): string => {
  const trimmedRoot = workspaceRoot.trim();
  const normalizedSeparators = trimmedRoot.replace(/\\/gu, "/");
  const withoutTrailingSeparators = normalizedSeparators.replace(/\/+$/gu, "");
  const normalizedRoot =
    /^[a-z]:$/iu.test(withoutTrailingSeparators) &&
    normalizedSeparators.endsWith("/")
      ? `${withoutTrailingSeparators}/`
      : withoutTrailingSeparators || normalizedSeparators;

  return normalizedRoot.toLocaleLowerCase();
};

export const createManagedWorkspaceViews = (
  workspaceRoots: readonly string[],
  instructionWorkspaces: readonly InstructionWorkspaceView[],
): ManagedWorkspaceView[] => {
  // Global roots define membership. Instruction bindings only enrich matching
  // entries with optional names, tags, and profile assignments.
  const instructionWorkspacesByRoot = new Map<
    string,
    InstructionWorkspaceView
  >();

  for (const instructionWorkspace of instructionWorkspaces) {
    const key = createWorkspaceRootKey(instructionWorkspace.root);

    if (key && !instructionWorkspacesByRoot.has(key)) {
      instructionWorkspacesByRoot.set(key, instructionWorkspace);
    }
  }

  const seenRoots = new Set<string>();
  const workspaces: ManagedWorkspaceView[] = [];

  for (const workspaceRoot of workspaceRoots) {
    const root = workspaceRoot.trim();
    const key = createWorkspaceRootKey(root);

    if (!root || !key || seenRoots.has(key)) {
      continue;
    }

    seenRoots.add(key);
    workspaces.push({
      key,
      root,
      instructionWorkspace: instructionWorkspacesByRoot.get(key) ?? null,
    });
  }

  return workspaces;
};

export const getManagedWorkspaceName = (
  workspace: ManagedWorkspaceView,
): string =>
  workspace.instructionWorkspace?.displayName ??
  workspace.root.split(/[\\/]/u).filter(Boolean).at(-1) ??
  workspace.root;

export const getManagedWorkspaceTags = (
  workspace: ManagedWorkspaceView,
): string[] => workspace.instructionWorkspace?.tags ?? [];
