import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readStableRegularFile } from "../_helpers/read-stable-regular-file.helper.js";
import { linkCredentialFile } from "./credential-link.js";

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
    await linkCredentialFile(sourcePath, join(codexHome, "auth.json"));
  } catch (error) {
    throw new Error(
      "Codex credentials could not be linked into the isolated run. " +
        (process.platform === "win32"
          ? "Keep the Codex login and the temporary folder on the same drive, or enable Windows Developer Mode, then retry."
          : "Check filesystem permissions and symbolic-link support, then retry."),
      { cause: error },
    );
  }
  return true;
};
