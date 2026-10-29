import { link, symlink } from "node:fs/promises";

/**
 * Shares a provider login file with an isolated run, so a token the CLI
 * refreshes during the run reaches the user's own login. Windows only lets
 * privileged or Developer Mode accounts create symbolic links; there a hard
 * link to the same file shares it just the same.
 */
export const linkCredentialFile = async (
  sourcePath: string,
  targetPath: string,
): Promise<void> => {
  try {
    await symlink(sourcePath, targetPath, "file");
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) {
      throw error;
    }
  }
  await link(sourcePath, targetPath);
};
