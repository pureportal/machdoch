import { resolveWorkspacePathReference } from "../task-paths.js";
import type {
  ReadOnlyInspectionTarget,
  TaskDeterministicAction,
} from "../types.js";
import type { TaskPathReference } from "../task-paths.js";
import { validateTaskDeterministicAction } from "./deterministic-action-validation.js";

export type ResolvedDeterministicAction =
  | { kind: "inspect"; target: ReadOnlyInspectionTarget }
  | { kind: "inspect-path"; target: TaskPathReference }
  | { kind: "create-file"; target: TaskPathReference; content: string };

export type DeterministicActionResolution =
  | { state: "none" }
  | { state: "invalid"; reason: string }
  | { state: "resolved"; action: ResolvedDeterministicAction };

export const resolveDeterministicAction = (
  value: TaskDeterministicAction | unknown,
  workspaceRoot: string,
): DeterministicActionResolution => {
  if (value === undefined) {
    return { state: "none" };
  }

  const validation = validateTaskDeterministicAction(value);
  if (validation.state === "invalid") {
    return validation;
  }

  switch (validation.action.kind) {
    case "inspect": {
      return {
        state: "resolved",
        action: {
          kind: "inspect",
          target: validation.action.target,
        },
      };
    }

    case "inspect-path": {
      return {
        state: "resolved",
        action: {
          kind: "inspect-path",
          target: resolveWorkspacePathReference(
            workspaceRoot,
            validation.action.path,
          ),
        },
      };
    }

    case "create-file": {
      return {
        state: "resolved",
        action: {
          kind: "create-file",
          target: resolveWorkspacePathReference(
            workspaceRoot,
            validation.action.path,
          ),
          content: validation.action.content,
        },
      };
    }
  }
};
