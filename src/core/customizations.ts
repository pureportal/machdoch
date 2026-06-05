import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { parseMarkdownDocument } from "./frontmatter.js";
import type {
  CustomizationDiscoveryResult,
  DiscoveredInstruction,
  DiscoveredPrompt,
  DiscoveredSkill,
  ToolName,
} from "./types.js";

const PROMPT_TOOL_ALIASES: Record<string, ToolName> = {
  api: "network",
  bash: "shell",
  browser: "browser",
  cli: "shell",
  command: "shell",
  commands: "shell",
  cargo: "packages",
  checksum: "utilities",
  date: "utilities",
  diff: "utilities",
  directories: "filesystem",
  directory: "filesystem",
  fetch: "network",
  file: "filesystem",
  files: "filesystem",
  filesystem: "filesystem",
  folder: "filesystem",
  folders: "filesystem",
  fs: "filesystem",
  git: "git",
  http: "network",
  https: "network",
  json: "utilities",
  network: "network",
  guid: "utilities",
  hash: "utilities",
  regex: "utilities",
  npm: "packages",
  package: "packages",
  "package-manager": "packages",
  packages: "packages",
  pip: "packages",
  pnpm: "packages",
  powershell: "shell",
  repo: "git",
  repository: "git",
  request: "network",
  requests: "network",
  random: "utilities",
  recurring: "scheduler",
  recurrence: "scheduler",
  semver: "utilities",
  schedule: "scheduler",
  scheduled: "scheduler",
  scheduler: "scheduler",
  schedules: "scheduler",
  slug: "utilities",
  shell: "shell",
  sh: "shell",
  terminal: "shell",
  terminals: "shell",
  time: "utilities",
  utilities: "utilities",
  utility: "utilities",
  uuid: "utilities",
  ulid: "utilities",
  version: "utilities",
  web: "browser",
  webpage: "browser",
  website: "browser",
  yarn: "packages",
};

interface CustomizationDiscoveryOptions {
  discoverGithubCustomizations?: boolean;
}

/**
 * Converts an absolute path into a normalized workspace-relative path.
 */
const toWorkspaceRelativePath = (
  workspaceRoot: string,
  absolutePath: string,
): string => {
  return relative(workspaceRoot, absolutePath).split("\\").join("/");
};

/**
 * Recursively collects file paths beneath a directory when it exists.
 */
const walkFiles = async (directoryPath: string): Promise<string[]> => {
  if (!existsSync(directoryPath)) {
    return [];
  }

  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        return walkFiles(fullPath);
      }

      return [fullPath];
    }),
  );

  return files.flat();
};

/**
 * Derives a display name from a file path by trimming a known suffix.
 */
const deriveDocumentName = (filePath: string, suffix: string): string => {
  const fileName = basename(filePath);

  return fileName.endsWith(suffix)
    ? fileName.slice(0, -suffix.length)
    : fileName;
};

/**
 * Maps prompt-declared tool aliases to canonical internal tool names.
 */
const normalizePromptTools = (tools: unknown): ToolName[] => {
  if (!Array.isArray(tools)) {
    return [];
  }

  const normalizedTools: ToolName[] = [];

  for (const tool of tools) {
    if (typeof tool !== "string") {
      continue;
    }

    const normalizedTool = PROMPT_TOOL_ALIASES[tool.trim().toLowerCase()];

    if (!normalizedTool || normalizedTools.includes(normalizedTool)) {
      continue;
    }

    normalizedTools.push(normalizedTool);
  }

  return normalizedTools;
};

/**
 * Loads a discovered instruction document and normalizes its metadata.
 */
const loadInstruction = async (
  workspaceRoot: string,
  filePath: string,
  kind: DiscoveredInstruction["kind"],
  fallbackName?: string,
): Promise<DiscoveredInstruction> => {
  const content = await readFile(filePath, "utf8");
  const document = parseMarkdownDocument(content);
  const description =
    typeof document.attributes.description === "string"
      ? document.attributes.description
      : undefined;
  const applyTo =
    typeof document.attributes.applyTo === "string"
      ? document.attributes.applyTo
      : undefined;
  const priority =
    typeof document.attributes.priority === "number"
      ? document.attributes.priority
      : undefined;

  return {
    kind,
    path: toWorkspaceRelativePath(workspaceRoot, filePath),
    name:
      typeof document.attributes.name === "string"
        ? document.attributes.name
        : typeof fallbackName === "string"
          ? fallbackName
          : deriveDocumentName(filePath, ".instructions.md"),
    body: document.body,
    ...(description ? { description } : {}),
    ...(applyTo ? { applyTo } : {}),
    keywords: Array.isArray(document.attributes.keywords)
      ? document.attributes.keywords
      : [],
    ...(typeof priority === "number" ? { priority } : {}),
  };
};

/**
 * Loads a discovered prompt file and normalizes its frontmatter fields.
 */
const loadPrompt = async (
  workspaceRoot: string,
  filePath: string,
): Promise<DiscoveredPrompt> => {
  const content = await readFile(filePath, "utf8");
  const document = parseMarkdownDocument(content);
  const description =
    typeof document.attributes.description === "string"
      ? document.attributes.description
      : undefined;
  const agent =
    typeof document.attributes.agent === "string"
      ? document.attributes.agent
      : undefined;
  const model =
    typeof document.attributes.model === "string"
      ? document.attributes.model
      : undefined;
  const argumentHint =
    typeof document.attributes["argument-hint"] === "string"
      ? document.attributes["argument-hint"]
      : undefined;
  const inputs = Array.isArray(document.attributes.inputs)
    ? document.attributes.inputs
    : [];

  return {
    path: toWorkspaceRelativePath(workspaceRoot, filePath),
    name:
      typeof document.attributes.name === "string"
        ? document.attributes.name
        : deriveDocumentName(filePath, ".prompt.md"),
    ...(description ? { description } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    inputs,
    tools: normalizePromptTools(document.attributes.tools),
    body: document.body,
  };
};

/**
 * Loads a discovered skill definition and normalizes its metadata.
 */
const loadSkill = async (
  workspaceRoot: string,
  filePath: string,
): Promise<DiscoveredSkill> => {
  const content = await readFile(filePath, "utf8");
  const document = parseMarkdownDocument(content);
  const relativePath = toWorkspaceRelativePath(workspaceRoot, filePath);
  const pathSegments = relativePath.split("/");
  const fallbackName = pathSegments.at(-2) ?? "skill";
  const argumentHint =
    typeof document.attributes["argument-hint"] === "string"
      ? document.attributes["argument-hint"]
      : undefined;

  return {
    path: relativePath,
    name:
      typeof document.attributes.name === "string"
        ? document.attributes.name
        : fallbackName,
    description:
      typeof document.attributes.description === "string"
        ? document.attributes.description
        : "No description provided.",
    ...(argumentHint ? { argumentHint } : {}),
    userInvocable:
      typeof document.attributes["user-invocable"] === "boolean"
        ? document.attributes["user-invocable"]
        : true,
    disableModelInvocation:
      typeof document.attributes["disable-model-invocation"] === "boolean"
        ? document.attributes["disable-model-invocation"]
        : false,
  };
};

/**
 * Discovers workspace-level instructions, prompts, and skills from native
 * `.machdoch` folders and optional GitHub-compatible customization folders.
 */
export const discoverCustomizations = async (
  workspaceRoot: string,
  options?: CustomizationDiscoveryOptions,
): Promise<CustomizationDiscoveryResult> => {
  const machdochRoot = join(workspaceRoot, ".machdoch");
  const githubRoot = join(workspaceRoot, ".github");
  const alwaysOnInstructionPath = join(machdochRoot, "instructions.md");
  const conditionalInstructionRoot = join(machdochRoot, "instructions");
  const promptsRoot = join(machdochRoot, "prompts");
  const skillsRoot = join(machdochRoot, "skills");
  const githubAlwaysOnInstructionPath = join(
    githubRoot,
    "copilot-instructions.md",
  );
  const githubConditionalInstructionRoot = join(githubRoot, "instructions");
  const githubPromptsRoot = join(githubRoot, "prompts");
  const githubSkillsRoot = join(githubRoot, "skills");
  const agentsInstructionPath = join(workspaceRoot, "AGENTS.md");

  const instructions: DiscoveredInstruction[] = [];

  if (existsSync(alwaysOnInstructionPath)) {
    instructions.push(
      await loadInstruction(
        workspaceRoot,
        alwaysOnInstructionPath,
        "always-on",
      ),
    );
  }

  if (options?.discoverGithubCustomizations) {
    if (existsSync(githubAlwaysOnInstructionPath)) {
      instructions.push(
        await loadInstruction(
          workspaceRoot,
          githubAlwaysOnInstructionPath,
          "always-on",
          "copilot-instructions",
        ),
      );
    }

    if (existsSync(agentsInstructionPath)) {
      instructions.push(
        await loadInstruction(
          workspaceRoot,
          agentsInstructionPath,
          "always-on",
          "AGENTS",
        ),
      );
    }
  }

  const conditionalInstructionPaths = (
    await walkFiles(conditionalInstructionRoot)
  ).filter((filePath) => filePath.endsWith(".instructions.md"));
  const promptPaths = (await walkFiles(promptsRoot)).filter((filePath) =>
    filePath.endsWith(".prompt.md"),
  );
  const skillPaths = (await walkFiles(skillsRoot)).filter(
    (filePath) => basename(filePath) === "SKILL.md",
  );

  const githubConditionalInstructionPaths =
    options?.discoverGithubCustomizations
      ? (await walkFiles(githubConditionalInstructionRoot)).filter((filePath) =>
          filePath.endsWith(".instructions.md"),
        )
      : [];
  const githubPromptPaths = options?.discoverGithubCustomizations
    ? (await walkFiles(githubPromptsRoot)).filter((filePath) =>
        filePath.endsWith(".prompt.md"),
      )
    : [];
  const githubSkillPaths = options?.discoverGithubCustomizations
    ? (await walkFiles(githubSkillsRoot)).filter(
        (filePath) => basename(filePath) === "SKILL.md",
      )
    : [];

  for (const filePath of [
    ...conditionalInstructionPaths,
    ...githubConditionalInstructionPaths,
  ].sort()) {
    instructions.push(
      await loadInstruction(workspaceRoot, filePath, "conditional"),
    );
  }

  const prompts = await Promise.all(
    [...promptPaths, ...githubPromptPaths]
      .sort()
      .map((filePath) => loadPrompt(workspaceRoot, filePath)),
  );
  const skills = await Promise.all(
    [...skillPaths, ...githubSkillPaths]
      .sort()
      .map((filePath) => loadSkill(workspaceRoot, filePath)),
  );

  return {
    workspaceRoot,
    instructions,
    prompts,
    skills,
  };
};
