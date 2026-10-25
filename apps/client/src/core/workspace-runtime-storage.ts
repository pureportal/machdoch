import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, relative, resolve, sep } from "node:path";

const storage = new AsyncLocalStorage<{
  workspace: string;
  directory: string;
}>();

export function withWorkspaceRuntimeStorage<T>(
  workspace: string,
  directory: string,
  operation: () => T,
): T {
  if (!isAbsolute(workspace) || !isAbsolute(directory))
    throw new Error("Runtime storage requires absolute paths.");
  const root = resolve(workspace),
    local = resolve(directory);
  for (const [parent, child] of [
    [root, local],
    [local, root],
  ] as const) {
    const path = relative(parent, child);
    if (
      !path ||
      (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    )
      throw new Error(
        "Task runtime storage must be separate from its workspace.",
      );
  }
  return storage.run({ workspace: root, directory: local }, operation);
}

export function getWorkspaceRuntimeDirectory(
  workspace: string,
): string | undefined {
  const current = storage.getStore();
  return current && relative(current.workspace, resolve(workspace)) === ""
    ? current.directory
    : undefined;
}
