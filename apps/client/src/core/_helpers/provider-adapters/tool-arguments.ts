import type { AgentModelToolCall, AgentModelToolSpec } from "../../types.js";
import { validateToolArguments } from "../tool-argument-validation.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const decodeToolArguments = (
  value: unknown,
  serialized = false,
): Pick<AgentModelToolCall, "arguments" | "rawArguments" | "argumentError"> => {
  const rawArguments =
    typeof value === "string" && serialized ? value : undefined;
  let parsed = value;
  if (serialized && typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {
        arguments: {},
        rawArguments: value,
        argumentError:
          "Tool arguments must be a valid JSON object. Correct the arguments and retry.",
      };
    }
  }
  if (parsed !== undefined && !isRecord(parsed)) {
    return {
      arguments: {},
      ...(rawArguments !== undefined ? { rawArguments } : {}),
      argumentError:
        "Tool arguments must be a JSON object. Correct the arguments and retry.",
    };
  }
  return {
    arguments: parsed ?? {},
    ...(rawArguments !== undefined ? { rawArguments } : {}),
  };
};

const validateArgumentValue = (
  value: unknown,
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
): string | undefined =>
  validateToolArguments(
    {
      $schema: root.$schema,
      $defs: root.$defs,
      definitions: root.definitions,
      type: "object",
      properties: { value: schema },
      required: ["value"],
    },
    { value },
  );

const restoreOptionalArguments = (
  value: unknown,
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  depth = 0,
): unknown => {
  if (depth >= 64) return value;
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    let referenced: unknown = root;
    for (const part of schema.$ref.slice(2).split("/")) {
      referenced = isRecord(referenced)
        ? referenced[part.replaceAll("~1", "/").replaceAll("~0", "~")]
        : undefined;
    }
    if (isRecord(referenced) && referenced !== schema) {
      schema = {
        ...referenced,
        ...Object.fromEntries(
          Object.entries(schema).filter(([key]) => key !== "$ref"),
        ),
      };
    }
  }
  for (const variants of [schema.anyOf, schema.oneOf]) {
    if (!Array.isArray(variants)) continue;
    if (
      variants.some(
        (variant) =>
          isRecord(variant) &&
          validateArgumentValue(value, variant, root) === undefined,
      )
    )
      continue;
    for (const variant of variants) {
      if (!isRecord(variant)) continue;
      const candidate = restoreOptionalArguments(
        value,
        variant,
        root,
        depth + 1,
      );
      if (validateArgumentValue(candidate, variant, root) === undefined) {
        value = candidate;
        break;
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const variant of schema.allOf) {
      if (isRecord(variant))
        value = restoreOptionalArguments(value, variant, root, depth + 1);
    }
  }
  if (Array.isArray(value) && Array.isArray(schema.prefixItems)) {
    const prefixItems = schema.prefixItems;
    return value.map((item, index) =>
      isRecord(prefixItems[index])
        ? restoreOptionalArguments(item, prefixItems[index], root, depth + 1)
        : isRecord(schema.items)
          ? restoreOptionalArguments(item, schema.items, root, depth + 1)
          : item,
    );
  }
  if (Array.isArray(value) && isRecord(schema.items)) {
    const itemSchema = schema.items;
    return value.map((item) =>
      restoreOptionalArguments(item, itemSchema, root, depth + 1),
    );
  }
  if (!isRecord(value) || !isRecord(schema.properties)) return value;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required : [],
  );
  const properties = schema.properties;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const property = properties[key];
      if (!isRecord(property)) return [[key, entry]];
      if (
        entry === null &&
        !required.has(key) &&
        validateArgumentValue(null, property, root)?.startsWith(
          "Tool arguments do not match",
        ) === true
      )
        return [];
      return [
        [key, restoreOptionalArguments(entry, property, root, depth + 1)],
      ];
    }),
  );
};

export const decodeOpenAIToolArguments = (
  value: unknown,
  tool: AgentModelToolSpec | undefined,
): ReturnType<typeof decodeToolArguments> => {
  const decoded = decodeToolArguments(value, true);
  if (!tool || tool.strict === false || decoded.argumentError) return decoded;
  if (validateToolArguments(tool.inputSchema, decoded.arguments) === undefined)
    return decoded;
  return {
    ...decoded,
    arguments: restoreOptionalArguments(
      decoded.arguments,
      tool.inputSchema,
      tool.inputSchema,
    ) as Record<string, unknown>,
  };
};
