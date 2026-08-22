import type {
  TaskExecutionState,
  TaskExecutionStatus,
} from "../types.js";

type TerminalTaskExecutionState = Extract<
  TaskExecutionState,
  "completed" | "planned" | "blocked" | "unsupported" | "cancelled"
>;

const TERMINAL_EXECUTION_STATES = {
  completed: true,
  planned: true,
  blocked: true,
  unsupported: true,
  cancelled: true,
} satisfies Record<TerminalTaskExecutionState, true>;

export const isTerminalTaskExecutionState = (
  state: TaskExecutionState,
): boolean => {
  return state in TERMINAL_EXECUTION_STATES;
};

export const TASK_EXECUTION_STATUS_TO_TERMINAL_STATE = {
  planned: "planned",
  executed: "completed",
  blocked: "blocked",
  cancelled: "cancelled",
  unsupported: "unsupported",
} satisfies Record<TaskExecutionStatus, TerminalTaskExecutionState>;
