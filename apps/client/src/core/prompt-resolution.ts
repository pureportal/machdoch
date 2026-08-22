import { normalizeOptionalString } from "../helpers/normalize-optional-string.helper.js";
import type {
  CustomizationDiscoveryResult,
  DiscoveredPrompt,
  ResolvedPromptInvocation,
} from "./types.js";

const INPUT_VARIABLE_PATTERN = /\$\{input:([A-Za-z0-9_.-]+)(?::([^}]+))?\}/g;
const NAMED_ARGUMENT_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const PROMPT_INVOCATION_PATTERN =
  /^(?:\/|prompt:)([a-z0-9][a-z0-9._/-]*)(?:\s+([\s\S]+))?$/i;

export interface ParsedPromptInvocation {
  arguments: string;
  name: string;
}

interface ParsedPromptArguments {
  freeformText: string;
  namedValues: Record<string, string>;
}

interface PromptInputReference {
  name: string;
  placeholder?: string;
}

const hasNonBlankArgumentValue = (value: string): boolean => {
  return normalizeOptionalString(value) !== undefined;
};

const tokenizeArgumentString = (value: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let activeQuote: '"' | "'" | "`" | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (character === undefined) {
      continue;
    }

    if (activeQuote) {
      if (character === activeQuote) {
        activeQuote = undefined;
        continue;
      }

      if (character === "\\") {
        const nextCharacter = value[index + 1];

        if (nextCharacter === activeQuote || nextCharacter === "\\") {
          current += nextCharacter;
          index += 1;
          continue;
        }
      }

      current += character;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      activeQuote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }

      continue;
    }

    current += character;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
};

const parsePromptArguments = (argumentsText: string): ParsedPromptArguments => {
  const namedValues: Record<string, string> = {};
  const freeformTokens: string[] = [];

  for (const token of tokenizeArgumentString(argumentsText.trim())) {
    const separatorIndex = token.indexOf("=");

    if (separatorIndex <= 0) {
      freeformTokens.push(token);
      continue;
    }

    const rawName = token.slice(0, separatorIndex).trim();
    const rawValue = token.slice(separatorIndex + 1);

    if (!NAMED_ARGUMENT_PATTERN.test(rawName)) {
      freeformTokens.push(token);
      continue;
    }

    if (!hasNonBlankArgumentValue(rawValue)) {
      continue;
    }

    namedValues[rawName.toLowerCase()] = rawValue;
  }

  return {
    freeformText: freeformTokens.join(" ").trim(),
    namedValues,
  };
};

const extractPromptInputReferences = (body: string): PromptInputReference[] => {
  const seen = new Set<string>();
  const references: PromptInputReference[] = [];

  for (const match of body.matchAll(INPUT_VARIABLE_PATTERN)) {
    const name = normalizeOptionalString(match[1]);
    const placeholder = normalizeOptionalString(match[2]);

    if (!name || seen.has(name)) {
      continue;
    }

    seen.add(name);
    references.push({
      name,
      ...(placeholder ? { placeholder } : {}),
    });
  }

  return references;
};

const collectExpectedInputs = (prompt: DiscoveredPrompt): string[] => {
  const expectedInputs: string[] = [];
  const seen = new Set<string>();

  for (const input of prompt.inputs) {
    const normalizedInput = normalizeOptionalString(input);

    if (!normalizedInput || seen.has(normalizedInput)) {
      continue;
    }

    seen.add(normalizedInput);
    expectedInputs.push(normalizedInput);
  }

  for (const reference of extractPromptInputReferences(prompt.body)) {
    if (seen.has(reference.name)) {
      continue;
    }

    seen.add(reference.name);
    expectedInputs.push(reference.name);
  }

  return expectedInputs;
};

const getNamedInputValue = (
  namedValues: Record<string, string>,
  inputName: string,
): string | undefined => {
  return namedValues[inputName.toLowerCase()];
};

/**
 * Parses `/prompt-name args` and `prompt:prompt-name args` style invocations.
 */
export const parsePromptInvocation = (
  task: string,
): ParsedPromptInvocation | undefined => {
  const match = task.trim().match(PROMPT_INVOCATION_PATTERN);
  const name = match?.[1]?.trim();

  if (!name) {
    return undefined;
  }

  return {
    arguments: match?.[2]?.trim() ?? "",
    name,
  };
};

/**
 * Resolves a discovered prompt against the raw slash-command argument string.
 * Supports VS Code-style `${input:name[:placeholder]}` variables, named
 * `name=value` arguments, and a single freeform fallback when exactly one input
 * remains unresolved.
 */
export const resolveInvokedPrompt = (
  prompt: DiscoveredPrompt,
  argumentsText: string,
): ResolvedPromptInvocation => {
  const parsedArguments = parsePromptArguments(argumentsText);
  const expectedInputs = collectExpectedInputs(prompt);
  const inputValues: Record<string, string> = {};

  for (const inputName of expectedInputs) {
    const namedValue = getNamedInputValue(
      parsedArguments.namedValues,
      inputName,
    );

    if (namedValue !== undefined) {
      inputValues[inputName] = namedValue;
    }
  }

  const unresolvedInputs = expectedInputs.filter(
    (inputName) => inputValues[inputName] === undefined,
  );

  if (
    parsedArguments.freeformText.length > 0 &&
    unresolvedInputs.length === 1 &&
    inputValues[unresolvedInputs[0] ?? ""] === undefined
  ) {
    const unresolvedInput = unresolvedInputs[0];

    if (unresolvedInput) {
      inputValues[unresolvedInput] = parsedArguments.freeformText;
    }
  }

  const missingInputs = expectedInputs.filter(
    (inputName) => inputValues[inputName] === undefined,
  );
  const resolvedBody = prompt.body.replace(
    INPUT_VARIABLE_PATTERN,
    (fullMatch, rawName: string) => inputValues[rawName] ?? fullMatch,
  );

  return {
    ...prompt,
    arguments: argumentsText,
    expectedInputs,
    inputValues,
    missingInputs,
    resolvedBody,
  };
};

/**
 * Resolves a parsed prompt invocation against the discovered workspace prompts.
 */
export const resolvePromptInvocation = (
  task: string,
  customizations: CustomizationDiscoveryResult,
): ResolvedPromptInvocation | undefined => {
  const parsedInvocation = parsePromptInvocation(task);

  if (!parsedInvocation) {
    return undefined;
  }

  const matchingPrompt = customizations.prompts.find(
    (prompt) =>
      prompt.name.toLowerCase() === parsedInvocation.name.toLowerCase(),
  );

  if (!matchingPrompt) {
    return undefined;
  }

  return resolveInvokedPrompt(matchingPrompt, parsedInvocation.arguments);
};
