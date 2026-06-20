import type { RalphInputField, RalphInputValue } from "../ralph.js";

const RALPH_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export interface NormalizedRalphInputResponseValues {
  values: Record<string, RalphInputValue>;
  skipped: string[];
  errors: string[];
}

export const stringifyRalphInputValue = (value: RalphInputValue): string => {
  if (value === null) {
    return "";
  }

  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }

  return String(value);
};

export const hasRalphInputValue = (
  value: RalphInputValue | undefined,
): boolean => {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
};

export const isRalphVariableName = (value: string): boolean => {
  return RALPH_VARIABLE_NAME_PATTERN.test(value);
};

export const getRalphInputFieldVariableNames = (
  field: RalphInputField,
): string[] => {
  const names = new Set<string>();
  const variableName = field.variableName?.trim();

  if (variableName && isRalphVariableName(variableName)) {
    names.add(variableName);
  }

  if (isRalphVariableName(field.id)) {
    names.add(field.id);
  }

  return [...names];
};

const validateStringInputValue = (
  field: RalphInputField,
  value: string,
  errors: string[],
): void => {
  const validation = field.validation;

  if (validation?.minLength !== undefined && value.length < validation.minLength) {
    errors.push(`${field.label} must be at least ${validation.minLength} characters.`);
  }

  if (validation?.maxLength !== undefined && value.length > validation.maxLength) {
    errors.push(`${field.label} must be at most ${validation.maxLength} characters.`);
  }

  if (validation?.pattern) {
    try {
      if (!new RegExp(validation.pattern, "u").test(value)) {
        errors.push(`${field.label} does not match the required pattern.`);
      }
    } catch {
      errors.push(`${field.label} has an invalid validation pattern.`);
    }
  }
};

const normalizeInputResponseValue = (
  field: RalphInputField,
  rawValue: RalphInputValue | undefined,
  errors: string[],
): RalphInputValue => {
  const value = rawValue ?? field.defaultValue ?? null;

  if (!hasRalphInputValue(value)) {
    if (field.required && !field.skippable) {
      errors.push(`${field.label} is required.`);
    }

    return null;
  }

  const optionValues = new Set(field.options?.map((option) => option.value) ?? []);

  if (field.type === "number") {
    const numericValue =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value.trim())
          : Number.NaN;

    if (!Number.isFinite(numericValue)) {
      errors.push(`${field.label} must be a number.`);
      return null;
    }

    if (field.validation?.min !== undefined && numericValue < field.validation.min) {
      errors.push(`${field.label} must be at least ${field.validation.min}.`);
    }

    if (field.validation?.max !== undefined && numericValue > field.validation.max) {
      errors.push(`${field.label} must be at most ${field.validation.max}.`);
    }

    return numericValue;
  }

  if (field.type === "boolean") {
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();

      if (normalized === "true" || normalized === "yes" || normalized === "1") {
        return true;
      }

      if (normalized === "false" || normalized === "no" || normalized === "0") {
        return false;
      }
    }

    errors.push(`${field.label} must be true or false.`);
    return null;
  }

  if (
    field.type === "multiselect" ||
    field.type === "files" ||
    field.type === "images"
  ) {
    const values = Array.isArray(value)
      ? value.map((entry) => entry.trim()).filter(Boolean)
      : typeof value === "string"
        ? [value.trim()].filter(Boolean)
        : [];

    if (field.type === "multiselect" && optionValues.size > 0) {
      for (const entry of values) {
        if (!optionValues.has(entry)) {
          errors.push(`${field.label} has an unknown option: ${entry}.`);
        }
      }
    }

    return values;
  }

  const stringValue =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
  const trimmedValue = stringValue.trim();

  if (field.type === "select" && optionValues.size > 0 && !optionValues.has(trimmedValue)) {
    errors.push(`${field.label} has an unknown option: ${trimmedValue}.`);
  }

  if (field.type === "url") {
    try {
      new URL(trimmedValue);
    } catch {
      errors.push(`${field.label} must be a valid URL.`);
    }
  }

  validateStringInputValue(field, stringValue, errors);

  return stringValue;
};

export const normalizeRalphInputResponseValues = (
  fields: RalphInputField[],
  values: Record<string, RalphInputValue> | undefined,
): NormalizedRalphInputResponseValues => {
  const normalizedValues: Record<string, RalphInputValue> = {};
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const field of fields) {
    const value = normalizeInputResponseValue(field, values?.[field.id], errors);
    normalizedValues[field.id] = value;

    if (!hasRalphInputValue(value)) {
      skipped.push(field.id);
    }
  }

  return { values: normalizedValues, skipped, errors };
};
