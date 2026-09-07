import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";

const validatorOptions = {
  allErrors: false,
  strict: false,
  validateFormats: false,
};
const DEFAULT_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const validators = new Map<string, Ajv>([
  ["http://json-schema.org/draft-07/schema", new Ajv(validatorOptions)],
  [
    "https://json-schema.org/draft/2019-09/schema",
    new Ajv2019(validatorOptions),
  ],
  [DEFAULT_SCHEMA_DIALECT, new Ajv2020(validatorOptions)],
]);
const MAX_CACHED_SCHEMAS = 128;
const MAX_SCHEMA_BYTES = 256 * 1024;
const compiledSchemas = new Map<string, ValidateFunction | string>();

const formatError = (error: ErrorObject): string => {
  const location = error.instancePath || "/";
  return `${location} ${error.message ?? "is invalid"}`;
};

export const validateToolArguments = (
  inputSchema: Record<string, unknown>,
  args: Record<string, unknown>,
): string | undefined => {
  let validate;
  try {
    const serialized = JSON.stringify(inputSchema);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES) {
      return "The tool input schema exceeds 256 KB.";
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
      let validator: Ajv | undefined;
      try {
        const dialect = inputSchema.$schema;
        if (dialect !== undefined && typeof dialect !== "string") {
          throw new Error("$schema must be a string.");
        }
        validator = validators.get(
          dialect?.replace(/#$/u, "") ?? DEFAULT_SCHEMA_DIALECT,
        );
        if (!validator) {
          throw new Error(`Unsupported JSON Schema dialect: ${dialect}`);
        }
        compiled = validator.compile(inputSchema);
      } catch (error) {
        compiled = `The tool input schema is invalid: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        validator?.removeSchema(inputSchema);
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
    return `The tool input schema is invalid: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  if (validate(args)) {
    return undefined;
  }

  const details = (validate.errors ?? []).map(formatError).join("; ");
  return `Tool arguments do not match the input schema${
    details ? `: ${details}` : "."
  }`;
};
