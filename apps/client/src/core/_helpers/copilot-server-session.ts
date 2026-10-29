import type { AgentModelStreamUsage } from "@machdoch/model-runtime/types";
import type {
  AgentLiveFileChange,
  AgentLiveLimit,
  AgentLivePlanStep,
} from "@machdoch/fleet-protocol/task-thinking";
import { AgentLiveTracker } from "./agent-live-tracker.js";
import {
  JsonRpcPeer,
  UNATTENDED_ANSWER,
  isRecord,
  mergeOutputUpdate,
  readNumber,
  readString,
  settleLiveQuestion,
  staleQuestionError,
  toEpochMs,
  turnFinishedError,
  type InteractiveAgentSession,
  type InteractiveSessionIo,
  type RpcId,
} from "./agent-interactive-session.js";
import {
  AgentControlRequestError,
  type AgentTaskControlHandlers,
} from "./agent-task-control-server.js";
import { CopilotCliOutputDecoder } from "./copilot-cli-output.js";
import type { ExternalAgentCliOutputUpdate } from "./external-agent-cli-output.js";

export interface CopilotServerTurnInput {
  prompt: string;
  imagePaths: string[];
  /** `session.create` params: model, working directory, agent, MCP servers… */
  session: Record<string, unknown>;
  /** Drops workspace instruction files, like `--no-custom-instructions`. */
  skipCustomInstructions: boolean;
}

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 5_000;
const TASK_REFRESH_DELAY_MS = 250;
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const FILE_TOOLS: Record<string, AgentLiveFileChange["kind"]> = {
  create: "add",
  edit: "update",
  str_replace_editor: "update",
};
const QUOTA_LABELS: Record<string, string> = {
  premium_interactions: "Premium requests",
  chat: "Chat messages",
};

/** Reads LSP-style `Content-Length` frames across arbitrary chunk boundaries. */
export class ContentLengthFrameReader {
  private buffer = Buffer.alloc(0);

  push(chunk: string, onFrame: (body: string) => void): void {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk, "utf8")]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.buffer.length > 8_192) this.buffer = Buffer.alloc(0);
        return;
      }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/content-length:\s*(\d+)/iu.exec(header)?.[1]);
      if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
        // Drop the unreadable header and resynchronise on the next one.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const end = headerEnd + 4 + length;
      if (this.buffer.length < end) return;
      const body = this.buffer.subarray(headerEnd + 4, end).toString("utf8");
      this.buffer = this.buffer.subarray(end);
      onFrame(body);
    }
  }
}

export const encodeContentLengthFrame = (message: Record<string, unknown>): string => {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
};

const parseTodoMarkdown = (text: string): AgentLivePlanStep[] =>
  text.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(?:[-*]|\d+\.)\s*\[([ xX~>-])\]\s*(.+)$/u.exec(line);
    if (!match?.[2]) return [];
    const mark = match[1]?.toLowerCase();
    return [
      {
        text: match[2],
        status: mark === "x" ? "completed" : mark === " " ? "pending" : "in_progress",
      } satisfies AgentLivePlanStep,
    ];
  });

/**
 * Drives one Copilot turn through `copilot --server --stdio`, the JSON-RPC
 * protocol the Copilot SDKs use. On top of the one-shot `-p` run it adds
 * steering, abort, clarifying questions, background-task control, and live
 * usage, context and quota reporting.
 */
export class CopilotServerSession implements InteractiveAgentSession {
  readonly live: AgentLiveTracker;
  readonly controls: AgentTaskControlHandlers;
  private readonly output: CopilotCliOutputDecoder;
  private readonly frames = new ContentLengthFrameReader();
  private readonly rpc: JsonRpcPeer<{ steerId?: string; steerText?: string; taskId?: string }>;
  private nextSteer = 1;
  private sessionId: string | undefined;
  private setupPending = 0;
  private promptSent = false;
  private readonly queuedSteers: { steerId: string; text: string }[] = [];
  private pendingQuestion: { requestId: RpcId; questionId: string; choices: string[] } | undefined;
  private terminal = false;
  private inputClosed = false;
  private shuttingDown = false;
  private shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  private taskRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private lastError: string | undefined;
  private modelCalls = 0;
  private readonly unattended: boolean;
  private readonly usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };

  constructor(
    private readonly input: CopilotServerTurnInput,
    private readonly io: InteractiveSessionIo,
    publish: ConstructorParameters<typeof AgentLiveTracker>[1],
    options: { model: string; captureEvidence: boolean; unattended?: boolean },
  ) {
    this.output = new CopilotCliOutputDecoder(options.captureEvidence);
    this.unattended = options.unattended === true;
    this.rpc = new JsonRpcPeer(
      (message) => {
        if (!this.inputClosed) this.io.write(encodeContentLengthFrame(message));
      },
      { jsonrpc: "2.0" },
    );
    this.live = new AgentLiveTracker(
      {
        provider: "copilot-cli",
        transport: "sdk-server",
        capabilities: this.unattended ? [] : ["steer", "interrupt", "answer", "stop-task"],
        model: options.model,
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
    this.rpc.request("connect", {});
    this.live.flush();
  }

  interrupt(): boolean {
    if (this.terminal || !this.sessionId) return false;
    this.cancelPendingQuestion();
    if (!this.promptSent) {
      this.finishTurn(this.fail("The turn was interrupted."));
      return true;
    }
    this.rpc.request("session.abort", { sessionId: this.sessionId });
    return true;
  }

  dispose(): void {
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
    if (this.taskRefreshTimer) clearTimeout(this.taskRefreshTimer);
    this.live.close();
  }

  private steer(text: string): void {
    if (this.terminal) throw turnFinishedError();
    const steerId = `steer-${this.nextSteer++}`;
    this.live.recordSteer(steerId, text, "pending");
    // Copilot can take a while to start; early messages follow the prompt.
    if (!this.promptSent) this.queuedSteers.push({ steerId, text });
    else this.sendSteer(steerId, text);
  }

  private sendSteer(steerId: string, text: string): void {
    this.rpc.request(
      "session.send",
      { sessionId: this.sessionId, prompt: text, mode: "immediate" },
      { steerId, steerText: text },
    );
  }

  private answer(questionId: string, answers: Record<string, string>): void {
    const pending = this.pendingQuestion;
    if (!pending || pending.questionId !== questionId) throw staleQuestionError();
    const answer = Object.values(answers).find((value) => value.trim())?.trim();
    if (!answer) throw new AgentControlRequestError("Type or choose an answer first.", 400);
    this.pendingQuestion = undefined;
    this.rpc.respond(pending.requestId, {
      answer,
      wasFreeform: !pending.choices.includes(answer),
    });
    settleLiveQuestion(this.live, "answered", answers);
  }

  private stopTask(taskId: string): void {
    const task = this.live.getTask(taskId);
    if (this.terminal || !this.sessionId || !task || task.status !== "running" || !task.canStop) {
      throw new AgentControlRequestError("This background task is not running.");
    }
    this.live.upsertTask({ id: taskId, canStop: false, summary: "Stopping…" });
    this.rpc.request("session.tasks.cancel", { sessionId: this.sessionId, id: taskId }, { taskId });
  }

  private cancelPendingQuestion(): void {
    const pending = this.pendingQuestion;
    if (!pending) return;
    this.pendingQuestion = undefined;
    this.rpc.respondError(pending.requestId, -32800, "The user stopped the turn before answering.");
    settleLiveQuestion(this.live, "cancelled");
  }

  push(chunk: string): ExternalAgentCliOutputUpdate {
    const update: ExternalAgentCliOutputUpdate = { displayText: [] };
    this.frames.push(chunk, (body) => {
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        return;
      }
      if (isRecord(message)) this.processMessage(message, update);
    });
    return update;
  }

  finish(): ExternalAgentCliOutputUpdate {
    const update: ExternalAgentCliOutputUpdate = { displayText: [] };
    if (!this.terminal) {
      mergeOutputUpdate(
        update,
        this.fail(this.lastError ?? "Copilot exited before the turn finished."),
      );
    }
    this.live.flush();
    return update;
  }

  private processMessage(message: Record<string, unknown>, update: ExternalAgentCliOutputUpdate): void {
    const incoming = this.rpc.classify(message);
    if (incoming?.kind === "response") {
      mergeOutputUpdate(
        update,
        this.handleResponse(incoming.method, incoming.meta, incoming.result, incoming.error),
      );
    } else if (incoming?.kind === "request") {
      this.handleServerRequest(incoming.id, incoming.method, incoming.params);
    } else if (incoming?.method === "session.event") {
      mergeOutputUpdate(update, this.handleEvent(incoming.params));
    }
  }

  private handleResponse(
    method: string,
    meta: { steerId?: string; steerText?: string; taskId?: string },
    result: Record<string, unknown>,
    text: string | undefined,
  ): ExternalAgentCliOutputUpdate {
    const empty: ExternalAgentCliOutputUpdate = { displayText: [] };
    if (method === "runtime.shutdown" || method === "session.destroy") {
      if (method === "session.destroy") this.rpc.request("runtime.shutdown", {});
      else this.closeInput();
      return empty;
    }
    if (text !== undefined) {
      switch (method) {
        case "session.send":
          if (meta.steerId) {
            this.live.recordSteer(meta.steerId, meta.steerText ?? "", "failed", text);
            return empty;
          }
          return this.finishTurn(this.fail(text));
        case "session.tasks.cancel":
          if (meta.taskId) this.live.upsertTask({ id: meta.taskId, canStop: true, summary: text });
          return empty;
        case "connect":
        case "session.create":
          return this.finishTurn(this.fail(text));
        case "session.permissions.setApproveAll":
          return this.finishTurn(this.fail(`Copilot could not allow all tools: ${text}`));
        case "session.options.update":
          this.live.addNotice("warning", `Copilot kept workspace instruction files: ${text}`);
          this.setupDone();
          return empty;
        default:
          return empty;
      }
    }
    switch (method) {
      case "connect":
        this.rpc.request("account.getQuota", {});
        this.rpc.request("session.create", {
          clientName: "machdoch",
          streaming: true,
          // Only offer ask_user when someone can answer it.
          requestUserInput: !this.unattended,
          requestPermission: true,
          requestExitPlanMode: false,
          requestAutoModeSwitch: false,
          requestElicitation: false,
          requestMcpApps: false,
          hooks: false,
          includeSubAgentStreamingEvents: true,
          ...this.input.session,
        });
        return empty;
      case "session.create": {
        const sessionId = readString(result, "sessionId");
        if (!sessionId) return this.finishTurn(this.fail("Copilot did not create a session."));
        this.sessionId = sessionId;
        this.setupPending = this.input.skipCustomInstructions ? 2 : 1;
        this.rpc.request("session.permissions.setApproveAll", { sessionId, enabled: true });
        if (this.input.skipCustomInstructions) {
          this.rpc.request("session.options.update", { sessionId, skipCustomInstructions: true });
        }
        return empty;
      }
      case "session.permissions.setApproveAll":
      case "session.options.update":
        this.setupDone();
        return empty;
      case "session.send":
        return empty;
      case "session.tasks.cancel":
        if (meta.taskId) {
          this.live.upsertTask(
            result.cancelled === false
              ? { id: meta.taskId, summary: "The task had already finished." }
              : { id: meta.taskId, status: "stopped", canStop: false, summary: "Stopped" },
          );
        }
        this.scheduleTaskRefresh();
        return empty;
      case "session.tasks.list":
        this.applyTasks(result.tasks);
        return empty;
      case "account.getQuota":
        this.applyQuota(result.quotaSnapshots);
        return empty;
      default:
        return empty;
    }
  }

  private setupDone(): void {
    this.setupPending -= 1;
    if (this.setupPending > 0 || this.promptSent || this.terminal || !this.sessionId) return;
    this.promptSent = true;
    // Messages sent while Copilot started belong to the same request. As
    // separate immediate sends they would pre-empt the prompt instead.
    const early = this.queuedSteers.splice(0);
    this.rpc.request("session.send", {
      sessionId: this.sessionId,
      prompt: [this.input.prompt, ...early.map((steer) => steer.text)].join("\n\n"),
      ...(this.input.imagePaths.length > 0
        ? { attachments: this.input.imagePaths.map((path) => ({ type: "file", path })) }
        : {}),
    });
    for (const { steerId, text } of early) this.live.recordSteer(steerId, text, "delivered");
  }

  private handleServerRequest(id: RpcId, method: string, params: Record<string, unknown>): void {
    if (method !== "userInput.request" || this.terminal) {
      this.rpc.respondError(id, -32601, `machdoch does not handle ${method}.`);
      return;
    }
    const question = readString(params, "question");
    if (!question) {
      this.rpc.respondError(id, -32602, "The question could not be shown to the user.");
      return;
    }
    const choices = (Array.isArray(params.choices) ? params.choices : [])
      .filter((choice): choice is string => typeof choice === "string" && choice.trim().length > 0)
      .slice(0, 12);
    if (this.unattended) {
      this.rpc.respond(id, { answer: UNATTENDED_ANSWER, wasFreeform: true });
      return;
    }
    this.cancelPendingQuestion();
    const questionId = `copilot-${String(id)}`;
    this.pendingQuestion = { requestId: id, questionId, choices };
    this.live.setQuestion({
      id: questionId,
      status: "pending",
      items: [
        {
          id: "answer",
          question,
          options: choices.map((label) => ({ label })),
          allowOther: params.allowFreeform !== false || choices.length === 0,
        },
      ],
    });
  }

  private handleEvent(params: Record<string, unknown>): ExternalAgentCliOutputUpdate {
    const empty: ExternalAgentCliOutputUpdate = { displayText: [] };
    const event = isRecord(params.event) ? params.event : undefined;
    const type = event ? readString(event, "type") : undefined;
    if (!event || !type || (this.sessionId && params.sessionId !== this.sessionId)) return empty;
    const data = isRecord(event.data) ? event.data : {};
    const agentId = readString(event, "agentId");
    this.trackEvent(type, data, agentId);
    if (this.terminal) return empty;
    if (!agentId) {
      if (type === "assistant.idle") return this.finishTurn(this.complete());
      if (type === "session.idle") {
        return this.finishTurn(
          data.aborted === true ? this.fail("The turn was interrupted.") : this.complete(),
        );
      }
      if (type === "session.error" || type === "error") {
        this.lastError = readString(data, "message") ?? readString(data, "error") ?? this.lastError;
      }
    }
    if (type === "result" || event.ephemeral === true) return empty;
    return this.output.push(
      `${JSON.stringify({ type, data, ...(agentId ? { agentId } : {}) })}\n`,
    );
  }

  private trackEvent(type: string, data: Record<string, unknown>, agentId: string | undefined): void {
    switch (type) {
      case "user.message": {
        const content = readString(data, "content");
        if (!agentId && data.delivery === "steering" && content) this.live.confirmSteer(content);
        return;
      }
      case "session.usage_info": {
        if (agentId) return;
        const limit = readNumber(data, "tokenLimit");
        const current = readNumber(data, "currentTokens");
        this.live.setUsage({
          ...(current !== undefined ? { contextUsedTokens: current } : {}),
          ...(limit ? { contextWindowTokens: limit } : {}),
        });
        return;
      }
      case "assistant.usage": {
        this.modelCalls += agentId ? 0 : 1;
        this.usage.inputTokens += readNumber(data, "inputTokens") ?? 0;
        this.usage.outputTokens += readNumber(data, "outputTokens") ?? 0;
        this.usage.cachedInputTokens += readNumber(data, "cacheReadTokens") ?? 0;
        this.usage.reasoningTokens += readNumber(data, "reasoningTokens") ?? 0;
        this.live.setUsage({ ...this.usage });
        this.applyQuota(data.quotaSnapshots);
        return;
      }
      case "tool.execution_start":
        this.trackToolStart(data, agentId);
        return;
      case "tool.execution_complete": {
        const id = readString(data, "toolCallId");
        const task = id ? this.live.getTask(id) : undefined;
        if (id && task?.status === "running" && !task.background) {
          this.live.upsertTask({ id, status: data.success === false ? "failed" : "completed" });
        }
        return;
      }
      case "subagent.started": {
        const id = readString(data, "toolCallId");
        if (!id || data.executionMode === "background") return;
        this.live.upsertTask({
          id,
          kind: "agent",
          description:
            readString(data, "agentDescription") ??
            readString(data, "agentDisplayName") ??
            readString(data, "agentName") ??
            "Sub-agent",
          status: "running",
          background: false,
          canStop: false,
          startedAt: Date.now(),
        });
        return;
      }
      case "subagent.completed":
      case "subagent.failed": {
        const id = readString(data, "toolCallId");
        if (id && this.live.getTask(id)) {
          this.live.upsertTask({ id, status: type === "subagent.failed" ? "failed" : "completed" });
        }
        return;
      }
      case "session.background_tasks_changed":
        this.scheduleTaskRefresh();
        return;
      case "model.rerouted":
      case "session.model_change": {
        const model = readString(data, "newModel") ?? readString(data, "toModel");
        if (model && !agentId) this.live.addNotice("info", `Copilot switched to ${model}.`);
        return;
      }
      case "session.compaction_start":
        if (!agentId) this.live.addNotice("info", "Copilot is compacting the conversation to free up context.");
        return;
      case "session.warning": {
        const text = readString(data, "message");
        if (text && !agentId) this.live.addNotice("warning", text);
        return;
      }
      default:
        return;
    }
  }

  private trackToolStart(data: Record<string, unknown>, agentId: string | undefined): void {
    const id = readString(data, "toolCallId");
    const tool = readString(data, "toolName");
    const args = isRecord(data.arguments) ? data.arguments : {};
    if (!id || !tool) return;
    if (SHELL_TOOLS.has(tool) && !agentId) {
      // Async shells are reported through session.tasks with a stop handle.
      if (args.mode === "async" || args.detach === true) return;
      this.live.upsertTask({
        id,
        kind: "shell",
        description: readString(args, "description") ?? readString(args, "command") ?? "Shell command",
        status: "running",
        background: false,
        canStop: false,
        startedAt: Date.now(),
      });
      return;
    }
    const fileKind = FILE_TOOLS[tool];
    const path = readString(args, "path") ?? readString(args, "file_path");
    if (fileKind && path) {
      this.live.setFileChanges([{ path, kind: fileKind }]);
      return;
    }
    if (tool === "update_todo" && !agentId) {
      const todos = readString(args, "todos");
      const plan = todos ? parseTodoMarkdown(todos) : [];
      if (plan.length > 0) this.live.setPlan(plan);
    }
  }

  private scheduleTaskRefresh(): void {
    if (this.taskRefreshTimer || this.terminal || !this.sessionId) return;
    this.taskRefreshTimer = setTimeout(() => {
      this.taskRefreshTimer = undefined;
      if (!this.terminal && this.sessionId) {
        this.rpc.request("session.tasks.list", { sessionId: this.sessionId });
      }
    }, TASK_REFRESH_DELAY_MS);
    (this.taskRefreshTimer as { unref?: () => void }).unref?.();
  }

  private applyTasks(value: unknown): void {
    const tasks = (Array.isArray(value) ? value : []).filter(isRecord);
    const listed = new Set(tasks.map((task) => readString(task, "id")));
    // A background task Copilot no longer lists has finished.
    for (const task of this.live.snapshot().tasks ?? []) {
      if (task.background && task.status === "running" && !listed.has(task.id)) {
        this.live.upsertTask({ id: task.id, status: "completed" });
      }
    }
    for (const task of tasks) {
      const id = readString(task, "id");
      if (!id) continue;
      const status = readString(task, "status");
      const startedAt = toEpochMs(task.startedAt);
      this.live.upsertTask({
        id,
        kind: task.type === "agent" ? "agent" : task.type === "shell" ? "shell" : "other",
        description: readString(task, "description") ?? readString(task, "command") ?? "Background task",
        status:
          status === "running"
            ? "running"
            : status === "cancelled"
              ? "stopped"
              : status === "failed"
                ? "failed"
                : "completed",
        background: true,
        canStop: status === "running",
        ...(startedAt ? { startedAt } : {}),
      });
    }
  }

  private applyQuota(value: unknown): void {
    if (!isRecord(value)) return;
    const limits: AgentLiveLimit[] = [];
    for (const [key, label] of Object.entries(QUOTA_LABELS)) {
      const snapshot = isRecord(value[key]) ? value[key] : undefined;
      if (!snapshot || snapshot.isUnlimitedEntitlement === true) continue;
      const remaining = readNumber(snapshot, "remainingPercentage");
      if (remaining === undefined) continue;
      const resetsAt = toEpochMs(snapshot.resetDate);
      const usedPercent = Math.max(0, 100 - remaining);
      limits.push({
        id: `copilot-${key}`,
        label,
        usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
        ...(usedPercent >= 100 && snapshot.usageAllowedWithExhaustedQuota !== true
          ? { limited: true }
          : {}),
      });
    }
    if (limits.length > 0) this.live.setLimits(limits);
  }

  private complete(): ExternalAgentCliOutputUpdate {
    if (this.terminal) return { displayText: [] };
    if (this.lastError && !this.output.getFinalOutput().trim()) return this.fail(this.lastError);
    this.terminal = true;
    return this.output.push(`${JSON.stringify({ type: "result", exitCode: 0 })}\n`);
  }

  private fail(message: string): ExternalAgentCliOutputUpdate {
    if (this.terminal) return { displayText: [] };
    this.terminal = true;
    this.lastError = message;
    return { displayText: [], resultExitCode: 1 };
  }

  /** Ends the Copilot session; background work still running is stopped with it. */
  private finishTurn(update: ExternalAgentCliOutputUpdate): ExternalAgentCliOutputUpdate {
    if (this.shuttingDown) return update;
    this.shuttingDown = true;
    this.cancelPendingQuestion();
    for (const { steerId, text } of this.queuedSteers.splice(0)) {
      this.live.recordSteer(steerId, text, "failed", "The turn ended before Copilot started.");
    }
    this.live.failPendingSteers("The turn ended before Copilot read this message.");
    const running = (this.live.snapshot().tasks ?? []).filter(
      (task) => task.status === "running" && task.background,
    );
    if (running.length > 0) {
      this.live.addNotice(
        "info",
        `Stopped ${running.length} background task${running.length === 1 ? "" : "s"} when the turn ended.`,
      );
    }
    for (const task of running) this.live.upsertTask({ id: task.id, status: "stopped" });
    this.live.replaceRunningTasks(new Set());
    this.live.setCapabilities([]);
    this.live.flush();
    if (this.sessionId) this.rpc.request("session.destroy", { sessionId: this.sessionId });
    else this.rpc.request("runtime.shutdown", {});
    this.shutdownTimer = setTimeout(() => this.closeInput(), SHUTDOWN_GRACE_MS);
    (this.shutdownTimer as { unref?: () => void }).unref?.();
    return update;
  }

  private closeInput(): void {
    if (this.inputClosed) return;
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
    this.inputClosed = true;
    this.io.closeInput();
  }

  getFinalOutput(): string {
    return this.output.getFinalOutput();
  }
  getUsage(): AgentModelStreamUsage | undefined {
    if (this.modelCalls === 0) return undefined;
    return {
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      totalTokens: this.usage.inputTokens + this.usage.outputTokens,
      cachedInputTokens: this.usage.cachedInputTokens,
      reasoningTokens: this.usage.reasoningTokens,
    };
  }
  getRetryCount(): undefined {
    return undefined;
  }
  getModelCallCount(): number {
    return Math.max(1, this.modelCalls);
  }
  getToolCallCount(): number {
    return this.output.getToolCallCount();
  }
  getToolEvidence(): string {
    return this.output.getToolEvidence();
  }
  isModelCallCountReported(): boolean {
    return this.modelCalls > 0;
  }
  hasTerminalResult(): boolean {
    return this.terminal && this.inputClosed;
  }
  getFailureMessage(): string | undefined {
    return this.terminal && this.output.hasTerminalResult() ? undefined : this.lastError;
  }
}
