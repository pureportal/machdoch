import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import { readStableRegularFile } from "../_helpers/read-stable-regular-file.helper.js";

const execute = promisify(execFile);
const ignoredDirectories = new Set([
  ".git",
  ".machdoch",
  ".next",
  ".cache",
  "node_modules",
  "dist",
  "build",
  "target",
  "coverage",
  "vendor",
  ".venv",
]);
const textExtensions = new Set([
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".xml",
  ".html",
  ".css",
  ".scss",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".c",
  ".cpp",
  ".h",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".sh",
  ".ps1",
  ".sql",
]);
const textNames = new Set(["readme", "license", "makefile", "dockerfile"]);
const maximumFiles = 20_000;
export const maximumKnowledgeFileBytes = 1024 * 1024;

export function eligibleKnowledgePath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  const name = parts.at(-1)?.toLowerCase() ?? "";
  return (
    !parts.some((part) => ignoredDirectories.has(part.toLowerCase())) &&
    !name.startsWith(".env") &&
    !/(?:credential|secret|private[-_]?key|lock)(?:\.|$)/iu.test(name) &&
    (textExtensions.has(extname(name)) || textNames.has(name))
  );
}

export async function listKnowledgeFiles(root: string): Promise<string[]> {
  let paths: string[];
  let gitWorkspace = false;
  for (let directory = root; ; directory = dirname(directory)) {
    try {
      await lstat(join(directory, ".git"));
      gitWorkspace = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(directory) === directory) break;
  }
  if (gitWorkspace) {
    const output = await execute(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    paths = output.stdout.split("\0").filter(Boolean);
  } else {
    paths = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 40)
        throw new Error("Workspace search exceeds 40 directory levels.");
      for (const entry of await readdir(join(root, directory), {
        withFileTypes: true,
      })) {
        if (entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (
          entry.isDirectory() &&
          !ignoredDirectories.has(entry.name.toLowerCase())
        )
          await visit(path, depth + 1);
        else if (entry.isFile() && eligibleKnowledgePath(path))
          paths.push(path);
        if (paths.length > maximumFiles)
          throw new Error(
            "Workspace search supports up to 20,000 text files. Select a smaller workspace.",
          );
      }
    };
    await visit("", 0);
  }
  paths = [...new Set(paths.filter(eligibleKnowledgePath))].sort();
  if (paths.length > maximumFiles)
    throw new Error(
      "Workspace search supports up to 20,000 text files. Select a smaller workspace.",
    );
  return paths;
}

export async function readKnowledgeFile(
  root: string,
  path: string,
): Promise<{
  content: string;
  fingerprint: string;
  size: number;
  modified: number;
} | null> {
  if (
    isAbsolute(path) ||
    path.split(/[\\/]/u).includes("..") ||
    !eligibleKnowledgePath(path)
  )
    return null;
  const absolutePath = resolve(root, path);
  let current = root;
  try {
    for (const part of relative(root, absolutePath).split(/[\\/]/u)) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) return null;
    }
    const resolvedPath = await realpath(absolutePath);
    const within = relative(root, resolvedPath);
    if (within.startsWith("..") || isAbsolute(within)) return null;
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.size > maximumKnowledgeFileBytes)
      return null;
    const bytes = await readStableRegularFile(absolutePath, {
      maxBytes: maximumKnowledgeFileBytes,
    });
    if (!bytes || bytes.includes(0)) return null;
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
    return {
      content: content.replaceAll("\r\n", "\n"),
      fingerprint: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      modified: metadata.mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function knowledgeChunks(
  content: string,
): { startLine: number; endLine: number; content: string }[] {
  const lines = content.split(/\r?\n/u);
  const chunks = [];
  for (let start = 0; start < lines.length;) {
    const first = lines[start] ?? "";
    if (first.length > 8000) {
      for (let offset = 0; offset < first.length; offset += 7600)
        chunks.push({
          startLine: start + 1,
          endLine: start + 1,
          content: first.slice(offset, offset + 8000),
        });
      start++;
      continue;
    }
    let end = start;
    let length = 0;
    while (
      end < lines.length &&
      end - start < 80 &&
      length + (lines[end]?.length ?? 0) <= 8000
    )
      length += (lines[end++]?.length ?? 0) + 1;
    chunks.push({
      startLine: start + 1,
      endLine: end,
      content: lines.slice(start, end).join("\n"),
    });
    if (end === lines.length) break;
    start = Math.max(start + 1, end - 8);
  }
  return chunks;
}
