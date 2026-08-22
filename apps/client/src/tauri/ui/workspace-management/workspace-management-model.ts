import type { InstructionWorkspaceView } from "../runtime";

export interface ManagedWorkspaceView {
  key: string;
  root: string;
  instructionWorkspace: InstructionWorkspaceView | null;
}

export const createWorkspaceRootKey = (workspaceRoot: string): string => {
  const trimmedRoot = workspaceRoot.trim();
  const windowsStyle = /^(?:[a-z]:[\\/]|[\\/]{2}(?:\?|[^\\/]))/iu.test(
    trimmedRoot,
  );
  const normalizedSeparators = windowsStyle
    ? trimmedRoot.replace(/\\/gu, "/")
    : trimmedRoot;
  const withoutTrailingSeparators = normalizedSeparators.replace(/\/+$/gu, "");
  const normalizedRoot =
    windowsStyle &&
    /^(?:\/\/\?\/)?[a-z]:$/iu.test(withoutTrailingSeparators) &&
    normalizedSeparators.endsWith("/")
      ? `${withoutTrailingSeparators}/`
      : withoutTrailingSeparators || normalizedSeparators;

  return windowsStyle
    ? normalizedRoot.toLocaleLowerCase("en-US")
    : normalizedRoot;
};

export const createManagedWorkspaceViews = (
  workspaceRoots: readonly string[],
  instructionWorkspaces: readonly InstructionWorkspaceView[],
): ManagedWorkspaceView[] => {
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

  // Keep bindings visible even if recent-workspace history was cleared or the
  // binding was created by the CLI. Otherwise assignments could only be found
  // and removed through another CLI invocation.
  for (const instructionWorkspace of instructionWorkspaces) {
    const root = instructionWorkspace.root.trim();
    const key = createWorkspaceRootKey(root);

    if (!root || !key || seenRoots.has(key)) {
      continue;
    }

    seenRoots.add(key);
    workspaces.push({ key, root, instructionWorkspace });
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
