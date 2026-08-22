import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { getUserConfigPath } from "./env.js";
import { parseMarkdownDocument } from "./frontmatter.js";
import type {
  CustomizationDiscoveryResult,
  CustomizationScope,
  DiscoveredPrompt,
  DiscoveredSkill,
} from "./types.js";
import type { ToolName } from "./runtime-contract.generated.js";

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
  guid: "utilities",
  hash: "utilities",
  http: "network",
  https: "network",
  json: "utilities",
  network: "network",
  npm: "packages",
  package: "packages",
  "package-manager": "packages",
  packages: "packages",
  pip: "packages",
  pnpm: "packages",
  powershell: "shell",
  random: "utilities",
  recurrence: "scheduler",
  recurring: "scheduler",
  regex: "utilities",
  repo: "git",
  repository: "git",
  request: "network",
  requests: "network",
  schedule: "scheduler",
  scheduled: "scheduler",
  scheduler: "scheduler",
  schedules: "scheduler",
  semver: "utilities",
  sh: "shell",
  shell: "shell",
  slug: "utilities",
  terminal: "shell",
  terminals: "shell",
  time: "utilities",
  ulid: "utilities",
  utilities: "utilities",
  utility: "utilities",
  uuid: "utilities",
  version: "utilities",
  web: "browser",
  webpage: "browser",
  website: "browser",
  yarn: "packages",
};

export interface CustomizationDiscoveryOptions {
  discoverGithubCustomizations?: boolean;
  discoverUserCustomizations?: boolean;
  includeDiagnostics?: boolean;
}

const toWorkspaceRelativePath = (
  workspaceRoot: string,
  absolutePath: string,
): string => relative(workspaceRoot, absolutePath).split("\\").join("/");

export const getUserCustomizationRoot = (): string =>
  dirname(getUserConfigPath());

export const getUserPromptDirectory = (): string =>
  join(getUserCustomizationRoot(), "prompts");

export const getUserSkillDirectory = (): string =>
  join(getUserCustomizationRoot(), "skills");

const toCustomizationPath = (
  workspaceRoot: string,
  absolutePath: string,
  options?: {
    scope?: CustomizationScope;
    pathRoot?: "user" | "workspace";
  },
): string =>
  options?.scope === "user" || options?.pathRoot === "user"
    ? absolutePath
    : toWorkspaceRelativePath(workspaceRoot, absolutePath);

const walkFiles = async (directoryPath: string): Promise<string[]> => {
  if (!existsSync(directoryPath)) return [];

  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(directoryPath, entry.name);
      return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
    }),
  );
  return files.flat();
};

const deriveDocumentName = (filePath: string, suffix: string): string => {
  const fileName = basename(filePath);
  return fileName.endsWith(suffix)
    ? fileName.slice(0, -suffix.length)
    : fileName;
};

const normalizePromptTools = (tools: unknown): ToolName[] => {
  if (!Array.isArray(tools)) return [];

  const normalizedTools: ToolName[] = [];
  for (const tool of tools) {
    if (typeof tool !== "string") continue;
    const normalizedTool = PROMPT_TOOL_ALIASES[tool.trim().toLowerCase()];
    if (normalizedTool && !normalizedTools.includes(normalizedTool)) {
      normalizedTools.push(normalizedTool);
    }
  }
  return normalizedTools;
};

const loadPrompt = async (
  workspaceRoot: string,
  filePath: string,
  options?: {
    scope?: CustomizationScope;
    pathRoot?: "user" | "workspace";
  },
): Promise<DiscoveredPrompt> => {
  const document = parseMarkdownDocument(await readFile(filePath, "utf8"));
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

  return {
    path: toCustomizationPath(workspaceRoot, filePath, options),
    name:
      typeof document.attributes.name === "string"
        ? document.attributes.name
        : deriveDocumentName(filePath, ".prompt.md"),
    ...(options?.scope ? { scope: options.scope } : {}),
    ...(description ? { description } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    inputs: Array.isArray(document.attributes.inputs)
      ? document.attributes.inputs
      : [],
    tools: normalizePromptTools(document.attributes.tools),
    body: document.body,
  };
};

const loadSkill = async (
  workspaceRoot: string,
  filePath: string,
  options?: {
    scope?: CustomizationScope;
    pathRoot?: "user" | "workspace";
  },
): Promise<DiscoveredSkill> => {
  const document = parseMarkdownDocument(await readFile(filePath, "utf8"));
  const displayPath = toCustomizationPath(workspaceRoot, filePath, options);
  const pathSegments = displayPath.replace(/\\/gu, "/").split("/");
  const argumentHint =
    typeof document.attributes["argument-hint"] === "string"
      ? document.attributes["argument-hint"]
      : undefined;

  return {
    path: displayPath,
    name:
      typeof document.attributes.name === "string"
        ? document.attributes.name
        : pathSegments.at(-2) ?? "skill",
    ...(options?.scope ? { scope: options.scope } : {}),
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

export const discoverCustomizations = async (
  workspaceRoot: string,
  options?: CustomizationDiscoveryOptions,
): Promise<CustomizationDiscoveryResult> => {
  const userRoot = getUserCustomizationRoot();
  const workspaceRootDirectory = join(workspaceRoot, ".machdoch");
  const githubRoot = join(workspaceRoot, ".github");

  const workspacePromptPaths = (
    await walkFiles(join(workspaceRootDirectory, "prompts"))
  )
    .filter((path) => path.endsWith(".prompt.md"))
    .sort();
  const workspaceSkillPaths = (
    await walkFiles(join(workspaceRootDirectory, "skills"))
  )
    .filter((path) => basename(path) === "SKILL.md")
    .sort();
  const githubPromptPaths = options?.discoverGithubCustomizations
    ? (await walkFiles(join(githubRoot, "prompts")))
        .filter((path) => path.endsWith(".prompt.md"))
        .sort()
    : [];
  const githubSkillPaths = options?.discoverGithubCustomizations
    ? (await walkFiles(join(githubRoot, "skills")))
        .filter((path) => basename(path) === "SKILL.md")
        .sort()
    : [];
  const userPromptPaths = options?.discoverUserCustomizations
    ? (await walkFiles(join(userRoot, "prompts")))
        .filter((path) => path.endsWith(".prompt.md"))
        .sort()
    : [];
  const userSkillPaths = options?.discoverUserCustomizations
    ? (await walkFiles(join(userRoot, "skills")))
        .filter((path) => basename(path) === "SKILL.md")
        .sort()
    : [];

  const prompts = await Promise.all([
    ...workspacePromptPaths.map((path) => loadPrompt(workspaceRoot, path)),
    ...githubPromptPaths.map((path) =>
      loadPrompt(workspaceRoot, path, { scope: "github" }),
    ),
    ...userPromptPaths.map((path) =>
      loadPrompt(workspaceRoot, path, {
        scope: "user",
        pathRoot: "user",
      }),
    ),
  ]);
  const skills = await Promise.all([
    ...workspaceSkillPaths.map((path) => loadSkill(workspaceRoot, path)),
    ...githubSkillPaths.map((path) =>
      loadSkill(workspaceRoot, path, { scope: "github" }),
    ),
    ...userSkillPaths.map((path) =>
      loadSkill(workspaceRoot, path, {
        scope: "user",
        pathRoot: "user",
      }),
    ),
  ]);

  return {
    workspaceRoot,
    prompts,
    skills,
  };
};
