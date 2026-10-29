import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readStableRegularFile } from "../_helpers/read-stable-regular-file.helper.js";
import { linkCredentialFile } from "./credential-link.js";

const MAX_CLAUDE_AUTHENTICATION_BYTES = 1024 * 1024;

/**
 * Gives an isolated Claude config directory the user's claude.ai login.
 * Without it Claude Code reports "Not logged in" in every run unless an API
 * key or `CLAUDE_CODE_OAUTH_TOKEN` is set. Logins kept in the macOS keychain
 * have no file to share and are left alone.
 */
export const linkClaudeAuthentication = async (
  claudeHome: string,
): Promise<boolean> => {
  const sourceHome = resolve(
    process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"),
  );
  let sourcePath: string;
  try {
    sourcePath = await realpath(join(sourceHome, ".credentials.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const authentication = await readStableRegularFile(sourcePath, {
    maxBytes: MAX_CLAUDE_AUTHENTICATION_BYTES,
  });
  if (authentication === undefined) return false;

  try {
    await linkCredentialFile(sourcePath, join(claudeHome, ".credentials.json"));
  } catch (error) {
    throw new Error(
      "Claude credentials could not be linked into the isolated run. " +
        (process.platform === "win32"
          ? "Keep the Claude login and the temporary folder on the same drive, or enable Windows Developer Mode, then retry."
          : "Check filesystem permissions and symbolic-link support, then retry."),
      { cause: error },
    );
  }
  return true;
};
