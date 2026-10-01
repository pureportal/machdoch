import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { splitInteractiveArguments } from "./cli-interactive-commands.js";

export const editPrompt = async (initialValue = ""): Promise<string> => {
  const editor =
    process.env.VISUAL?.trim() ||
    process.env.EDITOR?.trim() ||
    (process.platform === "win32" ? "notepad.exe" : "vi");
  const [command, ...args] = splitInteractiveArguments(editor);
  if (!command)
    throw new Error("Set VISUAL or EDITOR to a text editor executable.");
  const directory = await mkdtemp(join(tmpdir(), "machdoch-prompt-"));
  const path = join(directory, "prompt.md");
  try {
    await writeFile(path, initialValue, { encoding: "utf8", mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [...args, path], {
        stdio: "inherit",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `Editor exited ${signal ?? code}. Check VISUAL or EDITOR and try again.`,
              ),
            ),
      );
    });
    return await readFile(path, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
