import { realpath, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readStableRegularFile } from "../_helpers/read-stable-regular-file.helper.js";

const MAX_CODEX_AUTHENTICATION_BYTES = 4 * 1024 * 1024;

export const linkCodexAuthentication = async (
  codexHome: string,
): Promise<boolean> => {
  const sourceHome = resolve(
    process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
  );
  let sourcePath: string;
  try {
    sourcePath = await realpath(join(sourceHome, "auth.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const authentication = await readStableRegularFile(sourcePath, {
    maxBytes: MAX_CODEX_AUTHENTICATION_BYTES,
  });
  if (authentication === undefined) return false;

  try {
    await symlink(sourcePath, join(codexHome, "auth.json"), "file");
  } catch (error) {
    throw new Error(
      "Codex credentials could not be linked into the isolated run. " +
        (process.platform === "win32"
          ? "Enable Windows Developer Mode or grant symbolic-link creation rights, then retry."
          : "Check filesystem permissions and symbolic-link support, then retry."),
      { cause: error },
    );
  }
  return true;
};
