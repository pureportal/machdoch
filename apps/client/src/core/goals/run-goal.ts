import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type {
  ConversationHistoryEntry,
  TaskExecutionOptions,
  TaskExecutionResult,
} from "../types.js";
import { getActiveTaskModelUsageRecorder } from "../model-usage.js";
import { getAvailableGoalModes, type SessionGoal } from "../../shared/goals.js";
import {
  readGoalRecord,
  updateGoalRecord,
  type GoalRecord,
} from "./goal-store.js";
import { commandResult, describeGoal } from "./goal-result.js";
import { evaluateGoal } from "./goal-evaluation.js";

export type GoalTurnExecutor = (
  task: string,
  config: RuntimeConfig,
  options: TaskExecutionOptions,
) => Promise<TaskExecutionResult>;

const resultText = (result: TaskExecutionResult): string =>
  result.response?.markdown.trim() || result.summary;

export const executeGoalRun = async (
  task: string,
  config: RuntimeConfig,
  options: TaskExecutionOptions,
  execute: GoalTurnExecutor,
  path: string,
  record: GoalRecord,
  userSteering: boolean,
): Promise<TaskExecutionResult> => {
  let goal = record.goal;
  if (!goal || goal.status !== "active") return execute(task, config, options);
  if (!getAvailableGoalModes(config.provider).includes(goal.mode)) {
    throw new Error(
      "This goal uses an unavailable native provider. Select its provider or clear the goal.",
    );
  }
  const goalId = goal.id;
  const runStartedAt = Date.now();
  const elapsedBeforeRun = goal.elapsedMs;
  const tokensBeforeRun = goal.tokensUsed;
  const recorder = getActiveTaskModelUsageRecorder();
  const usageBeforeRun = recorder?.getTokenUsage();
  const tokensRecordedBeforeRun = usageBeforeRun?.totalTokens ?? 0;
  const unavailableUsageBeforeRun = usageBeforeRun?.unavailableCallCount ?? 0;
  const abortController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, abortController.signal])
    : abortController.signal;
  let pendingPoll: Promise<void> | undefined;
  let pollFailure: Error | undefined;
  let limitReason: string | undefined;
  const checkRunLimit = (): void => {
    if (!goal || goal.id !== goalId || goal.status !== "active") return;
    if (
      goal.timeBudgetMs &&
      elapsedBeforeRun + Math.max(0, Date.now() - runStartedAt) >=
        goal.timeBudgetMs
    ) {
      limitReason = "Time limit reached.";
    } else if (
      goal.tokenBudget &&
      tokensBeforeRun +
        (recorder?.getTokenUsage().totalTokens ?? 0) -
        tokensRecordedBeforeRun >=
        goal.tokenBudget
    ) {
      limitReason = "Token limit reached.";
    }
    if (limitReason) abortController.abort(limitReason);
  };
  const poll = setInterval(() => {
    checkRunLimit();
    if (pendingPoll || signal.aborted) return;
    pendingPoll = readGoalRecord(path)
      .then((latest) => {
        if (latest.goal?.id !== goalId || latest.goal.status !== "active")
          abortController.abort("Goal stopped by user.");
      })
      .catch((error: unknown) => {
        pollFailure = error instanceof Error ? error : new Error(String(error));
        abortController.abort("Goal state could not be read.");
      })
      .finally(() => {
        pendingPoll = undefined;
      });
  }, 250);
  poll.unref();
  let lastResult: TaskExecutionResult = commandResult(
    task,
    config,
    describeGoal(goal),
    goal,
    record.mode,
  );
  const history: ConversationHistoryEntry[] = [
    ...(options.conversationContext?.history ?? []),
  ];
  let noProgressTurns = 0;
  let runTurns = 0;
  const checkpoint = async (
    status: SessionGoal["status"],
    reason: string,
  ): Promise<void> => {
    const usage = recorder?.getTokenUsage();
    const updated: SessionGoal = {
      ...goal!,
      status,
      reason: reason.slice(0, 12_000),
      elapsedMs: elapsedBeforeRun + Math.max(0, Date.now() - runStartedAt),
      tokensUsed:
        tokensBeforeRun +
        Math.max(0, (usage?.totalTokens ?? 0) - tokensRecordedBeforeRun),
      updatedAt: Date.now(),
    };
    record = await updateGoalRecord(path, (current) =>
      current.goal?.id === goalId
        ? {
            ...current,
            goal:
              current.goal.status === "active"
                ? updated
                : {
                    ...updated,
                    status: current.goal.status,
                    reason: current.goal.reason,
                  },
          }
        : current,
    );
    goal = record.goal;
    await options.onStateChange?.({
      task,
      mode: config.mode,
      state: "executing",
      message: "Checking goal.",
      executedTools: lastResult.executedTools,
      outputSections: [],
      cancellable: true,
      goal,
    });
  };
  const reportProgress: NonNullable<
    TaskExecutionOptions["onStateChange"]
  > = async (progress) => {
    checkRunLimit();
    const terminal = [
      "completed",
      "blocked",
      "failed",
      "cancelled",
      "planned",
    ].includes(progress.state);
    await options.onStateChange?.({
      ...progress,
      task,
      goal,
      ...(terminal
        ? { state: "executing", message: "Checking goal.", cancellable: true }
        : {}),
    });
  };
  try {
    try {
      while (
        goal?.id === goalId &&
        goal.status === "active" &&
        !signal.aborted
      ) {
        checkRunLimit();
        if (signal.aborted) break;
        if (goal.turnBudget && goal.turns >= goal.turnBudget) {
          await checkpoint("budget-limited", "Turn limit reached.");
          break;
        }
        const directive =
          !userSteering || runTurns > 0
            ? `Work toward this goal and verify the full outcome: ${JSON.stringify(goal.objective)}.\n${goal.reason ? `Next step: ${goal.reason}` : ""}`
            : `${task}\n\nContinue toward the active goal: ${JSON.stringify(goal.objective)}`;
        goal = { ...goal, turns: goal.turns + 1 };
        runTurns += 1;
        lastResult = await execute(directive, config, {
          ...options,
          signal,
          onStateChange: reportProgress,
          captureGoalEvidence: true,
          conversationContext: {
            ...options.conversationContext,
            history: history.slice(-40),
            adaptiveControllerOverride: false,
          },
          systemPromptSections: [
            ...(options.systemPromptSections ?? []),
            `The user has explicitly set a persistent goal: ${JSON.stringify(goal.objective)}. Keep its full scope. Gather evidence of every requirement before claiming completion. Do not infer new goals. Tool and approval rules remain in effect.`,
          ],
          ...(goal.mode === "native" ? { nativeGoal: goal.objective } : {}),
        });
        history.push(
          { role: "user", content: directive },
          { role: "assistant", content: resultText(lastResult) },
        );
        history.splice(0, Math.max(0, history.length - 40));
        await checkpoint("active", "");
        if (!goal || goal.id !== goalId || goal.status !== "active") break;
        checkRunLimit();
        if (signal.aborted || lastResult.status === "cancelled") break;
        if (!["executed", "planned"].includes(lastResult.status)) {
          await checkpoint("blocked", lastResult.reason ?? lastResult.summary);
          break;
        }
        if (
          goal.tokenBudget &&
          (!recorder ||
            recorder.getTokenUsage().unavailableCallCount >
              unavailableUsageBeforeRun)
        ) {
          await checkpoint(
            "paused",
            "Token usage is unavailable. Resume without a token limit by setting a new goal.",
          );
          break;
        }
        const evaluation = await evaluateGoal(
          goal,
          history,
          lastResult,
          config,
          { ...options, signal, onStateChange: reportProgress },
          execute,
        );
        const verdict = evaluation.control;
        checkRunLimit();
        if (signal.aborted) break;
        if (
          goal.tokenBudget &&
          (!recorder ||
            recorder.getTokenUsage().unavailableCallCount >
              unavailableUsageBeforeRun)
        ) {
          await checkpoint(
            "paused",
            "Token usage is unavailable. Resume without a token limit by setting a new goal.",
          );
          break;
        }
        if (
          verdict?.kind !== "goal-evaluation" ||
          !["executed", "planned"].includes(evaluation.status)
        ) {
          await checkpoint(
            "paused",
            `Goal verification failed: ${evaluation.reason ?? evaluation.summary}`,
          );
          break;
        }
        await checkpoint(
          verdict.decision === "complete"
            ? "complete"
            : verdict.decision === "blocked"
              ? "blocked"
              : "active",
          resultText(evaluation),
        );
        if (!goal || goal.id !== goalId || goal.status !== "active") break;
        checkRunLimit();
        if (signal.aborted) break;
        if (goal.turnBudget && goal.turns >= goal.turnBudget) {
          await checkpoint("budget-limited", "Turn limit reached.");
          break;
        }
        const toolActivity =
          typeof lastResult.metadata?.goalToolCallCount === "number"
            ? lastResult.metadata.goalToolCallCount
            : lastResult.executedTools.length;
        noProgressTurns = toolActivity === 0 ? noProgressTurns + 1 : 0;
        if (noProgressTurns >= 3 || goal.mode === "native") {
          await checkpoint(
            "paused",
            goal.mode === "native"
              ? "The goal could not be verified. Resume to continue."
              : "Work stopped making progress. Resume to continue.",
          );
          break;
        }
      }
    } catch (error) {
      if (!signal.aborted || pollFailure) throw error;
    }
    clearInterval(poll);
    await pendingPoll;
    if (goal?.id === goalId && goal.status === "active") {
      checkRunLimit();
      await checkpoint(
        limitReason ? "budget-limited" : "paused",
        limitReason ??
          pollFailure?.message ??
          "Execution interrupted. Use /goal resume to continue.",
      );
    }
    if (pollFailure) throw pollFailure;
    record = await readGoalRecord(path);
    const finalGoal = record.goal;
    const status =
      finalGoal?.status === "complete"
        ? "executed"
        : finalGoal?.status === "blocked" ||
            finalGoal?.status === "budget-limited"
          ? "blocked"
          : "cancelled";
    const summary = describeGoal(finalGoal);
    const result: TaskExecutionResult = {
      ...lastResult,
      task,
      status,
      summary,
      metadata: {
        ...lastResult.metadata,
        goal: finalGoal,
        goalMode: record.mode,
      },
      ...(lastResult.response
        ? {
            response: {
              ...lastResult.response,
              markdown: `${lastResult.response.markdown}\n\n${summary}`,
            },
          }
        : {}),
    };
    await options.onStateChange?.({
      task,
      mode: config.mode,
      state: status === "executed" ? "completed" : status,
      message: summary,
      executedTools: result.executedTools,
      outputSections: result.outputSections,
      cancellable: false,
      goal: finalGoal,
    });
    return result;
  } catch (error) {
    await checkpoint(
      "paused",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  } finally {
    clearInterval(poll);
    await pendingPoll;
  }
};
