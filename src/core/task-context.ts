import { resolveToolPolicies } from "./policy.js";
import { resolvePromptInvocation } from "./prompt-resolution.js";
import {
  extractTaskPathReferences,
  matchesWorkspaceGlob,
} from "./task-paths.js";
import { createTokenSet, tokenSetIncludesKeyword } from "./text.js";
import { inferSuggestedTools } from "./tools.js";
import type {
  CustomizationDiscoveryResult,
  DiscoveredInstruction,
  ResolvedPromptInvocation,
  ResolvedTaskContext,
  RuntimeConfig,
  TaskCustomizationMatch,
  ToolName,
} from "./types.js";

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

const GENERIC_INSTRUCTION_METADATA_TERMS = new Set([
  "apply",
  "default",
  "defaults",
  "guideline",
  "guidelines",
  "instruction",
  "instructions",
  "rule",
  "rules",
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
 * Formats a short explanation for the terms that matched an instruction.
 */
const createMatchReason = (matchedTerms: string[]): string => {
  return `Matched terms: ${matchedTerms.join(", ")}`;
};

const createPathMatchReason = (
  matchedPaths: string[],
  applyTo: string,
): string => {
  return `Matched path(s): ${matchedPaths.join(", ")} via \`${applyTo}\``;
};

const createMetadataMatchReason = (matchedTerms: string[]): string => {
  return `Matched instruction metadata: ${matchedTerms.join(", ")}`;
};

const compareInstructionMatches = (
  left: TaskCustomizationMatch,
  right: TaskCustomizationMatch,
): number => {
  const priorityDelta = right.priority - left.priority;

  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  if (left.kind !== right.kind) {
    return left.kind === "always-on" ? -1 : 1;
  }

  return left.path.localeCompare(right.path, undefined, {
    sensitivity: "base",
  });
};

/**
 * Builds the text used to infer tools and rank prompt or skill matches.
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

const createInstructionContextText = (
  task: string,
  invokedPrompt: ResolvedPromptInvocation | undefined,
): string => {
  if (!invokedPrompt) {
    return task;
  }

  return [
    task,
    invokedPrompt.name,
    invokedPrompt.description,
    invokedPrompt.argumentHint,
    invokedPrompt.arguments,
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

const findMatchedInstructionMetadataTerms = (
  taskTokens: string[],
  instruction: DiscoveredInstruction,
): string[] => {
  const candidateText = [instruction.name, instruction.description]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join(" ");

  if (candidateText.length === 0) {
    return [];
  }

  const { matchedTerms } = rankTaskMatchText(taskTokens, candidateText);

  return matchedTerms.filter(
    (term) => !GENERIC_INSTRUCTION_METADATA_TERMS.has(term),
  );
};

/**
 * Collects instruction matches for the current effective task.
 */
const findApplicableInstructions = (
  taskText: string,
  workspacePaths: string[],
  customizations: CustomizationDiscoveryResult,
): TaskCustomizationMatch[] => {
  const normalizedTask = taskText.toLowerCase();
  const taskTokens = createTokenSet(taskText);
  const taskRankingTokens = tokenizeTaskMatchText(taskText);

  const matches: TaskCustomizationMatch[] = [];

  for (const instruction of customizations.instructions) {
    if (instruction.kind === "always-on") {
      matches.push({
        kind: instruction.kind,
        name: instruction.name,
        path: instruction.path,
        priority: instruction.priority ?? 0,
        body: instruction.body,
        reason: "Always-on workspace instruction.",
      });
      continue;
    }

    const reasons: string[] = [];
    let hasApplyToPathMatch = false;

    if (instruction.applyTo && workspacePaths.length > 0) {
      const matchedPaths = workspacePaths.filter((workspacePath) =>
        matchesWorkspaceGlob(workspacePath, instruction.applyTo ?? ""),
      );

      if (matchedPaths.length > 0) {
        hasApplyToPathMatch = true;
        reasons.push(createPathMatchReason(matchedPaths, instruction.applyTo));
      } else {
        continue;
      }
    }

    const matchedKeywords = instruction.keywords.filter((keyword) =>
      tokenSetIncludesKeyword(taskTokens, normalizedTask, keyword),
    );

    if (matchedKeywords.length > 0) {
      reasons.push(createMatchReason(matchedKeywords));
    }

    const matchedMetadataTerms =
      matchedKeywords.length === 0 && !hasApplyToPathMatch
        ? findMatchedInstructionMetadataTerms(taskRankingTokens, instruction)
        : [];

    if (matchedMetadataTerms.length > 0) {
      reasons.push(createMetadataMatchReason(matchedMetadataTerms));
    }

    if (reasons.length === 0) {
      continue;
    }

    matches.push({
      kind: instruction.kind,
      name: instruction.name,
      path: instruction.path,
      priority: instruction.priority ?? 0,
      body: instruction.body,
      reason: reasons.join("; "),
    });
  }

  return matches.sort(compareInstructionMatches);
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
  config: RuntimeConfig,
  customizations: CustomizationDiscoveryResult,
): ResolvedTaskContext => {
  const invokedPrompt = resolvePromptInvocation(task, customizations);
  const effectiveTask = invokedPrompt?.resolvedBody.trim().length
    ? invokedPrompt.resolvedBody.trim()
    : task;
  const taskContextText = createTaskContextText(task, invokedPrompt);
  const instructionContextText = createInstructionContextText(
    task,
    invokedPrompt,
  );
  const workspacePaths = collectWorkspacePaths(
    task,
    effectiveTask,
    customizations.workspaceRoot,
  );
  const suggestedTools = uniqueToolNames([
    ...(invokedPrompt?.tools ?? []),
    ...inferSuggestedTools(taskContextText),
  ]);
  const toolPolicies = resolveToolPolicies(config, suggestedTools);
  const blockedTools = toolPolicies
    .filter((policy) => policy.decision === "blocked")
    .map((policy) => policy.tool.name);
  const approvalRequiredTools = toolPolicies
    .filter((policy) => policy.decision === "ask")
    .map((policy) => policy.tool.name);
  const applicableInstructions = findApplicableInstructions(
    instructionContextText,
    workspacePaths,
    customizations,
  );

  return {
    task,
    effectiveTask,
    taskContextText,
    instructionContextText,
    workspacePaths,
    suggestedTools,
    blockedTools,
    approvalRequiredTools,
    toolPolicies,
    ...(invokedPrompt ? { invokedPrompt } : {}),
    applicableInstructions,
  };
};
