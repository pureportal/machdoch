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
  InstructionMode,
  InstructionTargetAudience,
  ResolvedPromptInvocation,
  ResolvedTaskContext,
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

const INSTRUCTION_REFERENCE_PATTERN =
  /@instruction(?::|\s+)(?:"([^"]+)"|'([^']+)'|([^\s,;]+))/giu;

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

const createInstructionLookupKey = (value: string): string => {
  return value.trim().replace(/\\/gu, "/").toLowerCase();
};

const extractInstructionReferenceKeys = (value: string): Set<string> => {
  const references = new Set<string>();

  for (const match of value.matchAll(INSTRUCTION_REFERENCE_PATTERN)) {
    const rawReference = match[1] ?? match[2] ?? match[3];

    if (rawReference) {
      references.add(createInstructionLookupKey(rawReference));
    }
  }

  return references;
};

const getInstructionMode = (
  instruction: DiscoveredInstruction,
): InstructionMode => {
  if (instruction.mode) {
    return instruction.mode;
  }

  return instruction.kind === "always-on" ? "always" : "auto";
};

const getInstructionApplyToPatterns = (
  instruction: DiscoveredInstruction,
): string[] => {
  if (instruction.applyToPatterns && instruction.applyToPatterns.length > 0) {
    return instruction.applyToPatterns;
  }

  return instruction.applyTo ? [instruction.applyTo] : [];
};

const findMatchedWorkspacePaths = (
  workspacePaths: string[],
  patterns: string[],
): { pattern: string; paths: string[] }[] => {
  return patterns
    .map((pattern) => ({
      pattern,
      paths: workspacePaths.filter((workspacePath) =>
        matchesWorkspaceGlob(workspacePath, pattern),
      ),
    }))
    .filter((match) => match.paths.length > 0);
};

const shouldInstructionRunForAudience = (
  instruction: DiscoveredInstruction,
  audience: InstructionTargetAudience,
): boolean => {
  return (
    !instruction.audience ||
    instruction.audience === "all" ||
    instruction.audience === audience
  );
};

const isInstructionExplicitlyReferenced = (
  instruction: DiscoveredInstruction,
  referenceKeys: Set<string>,
): boolean => {
  if (referenceKeys.size === 0) {
    return false;
  }

  const candidateKeys = [
    instruction.name,
    instruction.path,
    instruction.path.split("/").at(-1) ?? "",
  ].map(createInstructionLookupKey);

  return candidateKeys.some((candidateKey) => referenceKeys.has(candidateKey));
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
  audience: InstructionTargetAudience,
): TaskCustomizationMatch[] => {
  const normalizedTask = taskText.toLowerCase();
  const taskTokens = createTokenSet(taskText);
  const taskRankingTokens = tokenizeTaskMatchText(taskText);
  const instructionReferenceKeys = extractInstructionReferenceKeys(taskText);

  const matches: TaskCustomizationMatch[] = [];

  for (const instruction of customizations.instructions) {
    const mode = getInstructionMode(instruction);
    const explicitlyReferenced = isInstructionExplicitlyReferenced(
      instruction,
      instructionReferenceKeys,
    );

    if (
      mode === "disabled" ||
      !shouldInstructionRunForAudience(instruction, audience)
    ) {
      continue;
    }

    if (mode === "manual" && !explicitlyReferenced) {
      continue;
    }

    const excludedPathMatches =
      !explicitlyReferenced &&
      instruction.excludePatterns &&
      workspacePaths.length > 0
        ? findMatchedWorkspacePaths(workspacePaths, instruction.excludePatterns)
        : [];

    if (excludedPathMatches.length > 0) {
      continue;
    }

    const matchKind =
      mode === "always" ? ("always-on" as const) : instruction.kind;

    if (mode === "always") {
      matches.push({
        kind: matchKind,
        name: instruction.name,
        path: instruction.path,
        priority: instruction.priority ?? 0,
        body: instruction.body,
        reason:
          instruction.scope === "user"
            ? "Always-on user instruction."
            : "Always-on workspace instruction.",
      });
      continue;
    }

    if (explicitlyReferenced) {
      matches.push({
        kind: matchKind,
        name: instruction.name,
        path: instruction.path,
        priority: instruction.priority ?? 0,
        body: instruction.body,
        reason: "Explicitly requested instruction.",
      });
      continue;
    }

    const reasons: string[] = [];
    let hasApplyToPathMatch = false;
    const applyToPatterns = getInstructionApplyToPatterns(instruction);

    if (applyToPatterns.length > 0 && workspacePaths.length > 0) {
      const pathMatches = findMatchedWorkspacePaths(
        workspacePaths,
        applyToPatterns,
      );

      if (pathMatches.length > 0) {
        hasApplyToPathMatch = true;
        reasons.push(
          ...pathMatches.map((pathMatch) =>
            createPathMatchReason(pathMatch.paths, pathMatch.pattern),
          ),
        );
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
      kind: matchKind,
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
  customizations: CustomizationDiscoveryResult,
  options: {
    instructionAudience?: InstructionTargetAudience;
  } = {},
): ResolvedTaskContext => {
  const instructionAudience = options.instructionAudience ?? "executor";
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
  const applicableInstructions = findApplicableInstructions(
    instructionContextText,
    workspacePaths,
    customizations,
    instructionAudience,
  );
  const applicableValidatorInstructions =
    instructionAudience === "validator"
      ? applicableInstructions
      : findApplicableInstructions(
          instructionContextText,
          workspacePaths,
          customizations,
          "validator",
        );

  return {
    task,
    effectiveTask,
    taskContextText,
    instructionContextText,
    workspacePaths,
    suggestedTools,
    instructionAudience,
    ...(invokedPrompt ? { invokedPrompt } : {}),
    applicableInstructions,
    ...(applicableValidatorInstructions.length > 0
      ? { applicableValidatorInstructions }
      : {}),
  };
};
