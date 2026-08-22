export type McpConfigSaveFailure =
  | { kind: "conflict"; path: string }
  | { kind: "runtime"; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
};

export const parseMcpConfigSaveFailure = (
  value: unknown,
): McpConfigSaveFailure | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.kind === "conflict" && hasExactKeys(value, ["kind", "path"])) {
    const path = typeof value.path === "string" ? value.path.trim() : "";
    return path ? { kind: "conflict", path } : undefined;
  }

  if (value.kind === "runtime" && hasExactKeys(value, ["kind", "message"])) {
    const message =
      typeof value.message === "string" ? value.message.trim() : "";
    return message ? { kind: "runtime", message } : undefined;
  }

  return undefined;
};

export class McpConfigSaveProtocolError extends Error {
  readonly failure: McpConfigSaveFailure;

  constructor(failure: McpConfigSaveFailure) {
    super(
      failure.kind === "conflict"
        ? `MCP configuration changed at ${failure.path}.`
        : failure.message,
    );
    this.name = "McpConfigSaveProtocolError";
    this.failure = failure;
  }
}

export const normalizeMcpConfigSaveError = (error: unknown): Error => {
  const failure = parseMcpConfigSaveFailure(error);
  if (failure) {
    return new McpConfigSaveProtocolError(failure);
  }
  return error instanceof Error ? error : new Error(String(error));
};

export const isMcpConfigConflictError = (error: unknown): boolean => {
  return error instanceof McpConfigSaveProtocolError
    ? error.failure.kind === "conflict"
    : parseMcpConfigSaveFailure(error)?.kind === "conflict";
};
