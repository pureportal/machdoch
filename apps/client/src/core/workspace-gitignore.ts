import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";
import { writeFileAtomically } from "./_helpers/write-file-atomically.helper.js";

const IGNORE_PATTERNS = [
  "/local/",
  "*.machdoch.lock*/",
  "*.json.lock/",
  "*.tmp",
] as const;

const readRegularFile = async (path: string): Promise<string | undefined> => {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Workspace storage must be a regular file: ${path}`);
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

export const isWorkspaceGitignoreEnabled = async (
  workspaceRoot: string,
): Promise<boolean> => {
  const raw = await readRegularFile(
    join(workspaceRoot, ".machdoch/config.json"),
  );
  if (raw === undefined) return true;
  const config: unknown = JSON.parse(raw);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Expected workspace config to be a JSON object.");
  }
  if (!("autoGitignore" in config)) return true;
  if (typeof config.autoGitignore !== "boolean") {
    throw new Error("Expected autoGitignore to be a boolean.");
  }
  return config.autoGitignore;
};

const withMissingPatterns = (original: string): string => {
  const lines = original.split(/\r?\n/u);
  const missing = IGNORE_PATTERNS.filter(
    (pattern) => !lines.some((line) => line.trim() === pattern),
  );
  if (missing.length === 0) return original;
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const separator = original && !original.endsWith("\n") ? newline : "";
  return `${original}${separator}${missing.join(newline)}${newline}`;
};

export const ensureWorkspaceGitignore = async (
  workspaceRoot: string,
): Promise<void> => {
  const directory = join(workspaceRoot, ".machdoch");
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(
      `Workspace storage must be a regular directory: ${directory}`,
    );
  }
  if (!(await isWorkspaceGitignoreEnabled(workspaceRoot))) return;
  const path = join(directory, ".gitignore");
  const original = (await readRegularFile(path)) ?? "";
  if (withMissingPatterns(original) === original) return;
  await withCooperativeFileLock(path, async () => {
    if (!(await isWorkspaceGitignoreEnabled(workspaceRoot))) return;
    const latest = (await readRegularFile(path)) ?? "";
    const updated = withMissingPatterns(latest);
    if (updated !== latest) await writeFileAtomically(path, updated);
  });
};
