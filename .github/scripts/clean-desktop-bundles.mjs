import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export async function cleanDesktopBundles(targetDirectory, workspaceDirectory) {
  if (!targetDirectory) {
    throw new Error("Desktop target directory is required.");
  }

  const workspacePath = resolve(workspaceDirectory);
  const bundlePath = resolve(workspacePath, targetDirectory, "release/bundle");
  const workspaceRelativePath = relative(workspacePath, bundlePath);

  if (
    !workspaceRelativePath ||
    isAbsolute(workspaceRelativePath) ||
    workspaceRelativePath === ".." ||
    workspaceRelativePath.startsWith(`..${sep}`)
  ) {
    throw new Error(
      `Desktop bundle directory is outside the workspace: ${bundlePath}`,
    );
  }

  await rm(bundlePath, { recursive: true, force: true });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await cleanDesktopBundles(process.env.DESKTOP_TARGET_DIR, process.cwd());
}
