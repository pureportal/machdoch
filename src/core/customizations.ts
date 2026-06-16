import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { getUserConfigPath } from "./env.js";
import { parseMarkdownDocument } from "./frontmatter.js";
import type {
  CustomizationDiagnostic,
  CustomizationDiscoveryResult,
  DiscoveredInstruction,
  DiscoveredPrompt,
  DiscoveredSkill,
  FrontmatterValue,
  InstructionAudience,
  InstructionMode,
  InstructionScope,
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

export interface CustomizationDiscoveryOptions {
  discoverGithubCustomizations?: boolean;
  discoverUserCustomizations?: boolean;
  includeDiagnostics?: boolean;
}

const MAX_INSTRUCTION_FILE_BYTES = 128 * 1024;

const INSTRUCTION_MODE_VALUES = new Set<InstructionMode>([
  "always",
  "auto",
  "agent-requested",
  "manual",
  "disabled",
]);

const INSTRUCTION_AUDIENCE_VALUES = new Set<InstructionAudience>([
  "executor",
  "validator",
  "generator",
  "all",
]);

/**
 * Converts an absolute path into a normalized workspace-relative path.
 */
const toWorkspaceRelativePath = (
  workspaceRoot: string,
  absolutePath: string,
): string => {
  return relative(workspaceRoot, absolutePath).split("\\").join("/");
};

export const getUserCustomizationRoot = (): string => {
  return dirname(getUserConfigPath());
};

export const getUserInstructionDirectory = (): string => {
  return join(getUserCustomizationRoot(), "instructions");
};

/**
 * Uses absolute paths for user-global instructions and workspace-relative paths
 * for repository-owned instruction files.
 */
const toInstructionPath = (
  workspaceRoot: string,
  absolutePath: string,
  scope?: InstructionScope,
): string => {
  if (scope === "user") {
    return absolutePath;
  }

  return toWorkspaceRelativePath(workspaceRoot, absolutePath);
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

const readStringAttribute = (
  attributes: Record<string, FrontmatterValue>,
  names: string[],
): string | undefined => {
  for (const name of names) {
    const value = attributes[name];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
};

const readStringListAttribute = (
  attributes: Record<string, FrontmatterValue>,
  names: string[],
): string[] => {
  const values: string[] = [];

  for (const name of names) {
    const value = attributes[name];

    if (Array.isArray(value)) {
      values.push(...value);
      continue;
    }

    if (typeof value === "string") {
      values.push(...value.split(/[,;\n]/u));
    }
  }

  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
};

const readNumberAttribute = (
  attributes: Record<string, FrontmatterValue>,
  name: string,
): number | undefined => {
  const value = attributes[name];

  return typeof value === "number" ? value : undefined;
};

const normalizeInstructionModeValue = (
  value: string,
): InstructionMode | undefined => {
  const normalizedValue = value.trim().toLowerCase().replace(/_/gu, "-");

  if (normalizedValue === "always-on") {
    return "always";
  }

  if (normalizedValue === "auto-attached") {
    return "auto";
  }

  return INSTRUCTION_MODE_VALUES.has(normalizedValue as InstructionMode)
    ? (normalizedValue as InstructionMode)
    : undefined;
};

const readInstructionMode = (
  attributes: Record<string, FrontmatterValue>,
  filePath: string,
  diagnostics?: CustomizationDiagnostic[],
): InstructionMode | undefined => {
  const value = readStringAttribute(attributes, ["mode", "activation"]);

  if (!value) {
    return undefined;
  }

  const mode = normalizeInstructionModeValue(value);

  if (!mode) {
    diagnostics?.push({
      level: "warning",
      code: "invalid-instruction-mode",
      message: `Unsupported instruction mode "${value}". Expected always, auto, agent-requested, manual, disabled.`,
      path: filePath,
    });
  }

  return mode;
};

const readInstructionAudience = (
  attributes: Record<string, FrontmatterValue>,
  filePath: string,
  diagnostics?: CustomizationDiagnostic[],
): InstructionAudience | undefined => {
  const value = readStringAttribute(attributes, ["audience"]);

  if (!value) {
    return undefined;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (INSTRUCTION_AUDIENCE_VALUES.has(normalizedValue as InstructionAudience)) {
    return normalizedValue as InstructionAudience;
  }

  diagnostics?.push({
    level: "warning",
    code: "invalid-instruction-audience",
    message: `Unsupported instruction audience "${value}". Expected executor, validator, generator, or all.`,
    path: filePath,
  });

  return undefined;
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
interface LoadInstructionOptions {
  fallbackName?: string;
  scope?: InstructionScope;
  diagnostics?: CustomizationDiagnostic[];
}

const loadInstruction = async (
  workspaceRoot: string,
  filePath: string,
  kind: DiscoveredInstruction["kind"],
  options?: LoadInstructionOptions,
): Promise<DiscoveredInstruction> => {
  const content = await readFile(filePath, "utf8");
  const sizeBytes = Buffer.byteLength(content, "utf8");
  const effectiveContent =
    sizeBytes > MAX_INSTRUCTION_FILE_BYTES
      ? content.slice(0, MAX_INSTRUCTION_FILE_BYTES)
      : content;

  if (sizeBytes > MAX_INSTRUCTION_FILE_BYTES) {
    options?.diagnostics?.push({
      level: "warning",
      code: "instruction-file-too-large",
      message: `Instruction file exceeds ${MAX_INSTRUCTION_FILE_BYTES} bytes and was truncated during discovery.`,
      path: filePath,
    });
  }

  const document = parseMarkdownDocument(effectiveContent);
  const description = readStringAttribute(document.attributes, ["description"]);
  const applyToPatterns = readStringListAttribute(document.attributes, [
    "applyTo",
    "apply_to",
    "apply-to",
    "globs",
    "paths",
  ]);
  const excludePatterns = readStringListAttribute(document.attributes, [
    "exclude",
    "excludeTo",
    "exclude_to",
    "exclude-to",
    "excludePaths",
    "exclude_paths",
  ]);
  const mode = readInstructionMode(
    document.attributes,
    filePath,
    options?.diagnostics,
  );
  const audience = readInstructionAudience(
    document.attributes,
    filePath,
    options?.diagnostics,
  );
  const priority = readNumberAttribute(document.attributes, "priority");
  const primaryApplyTo = applyToPatterns[0];

  return {
    kind,
    path: toInstructionPath(workspaceRoot, filePath, options?.scope),
    name:
      typeof document.attributes.name === "string"
        ? document.attributes.name
        : typeof options?.fallbackName === "string"
          ? options.fallbackName
          : deriveDocumentName(filePath, ".instructions.md"),
    body: document.body,
    ...(description ? { description } : {}),
    ...(primaryApplyTo ? { applyTo: primaryApplyTo } : {}),
    ...(applyToPatterns.length > 1 ? { applyToPatterns } : {}),
    ...(excludePatterns.length > 0 ? { excludePatterns } : {}),
    keywords: readStringListAttribute(document.attributes, [
      "keywords",
      "keyword",
    ]),
    ...(typeof priority === "number" ? { priority } : {}),
    ...(mode ? { mode } : {}),
    ...(audience ? { audience } : {}),
    ...(options?.scope ? { scope: options.scope } : {}),
    ...(sizeBytes > MAX_INSTRUCTION_FILE_BYTES ? { sizeBytes } : {}),
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
  const diagnostics: CustomizationDiagnostic[] | undefined =
    options?.includeDiagnostics ? [] : undefined;
  const userCustomizationRoot = getUserCustomizationRoot();
  const machdochRoot = join(workspaceRoot, ".machdoch");
  const githubRoot = join(workspaceRoot, ".github");
  const userAlwaysOnInstructionPath = join(
    userCustomizationRoot,
    "instructions.md",
  );
  const userConditionalInstructionRoot = getUserInstructionDirectory();
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
  const instructionOptions = (
    base: LoadInstructionOptions = {},
  ): LoadInstructionOptions => {
    return {
      ...base,
      ...(diagnostics ? { diagnostics } : {}),
    };
  };

  if (options?.discoverUserCustomizations) {
    if (existsSync(userAlwaysOnInstructionPath)) {
      instructions.push(
        await loadInstruction(
          workspaceRoot,
          userAlwaysOnInstructionPath,
          "always-on",
          instructionOptions({
            fallbackName: "user-instructions",
            scope: "user",
          }),
        ),
      );
    }
  }

  if (existsSync(alwaysOnInstructionPath)) {
    instructions.push(
      await loadInstruction(
        workspaceRoot,
        alwaysOnInstructionPath,
        "always-on",
        instructionOptions(),
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
          instructionOptions({
            fallbackName: "copilot-instructions",
            scope: "compatibility",
          }),
        ),
      );
    }

    if (existsSync(agentsInstructionPath)) {
      instructions.push(
        await loadInstruction(
          workspaceRoot,
          agentsInstructionPath,
          "always-on",
          instructionOptions({
            fallbackName: "AGENTS",
            scope: "compatibility",
          }),
        ),
      );
    }
  }

  const userConditionalInstructionPaths = options?.discoverUserCustomizations
    ? (await walkFiles(userConditionalInstructionRoot)).filter((filePath) =>
        filePath.endsWith(".instructions.md"),
      )
    : [];
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
    ...userConditionalInstructionPaths,
    ...conditionalInstructionPaths,
    ...githubConditionalInstructionPaths,
  ].sort()) {
    const isUserInstruction = userConditionalInstructionPaths.includes(filePath);
    const isCompatibilityInstruction =
      githubConditionalInstructionPaths.includes(filePath);
    instructions.push(
      await loadInstruction(
        workspaceRoot,
        filePath,
        "conditional",
        instructionOptions(
          isUserInstruction
            ? { scope: "user" }
            : isCompatibilityInstruction
              ? { scope: "compatibility" }
              : {},
        ),
      ),
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
    ...(diagnostics && diagnostics.length > 0 ? { diagnostics } : {}),
  };
};
