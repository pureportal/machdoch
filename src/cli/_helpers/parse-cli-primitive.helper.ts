import { normalizeOptionalString } from "../../helpers/normalize-optional-string.helper.js";
import { COMMANDS_WITHOUT_POSITIONALS, VALID_BOOLEAN_TOGGLE_VALUES, VALID_MEMORY_OVERRIDE_VALUES } from "./cli-args-constants.js";
import type { CommandName } from "./cli-args-types.js";

export const fail = (message: string): never => {
  throw new Error(message);
};

export const parseBooleanToggle = (value: string, flagName: string): boolean => {
  if (!VALID_BOOLEAN_TOGGLE_VALUES.has(value)) {
    fail(`Expected ${flagName} to be followed by on or off.`);
  }

  return value === "on";
};

export const parseMemoryOverride = (
  value: string,
  flagName: string,
): boolean | undefined => {
  if (!VALID_MEMORY_OVERRIDE_VALUES.has(value)) {
    fail(`Expected ${flagName} to be followed by inherit, on, or off.`);
  }

  if (value === "inherit") {
    return undefined;
  }

  return value === "on";
};

export const parsePositiveInteger = (value: string, flagName: string): number => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    fail(`Expected ${flagName} to be followed by a positive integer.`);
  }

  return parsed;
};

export const parsePositiveNumber = (value: string, flagName: string): number => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`Expected ${flagName} to be followed by a positive number.`);
  }

  return parsed;
};

export const parseOptionalPositiveInteger = (
  value: string | undefined,
  flagName: string,
): number | undefined => {
  return value ? parsePositiveInteger(value, flagName) : undefined;
};

export const parseOptionalPositiveNumber = (
  value: string | undefined,
  flagName: string,
): number | undefined => {
  return value ? parsePositiveNumber(value, flagName) : undefined;
};

export const parseOptionalInteger = (
  value: string | undefined,
  flagName: string,
): number | undefined => {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    fail(`Expected ${flagName} to be followed by an integer.`);
  }

  return parsed;
};

export const normalizeContextPaths = (
  values: string[] | undefined,
): string[] | undefined => {
  if (values === undefined) {
    return undefined;
  }

  const normalizedPaths = values.flatMap((value) => {
    const normalized = normalizeOptionalString(value);

    return normalized ? [normalized] : [];
  });

  if (normalizedPaths.length === 0) {
    fail("Expected --context to be followed by a file or folder path.");
  }

  return Array.from(new Set(normalizedPaths));
};

export const normalizeImagePaths = (
  values: string[] | undefined,
): string[] | undefined => {
  if (values === undefined) {
    return undefined;
  }

  const normalizedPaths = values.flatMap((value) => {
    const normalized = normalizeOptionalString(value);

    return normalized ? [normalized] : [];
  });

  if (normalizedPaths.length === 0) {
    fail("Expected --image to be followed by an image file path.");
  }

  return Array.from(new Set(normalizedPaths));
};

export const assertNoAdditionalPositionals = (
  command: CommandName,
  positionals: string[],
): void => {
  if (positionals.length === 0 || !COMMANDS_WITHOUT_POSITIONALS.has(command)) {
    return;
  }

  fail(
    `Command \`${command}\` does not accept positional arguments: ${positionals.join(" ")}`,
  );
};
