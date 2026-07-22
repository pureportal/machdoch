import { copyFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileAtomically, writeJsonAtomically } from "../_helpers/write-file-atomically.helper.js";

export interface ProviderNativeCleanupResult {
  removedInstructionFiles: string[];
  cleanedMcpFiles: string[];
  backupFiles: string[];
}

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".machdoch",
  ".next",
  ".pnpm",
  ".svn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);

const pathExists = async (path: string): Promise<boolean> => {
  return await stat(path).then(() => true, () => false);
};

const createBackup = async (path: string): Promise<string> => {
  const suffix = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupPath = `${path}.machdoch-backup-${suffix}`;
  await copyFile(path, backupPath);
  return backupPath;
};

const removeFileWithBackup = async (
  path: string,
  result: ProviderNativeCleanupResult,
): Promise<void> => {
  if (!(await pathExists(path))) return;
  result.backupFiles.push(await createBackup(path));
  await rm(path, { force: true });
  result.removedInstructionFiles.push(path);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const normalizePathIdentity = (path: string): string => {
  const normalized = resolve(path).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
};

const removeMcpServersFromJson = async (
  path: string,
  result: ProviderNativeCleanupResult,
  workspaceRoot?: string,
): Promise<void> => {
  if (!(await pathExists(path))) return;
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(parsed)) return;

  let changed = false;
  if ("mcpServers" in parsed) {
    delete parsed.mcpServers;
    changed = true;
  }

  if (workspaceRoot && isRecord(parsed.projects)) {
    const workspaceIdentity = normalizePathIdentity(workspaceRoot);
    for (const [projectPath, rawProject] of Object.entries(parsed.projects)) {
      if (
        normalizePathIdentity(projectPath) !== workspaceIdentity ||
        !isRecord(rawProject) ||
        !("mcpServers" in rawProject)
      ) {
        continue;
      }
      delete rawProject.mcpServers;
      changed = true;
    }
  }

  if (!changed) return;
  result.backupFiles.push(await createBackup(path));
  if (Object.keys(parsed).length === 0) {
    await rm(path, { force: true });
  } else {
    await writeJsonAtomically(path, parsed);
  }
  result.cleanedMcpFiles.push(path);
};

const removeMcpServersFromCodexToml = (content: string): string => {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const retained: string[] = [];
  let inMcpSection = false;

  for (const line of lines) {
    const table = /^\s*\[(?<name>[^\]]+)\]\s*(?:#.*)?$/u.exec(line)?.groups?.name?.trim();
    if (table) {
      inMcpSection = table === "mcp_servers" || table.startsWith("mcp_servers.");
      if (inMcpSection) continue;
    }
    if (inMcpSection || /^\s*mcp_servers\s*=/u.test(line)) continue;
    retained.push(line);
  }

  return `${retained.join("\n").trim()}${retained.some((line) => line.trim()) ? "\n" : ""}`;
};

const cleanCodexMcpFile = async (
  path: string,
  result: ProviderNativeCleanupResult,
): Promise<void> => {
  if (!(await pathExists(path))) return;
  const existing = await readFile(path, "utf8");
  const next = removeMcpServersFromCodexToml(existing);
  if (next === existing) return;

  result.backupFiles.push(await createBackup(path));
  if (!next.trim()) {
    await rm(path, { force: true });
  } else {
    await writeFileAtomically(path, next);
  }
  result.cleanedMcpFiles.push(path);
};

const readCodexFallbackInstructionNames = async (
  configPath: string,
): Promise<Set<string>> => {
  const names = new Set<string>();
  const content = await readFile(configPath, "utf8").catch(() => "");
  const value = /^\s*project_doc_fallback_filenames\s*=\s*\[(?<value>[^\]]*)\]/gmu
    .exec(content)?.groups?.value;
  if (!value) return names;

  for (const match of value.matchAll(/["'](?<name>[^"']+)["']/gu)) {
    const name = match.groups?.name?.trim();
    if (name && !name.includes("/") && !name.includes("\\")) names.add(name.toLocaleLowerCase());
  }
  return names;
};

const collectWorkspaceInstructionFiles = async (
  workspaceRoot: string,
  codexFallbackNames: ReadonlySet<string>,
): Promise<string[]> => {
  const matches: string[] = [];
  const workspaceIdentity = normalizePathIdentity(workspaceRoot);
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORY_NAMES.has(entry.name.toLocaleLowerCase())) {
          await visit(path);
        }
        continue;
      }
      if (!entry.isFile()) continue;

      const name = entry.name.toLocaleLowerCase();
      const normalized = path.replaceAll("\\", "/").toLocaleLowerCase();
      const isInstructionFile =
        name === "agents.md" ||
        name === "agents.override.md" ||
        name === "claude.md" ||
        name === "claude.local.md" ||
        name === "gemini.md" ||
        name === "copilot-instructions.md" ||
        (normalizePathIdentity(directory) === workspaceIdentity &&
          codexFallbackNames.has(name)) ||
        (normalized.includes("/.claude/rules/") && name.endsWith(".md")) ||
        (normalized.includes("/.github/instructions/") && name.endsWith(".instructions.md"));
      if (isInstructionFile) matches.push(path);
    }
  };

  await visit(workspaceRoot);
  return matches.sort((left, right) => left.localeCompare(right));
};

const collectMarkdownFiles = async (directory: string): Promise<string[]> => {
  const matches: string[] = [];
  const visit = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.toLocaleLowerCase().endsWith(".md")) {
        matches.push(entryPath);
      }
    }
  };
  await visit(directory);
  return matches;
};

export const cleanupProviderNativeState = async (
  workspaceRoot: string,
): Promise<ProviderNativeCleanupResult> => {
  workspaceRoot = resolve(workspaceRoot);
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  const copilotHome = process.env.COPILOT_HOME?.trim() || join(homedir(), ".copilot");
  const result: ProviderNativeCleanupResult = {
    removedInstructionFiles: [],
    cleanedMcpFiles: [],
    backupFiles: [],
  };

  const codexConfigPath = join(codexHome, "config.toml");
  const fallbackNames = await readCodexFallbackInstructionNames(codexConfigPath);
  const instructionPaths = new Set<string>([
    join(codexHome, "AGENTS.md"),
    join(codexHome, "AGENTS.override.md"),
    join(claudeHome, "CLAUDE.md"),
    join(copilotHome, "copilot-instructions.md"),
    ...(await collectMarkdownFiles(join(claudeHome, "rules"))),
    ...(await collectMarkdownFiles(join(copilotHome, "instructions"))),
    ...(await collectWorkspaceInstructionFiles(workspaceRoot, fallbackNames)),
  ]);
  for (const path of [...instructionPaths].sort()) {
    await removeFileWithBackup(path, result);
  }

  await cleanCodexMcpFile(codexConfigPath, result);
  await cleanCodexMcpFile(join(workspaceRoot, ".codex", "config.toml"), result);
  await removeMcpServersFromJson(join(homedir(), ".claude.json"), result, workspaceRoot);
  await removeMcpServersFromJson(join(workspaceRoot, ".mcp.json"), result);
  await removeMcpServersFromJson(join(copilotHome, "mcp-config.json"), result);
  await removeMcpServersFromJson(join(workspaceRoot, ".github", "mcp.json"), result);

  result.removedInstructionFiles.sort((left, right) => left.localeCompare(right));
  result.cleanedMcpFiles.sort((left, right) => left.localeCompare(right));
  result.backupFiles.sort((left, right) => left.localeCompare(right));
  return result;
};
