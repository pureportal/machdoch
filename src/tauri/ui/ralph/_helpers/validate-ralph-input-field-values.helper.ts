import type { RalphInputField, RalphInputValue } from "../../../../core/ralph.js";

export const getDefaultRalphInputValue = (
  field: RalphInputField,
): RalphInputValue => {
  if (field.defaultValue !== undefined) {
    return field.defaultValue;
  }

  return field.type === "boolean" ? false : null;
};

export const createDefaultRalphInputValues = (
  fields: readonly RalphInputField[],
): Record<string, RalphInputValue> => {
  return Object.fromEntries(
    fields.map((field) => [field.id, getDefaultRalphInputValue(field)]),
  );
};

export const isEmptyRalphInputValue = (
  value: RalphInputValue | undefined,
): boolean => {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
};

export const formatRalphInputValueForPrompt = (
  value: RalphInputValue | undefined,
): string => {
  if (value === undefined || value === null) {
    return "Skipped";
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "Skipped";
  }

  return String(value);
};

export const validateRalphInputFieldValue = (
  field: RalphInputField,
  value: RalphInputValue | undefined,
): string | null => {
  if (field.required && !field.skippable && isEmptyRalphInputValue(value)) {
    return "This answer is required.";
  }

  if (isEmptyRalphInputValue(value)) {
    return null;
  }

  if (field.type === "number") {
    const numericValue =
      typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
          ? Number(value)
          : Number.NaN;

    if (!Number.isFinite(numericValue)) {
      return "Enter a valid number.";
    }

    if (field.validation?.min !== undefined && numericValue < field.validation.min) {
      return `Enter a value of at least ${field.validation.min}.`;
    }

    if (field.validation?.max !== undefined && numericValue > field.validation.max) {
      return `Enter a value of at most ${field.validation.max}.`;
    }
  }

  if (typeof value === "string") {
    if (
      field.validation?.minLength !== undefined &&
      value.length < field.validation.minLength
    ) {
      return `Enter at least ${field.validation.minLength} characters.`;
    }

    if (
      field.validation?.maxLength !== undefined &&
      value.length > field.validation.maxLength
    ) {
      return `Enter at most ${field.validation.maxLength} characters.`;
    }

    if (field.validation?.pattern) {
      try {
        const pattern = new RegExp(field.validation.pattern, "u");

        if (!pattern.test(value)) {
          return "Enter a value matching the requested format.";
        }
      } catch {
        return null;
      }
    }
  }

  return null;
};

export const validateRalphInputFieldValues = (
  fields: readonly RalphInputField[],
  values: Record<string, RalphInputValue>,
): Record<string, string> => {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const error = validateRalphInputFieldValue(field, values[field.id]);

      return error ? [[field.id, error]] : [];
    }),
  );
};
