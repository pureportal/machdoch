import type { AgentModelStreamUsage } from "@machdoch/model-runtime/types";
import type {
  AgentLiveLimit,
  AgentLiveQuestion,
  AgentLiveTask,
} from "@machdoch/fleet-protocol/task-thinking";
import { AgentLiveTracker } from "./agent-live-tracker.js";
import {
  JsonLineSplitter,
  UNATTENDED_ANSWER,
  isRecord,
  mergeOutputUpdate,
  parseJsonRecord,
  readNumber,
  readQuestionOptions,
  readString,
  settleLiveQuestion,
  staleQuestionError,
  toEpochMs,
  turnFinishedError,
  type InteractiveAgentSession,
  type InteractiveSessionIo,
} from "./agent-interactive-session.js";
import {
  AgentControlRequestError,
  type AgentTaskControlHandlers,
} from "./agent-task-control-server.js";
import {
  ClaudeCliOutputDecoder,
  type ExternalAgentCliOutputUpdate,
} from "./external-agent-cli-output.js";

const PLAN_TOOLS = new Set(["TodoWrite"]);
const FAST_MODE_REASONS: Record<string, string> = {
  extra_usage_disabled: "extra usage is turned off for this Claude account",
  sdk_opt_in_required: "this run did not opt in",
  model_not_supported: "this model has no fast mode",
};
const FILE_TOOLS = new Map<string, "add" | "update">([
  ["Write", "add"],
  ["Edit", "update"],
  ["MultiEdit", "update"],
  ["NotebookEdit", "update"],
]);

interface PendingToolRequest {
  requestId: string;
  input: Record<string, unknown>;
  questionId: string;
  questionTexts: Map<string, string>;
}

const RATE_LIMIT_LABELS: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
  overage: "Extra usage",
};

const readTaskKind = (event: Record<string, unknown>): AgentLiveTask["kind"] => {
  const type = `${readString(event, "task_type") ?? ""} ${readString(event, "type") ?? ""}`;
  if (/agent/iu.test(type) || readString(event, "subagent_type")) return "agent";
  if (/monitor/iu.test(type)) return "monitor";
  if (/bash|shell/iu.test(type)) return "shell";
  return "other";
};

const readTaskStatus = (value: unknown): AgentLiveTask["status"] | undefined => {
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

/**
 * Drives one Claude Code turn over `--input-format stream-json` with stdin
 * held open, so the host can steer, interrupt, answer AskUserQuestion and
 * stop background tasks while the turn runs.
 */
export class ClaudeInteractiveSession implements InteractiveAgentSession {
  readonly live: AgentLiveTracker;
  readonly controls: AgentTaskControlHandlers;
  private readonly output: ClaudeCliOutputDecoder;
  private readonly lines = new JsonLineSplitter();
  private nextRequest = 1;
  private readonly ownRequests = new Map<string, string>();
  private pendingTool: PendingToolRequest | undefined;
  private turnFinished = false;
  private inputClosed = false;
  private interrupted = false;
  private nextSteer = 1;
  private readonly requestedFastMode: boolean;
  private readonly unattended: boolean;
  /** Claude's task list (TaskCreate/TaskUpdate), keyed by task id, in creation order. */
  private readonly planTasks = new Map<string, { text: string; status: "pending" | "in_progress" | "completed" }>();
  private readonly pendingTaskCreates = new Map<string, string>();

  constructor(
    private readonly prompt: string,
    private readonly io: InteractiveSessionIo,
    publish: ConstructorParameters<typeof AgentLiveTracker>[1],
    options: { model: string; captureEvidence: boolean; fastMode?: boolean; unattended?: boolean },
  ) {
    this.output = new ClaudeCliOutputDecoder(options.captureEvidence);
    this.requestedFastMode = options.fastMode === true;
    this.unattended = options.unattended === true;
    this.live = new AgentLiveTracker(
      {
        provider: "claude-cli",
        transport: "stream-json",
        capabilities: this.unattended ? [] : ["steer", "interrupt", "answer", "stop-task"],
        model: options.model,
        ...(options.fastMode !== undefined ? { fastMode: options.fastMode } : {}),
      },
      publish,
    );
    this.controls = {
      steer: (text) => this.steer(text),
      interrupt: () => {
        if (!this.interrupt()) {
          throw new AgentControlRequestError("The turn has already finished.");
        }
      },
      answer: (questionId, answers) => this.answer(questionId, answers),
      stopTask: (taskId) => this.stopTask(taskId),
    };
  }

  start(): void {
    this.sendControl({
      subtype: "initialize",
      promptSuggestions: true,
      agentProgressSummaries: true,
    });
    this.sendUser(this.prompt);
    this.live.flush();
  }

  interrupt(): boolean {
    if (this.turnFinished || this.inputClosed) return false;
    this.interrupted = true;
    this.cancelPendingQuestion();
    // Also drop steering messages still waiting for the next tool boundary.
    this.sendControl({ subtype: "interrupt", cancel_queued: true });
    return true;
  }

  dispose(): void {
    this.live.close();
  }

  private steer(text: string): void {
    if (this.turnFinished || this.inputClosed) throw turnFinishedError();
    const id = `steer-${this.nextSteer++}`;
    // Claude echoes the message once the turn takes it in (--replay-user-messages).
    this.live.recordSteer(id, text, "pending");
    this.sendUser(text, "next");
  }

  private answer(questionId: string, answers: Record<string, string>): void {
    const pending = this.pendingTool;
    if (!pending || pending.questionId !== questionId) throw staleQuestionError();
    const answerMap: Record<string, string> = {};
    for (const [itemId, answer] of Object.entries(answers)) {
      const questionText = pending.questionTexts.get(itemId) ?? itemId;
      answerMap[questionText] = answer;
    }
    this.pendingTool = undefined;
    this.reply(pending.requestId, {
      behavior: "allow",
      updatedInput: { ...pending.input, answers: answerMap },
    });
    settleLiveQuestion(this.live, "answered", answers);
  }

  private stopTask(taskId: string): void {
    const task = this.live.getTask(taskId);
    if (!task || task.status !== "running") {
      throw new AgentControlRequestError("That task is no longer running.");
    }
    if (this.inputClosed) {
      throw new AgentControlRequestError("The session has already closed.");
    }
    this.sendControl({ subtype: "stop_task", task_id: taskId });
    this.live.upsertTask({ id: taskId, canStop: false, summary: "Stopping…" });
  }

  private sendUser(text: string, priority?: "next" | "now"): void {
    this.write({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
      origin: { kind: "human" },
      ...(priority ? { priority } : {}),
    });
  }

  private sendControl(request: Record<string, unknown>): void {
    const requestId = `machdoch-${this.nextRequest++}`;
    this.ownRequests.set(requestId, String(request.subtype));
    this.write({ type: "control_request", request_id: requestId, request });
  }

  private reply(requestId: string, response: Record<string, unknown>): void {
    this.write({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  }

  private replyError(requestId: string, error: string): void {
    this.write({
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error },
    });
  }

  private write(message: Record<string, unknown>): void {
    if (this.inputClosed) return;
    this.io.write(`${JSON.stringify(message)}\n`);
  }

  private closeInput(): void {
    if (this.inputClosed) return;
    this.inputClosed = true;
    this.cancelPendingQuestion();
    this.live.setCapabilities([]);
    this.live.flush();
    this.io.closeInput();
  }

  private cancelPendingQuestion(): void {
    if (!this.pendingTool) return;
    const pending = this.pendingTool;
    this.pendingTool = undefined;
    if (!this.inputClosed) {
      this.reply(pending.requestId, {
        behavior: "deny",
        message: "The user stopped the turn before answering.",
      });
    }
    settleLiveQuestion(this.live, "cancelled");
  }

  push(chunk: string): ExternalAgentCliOutputUpdate {
    const update: ExternalAgentCliOutputUpdate = { displayText: [] };
    this.lines.push(chunk, (line) => this.processLine(line, update));
    return update;
  }

  finish(): ExternalAgentCliOutputUpdate {
    const update: ExternalAgentCliOutputUpdate = { displayText: [] };
    this.lines.finish((line) => this.processLine(line, update));
    mergeOutputUpdate(update, this.output.finish());
    this.live.flush();
    return update;
  }

  private processLine(line: string, update: ExternalAgentCliOutputUpdate): void {
    const event = parseJsonRecord(line);
    if (!event) {
      mergeOutputUpdate(update, this.output.push(`${line}\n`));
      return;
    }
    const type = readString(event, "type");
    if (type === "control_request") {
      this.handleProviderRequest(event);
      return;
    }
    if (type === "control_response") {
      this.handleControlResponse(event);
      return;
    }
    if (type === "prompt_suggestion") {
      const suggestion = readString(event, "suggestion");
      if (suggestion) this.live.setSuggestions([suggestion]);
      return;
    }
    if (type === "rate_limit_event") {
      this.handleRateLimit(event);
      return;
    }
    if (type === "user" && event.isReplay === true) {
      // An echoed steering message: the turn has now read it.
      const message = isRecord(event.message) ? event.message : {};
      if (typeof message.content === "string") this.live.confirmSteer(message.content);
      return;
    }
    if (type === "system") this.handleSystem(event);
    // A background task that finishes after the answer can start a follow-up
    // turn of its own; it must not replace the answer the user asked for.
    if (this.turnFinished) return;
    if (type === "assistant") this.handleAssistant(event);
    if (type === "user") this.handleToolResults(event);
    if (type === "result") this.handleResult(event);
    mergeOutputUpdate(update, this.output.pushEvent(event));
  }

  private handleProviderRequest(event: Record<string, unknown>): void {
    const requestId = readString(event, "request_id");
    const request = isRecord(event.request) ? event.request : {};
    if (!requestId) return;
    const subtype = readString(request, "subtype");
    if (subtype !== "can_use_tool") {
      this.replyError(requestId, `machdoch does not handle ${subtype ?? "this"} requests.`);
      return;
    }
    const toolName = readString(request, "tool_name") ?? "";
    const input = isRecord(request.input) ? request.input : {};
    if (toolName !== "AskUserQuestion") {
      // Runs keep bypass permissions; only questions need the user.
      this.reply(requestId, { behavior: "allow", updatedInput: input });
      return;
    }
    if (this.unattended) {
      this.reply(requestId, { behavior: "deny", message: UNATTENDED_ANSWER });
      return;
    }
    const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
    const questionTexts = new Map<string, string>();
    const items: AgentLiveQuestion["items"] = [];
    rawQuestions.slice(0, 8).forEach((raw, index) => {
      if (!isRecord(raw)) return;
      const text = readString(raw, "question");
      if (!text) return;
      const id = `q${index + 1}`;
      questionTexts.set(id, text);
      items.push({
        id,
        question: text,
        ...(readString(raw, "header") ? { header: readString(raw, "header") } : {}),
        options: readQuestionOptions(raw.options),
        ...(raw.multiSelect === true ? { multiSelect: true } : {}),
        allowOther: true,
      });
    });
    if (items.length === 0) {
      this.reply(requestId, {
        behavior: "deny",
        message: "The question could not be shown to the user.",
      });
      return;
    }
    this.cancelPendingQuestion();
    const questionId = `claude-${requestId}`;
    this.pendingTool = { requestId, input, questionId, questionTexts };
    this.live.setQuestion({ id: questionId, items, status: "pending" });
  }

  private handleControlResponse(event: Record<string, unknown>): void {
    const response = isRecord(event.response) ? event.response : {};
    const requestId = readString(response, "request_id");
    if (!requestId) return;
    const subtype = this.ownRequests.get(requestId);
    this.ownRequests.delete(requestId);
    const body = isRecord(response.response) ? response.response : {};
    if (readString(response, "subtype") === "error") {
      const error = readString(response, "error") ?? "The request failed.";
      if (subtype === "stop_task") this.live.addNotice("warning", `Could not stop the task: ${error}`);
      else if (subtype === "interrupt") this.live.addNotice("warning", `Interrupt failed: ${error}`);
      return;
    }
    if (subtype === "initialize" && this.requestedFastMode) {
      const fastMode = readString(body, "fast_mode_state");
      if (fastMode) this.live.setFastMode(fastMode === "on");
      const reason = readString(body, "fast_mode_disabled_reason");
      if (fastMode !== "on" && reason) {
        this.live.addNotice(
          "warning",
          `Fast mode is not available: ${FAST_MODE_REASONS[reason] ?? reason.replace(/_/gu, " ")}.`,
        );
      }
    }
  }

  private handleRateLimit(event: Record<string, unknown>): void {
    const info = isRecord(event.rate_limit_info) ? event.rate_limit_info : event;
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
          utilization === undefined ? 100 : utilization <= 1 ? utilization * 100 : utilization,
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
      this.live.addNotice("warning", "You are close to your Claude plan limit.");
    } else if (status === "rejected") {
      this.live.addNotice("danger", "Claude plan limit reached for now.");
    }
  }

  private handleSystem(event: Record<string, unknown>): void {
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
          ...(readString(event, "summary") ?? readString(event, "description")
            ? { summary: readString(event, "summary") ?? readString(event, "description") }
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
          ...(readString(event, "summary") ? { summary: readString(event, "summary") } : {}),
        });
        return;
      }
      case "background_tasks_changed": {
        const tasks = Array.isArray(event.tasks) ? event.tasks.filter(isRecord) : [];
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
        this.live.addNotice("warning", "Claude is retrying after a temporary API error.");
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

  private handleAssistant(event: Record<string, unknown>): void {
    const message = isRecord(event.message) ? event.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block) || readString(block, "type") !== "tool_use") continue;
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
        const subject = readString(input, "subject") ?? readString(input, "activeForm");
        if (id && subject) this.pendingTaskCreates.set(id, subject);
      }
      if (name === "TaskUpdate") this.updatePlanTask(input);
      const fileKind = FILE_TOOLS.get(name);
      const path = readString(input, "file_path") ?? readString(input, "notebook_path");
      if (fileKind && path) this.live.setFileChanges([{ path, kind: fileKind }]);
    }
    const usage = isRecord(message.usage) ? message.usage : undefined;
    if (usage && !readString(event, "parent_tool_use_id")) {
      const contextUsed =
        (readNumber(usage, "input_tokens") ?? 0) +
        (readNumber(usage, "cache_read_input_tokens") ?? 0) +
        (readNumber(usage, "cache_creation_input_tokens") ?? 0);
      if (contextUsed > 0) this.live.setUsage({ contextUsedTokens: contextUsed });
    }
  }

  /** Adds tasks Claude created once their ids come back in the tool results. */
  private handleToolResults(event: Record<string, unknown>): void {
    const message = isRecord(event.message) ? event.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const result = isRecord(event.tool_use_result) ? event.tool_use_result : {};
    const task = isRecord(result.task) ? result.task : undefined;
    for (const block of content) {
      if (!isRecord(block) || readString(block, "type") !== "tool_result") continue;
      const toolUseId = readString(block, "tool_use_id");
      const subject = toolUseId ? this.pendingTaskCreates.get(toolUseId) : undefined;
      if (!toolUseId || subject === undefined) continue;
      this.pendingTaskCreates.delete(toolUseId);
      const id = task ? readString(task, "id") : undefined;
      if (!id || block.is_error === true) continue;
      this.planTasks.set(id, { text: readString(task ?? {}, "subject") ?? subject, status: "pending" });
      this.publishPlanTasks();
    }
  }

  private updatePlanTask(input: Record<string, unknown>): void {
    const id = readString(input, "taskId");
    const task = id ? this.planTasks.get(id) : undefined;
    if (!id || !task) return;
    if (input.status === "deleted") this.planTasks.delete(id);
    else {
      if (typeof input.status === "string") task.status = readTodoStatus(input.status);
      task.text = readString(input, "subject") ?? task.text;
    }
    this.publishPlanTasks();
  }

  private publishPlanTasks(): void {
    this.live.setPlan([...this.planTasks.values()].map((task) => ({ ...task })));
  }

  private handleResult(event: Record<string, unknown>): void {
    this.turnFinished = true;
    const usage = this.output.getUsage();
    const modelUsage = isRecord(event.modelUsage) ? event.modelUsage : {};
    let contextWindow: number | undefined;
    for (const entry of Object.values(modelUsage)) {
      if (!isRecord(entry)) continue;
      const window = readNumber(entry, "contextWindow");
      if (window && (!contextWindow || window > contextWindow)) contextWindow = window;
    }
    const cost = readNumber(event, "total_cost_usd");
    this.live.setUsage({
      ...toLiveUsage(usage),
      ...(contextWindow ? { contextWindowTokens: contextWindow } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
    });
    this.live.failPendingSteers("The turn ended before Claude read this message.");
    // Closing stdin ends the session; a predicted next prompt, if Claude
    // makes one, still arrives before the process exits.
    this.closeInput();
  }

  getFinalOutput(): string {
    return this.output.getFinalOutput();
  }
  getUsage(): AgentModelStreamUsage | undefined {
    return this.output.getUsage();
  }
  getRetryCount(): number | undefined {
    return this.output.getRetryCount();
  }
  getFailureMessage(): string | undefined {
    return this.output.getFailureMessage();
  }
  reachedTurnLimit(): boolean {
    return this.output.reachedTurnLimit();
  }
  getModelCallCount(): number {
    return this.output.getModelCallCount();
  }
  getToolCallCount(): number {
    return this.output.getToolCallCount();
  }
  getToolEvidence(): string {
    return this.output.getToolEvidence();
  }
  isModelCallCountReported(): boolean {
    return this.output.isModelCallCountReported();
  }
  hasTerminalResult(): boolean {
    return this.output.hasTerminalResult() && this.inputClosed;
  }
}

export const toLiveUsage = (usage: AgentModelStreamUsage | undefined) => ({
  ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
  ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
  ...(usage?.cachedInputTokens !== undefined
    ? { cachedInputTokens: usage.cachedInputTokens }
    : usage?.cacheReadInputTokens !== undefined
      ? { cachedInputTokens: usage.cacheReadInputTokens }
      : {}),
  ...(usage?.reasoningTokens !== undefined
    ? { reasoningTokens: usage.reasoningTokens }
    : {}),
});
