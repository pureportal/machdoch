import { resolvePromptInvocation } from "./prompt-resolution.js";
import { extractTaskPathReferences } from "./task-paths.js";
import type {
  CustomizationDiscoveryResult,
  ResolvedPromptInvocation,
  ResolvedTaskContext,
  TaskExecutionRole,
} from "./types.js";
import type { ToolName } from "./runtime-contract.generated.js";
import type { FrozenInstructionSet } from "./instruction-system/types.js";

const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "from",
  "into",
  "that",
  "the",
  "their",
  "them",
  "then",
  "this",
  "update",
  "with",
  "your",
]);

/**
 * Tokenizes task text while dropping short words and common stop words.
 */
const createTaskMatchTokenSet = (value: string): Set<string> => {
  const tokens = new Set<string>();

  for (const part of value.toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length >= 3 && !STOP_WORDS.has(part)) {
      tokens.add(part);
    }
  }

  return tokens;
};

export const tokenizeTaskMatchText = (value: string): string[] => {
  return Array.from(createTaskMatchTokenSet(value));
};

/**
 * Scores candidate text by counting overlapping task tokens.
 */
export const rankTaskMatchText = (
  taskTokens: string[],
  candidateText: string,
): { score: number; matchedTerms: string[] } => {
  const candidateTokenSet = createTaskMatchTokenSet(candidateText);
  const matchedTerms: string[] = [];

  for (const token of taskTokens) {
    if (candidateTokenSet.has(token)) {
      matchedTerms.push(token);
    }
  }

  return {
    score: matchedTerms.length,
    matchedTerms,
  };
};

/**
 * Deduplicates tool names while preserving their original order.
 */
const uniqueToolNames = (tools: ToolName[]): ToolName[] => {
  return Array.from(new Set(tools));
};

const uniqueWorkspacePaths = (workspacePaths: string[]): string[] => {
  return Array.from(new Set(workspacePaths));
};

/**
 * Builds the text used for presentation-only prompt and skill suggestions.
 */
const createTaskContextText = (
  task: string,
  invokedPrompt: ResolvedPromptInvocation | undefined,
): string => {
  if (!invokedPrompt) {
    return task;
  }

  return [
    invokedPrompt.name,
    invokedPrompt.description,
    invokedPrompt.argumentHint,
    invokedPrompt.arguments,
    invokedPrompt.inputs.join(" "),
    invokedPrompt.expectedInputs.join(" "),
    Object.entries(invokedPrompt.inputValues)
      .map(([name, value]) => `${name} ${value}`)
      .join(" "),
    invokedPrompt.resolvedBody,
  ]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join(" ");
};

const collectWorkspacePaths = (
  task: string,
  effectiveTask: string,
  workspaceRoot: string,
): string[] => {
  const candidateTexts =
    effectiveTask === task ? [task] : [task, effectiveTask];

  return uniqueWorkspacePaths(
    candidateTexts.flatMap((candidateText) =>
      extractTaskPathReferences(candidateText, workspaceRoot).flatMap(
        (reference) =>
          reference.insideWorkspace && reference.workspacePath
            ? [reference.workspacePath]
            : [],
      ),
    ),
  );
};

/**
 * Resolves the shared task context consumed by staged previews and the current
 * deterministic execution path.
 */
export const resolveTaskContext = (
  task: string,
  customizations: CustomizationDiscoveryResult,
  options: {
    executionRole?: TaskExecutionRole;
    instructionResolution?: FrozenInstructionSet;
  } = {},
): ResolvedTaskContext => {
  const executionRole = options.executionRole ?? "executor";
  const invokedPrompt = resolvePromptInvocation(task, customizations);
  const effectiveTask = invokedPrompt?.resolvedBody.trim().length
    ? invokedPrompt.resolvedBody.trim()
    : task;
  const taskContextText = createTaskContextText(task, invokedPrompt);
  const workspacePaths = collectWorkspacePaths(
    task,
    effectiveTask,
    customizations.workspaceRoot,
  );
  const suggestedTools = uniqueToolNames(invokedPrompt?.tools ?? []);
  const applicableInstructions = options.instructionResolution
    ? options.instructionResolution.selectedSources.map((source) => ({
        id: source.id,
        digest: source.digest,
        kind: source.kind,
        name: source.name,
        body: source.body,
        scopePath: source.scopePath,
        precedence: source.precedence,
      }))
    : [];

  return {
    task,
    effectiveTask,
    taskContextText,
    workspacePaths,
    suggestedTools,
    executionRole,
    ...(invokedPrompt ? { invokedPrompt } : {}),
    applicableInstructions,
    ...(options.instructionResolution === undefined
      ? {}
      : { instructionResolution: options.instructionResolution }),
  };
};
