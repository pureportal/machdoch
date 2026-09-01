import { z } from "zod";
import type { FleetManagerConfig } from "./config";

export class SettingsValidationError extends Error {}

export const modelProviders = [
  "openai",
  "anthropic",
  "google",
  "langdock",
  "codex-cli",
  "claude-cli",
  "copilot-cli",
] as const;
export const modes = ["ask", "machdoch"] as const;
export const reasoningLevels = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export const webSearchProviders = [
  "none",
  "perplexity",
  "tavily",
  "serper",
] as const;
export const themes = ["dark", "light"] as const;
export const densities = ["comfortable", "compact"] as const;
export const accents = ["sky", "emerald", "violet", "amber"] as const;

export const secretDescriptors = [
  { id: "openai", label: "OpenAI", category: "Models & media" },
  { id: "anthropic", label: "Anthropic", category: "Models & media" },
  { id: "google", label: "Google", category: "Models & media" },
  { id: "langdock", label: "Langdock", category: "Models & media" },
  { id: "quiver", label: "Quiver", category: "Models & media" },
  { id: "recraft", label: "Recraft", category: "Models & media" },
  { id: "perplexity", label: "Perplexity", category: "Web search" },
  { id: "tavily", label: "Tavily", category: "Web search" },
  { id: "serper", label: "Serper", category: "Web search" },
] as const;

const optionalText = z.string().trim().min(1).max(200).nullable().default(null);
const optionalEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.enum(values).nullable().default(null);

const defaultsSchema = z
  .strictObject({
    provider: optionalEnum(modelProviders),
    model: optionalText,
    mode: optionalEnum(modes),
    reasoning: optionalEnum(reasoningLevels),
    webSearchProvider: optionalEnum(webSearchProviders),
    theme: optionalEnum(themes),
    density: optionalEnum(densities),
    accent: optionalEnum(accents),
  })
  .refine((defaults) => defaults.model === null || defaults.provider !== null, {
    message: "A default model requires a provider.",
  })
  .default({
    provider: null,
    model: null,
    mode: null,
    reasoning: null,
    webSearchProvider: null,
    theme: null,
    density: null,
    accent: null,
  });

const agentLimit = z
  .number()
  .int()
  .min(1)
  .max(100_000)
  .nullable()
  .default(null);
const agentLimitsSchema = z
  .strictObject({
    infinite: z.boolean().nullable().default(null),
    executorTurns: agentLimit,
    autopilotExecutorIterations: agentLimit,
  })
  .default({
    infinite: null,
    executorTurns: null,
    autopilotExecutorIterations: null,
  });

const instructionSchema = z.strictObject({
  id: z.string().uuid(),
  name: validName(200),
  body: z
    .string()
    .min(1)
    .max(128 * 1024)
    .refine(noNullByte),
  enabled: z.boolean(),
  global: z.boolean(),
  tags: z
    .array(validListValue(80).refine((value) => !value.includes(",")))
    .max(64)
    .default([]),
});

const contextPackSchema = z
  .strictObject({
    id: z.string().uuid(),
    name: validName(200),
    instructions: z
      .string()
      .max(128 * 1024)
      .refine(noNullByte)
      .default(""),
    prompt: z
      .string()
      .max(128 * 1024)
      .refine(noNullByte)
      .default(""),
    provider: optionalEnum(modelProviders),
    model: optionalText,
    mode: optionalEnum(modes),
    reasoning: optionalEnum(reasoningLevels),
    variables: z
      .array(
        z.strictObject({
          name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,79}$/),
          defaultValue: z.string().max(8_000).refine(noNullByte).nullable(),
        }),
      )
      .max(64)
      .default([]),
    triggerPhrases: z.array(validListValue(500)).max(64).default([]),
    pathPatterns: z.array(validListValue(500)).max(64).default([]),
    promptEnhancementMode: optionalEnum([
      "off",
      "simple",
      "web-search",
    ] as const),
    interviewEnabled: z.boolean().nullable().default(null),
    sessionMemoryEnabled: z.boolean().nullable().default(null),
    useGlobalMemory: z.boolean().nullable().default(null),
    uiControlEnabled: z.boolean().nullable().default(null),
  })
  .refine((pack) => (pack.provider === null) === (pack.model === null), {
    message: "Context pack provider and model must be set together.",
  })
  .refine((pack) => Boolean(pack.instructions || pack.prompt), {
    message: "A context pack requires instructions or a prompt.",
  });

const promptSchema = z.strictObject({
  id: z.string().uuid(),
  relativePath: z
    .string()
    .trim()
    .min(1)
    .max(1_000)
    .refine(isPromptRelativePath, "Prompt path is invalid."),
  content: z
    .string()
    .min(1)
    .max(128 * 1024)
    .refine(noNullByte),
});

const documentSchema = z
  .strictObject({
    defaults: defaultsSchema,
    agentLimits: agentLimitsSchema,
    instructions: z.array(instructionSchema).default([]),
    contextPacks: z.array(contextPackSchema).default([]),
    prompts: z.array(promptSchema).default([]),
  })
  .default({
    defaults: defaultsSchema.parse(undefined),
    agentLimits: agentLimitsSchema.parse(undefined),
    instructions: [],
    contextPacks: [],
    prompts: [],
  });

export type ManagedSettingsDocument = z.infer<typeof documentSchema>;
export type ManagedInstruction = z.infer<typeof instructionSchema>;
export type ManagedContextPack = z.infer<typeof contextPackSchema>;
export type ManagedPrompt = z.infer<typeof promptSchema>;

export function emptySettingsDocument(): ManagedSettingsDocument {
  return documentSchema.parse({});
}

export function validateSettingsDocument(
  input: unknown,
  limits: FleetManagerConfig["settingsManager"]["limits"],
): ManagedSettingsDocument {
  if (Buffer.byteLength(JSON.stringify(input)) > limits.maximumDocumentBytes) {
    throw new SettingsValidationError(
      "Settings profile exceeds the configured size limit.",
    );
  }
  const result = documentSchema.safeParse(input);
  if (!result.success)
    throw new SettingsValidationError(firstIssue(result.error));
  const document = result.data;
  if (document.instructions.length > limits.maximumInstructionsPerProfile) {
    throw new SettingsValidationError(
      "Instruction count exceeds the configured limit.",
    );
  }
  if (document.contextPacks.length > limits.maximumPacksPerProfile) {
    throw new SettingsValidationError(
      "Context pack count exceeds the configured limit.",
    );
  }
  if (document.prompts.length > limits.maximumPromptsPerProfile) {
    throw new SettingsValidationError(
      "Prompt count exceeds the configured limit.",
    );
  }
  ensureUnique(document.instructions, "Instruction");
  ensureUnique(document.contextPacks, "Context pack");
  ensureUniquePrompts(document.prompts);
  document.instructions.forEach((instruction) =>
    ensureUniqueStrings(instruction.tags),
  );
  document.contextPacks.forEach((pack) =>
    ensureUniqueStrings(pack.variables.map((variable) => variable.name)),
  );
  return document;
}

export function normalizeProfileName(value: unknown): string {
  return parseName(value, 120, "Profile name");
}

export function normalizeProfileDescription(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string")
    throw new SettingsValidationError("Profile description is invalid.");
  const normalized = value.trim();
  if ([...normalized].length > 500 || /[\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw new SettingsValidationError("Profile description is invalid.");
  }
  return normalized;
}

export function normalizeChangeSummary(value: unknown): string {
  const candidate =
    value === undefined || value === null ? "Updated profile" : value;
  return parseName(candidate, 120, "Change summary");
}

export function normalizeSecret(
  value: unknown,
  limits: FleetManagerConfig["settingsManager"]["limits"],
): string {
  if (typeof value !== "string")
    throw new SettingsValidationError("API key is invalid.");
  const normalized = value.trim();
  if (
    !normalized ||
    Buffer.byteLength(normalized) > limits.maximumSecretBytes ||
    /[\p{Cc}\p{Cf}]/u.test(normalized)
  ) {
    throw new SettingsValidationError("API key is invalid.");
  }
  return normalized;
}

export function isSecretId(value: string): boolean {
  return secretDescriptors.some((descriptor) => descriptor.id === value);
}

function validName(maximum: number): z.ZodString {
  return z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
}

function validListValue(maximum: number): z.ZodString {
  return z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value));
}

function noNullByte(value: string): boolean {
  return !value.includes("\0");
}

function parseName(value: unknown, maximum: number, label: string): string {
  const result = validName(maximum).safeParse(value);
  if (!result.success)
    throw new SettingsValidationError(`${label} is invalid.`);
  return result.data;
}

function ensureUnique<T extends { id: string; name: string }>(
  values: T[],
  label: string,
): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const value of values) {
    const normalizedName = value.name.toLocaleLowerCase();
    if (ids.has(value.id) || names.has(normalizedName)) {
      throw new SettingsValidationError(
        `${label} ids and names must be unique.`,
      );
    }
    ids.add(value.id);
    names.add(normalizedName);
  }
}

function ensureUniqueStrings(values: string[]): void {
  const normalized = values.map((value) => value.toLocaleLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new SettingsValidationError("List values must not be duplicated.");
  }
}

function ensureUniquePrompts(prompts: ManagedPrompt[]): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const prompt of prompts) {
    const normalizedPath = prompt.relativePath.toLowerCase();
    if (ids.has(prompt.id) || paths.has(normalizedPath)) {
      throw new SettingsValidationError("Prompt ids and paths must be unique.");
    }
    ids.add(prompt.id);
    paths.add(normalizedPath);
  }
}

function isPromptRelativePath(value: string): boolean {
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    !value.endsWith(".prompt.md")
  ) {
    return false;
  }
  const components = value.split("/");
  return (
    components.length <= 16 &&
    components.every(
      (component) =>
        component !== "." &&
        component !== ".." &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(component),
    )
  );
}

function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Settings document is invalid.";
}
