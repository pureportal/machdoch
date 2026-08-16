import type { TaskExecutionControl, TaskResultProtocol } from "../types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean => {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
};

export const validateTaskResultProtocol = (
  value: unknown,
): TaskResultProtocol | undefined => {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return undefined;
  }

  if (value.kind === "ralph-iteration") {
    return hasExactKeys(value, ["kind"])
      ? { kind: "ralph-iteration" }
      : undefined;
  }
  if (value.kind === "ralph-validator") {
    return hasExactKeys(value, ["kind"])
      ? { kind: "ralph-validator" }
      : undefined;
  }
  if (
    value.kind === "ralph-route" &&
    hasExactKeys(value, ["kind", "labels"]) &&
    Array.isArray(value.labels) &&
    value.labels.length > 0 &&
    value.labels.every(
      (label, index, labels) =>
        typeof label === "string" &&
        label.length > 0 &&
        label.trim() === label &&
        labels.indexOf(label) === index,
    )
  ) {
    return { kind: "ralph-route", labels: [...value.labels] };
  }

  return undefined;
};

export const createTaskResultControlSchema = (
  rawProtocol: TaskResultProtocol,
): Record<string, unknown> => {
  const protocol = validateTaskResultProtocol(rawProtocol);
  if (!protocol) {
    throw new Error("The structured result protocol is missing or invalid.");
  }

  switch (protocol.kind) {
    case "ralph-iteration":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { const: "ralph-iteration" },
          decision: { type: "string", enum: ["DONE", "CONTINUE"] },
        },
        required: ["kind", "decision"],
      };
    case "ralph-validator":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { const: "ralph-validator" },
          decision: {
            type: "string",
            enum: ["DONE", "CONTINUE", "RETRY", "ERROR"],
          },
        },
        required: ["kind", "decision"],
      };
    case "ralph-route":
      return {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { const: "ralph-route" },
          label: { type: "string", enum: protocol.labels },
        },
        required: ["kind", "label"],
      };
  }
};

export const createTaskResultControlOptions = (
  rawProtocol: TaskResultProtocol,
): TaskExecutionControl[] => {
  const protocol = validateTaskResultProtocol(rawProtocol);
  if (!protocol) {
    throw new Error("The structured result protocol is missing or invalid.");
  }

  switch (protocol.kind) {
    case "ralph-iteration":
      return [
        { kind: "ralph-iteration", decision: "DONE" },
        { kind: "ralph-iteration", decision: "CONTINUE" },
      ];
    case "ralph-validator":
      return [
        { kind: "ralph-validator", decision: "DONE" },
        { kind: "ralph-validator", decision: "CONTINUE" },
        { kind: "ralph-validator", decision: "RETRY" },
        { kind: "ralph-validator", decision: "ERROR" },
      ];
    case "ralph-route":
      return protocol.labels.map((label) => ({
        kind: "ralph-route",
        label,
      }));
  }
};

export const parseTaskExecutionControl = (
  value: unknown,
  rawProtocol: TaskResultProtocol,
): TaskExecutionControl | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const protocol = validateTaskResultProtocol(rawProtocol);
  if (!protocol) {
    return undefined;
  }

  switch (protocol.kind) {
    case "ralph-iteration":
      return hasExactKeys(value, ["decision", "kind"]) &&
        value.kind === "ralph-iteration" &&
        (value.decision === "DONE" || value.decision === "CONTINUE")
        ? { kind: "ralph-iteration", decision: value.decision }
        : undefined;
    case "ralph-validator":
      return hasExactKeys(value, ["decision", "kind"]) &&
        value.kind === "ralph-validator" &&
        (value.decision === "DONE" ||
          value.decision === "CONTINUE" ||
          value.decision === "RETRY" ||
          value.decision === "ERROR")
        ? { kind: "ralph-validator", decision: value.decision }
        : undefined;
    case "ralph-route":
      return hasExactKeys(value, ["kind", "label"]) &&
        value.kind === "ralph-route" &&
        typeof value.label === "string" &&
        protocol.labels.includes(value.label)
        ? { kind: "ralph-route", label: value.label }
        : undefined;
  }
};
