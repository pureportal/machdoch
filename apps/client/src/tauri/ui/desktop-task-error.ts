export type DesktopTaskRunFailure =
  | { kind: "task-already-active"; taskId: string }
  | { kind: "operation-already-active"; activeTaskId: string }
  | { kind: "cancelled"; message: string }
  | {
      kind: "timed-out";
      timeoutKind: "idle" | "absolute";
      message: string;
    }
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

const readNonEmptyString = (
  value: Record<string, unknown>,
  field: string,
): string | undefined => {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
};

export const parseDesktopTaskRunFailure = (
  value: unknown,
): DesktopTaskRunFailure | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  if (
    value.kind === "task-already-active" &&
    hasExactKeys(value, ["kind", "taskId"])
  ) {
    const taskId = readNonEmptyString(value, "taskId");
    return taskId ? { kind: "task-already-active", taskId } : undefined;
  }

  if (
    value.kind === "operation-already-active" &&
    hasExactKeys(value, ["activeTaskId", "kind"])
  ) {
    const activeTaskId = readNonEmptyString(value, "activeTaskId");
    return activeTaskId
      ? { kind: "operation-already-active", activeTaskId }
      : undefined;
  }

  if (value.kind === "runtime" && hasExactKeys(value, ["kind", "message"])) {
    const message = readNonEmptyString(value, "message");
    return message ? { kind: "runtime", message } : undefined;
  }

  if (value.kind === "cancelled" && hasExactKeys(value, ["kind", "message"])) {
    const message = readNonEmptyString(value, "message");
    return message ? { kind: "cancelled", message } : undefined;
  }

  if (
    value.kind === "timed-out" &&
    (value.timeoutKind === "idle" || value.timeoutKind === "absolute") &&
    hasExactKeys(value, ["kind", "message", "timeoutKind"])
  ) {
    const message = readNonEmptyString(value, "message");
    return message
      ? { kind: "timed-out", timeoutKind: value.timeoutKind, message }
      : undefined;
  }

  return undefined;
};

export class DesktopTaskRunProtocolError extends Error {
  readonly failure: DesktopTaskRunFailure;

  constructor(failure: DesktopTaskRunFailure) {
    const message =
      failure.kind === "task-already-active"
        ? `Desktop task ${failure.taskId} is already active.`
        : failure.kind === "operation-already-active"
          ? `Desktop task operation is already active under task ${failure.activeTaskId}.`
          : failure.message;
    super(message);
    this.name = "DesktopTaskRunProtocolError";
    this.failure = failure;
  }
}

export const normalizeDesktopTaskRunError = (error: unknown): Error => {
  const failure = parseDesktopTaskRunFailure(error);
  if (failure) {
    return new DesktopTaskRunProtocolError(failure);
  }

  return error instanceof Error ? error : new Error(String(error));
};

export const getDesktopTaskRunFailure = (
  error: unknown,
): DesktopTaskRunFailure | undefined => {
  return error instanceof DesktopTaskRunProtocolError
    ? error.failure
    : parseDesktopTaskRunFailure(error);
};
