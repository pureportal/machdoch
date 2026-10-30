import type { AgentModelStreamUsage } from "@machdoch/model-runtime/types";
import type {
  AgentLiveLimit,
  AgentLiveTask,
} from "@machdoch/fleet-protocol/task-thinking";
import type { AgentLiveTracker } from "./agent-live-tracker.js";
import {
  isRecord,
  readNumber,
  readString,
  toEpochMs,
} from "./agent-interactive-session.js";

const PLAN_TOOLS = new Set(["TodoWrite"]);
const FILE_TOOLS = new Map<string, "add" | "update">([
  ["Write", "add"],
  ["Edit", "update"],
  ["MultiEdit", "update"],
  ["NotebookEdit", "update"],
]);

const RATE_LIMIT_LABELS: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
  overage: "Extra usage",
};

const readTaskKind = (
  event: Record<string, unknown>,
): AgentLiveTask["kind"] => {
  const type = `${readString(event, "task_type") ?? ""} ${readString(event, "type") ?? ""}`;
  if (/agent/iu.test(type) || readString(event, "subagent_type"))
    return "agent";
  if (/monitor/iu.test(type)) return "monitor";
  if (/bash|shell/iu.test(type)) return "shell";
  return "other";
};

const readTaskStatus = (
  value: unknown,
): AgentLiveTask["status"] | undefined => {
  switch (String(value ?? "").toLowerCase()) {
    case "running":
    case "pending":
      return "running";
    case "completed":
    case "complete":
    case "succeeded":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "stopped":
    case "killed":
    case "cancelled":
    case "canceled":
      return "stopped";
    default:
      return undefined;
  }
};

const readTodoStatus = (value: unknown) =>
  value === "completed"
    ? ("completed" as const)
    : value === "in_progress"
      ? ("in_progress" as const)
      : ("pending" as const);

const toLiveUsage = (usage: AgentModelStreamUsage | undefined) => ({
  ...(usage?.inputTokens !== undefined
    ? { inputTokens: usage.inputTokens }
    : {}),
  ...(usage?.outputTokens !== undefined
    ? { outputTokens: usage.outputTokens }
    : {}),
  ...(usage?.cachedInputTokens !== undefined
    ? { cachedInputTokens: usage.cachedInputTokens }
    : usage?.cacheReadInputTokens !== undefined
      ? { cachedInputTokens: usage.cacheReadInputTokens }
      : {}),
  ...(usage?.reasoningTokens !== undefined
    ? { reasoningTokens: usage.reasoningTokens }
    : {}),
});

/** Turns what Claude Code reports on stream-json output into live run details. */
export class ClaudeLiveEventReader {
  /** Claude's task list (TaskCreate/TaskUpdate), keyed by task id, in creation order. */
  private readonly planTasks = new Map<
    string,
    { text: string; status: "pending" | "in_progress" | "completed" }
  >();
  private readonly pendingTaskCreates = new Map<string, string>();

  constructor(private readonly live: AgentLiveTracker) {}

  rateLimit(event: Record<string, unknown>): void {
    const info = isRecord(event.rate_limit_info)
      ? event.rate_limit_info
      : event;
    const status = readString(info, "status");
    const limits: AgentLiveLimit[] = [];
    const windows = isRecord(info.unifiedWindows) ? info.unifiedWindows : {};
    for (const [id, window] of Object.entries(windows)) {
      if (!isRecord(window)) continue;
      const utilization = readNumber(window, "utilization");
      const windowStatus = readString(window, "status");
      if (utilization === undefined && windowStatus !== "rejected") continue;
      const resetsAt = toEpochMs(window.resetsAt);
      limits.push({
        id,
        label: RATE_LIMIT_LABELS[id] ?? id.replace(/_/gu, " "),
        usedPercent:
          utilization === undefined
            ? 100
            : utilization <= 1
              ? utilization * 100
              : utilization,
        ...(resetsAt ? { resetsAt } : {}),
        ...(windowStatus === "rejected" ? { limited: true } : {}),
      });
    }
    const type = readString(info, "rateLimitType");
    if (limits.length === 0 && type && status === "rejected") {
      const resetsAt = toEpochMs(info.resetsAt);
      limits.push({
        id: type,
        label: RATE_LIMIT_LABELS[type] ?? type.replace(/_/gu, " "),
        usedPercent: 100,
        ...(resetsAt ? { resetsAt } : {}),
        limited: true,
      });
    }
    if (limits.length > 0) this.live.setLimits(limits);
    if (status === "allowed_warning") {
      this.live.addNotice(
        "warning",
        "You are close to your Claude plan limit.",
      );
    } else if (status === "rejected") {
      this.live.addNotice("danger", "Claude plan limit reached for now.");
    }
  }

  system(event: Record<string, unknown>): void {
    const subtype = readString(event, "subtype");
    const taskId = readString(event, "task_id");
    switch (subtype) {
      case "task_started":
        if (!taskId) return;
        this.live.upsertTask({
          id: taskId,
          kind: readTaskKind(event),
          description: readString(event, "description") ?? "Background work",
          status: "running",
          background: event.is_backgrounded === true,
          startedAt: Date.now(),
          canStop: true,
        });
        return;
      case "task_progress":
        if (!taskId) return;
        this.live.upsertTask({
          id: taskId,
          ...((readString(event, "summary") ?? readString(event, "description"))
            ? {
                summary:
                  readString(event, "summary") ??
                  readString(event, "description"),
              }
            : {}),
        });
        return;
      case "task_updated": {
        if (!taskId) return;
        const patch = isRecord(event.patch) ? event.patch : event;
        const status = readTaskStatus(patch.status);
        this.live.upsertTask({
          id: taskId,
          ...(status ? { status } : {}),
          ...(typeof patch.is_backgrounded === "boolean"
            ? { background: patch.is_backgrounded }
            : {}),
        });
        return;
      }
      case "task_notification": {
        if (!taskId) return;
        const status = readTaskStatus(event.status) ?? "completed";
        this.live.upsertTask({
          id: taskId,
          status,
          ...(readString(event, "summary")
            ? { summary: readString(event, "summary") }
            : {}),
        });
        return;
      }
      case "background_tasks_changed": {
        const tasks = Array.isArray(event.tasks)
          ? event.tasks.filter(isRecord)
          : [];
        const running = new Set<string>();
        for (const task of tasks) {
          const id = readString(task, "task_id") ?? readString(task, "id");
          if (!id) continue;
          running.add(id);
          this.live.upsertTask({
            id,
            kind: readTaskKind(task),
            description: readString(task, "description") ?? "Background work",
            status: readTaskStatus(task.status) ?? "running",
            background: true,
            canStop: true,
          });
        }
        this.live.replaceRunningTasks(running);
        return;
      }
      case "api_retry":
        this.live.addNotice(
          "warning",
          "Claude is retrying after a temporary API error.",
        );
        return;
      case "model_fallback":
        this.live.addNotice(
          "info",
          `Claude switched to ${readString(event, "fallback_model") ?? readString(event, "model") ?? "a fallback model"}.`,
        );
        return;
      default:
        return;
    }
  }

  assistant(event: Record<string, unknown>): void {
    const message = isRecord(event.message) ? event.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block) || readString(block, "type") !== "tool_use")
        continue;
      const name = readString(block, "name") ?? "";
      const input = isRecord(block.input) ? block.input : {};
      if (PLAN_TOOLS.has(name) && Array.isArray(input.todos)) {
        this.live.setPlan(
          input.todos.filter(isRecord).map((todo) => ({
            text:
              readString(todo, "content") ??
              readString(todo, "activeForm") ??
              "",
            status: readTodoStatus(todo.status),
          })),
        );
      }
      if (name === "TaskCreate") {
        const id = readString(block, "id");
        const subject =
          readString(input, "subject") ?? readString(input, "activeForm");
        if (id && subject) this.pendingTaskCreates.set(id, subject);
      }
      if (name === "TaskUpdate") this.updatePlanTask(input);
      const fileKind = FILE_TOOLS.get(name);
      const path =
        readString(input, "file_path") ?? readString(input, "notebook_path");
      if (fileKind && path)
        this.live.setFileChanges([{ path, kind: fileKind }]);
    }
    const usage = isRecord(message.usage) ? message.usage : undefined;
    if (usage && !readString(event, "parent_tool_use_id")) {
      const contextUsed =
        (readNumber(usage, "input_tokens") ?? 0) +
        (readNumber(usage, "cache_read_input_tokens") ?? 0) +
        (readNumber(usage, "cache_creation_input_tokens") ?? 0);
      if (contextUsed > 0)
        this.live.setUsage({ contextUsedTokens: contextUsed });
    }
  }

  /** Adds tasks Claude created once their ids come back in the tool results. */
  toolResults(event: Record<string, unknown>): void {
    const message = isRecord(event.message) ? event.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const result = isRecord(event.tool_use_result) ? event.tool_use_result : {};
    const task = isRecord(result.task) ? result.task : undefined;
    for (const block of content) {
      if (!isRecord(block) || readString(block, "type") !== "tool_result")
        continue;
      const toolUseId = readString(block, "tool_use_id");
      const subject = toolUseId
        ? this.pendingTaskCreates.get(toolUseId)
        : undefined;
      if (!toolUseId || subject === undefined) continue;
      this.pendingTaskCreates.delete(toolUseId);
      const id = task ? readString(task, "id") : undefined;
      if (!id || block.is_error === true) continue;
      this.planTasks.set(id, {
        text: readString(task ?? {}, "subject") ?? subject,
        status: "pending",
      });
      this.publishPlanTasks();
    }
  }

  result(
    event: Record<string, unknown>,
    usage: AgentModelStreamUsage | undefined,
  ): void {
    const modelUsage = isRecord(event.modelUsage) ? event.modelUsage : {};
    let contextWindow: number | undefined;
    for (const entry of Object.values(modelUsage)) {
      if (!isRecord(entry)) continue;
      const window = readNumber(entry, "contextWindow");
      if (window && (!contextWindow || window > contextWindow))
        contextWindow = window;
    }
    const cost = readNumber(event, "total_cost_usd");
    this.live.setUsage({
      ...toLiveUsage(usage),
      ...(contextWindow ? { contextWindowTokens: contextWindow } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
    });
  }

  private updatePlanTask(input: Record<string, unknown>): void {
    const id = readString(input, "taskId");
    const task = id ? this.planTasks.get(id) : undefined;
    if (!id || !task) return;
    if (input.status === "deleted") this.planTasks.delete(id);
    else {
      if (typeof input.status === "string")
        task.status = readTodoStatus(input.status);
      task.text = readString(input, "subject") ?? task.text;
    }
    this.publishPlanTasks();
  }

  private publishPlanTasks(): void {
    this.live.setPlan(
      [...this.planTasks.values()].map((task) => ({ ...task })),
    );
  }
}
