import { CliUsageError } from "./cli-error.js";

export const fail = (message: string): never => {
  throw new CliUsageError(message);
};

export const parseConfigBoolean = (setting: string, value: string): boolean => {
  const normalizedValue = value.trim().toLowerCase();

  if (["on", "true", "1", "yes"].includes(normalizedValue)) {
    return true;
  }

  if (["off", "false", "0", "no"].includes(normalizedValue)) {
    return false;
  }

  return fail(`Expected ${setting} to be followed by on or off.`);
};

export const parseConfigNumber = (
  setting: string,
  value: string,
  options: { integer: boolean; min?: number; max?: number },
): number => {
  const parsed = Number(value);
  const valid =
    Number.isFinite(parsed) &&
    (!options.integer || Number.isInteger(parsed)) &&
    (options.min === undefined || parsed >= options.min) &&
    (options.max === undefined || parsed <= options.max);

  if (!valid) {
    const range =
      options.min !== undefined && options.max !== undefined
        ? ` between ${options.min} and ${options.max}`
        : "";
    return fail(
      `Expected ${setting} to be ${options.integer ? "an integer" : "a number"}${range}.`,
    );
  }

  return parsed;
};

export const unsupportedConfigSetting = (setting: string): never =>
  fail(
    `Unsupported config setting \`${setting}\`. Run \`machdoch config list\` to see configurable settings.`,
  );

export const configSource = (
  persisted: unknown,
  envValue?: string,
  fallback = "default",
): string =>
  envValue ? "environment" : persisted !== undefined ? "saved" : fallback;
