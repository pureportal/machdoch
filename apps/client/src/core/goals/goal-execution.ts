import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type { TaskExecutionOptions, TaskExecutionResult } from "../types.js";
import { getAvailableGoalModes } from "../../shared/goals.js";
import { parseGoalCommand } from "./goal-command.js";
import {
  clearGoalRecord,
  getGoalPath,
  readGoalRecord,
  updateGoalRecord,
} from "./goal-store.js";
import { commandResult, describeGoal } from "./goal-result.js";
import { executeGoalRun, type GoalTurnExecutor } from "./run-goal.js";
import { withCooperativeFileLock } from "../_helpers/with-cooperative-file-lock.helper.js";

export const executeWithSessionGoal = async (
  task: string,
  config: RuntimeConfig,
  options: TaskExecutionOptions,
  execute: GoalTurnExecutor,
): Promise<TaskExecutionResult> => {
  if (
    options.resultProtocol ||
    options.executionRole === "validator" ||
    options.executionRole === "generator" ||
    options.deterministicAction
  ) {
    return execute(task, config, options);
  }
  const command = parseGoalCommand(task);
  const sessionId = options.conversationContext?.sessionId;
  if (!command && !sessionId) return execute(task, config, options);
  const path = getGoalPath(config.workspaceRoot, sessionId ?? "command-line");
  const selectedMode = options.conversationContext?.goalMode;
  if (command?.kind === "clear") {
    const record = await clearGoalRecord(
      path,
      selectedMode &&
        getAvailableGoalModes(config.provider).includes(selectedMode)
        ? selectedMode
        : undefined,
    );
    return commandResult(
      task,
      config,
      "Goal cleared.",
      record.goal,
      record.mode,
    );
  }
  let record = await readGoalRecord(path);
  if (
    selectedMode &&
    command?.kind !== "mode" &&
    selectedMode !== record.mode &&
    getAvailableGoalModes(config.provider).includes(selectedMode)
  ) {
    record = await updateGoalRecord(path, (current) => ({
      ...current,
      mode: selectedMode,
    }));
  }
  if (command?.kind === "mode") {
    if (!getAvailableGoalModes(config.provider).includes(command.mode)) {
      throw new Error(
        "Native goals are unavailable for this provider. Choose Machdoch mode.",
      );
    }
    record = await updateGoalRecord(path, (current) => ({
      ...current,
      mode: command.mode,
    }));
    return commandResult(
      task,
      config,
      `Goal mode: ${command.mode === "machdoch" ? "Machdoch" : "Native"}.`,
      record.goal,
      record.mode,
    );
  }
  if (command?.kind === "status") {
    return commandResult(
      task,
      config,
      describeGoal(record.goal),
      record.goal,
      record.mode,
    );
  }
  if (command?.kind === "pause") {
    record = await updateGoalRecord(path, (current) => ({
      ...current,
      goal:
        current.goal && current.goal.status !== "complete"
          ? {
              ...current.goal,
              status: "paused",
              updatedAt: Date.now(),
              reason: "Paused by user.",
            }
          : current.goal,
    }));
    return commandResult(
      task,
      config,
      describeGoal(record.goal),
      record.goal,
      record.mode,
    );
  }
  if (!command && record.goal?.status !== "active")
    return execute(task, config, options);
  return withCooperativeFileLock(
    `${path}.run`,
    async () => {
      record = await readGoalRecord(path);
      if (command?.kind === "set") {
        if (options.conversationContext?.chatType === "pose")
          throw new Error("Goals require an agent chat.");
        const mode = options.conversationContext?.goalMode ?? record.mode;
        if (!getAvailableGoalModes(config.provider).includes(mode))
          throw new Error(
            "Native goals are unavailable for this provider. Choose Machdoch mode.",
          );
        if (mode === "native" && (command.tokenBudget || command.turnBudget)) {
          throw new Error(
            "Use Machdoch mode for token or turn limits. Native goals support --minutes.",
          );
        }
        record = await updateGoalRecord(path, (current) => {
          if (
            current.goal &&
            !["complete", "paused", "blocked", "budget-limited"].includes(
              current.goal.status,
            )
          ) {
            throw new Error(
              "A goal is active. Pause or clear it before setting another.",
            );
          }
          const timestamp = Date.now();
          return {
            version: 1,
            mode,
            goal: {
              id: randomUUID(),
              objective: command.objective,
              mode,
              status: "active",
              turns: 0,
              tokensUsed: 0,
              elapsedMs: 0,
              reason: "",
              createdAt: timestamp,
              updatedAt: timestamp,
              ...(command.tokenBudget
                ? { tokenBudget: command.tokenBudget }
                : {}),
              ...(command.turnBudget ? { turnBudget: command.turnBudget } : {}),
              ...(command.timeBudgetMs
                ? { timeBudgetMs: command.timeBudgetMs }
                : {}),
            },
          };
        });
      }
      if (command?.kind === "resume") {
        record = await updateGoalRecord(path, (current) => {
          if (!current.goal)
            throw new Error("No goal set. Use /goal <objective>.");
          if (
            !getAvailableGoalModes(config.provider).includes(current.goal.mode)
          )
            throw new Error(
              "This goal uses an unavailable native provider. Select its provider or clear the goal.",
            );
          if (current.goal.status === "complete")
            throw new Error("This goal is complete. Set a new goal.");
          if (current.goal.status === "budget-limited")
            throw new Error(
              "This goal reached its limit. Set a new goal with a larger limit.",
            );
          return {
            ...current,
            goal: {
              ...current.goal,
              status: "active",
              reason: "",
              updatedAt: Date.now(),
            },
          };
        });
      }
      return executeGoalRun(
        task,
        config,
        options,
        execute,
        path,
        record,
        !command,
      );
    },
    { timeoutMs: 1, ownerDescription: "session goal runner" },
  );
};
