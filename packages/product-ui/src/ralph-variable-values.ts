export interface RalphVariableDefinition {
  name: string;
  type:
    | "string"
    | "text"
    | "path"
    | "file"
    | "files"
    | "url"
    | "number"
    | "boolean"
    | "image"
    | "images"
    | "model"
    | "provider"
    | "pack";
  default?: string | undefined;
  required: boolean;
}

export const maximumRalphParameterValueLength = 8_000;

export interface RalphVariableValidationOptions {
  maximumValueLength?: number;
}

export const createDefaultRalphVariableValues = (
  variables: readonly RalphVariableDefinition[],
): Record<string, string> =>
  Object.fromEntries(
    variables.map((variable) => [variable.name, variable.default ?? ""]),
  );

export const getRalphVariableValue = (
  variable: RalphVariableDefinition,
  values: Readonly<Record<string, string>>,
): string =>
  Object.hasOwn(values, variable.name)
    ? (values[variable.name] ?? "")
    : (variable.default ?? "");

export const normalizeRalphBooleanVariableValue = (
  value: string,
): "true" | "false" | "" | null => {
  const normalized = value.trim().toLowerCase();

  if (!normalized) return "";
  if (normalized === "true" || normalized === "false") return normalized;
  return null;
};

export const validateRalphFlowVariableValue = (
  variable: RalphVariableDefinition,
  value: string | undefined,
  options: RalphVariableValidationOptions = {},
): string | null => {
  const rawValue = value ?? variable.default ?? "";
  const trimmedValue = rawValue.trim();

  if (variable.required && !trimmedValue) return "This variable is required.";
  if (!trimmedValue) return null;

  if (
    options.maximumValueLength !== undefined &&
    rawValue.length > options.maximumValueLength
  ) {
    return `Enter ${options.maximumValueLength.toLocaleString()} characters or fewer.`;
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
  variables: readonly RalphVariableDefinition[],
  values: Readonly<Record<string, string>>,
  options: RalphVariableValidationOptions = {},
): Record<string, string> =>
  Object.fromEntries(
    variables.flatMap((variable) => {
      const error = validateRalphFlowVariableValue(
        variable,
        Object.hasOwn(values, variable.name)
          ? values[variable.name]
          : undefined,
        options,
      );
      return error ? [[variable.name, error]] : [];
    }),
  );
