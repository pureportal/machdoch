import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";
import { loadRuntimeConfig } from "./config.js";
import {
  discoverCustomizations,
  getUserCustomizationRoot,
  getUserInstructionDirectory,
} from "./customizations.js";
import { executeTask } from "./execution.js";
import { parseMarkdownDocument } from "./frontmatter.js";
import type {
  AgentModelAdapter,
  CustomizationDiagnostic,
  CustomizationDiscoveryResult,
  FrontmatterValue,
  InstructionAudience,
  InstructionMode,
  InstructionScope,
  RuntimeConfig,
  TaskExecutionProgressHandler,
  TaskExecutionResult,
} from "./types.js";

export type WritableInstructionScope = Extract<
  InstructionScope,
  "user" | "workspace"
>;

export interface InstructionFileInput {
  name: string;
  body: string;
  scope?: WritableInstructionScope;
  mode?: InstructionMode;
  audience?: InstructionAudience;
  applyTo?: string[];
  exclude?: string[];
  keywords?: string[];
  priority?: number;
}

export interface InstructionFileWriteOptions {
  path?: string;
  overwrite?: boolean;
}

export interface InstructionFileWriteResult {
  path: string;
  scope: WritableInstructionScope;
  name: string;
  created: boolean;
}

export interface InstructionValidationResult {
  valid: boolean;
  diagnostics: CustomizationDiagnostic[];
}

export interface InstructionGenerationOptions
  extends Omit<InstructionFileInput, "body"> {
  prompt: string;
  path?: string;
  overwrite?: boolean;
  maxRounds?: number;
  config?: RuntimeConfig;
  customizations?: CustomizationDiscoveryResult;
  modelAdapter?: AgentModelAdapter;
  onStateChange?: TaskExecutionProgressHandler;
  runId?: string;
  signal?: AbortSignal;
}

export interface InstructionGenerationResult {
  status: "created" | "updated" | "blocked";
  path: string;
  scope: WritableInstructionScope;
  name: string;
  rounds: number;
  validation: InstructionValidationResult;
  generatorResults: TaskExecutionResult[];
  summary: string;
}

const INSTRUCTION_MODES = new Set<InstructionMode>([
  "always",
  "auto",
  "agent-requested",
  "manual",
  "disabled",
]);

const INSTRUCTION_AUDIENCES = new Set<InstructionAudience>([
  "executor",
  "validator",
  "generator",
  "all",
]);

const DEFAULT_GENERATION_MAX_ROUNDS = 2;
const MAX_GENERATION_MAX_ROUNDS = 4;

const normalizeWritableInstructionScope = (
  scope: string | undefined,
): WritableInstructionScope => {
  if (!scope) {
    return "workspace";
  }

  if (scope === "user" || scope === "workspace") {
    return scope;
  }

  throw new Error("Instruction scope must be user or workspace.");
};

const validateInstructionMetadataInput = (input: {
  mode?: InstructionMode;
  audience?: InstructionAudience;
}): void => {
  if (input.mode && !INSTRUCTION_MODES.has(input.mode)) {
    throw new Error(
      "Instruction mode must be always, auto, agent-requested, manual, or disabled.",
    );
  }

  if (input.audience && !INSTRUCTION_AUDIENCES.has(input.audience)) {
    throw new Error(
      "Instruction audience must be executor, validator, generator, or all.",
    );
  }
};

const normalizeStringList = (values: string[] | undefined): string[] => {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
};

const sanitizeFrontmatterValue = (value: string): string => {
  return value.replace(/\r?\n/gu, " ").trim();
};

const appendStringField = (
  lines: string[],
  key: string,
  value: string | number | undefined,
): void => {
  if (value === undefined) {
    return;
  }

  const sanitizedValue = sanitizeFrontmatterValue(String(value));

  if (sanitizedValue.length > 0) {
    lines.push(`${key}: ${sanitizedValue}`);
  }
};

const appendArrayField = (
  lines: string[],
  key: string,
  values: string[] | undefined,
): void => {
  const sanitizedValues = normalizeStringList(values).map(
    sanitizeFrontmatterValue,
  );

  if (sanitizedValues.length === 0) {
    return;
  }

  lines.push(`${key}:`);

  for (const value of sanitizedValues) {
    lines.push(`  - ${value}`);
  }
};

export const createInstructionSlug = (name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return slug || "instruction";
};

export const getWorkspaceInstructionDirectory = (
  workspaceRoot: string,
): string => {
  return join(workspaceRoot, ".machdoch", "instructions");
};

export const getInstructionDirectory = (
  workspaceRoot: string,
  scope: WritableInstructionScope,
): string => {
  return scope === "user"
    ? getUserInstructionDirectory()
    : getWorkspaceInstructionDirectory(workspaceRoot);
};

const isPathInside = (parentPath: string, candidatePath: string): boolean => {
  const relativePath = relative(parentPath, candidatePath);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

const resolveUserInstructionRelativePath = (path: string): string => {
  const normalizedPath = path.trim().replace(/\\/gu, "/");

  if (
    normalizedPath === ".machdoch" ||
    normalizedPath.startsWith(".machdoch/")
  ) {
    throw new Error(
      "User instruction paths are relative to the user config directory; use instructions/<file> or a file name.",
    );
  }

  if (
    normalizedPath === "instructions.md" ||
    normalizedPath.startsWith("instructions/")
  ) {
    return resolve(getUserCustomizationRoot(), normalizedPath);
  }

  return resolve(getUserInstructionDirectory(), normalizedPath);
};

const resolveWritableInstructionPath = (
  workspaceRoot: string,
  scope: WritableInstructionScope,
  name: string,
  path: string | undefined,
): string => {
  if (!path) {
    return join(
      getInstructionDirectory(workspaceRoot, scope),
      `${createInstructionSlug(name)}.instructions.md`,
    );
  }

  const resolvedPath = isAbsolute(path)
    ? resolve(path)
    : scope === "user"
      ? resolveUserInstructionRelativePath(path)
      : resolve(workspaceRoot, path);
  const allowedRoot =
    scope === "user" ? getUserCustomizationRoot() : resolve(workspaceRoot);

  if (!isPathInside(allowedRoot, resolvedPath)) {
    throw new Error(
      `Instruction path ${resolvedPath} is outside the ${scope} instruction scope.`,
    );
  }

  return resolvedPath;
};

export const createInstructionFileBody = (
  input: InstructionFileInput,
): string => {
  const lines = ["---"];
  appendStringField(lines, "name", input.name);
  appendStringField(lines, "mode", input.mode);
  appendStringField(lines, "audience", input.audience);
  appendStringField(lines, "priority", input.priority);
  appendArrayField(lines, "applyTo", input.applyTo);
  appendArrayField(lines, "exclude", input.exclude);
  appendArrayField(lines, "keywords", input.keywords);
  lines.push("---");
  lines.push("");
  lines.push(input.body.trim());
  lines.push("");

  return lines.join("\n");
};

export const writeInstructionFile = async (
  workspaceRoot: string,
  input: InstructionFileInput,
  options: InstructionFileWriteOptions = {},
): Promise<InstructionFileWriteResult> => {
  const name = input.name.trim();
  const body = input.body.trim();

  if (!name) {
    throw new Error("Expected an instruction name.");
  }

  if (!body) {
    throw new Error("Expected instruction body text.");
  }

  validateInstructionMetadataInput(input);

  const scope = normalizeWritableInstructionScope(input.scope);
  const filePath = resolveWritableInstructionPath(
    workspaceRoot,
    scope,
    name,
    options.path,
  );
  const existed = existsSync(filePath);

  if (existed && !options.overwrite) {
    throw new Error(`Instruction file already exists: ${filePath}`);
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, createInstructionFileBody(input), "utf8");

  return {
    path: filePath,
    scope,
    name,
    created: !existed,
  };
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

  return normalizeStringList(values);
};

const normalizeInstructionMode = (
  value: string | undefined,
): InstructionMode | undefined => {
  if (!value) {
    return undefined;
  }

  const normalizedValue = value.trim().toLowerCase().replace(/_/gu, "-");

  if (normalizedValue === "always-on") {
    return "always";
  }

  if (normalizedValue === "auto-attached") {
    return "auto";
  }

  return INSTRUCTION_MODES.has(normalizedValue as InstructionMode)
    ? (normalizedValue as InstructionMode)
    : undefined;
};

export const validateInstructionFileContent = (
  path: string,
  content: string,
): InstructionValidationResult => {
  const diagnostics: CustomizationDiagnostic[] = [];
  const document = parseMarkdownDocument(content);
  const name = readStringAttribute(document.attributes, ["name"]);
  const description = readStringAttribute(document.attributes, ["description"]);
  const rawMode = readStringAttribute(document.attributes, [
    "mode",
    "activation",
  ]);
  const mode = normalizeInstructionMode(rawMode);
  const rawAudience = readStringAttribute(document.attributes, ["audience"]);
  const applyTo = readStringListAttribute(document.attributes, [
    "applyTo",
    "apply_to",
    "apply-to",
    "globs",
    "paths",
  ]);
  const keywords = readStringListAttribute(document.attributes, [
    "keywords",
    "keyword",
  ]);

  if (!name) {
    diagnostics.push({
      level: "warning",
      code: "missing-instruction-name",
      message: "Instruction frontmatter should include a stable name.",
      path,
    });
  }

  if (rawMode && !mode) {
    diagnostics.push({
      level: "error",
      code: "invalid-instruction-mode",
      message:
        "Instruction mode must be always, auto, agent-requested, manual, or disabled.",
      path,
    });
  }

  if (
    rawAudience &&
    !INSTRUCTION_AUDIENCES.has(rawAudience.toLowerCase() as InstructionAudience)
  ) {
    diagnostics.push({
      level: "error",
      code: "invalid-instruction-audience",
      message:
        "Instruction audience must be executor, validator, generator, or all.",
      path,
    });
  }

  if (!document.body.trim()) {
    diagnostics.push({
      level: "error",
      code: "empty-instruction-body",
      message: "Instruction body cannot be empty.",
      path,
    });
  }

  const effectiveMode = mode ?? "auto";

  if (
    (effectiveMode === "auto" || effectiveMode === "agent-requested") &&
    applyTo.length === 0 &&
    keywords.length === 0 &&
    !description
  ) {
    diagnostics.push({
      level: "warning",
      code: "weak-instruction-activation",
      message:
        "Automatic instructions should include applyTo, keywords, or a description.",
      path,
    });
  }

  return {
    valid: diagnostics.every((diagnostic) => diagnostic.level !== "error"),
    diagnostics,
  };
};

const createInstructionGenerationTask = (input: {
  draftWorkspacePath: string;
  finalPath: string;
  name: string;
  scope: WritableInstructionScope;
  prompt: string;
  existingContent?: string;
  validatorFeedback?: string;
  mode?: InstructionMode;
  audience?: InstructionAudience;
  applyTo: string[];
  exclude: string[];
  keywords: string[];
  priority?: number;
}): string => {
  return [
    "Create a Machdoch instruction file.",
    "",
    "Write the generated markdown to this exact workspace path:",
    input.draftWorkspacePath,
    "",
    `Final destination after host validation: ${input.finalPath}`,
    `Instruction scope: ${input.scope}`,
    "",
    "Instruction file requirements:",
    "- Use Markdown with YAML-like frontmatter delimited by ---.",
    "- Include a stable `name` frontmatter field.",
    "- Use `mode` when activation is known: always, auto, agent-requested, manual, or disabled.",
    "- Use `audience` only when needed: executor, validator, generator, or all.",
    "- Use `applyTo` globs for file/path-specific behavior.",
    "- Use `exclude` globs to prevent accidental application to generated, vendor, or unrelated paths.",
    "- Use `keywords` for task-text activation when file paths are not enough.",
    "- Put durable, imperative instructions in the markdown body.",
    "- Do not include TODOs, placeholders, legacy compatibility notes, or commentary about this generation process.",
    "- Do not modify any other files.",
    "",
    "Requested metadata:",
    `name: ${input.name}`,
    input.mode ? `mode: ${input.mode}` : undefined,
    input.audience ? `audience: ${input.audience}` : undefined,
    input.priority !== undefined ? `priority: ${input.priority}` : undefined,
    input.applyTo.length > 0 ? `applyTo: ${input.applyTo.join(", ")}` : undefined,
    input.exclude.length > 0 ? `exclude: ${input.exclude.join(", ")}` : undefined,
    input.keywords.length > 0 ? `keywords: ${input.keywords.join(", ")}` : undefined,
    input.existingContent
      ? `<existing_instruction>\n${input.existingContent}\n</existing_instruction>`
      : undefined,
    input.validatorFeedback
      ? `<validator_feedback>\n${input.validatorFeedback}\n</validator_feedback>`
      : undefined,
    "<user_request>",
    input.prompt,
    "</user_request>",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
};

const createDraftWorkspacePath = (name: string): string => {
  return `.machdoch/.instruction-generation/${createInstructionSlug(name)}-${randomUUID()}.instructions.md`;
};

const createBlockedGenerationResult = (
  path: string,
  scope: WritableInstructionScope,
  name: string,
  validation: InstructionValidationResult,
  generatorResults: TaskExecutionResult[],
  summary: string,
): InstructionGenerationResult => {
  return {
    status: "blocked",
    path,
    scope,
    name,
    rounds: generatorResults.length,
    validation,
    generatorResults,
    summary,
  };
};

export const generateInstructionFileWithAgent = async (
  workspaceRoot: string,
  options: InstructionGenerationOptions,
): Promise<InstructionGenerationResult> => {
  const name = options.name.trim();
  const prompt = options.prompt.trim();
  validateInstructionMetadataInput(options);

  const scope = normalizeWritableInstructionScope(options.scope);
  const finalPath = resolveWritableInstructionPath(
    workspaceRoot,
    scope,
    name,
    options.path,
  );
  const maxRounds = options.maxRounds ?? DEFAULT_GENERATION_MAX_ROUNDS;
  const generatorResults: TaskExecutionResult[] = [];
  const existed = existsSync(finalPath);
  let validatorFeedback: string | undefined;

  if (!name) {
    return createBlockedGenerationResult(
      finalPath,
      scope,
      name,
      { valid: false, diagnostics: [{ level: "error", code: "name-required", message: "Expected an instruction name.", path: finalPath }] },
      generatorResults,
      "Expected an instruction name.",
    );
  }

  if (!prompt) {
    return createBlockedGenerationResult(
      finalPath,
      scope,
      name,
      { valid: false, diagnostics: [{ level: "error", code: "prompt-required", message: "Expected an instruction generation prompt.", path: finalPath }] },
      generatorResults,
      "Expected an instruction generation prompt.",
    );
  }

  if (
    !Number.isInteger(maxRounds) ||
    maxRounds < 1 ||
    maxRounds > MAX_GENERATION_MAX_ROUNDS
  ) {
    return createBlockedGenerationResult(
      finalPath,
      scope,
      name,
      {
        valid: false,
        diagnostics: [
          {
            level: "error",
            code: "max-rounds-invalid",
            message: `maxRounds must be an integer from 1 to ${MAX_GENERATION_MAX_ROUNDS}.`,
            path: finalPath,
          },
        ],
      },
      generatorResults,
      `maxRounds must be an integer from 1 to ${MAX_GENERATION_MAX_ROUNDS}.`,
    );
  }

  if (existed && options.overwrite === false) {
    return createBlockedGenerationResult(
      finalPath,
      scope,
      name,
      {
        valid: false,
        diagnostics: [
          {
            level: "error",
            code: "instruction-file-exists",
            message: `Instruction file already exists: ${finalPath}`,
            path: finalPath,
          },
        ],
      },
      generatorResults,
      `Instruction file already exists: ${finalPath}`,
    );
  }

  const config =
    options.config ??
    (await loadRuntimeConfig(
      workspaceRoot,
      "machdoch",
      undefined,
      undefined,
      undefined,
    ));
  const customizations =
    options.customizations ??
    (await discoverCustomizations(workspaceRoot, {
      discoverUserCustomizations: true,
      discoverGithubCustomizations:
        Boolean(config.compatibility.discoverGithubCustomizations),
      includeDiagnostics: true,
    }));
  const existingContent = existed ? await readFile(finalPath, "utf8") : undefined;

  await mkdir(dirname(finalPath), { recursive: true });
  await mkdir(join(workspaceRoot, ".machdoch", ".instruction-generation"), {
    recursive: true,
  });

  for (let round = 1; round <= maxRounds; round += 1) {
    const draftWorkspacePath = createDraftWorkspacePath(name);
    const draftAbsolutePath = join(workspaceRoot, draftWorkspacePath);
    await rm(draftAbsolutePath, { force: true });

    const result = await executeTask(
      createInstructionGenerationTask({
        draftWorkspacePath,
        finalPath,
        name,
        scope,
        prompt,
        ...(existingContent ? { existingContent } : {}),
        ...(validatorFeedback ? { validatorFeedback } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.audience ? { audience: options.audience } : {}),
        applyTo: normalizeStringList(options.applyTo),
        exclude: normalizeStringList(options.exclude),
        keywords: normalizeStringList(options.keywords),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
      }),
      config,
      customizations,
      {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.modelAdapter ? { modelAdapter: options.modelAdapter } : {}),
        ...(options.onStateChange ? { onStateChange: options.onStateChange } : {}),
        instructionAudience: "generator",
      },
    );
    generatorResults.push(result);

    if (!existsSync(draftAbsolutePath)) {
      validatorFeedback =
        "The generation did not create the requested draft instruction file.";
      continue;
    }

    const draftContent = await readFile(draftAbsolutePath, "utf8");
    const validation = validateInstructionFileContent(
      basename(finalPath),
      draftContent,
    );

    if (!validation.valid) {
      validatorFeedback = validation.diagnostics
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join("\n");
      await rm(draftAbsolutePath, { force: true });
      continue;
    }

    await writeFile(finalPath, draftContent, "utf8");
    await rm(draftAbsolutePath, { force: true });

    return {
      status: existed ? "updated" : "created",
      path: finalPath,
      scope,
      name,
      rounds: round,
      validation,
      generatorResults,
      summary: `${existed ? "Updated" : "Created"} ${scope} instruction \`${name}\` at ${finalPath}.`,
    };
  }

  return createBlockedGenerationResult(
    finalPath,
    scope,
    name,
    {
      valid: false,
      diagnostics: [
        {
          level: "error",
          code: "instruction-generation-invalid",
          message:
            validatorFeedback ??
            "The generated instruction file did not pass validation.",
          path: finalPath,
        },
      ],
    },
    generatorResults,
    "Instruction generation did not produce a valid instruction file.",
  );
};
