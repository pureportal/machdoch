import { linkRunCancellation } from "../_helpers/run-cancellation.js";
import { resolveGoalLimits } from "../_helpers/agent-runtime-types.js";
import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type {
  AgentLiveState,
  ConversationHistoryEntry,
  TaskExecutionOptions,
  TaskExecutionResult,
} from "../types.js";
import { getActiveTaskModelUsageRecorder } from "../model-usage.js";
import {
  getAvailableGoalModes,
  MAX_GOAL_OBJECTIVE_CHARS,
  type SessionGoal,
} from "../../shared/goals.js";
import {
  appendGoalVerdict,
  readGoalRecord,
  updateGoalRecord,
  type GoalRecord,
  type GoalRequirement,
} from "./goal-store.js";
import { commandResult, describeGoal } from "./goal-result.js";
import { evaluateGoal } from "./goal-evaluation.js";
import { combineGoalTurnLive } from "./goal-live-state.js";
import {
  countVerifiedRequirements,
  createGoalNextStep,
  parseGoalChecklist,
} from "./goal-checklist.js";

export type GoalTurnExecutor = (
  task: string,
  config: RuntimeConfig,
  options: TaskExecutionOptions,
) => Promise<TaskExecutionResult>;

const MAX_USAGE_LIMIT_WAITS_PER_RUN = 5;
const USAGE_LIMIT_RESET_GRACE_MS = 30_000;
const USAGE_LIMIT_ACTIVITY_INTERVAL_MS = 60_000;

const resultText = (result: TaskExecutionResult): string =>
  result.response?.markdown.trim() || result.summary;

const nativeObjective = (
  objective: string,
  nextStep: string | undefined,
): string =>
  nextStep
    ? `${objective}\n\nNext step from the last check: ${nextStep}`.slice(
        0,
        MAX_GOAL_OBJECTIVE_CHARS,
      )
    : objective;

/** Cached input costs a fraction of new tokens, so it does not count. */
const liveUncachedTokens = (live: AgentLiveState | undefined): number => {
  const usage = live?.usage;
  if (!usage) return 0;
  return (
    Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0)) +
    (usage.outputTokens ?? 0)
  );
};

/** When the plan limit that stopped this turn lifts, if the provider said. */
const findUsageLimitReset = (
  live: AgentLiveState | undefined,
): number | undefined => {
  const resets = (live?.limits ?? []).flatMap((limit) =>
    limit.limited && limit.resetsAt && limit.resetsAt > Date.now()
      ? [limit.resetsAt]
      : [],
  );
  return resets.length > 0 ? Math.max(...resets) : undefined;
};

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
  const goalId = goal.id;
  const limits = resolveGoalLimits(config);
  const runStartedAt = Date.now();
  const elapsedBeforeRun = goal.elapsedMs;
  const tokensBeforeRun = goal.tokensUsed;
  const costBeforeRun = goal.costUsd ?? 0;
  const recorder = getActiveTaskModelUsageRecorder();
  const usageBeforeRun = recorder?.getTokenUsage();
  const tokensRecordedBeforeRun = usageBeforeRun?.uncachedTokens ?? 0;
  const unavailableUsageBeforeRun = usageBeforeRun?.unavailableCallCount ?? 0;
  const abortController = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, abortController.signal])
    : abortController.signal;
  linkRunCancellation(signal, options.signal);
  let pendingPoll: Promise<void> | undefined;
  let pollFailure: Error | undefined;
  let limitReason: string | undefined;
  let lastAccountingAt = runStartedAt;
  let earlierTurnsLive: AgentLiveState | undefined;
  let latestLive: AgentLiveState | undefined;
  let turnLive: AgentLiveState | undefined;
  let turnInProgress = false;
  let verificationCostUsd = 0;
  const tokensSpent = (): number =>
    tokensBeforeRun +
    Math.max(
      0,
      (recorder?.getTokenUsage().uncachedTokens ?? 0) - tokensRecordedBeforeRun,
    ) +
    (turnInProgress ? liveUncachedTokens(turnLive) : 0);
  const costSpent = (): number =>
    costBeforeRun + (latestLive?.usage?.costUsd ?? 0) + verificationCostUsd;
  const accountGoal = (snapshot: SessionGoal): SessionGoal => {
    const costUsd = Math.max(snapshot.costUsd ?? 0, costSpent());
    return {
      ...snapshot,
      elapsedMs: Math.max(
        snapshot.elapsedMs,
        elapsedBeforeRun + Math.max(0, Date.now() - runStartedAt),
      ),
      tokensUsed: Math.max(snapshot.tokensUsed, tokensSpent()),
      ...(costUsd > 0 ? { costUsd } : {}),
      updatedAt: Date.now(),
    };
  };
  const checkRunLimit = (): void => {
    if (!goal || goal.id !== goalId || goal.status !== "active") return;
    if (
      goal.timeBudgetMs &&
      elapsedBeforeRun + Math.max(0, Date.now() - runStartedAt) >=
        goal.timeBudgetMs
    ) {
      limitReason = "Time limit reached.";
    } else if (goal.tokenBudget && tokensSpent() >= goal.tokenBudget) {
      limitReason = "Token limit reached.";
    } else if (goal.costBudgetUsd && costSpent() >= goal.costBudgetUsd) {
      limitReason = "Cost limit reached.";
    }
    if (limitReason) abortController.abort(limitReason);
  };
  const poll = setInterval(() => {
    checkRunLimit();
    if (pendingPoll || signal.aborted) return;
    pendingPoll = (
      Date.now() - lastAccountingAt >= 5_000
        ? updateGoalRecord(path, (current) => ({
            ...current,
            goal:
              current.goal?.id === goalId && current.goal.status === "active"
                ? accountGoal(current.goal)
                : current.goal,
          })).then((latest) => {
            if (latest.goal) lastAccountingAt = latest.goal.updatedAt;
            return latest;
          })
        : readGoalRecord(path)
    )
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
  const outerHistory = options.conversationContext?.history ?? [];
  const history: ConversationHistoryEntry[] = [...outerHistory];
  let noProgressTurns = 0;
  let blockedAssessments = 0;
  let previousOutcome: string | undefined;
  let runTurns = 0;
  let automaticPasses = 0;
  let turnInstructions = options.resolvedInstructions;
  let bestVerified = goal.verifiedRequirements ?? -1;
  let stalledPasses = 0;
  let usageLimitReset: number | undefined;
  let usageLimitWaits = 0;
  const checkpoint = async (
    status: SessionGoal["status"],
    reason: string,
    nextStep?: string,
  ): Promise<void> => {
    record = await updateGoalRecord(path, (current) =>
      current.goal?.id === goalId
        ? {
            ...current,
            ...(nextStep ? { nextStep } : {}),
            goal: accountGoal({
              ...current.goal,
              turns: goal!.turns,
              status:
                current.goal.status === "active" ? status : current.goal.status,
              reason:
                current.goal.status === "active"
                  ? reason.slice(0, 12_000)
                  : current.goal.reason,
            }),
          }
        : current,
    );
    lastAccountingAt = Date.now();
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
  const saveVerdict = async (
    decision: "complete" | "continue" | "blocked",
    summary: string,
    requirements: GoalRequirement[],
  ): Promise<void> => {
    const turn = goal!.turns;
    record = await updateGoalRecord(path, (current) =>
      current.goal?.id === goalId
        ? appendGoalVerdict(
            {
              ...current,
              goal: {
                ...current.goal,
                ...(requirements.length > 0
                  ? {
                      verifiedRequirements:
                        countVerifiedRequirements(requirements),
                      totalRequirements: requirements.length,
                    }
                  : {}),
              },
            },
            {
              turn,
              decision,
              summary: summary.slice(0, 12_000),
              requirements,
              createdAt: Date.now(),
            },
          )
        : current,
    );
    goal = record.goal;
  };
  const waitForUsageLimitReset = async (resetsAt: number): Promise<boolean> => {
    const waitMs = resetsAt - Date.now() + USAGE_LIMIT_RESET_GRACE_MS;
    const resetTime = new Date(resetsAt).toLocaleString();
    usageLimitWaits += 1;
    if (
      waitMs > limits.usageWaitMs ||
      usageLimitWaits > MAX_USAGE_LIMIT_WAITS_PER_RUN
    ) {
      await checkpoint(
        "paused",
        `Plan usage limit reached. It resets at ${resetTime}. Resume after that.`,
      );
      return false;
    }
    await checkpoint("active", `Waiting for the plan limit to reset at ${resetTime}.`);
    const waitUntil = Date.now() + waitMs;
    await options.onStateChange?.({
      task,
      mode: config.mode,
      state: "executing",
      message: `Waiting for the plan limit to reset at ${resetTime}.`,
      executedTools: lastResult.executedTools,
      outputSections: [],
      cancellable: true,
      goal,
    });
    while (!signal.aborted && Date.now() < waitUntil) {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(
          finish,
          Math.min(USAGE_LIMIT_ACTIVITY_INTERVAL_MS, waitUntil - Date.now()),
        );
        signal.addEventListener("abort", finish, { once: true });
      });
      options.onStreamActivity?.();
    }
    return !signal.aborted;
  };
  const reportProgress: NonNullable<
    TaskExecutionOptions["onStateChange"]
  > = async (progress) => {
    const terminal = [
      "completed",
      "blocked",
      "failed",
      "cancelled",
      "planned",
    ].includes(progress.state);
    if (progress.agentLive) {
      turnLive = progress.agentLive;
      latestLive = combineGoalTurnLive(earlierTurnsLive, progress.agentLive);
    }
    checkRunLimit();
    await options.onStateChange?.({
      ...progress,
      ...(progress.agentLive && latestLive ? { agentLive: latestLive } : {}),
      task,
      goal,
      ...(terminal
        ? { state: "executing", message: "Checking goal.", cancellable: true }
        : {}),
    });
  };
  try {
    if (!getAvailableGoalModes(config.provider).includes(goal.mode)) {
      throw new Error(
        "This goal uses an unavailable native provider. Select its provider or clear the goal.",
      );
    }
    try {
      while (
        goal?.id === goalId &&
        goal.status === "active" &&
        !signal.aborted
      ) {
        checkRunLimit();
        if (signal.aborted) break;
        if (usageLimitReset !== undefined) {
          const resetsAt = usageLimitReset;
          usageLimitReset = undefined;
          if (!(await waitForUsageLimitReset(resetsAt))) break;
          checkRunLimit();
          if (signal.aborted) break;
          await checkpoint("active", "");
          if (!goal || goal.id !== goalId || goal.status !== "active") break;
        }
        if (goal.turnBudget && goal.turns >= goal.turnBudget) {
          await checkpoint("budget-limited", "Turn limit reached.");
          break;
        }
        const nextStep = record.nextStep || goal.reason;
        const directive =
          !userSteering || runTurns > 0
            ? `Work toward this goal and verify the full outcome: ${JSON.stringify(goal.objective)}.\n${nextStep ? `Next step: ${nextStep}` : ""}\n${blockedAssessments ? `A blocker was reported in ${blockedAssessments} consecutive assessment(s). Audit it against current evidence, investigate approaches within the user's requirements, and finish all work that can proceed independently. A partial limitation does not block the entire goal. Do not repeat an unchanged failed approach or ask to reduce the goal's scope.` : ""}`
            : `${task}\n\nContinue toward the active goal: ${JSON.stringify(goal.objective)}`;
        goal = { ...goal, turns: goal.turns + 1 };
        await checkpoint("active", goal.reason);
        if (!goal || goal.id !== goalId || goal.status !== "active") break;
        signal.throwIfAborted();
        turnLive = undefined;
        turnInProgress = true;
        const goalBackgroundWaitMs = goal.timeBudgetMs
          ? Math.max(
              0,
              goal.timeBudgetMs -
                (elapsedBeforeRun + (Date.now() - runStartedAt)),
            )
          : limits.backgroundWaitMs;
        try {
          lastResult = await execute(directive, config, {
            ...options,
            signal,
            onStateChange: reportProgress,
            onInstructionsResolved: (instructions) => {
              turnInstructions = instructions;
            },
            captureGoalEvidence: true,
            goalBackgroundWaitMs,
            conversationContext: {
              ...options.conversationContext,
              history: [...history],
              promptHistoryMessageLimit: Math.min(
                options.conversationContext?.promptHistoryMessageLimit ?? 40,
                40,
              ),
              adaptiveControllerOverride: false,
              continueProviderSession: runTurns > 0,
            },
            systemPromptSections: [
              ...(options.systemPromptSections ?? []),
              `The user has explicitly set a persistent goal: ${JSON.stringify(goal.objective)}. Keep its full scope. Gather evidence of every requirement before claiming completion. Investigate obstacles and finish independent requirements before declaring the goal blocked. Missing verification is a next action, not by itself an external blocker. Do not infer new goals. Tool and approval rules remain in effect.`,
            ],
            ...(goal.mode === "native"
              ? { nativeGoal: nativeObjective(goal.objective, record.nextStep) }
              : {}),
          });
        } finally {
          turnInProgress = false;
        }
        runTurns += 1;
        automaticPasses += 1;
        earlierTurnsLive = latestLive;
        history.push(
          { role: "user", content: directive },
          { role: "assistant", content: resultText(lastResult) },
        );
        await checkpoint("active", "");
        if (!goal || goal.id !== goalId || goal.status !== "active") break;
        checkRunLimit();
        if (signal.aborted || lastResult.status === "cancelled") break;
        usageLimitReset = findUsageLimitReset(turnLive);
        if (
          lastResult.failure?.retryable === false ||
          !["executed", "planned", "blocked"].includes(lastResult.status)
        ) {
          if (
            usageLimitReset !== undefined &&
            lastResult.failure?.retryable !== false
          ) {
            automaticPasses -= 1;
            continue;
          }
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
        let evaluationCostUsd = 0;
        const evaluation = await evaluateGoal(
          goal,
          history,
          lastResult,
          config,
          {
            ...options,
            signal,
            onStateChange: reportProgress,
            // Resolving again can take minutes in a large workspace, which
            // would use up the verification deadline before the model starts.
            ...(turnInstructions
              ? { resolvedInstructions: turnInstructions }
              : {}),
          },
          execute,
          {
            timeoutMs: limits.verificationMs,
            ...(record.verdicts?.length
              ? {
                  previousRequirements:
                    record.verdicts[record.verdicts.length - 1]!.requirements,
                }
              : {}),
            ...(latestLive ? { live: latestLive } : {}),
            onLive: (live) => {
              evaluationCostUsd = live.usage?.costUsd ?? evaluationCostUsd;
            },
          },
        );
        verificationCostUsd += evaluationCostUsd;
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
        if (evaluation.failure?.retryable === false) {
          const reason = evaluation.reason ?? evaluation.summary;
          lastResult = {
            ...lastResult,
            failure: evaluation.failure,
            reason,
          };
          await checkpoint("blocked", reason);
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
        const { requirements, summary } = parseGoalChecklist(
          resultText(evaluation),
        );
        const verified = countVerifiedRequirements(requirements);
        const decision =
          verdict.decision === "complete" && verified < requirements.length
            ? "continue"
            : verdict.decision;
        await saveVerdict(decision, summary, requirements);
        blockedAssessments =
          decision === "blocked" ? blockedAssessments + 1 : 0;
        const confirmedBlocked =
          decision === "blocked" &&
          (blockedAssessments >= 3 || goal.mode === "native");
        const followUp = createGoalNextStep(summary, requirements);
        await checkpoint(
          decision === "complete"
            ? "complete"
            : confirmedBlocked
              ? "blocked"
              : "active",
          summary,
          decision === "complete" ? undefined : followUp,
        );
        if (!goal || goal.id !== goalId || goal.status !== "active") break;
        checkRunLimit();
        if (signal.aborted) break;
        if (goal.turnBudget && goal.turns >= goal.turnBudget) {
          await checkpoint("budget-limited", "Turn limit reached.");
          break;
        }
        if (goal.mode === "native") {
          if (verified > bestVerified) {
            bestVerified = verified;
            stalledPasses = 0;
          } else {
            stalledPasses += 1;
          }
          if (stalledPasses >= limits.stalledPasses) {
            await checkpoint(
              "paused",
              `No new progress in ${stalledPasses} checks. ${summary}`,
            );
            break;
          }
          if (limits.passes !== null && automaticPasses >= limits.passes) {
            await checkpoint(
              "paused",
              `Stopped after ${automaticPasses} passes. Resume to continue. ${summary}`,
            );
            break;
          }
          continue;
        }
        const toolActivity =
          typeof lastResult.metadata?.goalToolCallCount === "number"
            ? lastResult.metadata.goalToolCallCount
            : lastResult.executedTools.length;
        const outcome = JSON.stringify([
          resultText(lastResult),
          lastResult.metadata?.goalToolEvidence,
          lastResult.outputSections,
        ]);
        noProgressTurns =
          toolActivity === 0 || outcome === previousOutcome
            ? noProgressTurns + 1
            : 0;
        previousOutcome = outcome;
        if (
          noProgressTurns >= limits.stalledPasses &&
          blockedAssessments === 0
        ) {
          await checkpoint(
            "paused",
            "Work stopped making progress. Resume to continue.",
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
    // The composer's goal bar shows the full objective.
    const summary = describeGoal(finalGoal, { brief: true });
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
