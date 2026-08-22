import type {
  ReadOnlyInspectionTarget,
  TaskDeterministicAction,
} from "../types.js";

const INSPECTION_TARGETS = new Set<ReadOnlyInspectionTarget>([
  "workspace",
  "runtime-config",
  "tools",
  "instructions",
  "prompts",
  "skills",
  "customizations",
]);

export type DeterministicActionValidation =
  | { state: "invalid"; reason: string }
  | { state: "valid"; action: TaskDeterministicAction };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
};

export const validateTaskDeterministicAction = (
  value: unknown,
): DeterministicActionValidation => {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return {
      state: "invalid",
      reason:
        "The deterministic action must be a structured object with a known kind.",
    };
  }

  switch (value.kind) {
    case "inspect":
      if (
        !hasExactKeys(value, ["kind", "target"]) ||
        typeof value.target !== "string" ||
        !INSPECTION_TARGETS.has(value.target as ReadOnlyInspectionTarget)
      ) {
        return {
          state: "invalid",
          reason: "The inspection action must contain exactly a known target.",
        };
      }

      return {
        state: "valid",
        action: {
          kind: "inspect",
          target: value.target as ReadOnlyInspectionTarget,
        },
      };

    case "inspect-path":
      if (
        !hasExactKeys(value, ["kind", "path"]) ||
        typeof value.path !== "string" ||
        value.path.trim().length === 0
      ) {
        return {
          state: "invalid",
          reason:
            "The inspect-path action must contain exactly one non-empty path.",
        };
      }

      return {
        state: "valid",
        action: { kind: "inspect-path", path: value.path },
      };

    case "create-file":
      if (
        !hasExactKeys(value, ["content", "kind", "path"]) ||
        typeof value.path !== "string" ||
        value.path.trim().length === 0 ||
        typeof value.content !== "string"
      ) {
        return {
          state: "invalid",
          reason:
            "The create-file action must contain exactly a non-empty path and string content.",
        };
      }

      return {
        state: "valid",
        action: {
          kind: "create-file",
          path: value.path,
          content: value.content,
        },
      };

    default:
      return {
        state: "invalid",
        reason: `Unknown deterministic action kind: ${value.kind}.`,
      };
  }
};
