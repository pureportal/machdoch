import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const MAX_SCAN_DEPTH = 3;
const MAX_SCANNED_DIRECTORIES = 400;
const MAX_LISTED_DIRECTORY_DEPTH = 2;
const MAX_LISTED_DIRECTORIES = 200;
const MAX_FILE_CHARACTERS = 8_000;
const MAX_README_CHARACTERS = 3_000;
const MAX_EVIDENCE_CHARACTERS = 90_000;
const MAX_LISTED_DEPENDENCIES = 80;

const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "vendor",
  "venv",
  "__pycache__",
  "bin",
  "obj",
  "tmp",
  "temp",
  "logs",
]);

const MANIFEST_FILE_NAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "deno.json",
  "deno.jsonc",
  "Cargo.toml",
  "pyproject.toml",
  "manage.py",
  "go.mod",
  "composer.json",
  "Gemfile",
  "mix.exs",
  "Makefile",
  "makefile",
  "justfile",
  "Justfile",
  "Taskfile.yml",
  "Taskfile.yaml",
  "Procfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
]);

const LOCKFILE_NAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
]);

const EDITOR_LAUNCH_FILES = ["launch.json", "tasks.json"];

export interface WorkspaceRunEvidence {
  directories: string[];
  lockfiles: string[];
  files: { path: string; content: string }[];
}

const toWorkspacePath = (root: string, path: string): string =>
  relative(root, path).replaceAll("\\", "/") || ".";

const truncate = (content: string, maximum: number): string =>
  content.length > maximum
    ? `${content.slice(0, maximum)}\n... (truncated)`
    : content;

const condensePackageManifest = (content: string): string => {
  let manifest: unknown;
  try {
    manifest = JSON.parse(content);
  } catch {
    return content;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return content;
  }
  const source = manifest as Record<string, unknown>;
  const dependencyNames = ["dependencies", "devDependencies"].flatMap(
    (field) => {
      const dependencies = source[field];
      return dependencies && typeof dependencies === "object"
        ? Object.keys(dependencies)
        : [];
    },
  );
  const condensed = Object.fromEntries(
    [
      "name",
      "private",
      "packageManager",
      "workspaces",
      "type",
      "main",
      "bin",
      "scripts",
    ].flatMap((field) =>
      source[field] === undefined ? [] : [[field, source[field]] as const],
    ),
  );
  if (dependencyNames.length > 0) {
    condensed.dependencyNames = dependencyNames.slice(
      0,
      MAX_LISTED_DEPENDENCIES,
    );
  }
  return JSON.stringify(condensed, null, 2);
};

const readEvidenceFile = async (
  path: string,
  maximum: number,
): Promise<string | null> => {
  try {
    const content = await readFile(path, "utf8");
    return truncate(
      path.endsWith("package.json")
        ? condensePackageManifest(content)
        : content,
      maximum,
    );
  } catch {
    return null;
  }
};

export const collectWorkspaceRunEvidence = async (
  workspaceRoot: string,
): Promise<WorkspaceRunEvidence> => {
  const directories: string[] = [];
  const lockfiles: string[] = [];
  const candidates: { path: string; depth: number; maximum: number }[] = [];
  const queue = [{ path: workspaceRoot, depth: 0 }];
  let scanned = 0;

  while (queue.length > 0 && scanned < MAX_SCANNED_DIRECTORIES) {
    const directory = queue.shift()!;
    scanned += 1;
    let entries;
    try {
      entries = await readdir(directory.path, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory.path, entry.name);
      if (entry.isFile()) {
        if (LOCKFILE_NAMES.has(entry.name)) {
          lockfiles.push(toWorkspacePath(workspaceRoot, path));
        } else if (MANIFEST_FILE_NAMES.has(entry.name)) {
          candidates.push({
            path,
            depth: directory.depth,
            maximum: MAX_FILE_CHARACTERS,
          });
        } else if (
          directory.depth === 0 &&
          (entry.name.endsWith(".code-workspace") ||
            entry.name.endsWith(".code-workspace.example"))
        ) {
          candidates.push({ path, depth: 0, maximum: MAX_FILE_CHARACTERS * 4 });
        } else if (directory.depth === 0 && /^readme\.md$/iu.test(entry.name)) {
          candidates.push({ path, depth: 0, maximum: MAX_README_CHARACTERS });
        }
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (entry.name === ".vscode") {
        for (const name of EDITOR_LAUNCH_FILES) {
          candidates.push({
            path: join(path, name),
            depth: directory.depth,
            maximum: MAX_FILE_CHARACTERS * 2,
          });
        }
        continue;
      }
      if (
        entry.name.startsWith(".") ||
        IGNORED_DIRECTORY_NAMES.has(entry.name) ||
        directory.depth >= MAX_SCAN_DEPTH
      ) {
        continue;
      }
      if (
        directory.depth < MAX_LISTED_DIRECTORY_DEPTH &&
        directories.length < MAX_LISTED_DIRECTORIES
      ) {
        directories.push(toWorkspacePath(workspaceRoot, path));
      }
      queue.push({ path, depth: directory.depth + 1 });
    }
  }

  candidates.sort(
    (left, right) =>
      left.depth - right.depth || left.path.localeCompare(right.path),
  );
  const hasWorkspaceFile = candidates.some((candidate) =>
    candidate.path.endsWith(".code-workspace"),
  );
  const files: WorkspaceRunEvidence["files"] = [];
  let usedCharacters = 0;
  for (const candidate of candidates) {
    if (
      hasWorkspaceFile &&
      candidate.path.endsWith(".code-workspace.example")
    ) {
      continue;
    }
    const content = await readEvidenceFile(candidate.path, candidate.maximum);
    if (content === null) continue;
    if (usedCharacters + content.length > MAX_EVIDENCE_CHARACTERS) break;
    usedCharacters += content.length;
    files.push({
      path: toWorkspacePath(workspaceRoot, candidate.path),
      content,
    });
  }

  return { directories, lockfiles, files };
};

export const formatWorkspaceRunEvidence = (
  evidence: WorkspaceRunEvidence,
): string =>
  [
    "Workspace directories (relative to the workspace root):",
    evidence.directories.length > 0
      ? evidence.directories.map((directory) => `- ${directory}`).join("\n")
      : "- (none)",
    `Lockfiles: ${evidence.lockfiles.join(", ") || "(none)"}`,
    ...evidence.files.map(
      (file) => `File: ${file.path}\n<<<\n${file.content}\n>>>`,
    ),
  ].join("\n\n");
