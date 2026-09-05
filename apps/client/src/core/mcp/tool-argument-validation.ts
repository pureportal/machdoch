import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { createHash } from "node:crypto";

const validator = new Ajv2020({
  allErrors: false,
  strict: false,
  validateFormats: false,
});
const MAX_CACHED_SCHEMAS = 128;
const MAX_SCHEMA_BYTES = 256 * 1024;
const compiledSchemas = new Map<string, ValidateFunction | string>();

const formatError = (error: ErrorObject): string => {
  const location = error.instancePath || "/";
  return `${location} ${error.message ?? "is invalid"}`;
};

export const validateMcpToolArguments = (
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
): string | undefined => {
  let validate;
  try {
    const serialized = JSON.stringify(inputSchema);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES) {
      return "The discovered MCP tool input schema exceeds 256 KB.";
    }
    const key = createHash("sha256").update(serialized).digest("hex");
    const cached = compiledSchemas.get(key);
    if (cached !== undefined) {
      compiledSchemas.delete(key);
      compiledSchemas.set(key, cached);
      if (typeof cached === "string") return cached;
      validate = cached;
    } else {
      let compiled: ValidateFunction | string;
      try {
        compiled = validator.compile(inputSchema);
      } catch (error) {
        compiled = `The discovered MCP tool input schema is invalid: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        // AJV caches by object identity. Discovery reloads produce new objects;
        // keep only our bounded content cache, including failed compilations.
        validator.removeSchema(inputSchema);
      }
      compiledSchemas.set(key, compiled);
      if (compiledSchemas.size > MAX_CACHED_SCHEMAS) {
        const oldest = compiledSchemas.keys().next().value;
        if (oldest !== undefined) compiledSchemas.delete(oldest);
      }
      if (typeof compiled === "string") return compiled;
      validate = compiled;
    }
  } catch (error) {
    return `The discovered MCP tool input schema is invalid: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  if (validate(args)) {
    return undefined;
  }

  const details = (validate.errors ?? []).map(formatError).join("; ");
  return `MCP tool arguments do not match the discovered input schema${
    details ? `: ${details}` : "."
  }`;
};
