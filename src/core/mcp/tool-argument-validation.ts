import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

const validator = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false,
});

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
    validate = validator.compile(inputSchema);
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
