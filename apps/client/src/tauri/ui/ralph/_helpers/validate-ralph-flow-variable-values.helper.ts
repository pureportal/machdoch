import type { RalphFlowVariable } from "../../../../core/ralph.js";

export const createDefaultRalphVariableValues = (
  variables: readonly RalphFlowVariable[],
): Record<string, string> => {
  return Object.fromEntries(
    variables.map((variable) => [variable.name, variable.default ?? ""]),
  );
};

export const getRalphVariableValue = (
  variable: RalphFlowVariable,
  values: Record<string, string>,
): string => {
  return values[variable.name] ?? variable.default ?? "";
};

export const normalizeRalphBooleanVariableValue = (
  value: string,
): "true" | "false" | "" | null => {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return "";
  }

  if (normalized === "true" || normalized === "false") {
    return normalized;
  }

  return null;
};

export const validateRalphFlowVariableValue = (
  variable: RalphFlowVariable,
  value: string | undefined,
): string | null => {
  const rawValue = value ?? variable.default ?? "";
  const trimmedValue = rawValue.trim();

  if (variable.required && !trimmedValue) {
    return "This variable is required.";
  }

  if (!trimmedValue) {
    return null;
  }

  if (variable.type === "number" && !Number.isFinite(Number(trimmedValue))) {
    return "Enter a valid number.";
  }

  if (
    variable.type === "boolean" &&
    normalizeRalphBooleanVariableValue(trimmedValue) === null
  ) {
    return "Choose true or false.";
  }

  if (variable.type === "url") {
    try {
      new URL(trimmedValue);
    } catch {
      return "Enter a valid URL.";
    }
  }

  return null;
};

export const validateRalphFlowVariableValues = (
  variables: readonly RalphFlowVariable[],
  values: Record<string, string>,
): Record<string, string> => {
  return Object.fromEntries(
    variables.flatMap((variable) => {
      const error = validateRalphFlowVariableValue(variable, values[variable.name]);

      return error ? [[variable.name, error]] : [];
    }),
  );
};
