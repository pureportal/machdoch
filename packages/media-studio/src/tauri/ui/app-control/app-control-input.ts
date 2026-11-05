import type {
  AppControlInputSchema,
  AppControlValueSchema,
} from "./app-control-contract";

const describeType = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const validateValue = (
  schema: AppControlValueSchema,
  value: unknown,
  path: string,
): string | null => {
  switch (schema.type) {
    case "string":
      if (typeof value !== "string")
        return `${path} must be a string, not ${describeType(value)}.`;
      if (schema.enum && !schema.enum.includes(value))
        return `${path} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}.`;
      if (schema.minLength !== undefined && value.length < schema.minLength)
        return `${path} must have at least ${schema.minLength} characters.`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength)
        return `${path} must have at most ${schema.maxLength} characters.`;
      return null;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value))
        return `${path} must be a number, not ${describeType(value)}.`;
      if (schema.type === "integer" && !Number.isInteger(value))
        return `${path} must be an integer.`;
      if (schema.minimum !== undefined && value < schema.minimum)
        return `${path} must be at least ${schema.minimum}.`;
      if (schema.maximum !== undefined && value > schema.maximum)
        return `${path} must be at most ${schema.maximum}.`;
      return null;
    case "boolean":
      return typeof value === "boolean"
        ? null
        : `${path} must be true or false, not ${describeType(value)}.`;
    case "array": {
      if (!Array.isArray(value))
        return `${path} must be an array, not ${describeType(value)}.`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems)
        return `${path} must have at most ${schema.maxItems} items.`;
      for (const [index, item] of value.entries()) {
        const error = validateValue(schema.items, item, `${path}[${index}]`);
        if (error) return error;
      }
      return null;
    }
  }
};

export const validateAppControlInput = (
  schema: AppControlInputSchema,
  input: Record<string, unknown>,
): string | null => {
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema.properties, key))
      return `Unknown input "${key}". Allowed: ${Object.keys(schema.properties).join(", ") || "none"}.`;
  }
  for (const key of schema.required ?? []) {
    if (input[key] === undefined) return `Input "${key}" is required.`;
  }
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const error = validateValue(schema.properties[key]!, value, key);
    if (error) return error;
  }
  return null;
};
