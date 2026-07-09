import { coerceInteger, coerceString } from "../agent-tools-shared.js";
import { executeLocalCommand, type LocalCommandResult } from "../process-execution.js";
import {
  CONFIGURABLE_AUDIT_LEVELS,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  MAX_PACKAGE_SPEC_LENGTH,
  MAX_PACKAGE_SPECS,
  MAX_SCRIPT_ARG_LENGTH,
  MAX_SCRIPT_ARGS,
  MAX_SCRIPT_TIMEOUT_MS,
  PACKAGE_MAX_BUFFER_BYTES,
  PACKAGE_TIMEOUT_MS,
  type ConfigurableAuditLevel,
  type NodePackageManager,
  type NodePackageProject,
} from "./model.js";

const normalizeStringArray = (
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0
      ? [entry.trim()]
      : [],
  );

  if (normalized.length > maxItems) {
    return undefined;
  }

  return normalized.every(
    (entry) => entry.length <= maxLength && !entry.includes("\0"),
  )
    ? normalized
    : undefined;
};

export const normalizeScriptArgs = (value: unknown): string[] | undefined => {
  return value === undefined
    ? []
    : normalizeStringArray(value, MAX_SCRIPT_ARGS, MAX_SCRIPT_ARG_LENGTH);
};

export const normalizePackageSpecs = (value: unknown): string[] | undefined => {
  const packageSpecs = normalizeStringArray(
    value,
    MAX_PACKAGE_SPECS,
    MAX_PACKAGE_SPEC_LENGTH,
  );

  if (!packageSpecs) {
    return undefined;
  }

  const invalidSpec = packageSpecs.find(
    (spec) =>
      /\s/u.test(spec) ||
      spec.startsWith("-") ||
      spec.startsWith(".") ||
      spec.startsWith("/") ||
      spec.startsWith("~") ||
      /^[A-Za-z]:[\\/]/u.test(spec) ||
      /^(?:file|link|portal|workspace|patch|git(?:\+ssh|\+https|\+http|\+file)?|https?|ssh):/iu.test(
        spec,
      ) ||
      /@(?:file|link|portal|workspace|patch|git(?:\+ssh|\+https|\+http|\+file)?|https?|ssh|github|gitlab|bitbucket):/iu.test(
        spec,
      ) ||
      spec.includes("://") ||
      spec.startsWith("github:") ||
      spec.startsWith("gitlab:") ||
      spec.startsWith("bitbucket:"),
  );

  return invalidSpec ? undefined : packageSpecs;
};

export const scriptCommandArgs = (
  manager: NodePackageManager,
  script: string,
  scriptArgs: string[],
): string[] => {
  switch (manager) {
    case "npm": {
      return [
        "run",
        script,
        ...(scriptArgs.length > 0 ? ["--", ...scriptArgs] : []),
      ];
    }
    case "pnpm":
    case "yarn":
    case "bun": {
      return ["run", script, ...scriptArgs];
    }
  }
};

export const installCommandArgs = (
  manager: NodePackageManager,
  packageSpecs: string[],
  options: { dev: boolean; exact: boolean; lockfileOnly: boolean },
): string[] => {
  switch (manager) {
    case "npm": {
      return [
        "install",
        ...(options.dev ? ["--save-dev"] : []),
        ...(options.exact ? ["--save-exact"] : []),
        ...(options.lockfileOnly ? ["--package-lock-only"] : []),
        ...packageSpecs,
      ];
    }
    case "pnpm": {
      return [
        "add",
        ...(options.dev ? ["--save-dev"] : []),
        ...(options.exact ? ["--save-exact"] : []),
        ...packageSpecs,
      ];
    }
    case "yarn": {
      return [
        "add",
        ...(options.dev ? ["--dev"] : []),
        ...(options.exact ? ["--exact"] : []),
        ...packageSpecs,
      ];
    }
    case "bun": {
      return [
        "add",
        ...(options.dev ? ["--dev"] : []),
        ...(options.exact ? ["--exact"] : []),
        ...(options.lockfileOnly ? ["--lockfile-only"] : []),
        ...packageSpecs,
      ];
    }
  }
};

export const runPackageManager = async (
  project: NodePackageProject,
  args: string[],
  timeoutMs = PACKAGE_TIMEOUT_MS,
  acceptedExitCodes?: number[],
): Promise<LocalCommandResult> => {
  return executeLocalCommand(project.manager, args, {
    cwd: project.packageRoot,
    timeoutMs,
    maxBufferBytes: PACKAGE_MAX_BUFFER_BYTES,
    ...(acceptedExitCodes ? { acceptedExitCodes } : {}),
  });
};

export const coerceBoundedInteger = (
  args: Record<string, unknown>,
  field: string,
  defaultValue: number,
  maxValue: number,
): number | undefined => {
  const value = coerceInteger(args, field) ?? defaultValue;

  return value >= 1 && value <= maxValue ? value : undefined;
};

export const coerceScriptTimeout = (args: Record<string, unknown>): number => {
  const timeoutMs =
    coerceInteger(args, "timeoutMs") ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  return Math.min(Math.max(timeoutMs, 1_000), MAX_SCRIPT_TIMEOUT_MS);
};

export const coerceAuditLevel = (
  args: Record<string, unknown>,
): ConfigurableAuditLevel | undefined => {
  const value = coerceString(args, "auditLevel") ?? "low";

  return CONFIGURABLE_AUDIT_LEVELS.includes(value as ConfigurableAuditLevel)
    ? (value as ConfigurableAuditLevel)
    : undefined;
};

