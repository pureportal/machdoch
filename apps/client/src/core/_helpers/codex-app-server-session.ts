import { isAbsolute, relative } from "node:path";
import type { AgentModelStreamUsage } from "@machdoch/model-runtime/types";
import type {
  AgentLiveFileChange,
  AgentLiveLimit,
  AgentLiveQuestion,
} from "@machdoch/fleet-protocol/task-thinking";
import { AgentLiveTracker } from "./agent-live-tracker.js";
import {
  JsonLineSplitter,
  JsonRpcPeer,
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
  type RpcId,
} from "./agent-interactive-session.js";
import {
  AgentControlRequestError,
  type AgentTaskControlHandlers,
} from "./agent-task-control-server.js";
import {
  CodexCliOutputDecoder,
  type ExternalAgentCliOutputUpdate,
} from "./external-agent-cli-output.js";

export interface CodexAppServerTurnInput {
  prompt: string;
  imagePaths: string[];
  /** Extra `thread/start` params (model, cwd, sandbox, service tier…). */
  thread: Record<string, unknown>;
  /** Extra `turn/start` params. */
  turn: Record<string, unknown>;
  /** Runs a native Codex review instead of a prompt turn. */
  review?: { target: Record<string, unknown> };
}

const ITEM_TYPES: Record<string, string> = {
  agentMessage: "agent_message",
  commandExecution: "command_execution",
  fileChange: "file_change",
  mcpToolCall: "mcp_tool_call",
  webSearch: "web_search",
};

const windowLabel = (minutes: number | undefined, fallback: string): string => {
  if (!minutes) return fallback;
  if (minutes % 10_080 === 0) return minutes === 10_080 ? "Weekly limit" : `${minutes / 10_080}-week limit`;
  if (minutes % 1_440 === 0) return minutes === 1_440 ? "Daily limit" : `${minutes / 1_440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
};

/** Shows the command Codex ran without the shell it was wrapped in. */
export const describeShellCommand = (command: string): string => {
  const match =
    /^\s*"?(?:[^"]*[\\/])?(?:pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?"?\s+(?:-NoProfile\s+|-NonInteractive\s+)*(?:-Command|-lc|-c|\/c)\s+([\s\S]+)$/iu.exec(
      command,
    );
  const inner = match?.[1]?.trim();
  if (!inner) return command.trim();
  const quote = inner[0];
  return (quote === "'" || quote === '"') && inner.endsWith(quote) && inner.length > 1
    ? inner.slice(1, -1)
    : inner;
};

/** Counts added and removed lines per file in a unified diff. */
export const summarizeUnifiedDiff = (diff: string): AgentLiveFileChange[] => {
  const files = new Map<string, AgentLiveFileChange>();
  let current: AgentLiveFileChange | undefined;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      // Git quotes paths that contain spaces or special characters.
      const match = / "?b\/(.+?)"?$/u.exec(line);
      current = match?.[1]
        ? { path: match[1], kind: "update", additions: 0, deletions: 0 }
        : undefined;
      if (current) files.set(current.path, current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.kind = "add";
    else if (line.startsWith("deleted file mode")) current.kind = "delete";
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) current.additions = (current.additions ?? 0) + 1;
    else if (line.startsWith("-")) current.deletions = (current.deletions ?? 0) + 1;
  }
  return [...files.values()];
};

/**
 * Drives one ordinary Codex chat turn through `codex app-server`, which adds
 * steering, interrupt, live plan/diff, usage and plan-limit pushes, and
 * clarifying questions on top of what `codex exec --json` reports.
 */
export class CodexAppServerSession implements InteractiveAgentSession {
  readonly live: AgentLiveTracker;
  readonly controls: AgentTaskControlHandlers;
  private readonly output: CodexCliOutputDecoder;
  private readonly lines = new JsonLineSplitter();
  private readonly rpc: JsonRpcPeer<{ steerId?: string; steerText?: string }>;
  private threadId: string | undefined;
  private activeTurnId: string | undefined;
  private pendingQuestion: { requestId: RpcId; questionId: string } | undefined;
  private terminal = false;
  private inputClosed = false;
  private usage: AgentModelStreamUsage | undefined;
  private nextSteer = 1;
  private readonly queuedSteers: { steerId: string; text: string }[] = [];
  private readonly unattended: boolean;

  constructor(
    private readonly input: CodexAppServerTurnInput,
    private readonly io: InteractiveSessionIo,
    publish: ConstructorParameters<typeof AgentLiveTracker>[1],
    options: { model: string; captureEvidence: boolean; fastMode?: boolean; unattended?: boolean },
  ) {
    this.output = new CodexCliOutputDecoder(options.captureEvidence);
    this.unattended = options.unattended === true;
    this.rpc = new JsonRpcPeer((message) => {
      if (!this.inputClosed) this.io.write(`${JSON.stringify(message)}\n`);
    });
    this.live = new AgentLiveTracker(
      {
        provider: "codex-cli",
        transport: "app-server",
        // Codex rejects steering on review turns.
        capabilities: this.unattended
          ? []
          : input.review
            ? ["interrupt"]
            : ["steer", "interrupt", "answer"],
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
    };
  }

  start(): void {
    this.rpc.request("initialize", {
      clientInfo: { name: "machdoch", title: "machdoch", version: "1.0.0" },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/textDelta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/summaryPartAdded",
          "item/commandExecution/outputDelta",
          "item/fileChange/outputDelta",
          "item/plan/delta",
          "mcpServer/startupStatus/updated",
          "turn/moderationMetadata",
        ],
      },
    });
    this.live.flush();
  }

  interrupt(): boolean {
    if (this.terminal || !this.threadId || !this.activeTurnId) return false;
    this.cancelPendingQuestion();
    this.rpc.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.activeTurnId,
    });
    return true;
  }

  dispose(): void {
    this.live.close();
  }

  private steer(text: string): void {
    if (this.input.review) {
      throw new AgentControlRequestError("Codex reviews cannot be steered.");
    }
    if (this.terminal) throw turnFinishedError();
    const steerId = `steer-${this.nextSteer++}`;
    this.live.recordSteer(steerId, text, "pending");
    // Steering needs the turn id; messages sent while Codex starts wait for it.
    if (!this.threadId || !this.activeTurnId) this.queuedSteers.push({ steerId, text });
    else this.sendSteer(this.threadId, this.activeTurnId, steerId, text);
  }

  private sendSteer(threadId: string, turnId: string, steerId: string, text: string): void {
    this.rpc.request(
      "turn/steer",
      {
        threadId,
        expectedTurnId: turnId,
        input: [{ type: "text", text, text_elements: [] }],
      },
      { steerId, steerText: text },
    );
  }

  private flushQueuedSteers(): void {
    // Review turns cannot be steered; their capabilities never offer it.
    if (!this.threadId || !this.activeTurnId || this.input.review) return;
    for (const { steerId, text } of this.queuedSteers.splice(0)) {
      this.sendSteer(this.threadId, this.activeTurnId, steerId, text);
    }
  }

  private answer(questionId: string, answers: Record<string, string>): void {
    const pending = this.pendingQuestion;
    if (!pending || pending.questionId !== questionId) throw staleQuestionError();
    this.pendingQuestion = undefined;
    this.rpc.respond(pending.requestId, {
      answers: Object.fromEntries(
        Object.entries(answers).map(([id, answer]) => [id, { answers: [answer] }]),
      ),
    });
    settleLiveQuestion(this.live, "answered", answers);
  }

  private cancelPendingQuestion(): void {
    const pending = this.pendingQuestion;
    if (!pending) return;
    this.pendingQuestion = undefined;
    this.rpc.respondError(pending.requestId, -32800, "The user stopped the turn before answering.");
    settleLiveQuestion(this.live, "cancelled");
  }

  private closeInput(): void {
    if (this.inputClosed) return;
    this.cancelPendingQuestion();
    for (const { steerId, text } of this.queuedSteers.splice(0)) {
      this.live.recordSteer(steerId, text, "failed", "The turn ended before Codex started.");
    }
    this.live.failPendingSteers("The turn ended before Codex read this message.");
    this.inputClosed = true;
    this.live.setCapabilities([]);
    this.live.flush();
    this.io.closeInput();
  }

  push(chunk: string): ExternalAgentCliOutputUpdate {
    const update: ExternalAgentCliOutputUpdate = { displayText: [] };
    this.lines.push(chunk, (line) => this.processLine(line, update));
    return update;
  }

  finish(): ExternalAgentCliOutputUpdate {
    const update: ExternalAgentCliOutputUpdate = { displayText: [] };
    this.lines.finish((line) => this.processLine(line, update));
    if (!this.terminal) {
      mergeOutputUpdate(
        update,
        this.fail("Codex exited before the turn finished."),
      );
    }
    this.live.flush();
    return update;
  }

  private processLine(line: string, update: ExternalAgentCliOutputUpdate): void {
    const message = parseJsonRecord(line);
    const incoming = message ? this.rpc.classify(message) : undefined;
    if (!incoming || this.terminal) return;
    if (incoming.kind === "response") {
      mergeOutputUpdate(
        update,
        this.handleResponse(incoming.method, incoming.meta, incoming.result, incoming.error),
      );
    } else if (incoming.kind === "request") {
      this.handleServerRequest(incoming.id, incoming.method, incoming.params);
    } else {
      mergeOutputUpdate(update, this.handleNotification(incoming.method, incoming.params));
    }
  }

  private handleResponse(
    method: string,
    meta: { steerId?: string; steerText?: string },
    result: Record<string, unknown>,
    error: string | undefined,
  ): ExternalAgentCliOutputUpdate {
    const empty: ExternalAgentCliOutputUpdate = { displayText: [] };
    if (error !== undefined) {
      if (method === "turn/steer" && meta.steerId) {
        this.live.recordSteer(meta.steerId, meta.steerText ?? "", "failed", error);
        return empty;
      }
      if (method === "turn/interrupt" || method === "account/rateLimits/read") return empty;
      return this.fail(error);
    }
    switch (method) {
      case "initialize":
        this.rpc.notify("initialized", {});
        this.rpc.request("account/rateLimits/read", {});
        this.rpc.request("thread/start", {
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: true,
          ...this.input.thread,
          config: {
            // Lets Codex ask clarifying questions outside Plan mode, when
            // someone is there to answer them.
            "features.default_mode_request_user_input": !this.unattended,
            ...(isRecord(this.input.thread.config) ? this.input.thread.config : {}),
          },
        });
        return empty;
      case "thread/start": {
        const thread = isRecord(result.thread) ? result.thread : {};
        const threadId = readString(thread, "id");
        if (!threadId) return this.fail("Codex did not return a thread.");
        this.threadId = threadId;
        if (this.input.review) {
          this.rpc.request("review/start", {
            threadId,
            target: this.input.review.target,
          });
          return empty;
        }
        // Messages sent while Codex started join the opening request.
        const early = this.queuedSteers.splice(0);
        for (const { steerId, text } of early) this.live.recordSteer(steerId, text, "delivered");
        this.rpc.request("turn/start", {
          ...this.input.turn,
          threadId,
          input: [
            {
              type: "text",
              text: [this.input.prompt, ...early.map((steer) => steer.text)].join("\n\n"),
              text_elements: [],
            },
            ...this.input.imagePaths.map((path) => ({ type: "localImage", path })),
          ],
        });
        return empty;
      }
      case "turn/start":
      case "review/start": {
        const turn = isRecord(result.turn) ? result.turn : {};
        const turnId = readString(turn, "id");
        if (!turnId) return this.fail("Codex did not start the turn.");
        this.activeTurnId ??= turnId;
        this.flushQueuedSteers();
        return empty;
      }
      case "turn/steer":
        if (meta.steerId) this.live.recordSteer(meta.steerId, meta.steerText ?? "", "delivered");
        return empty;
      case "account/rateLimits/read":
        this.applyRateLimits(result.rateLimits ?? result);
        return empty;
      default:
        return empty;
    }
  }

  private handleServerRequest(id: RpcId, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "item/tool/requestUserInput":
        this.askUser(id, params);
        return;
      // The run keeps full access; approvals that still arrive are accepted.
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "execCommandApproval":
      case "applyPatchApproval":
        this.rpc.respond(id, { decision: "accept" });
        return;
      case "mcpServer/elicitation/request":
        this.rpc.respond(id, { action: "decline", content: null, _meta: null });
        return;
      default:
        this.rpc.respondError(id, -32601, `machdoch does not handle ${method}.`);
    }
  }

  private askUser(id: RpcId, params: Record<string, unknown>): void {
    const questions = Array.isArray(params.questions) ? params.questions.filter(isRecord) : [];
    const items: AgentLiveQuestion["items"] = questions.slice(0, 8).flatMap((question, index) => {
      const text = readString(question, "question");
      if (!text) return [];
      const options = readQuestionOptions(question.options);
      return [
        {
          id: readString(question, "id") ?? `q${index + 1}`,
          question: text,
          ...(readString(question, "header") ? { header: readString(question, "header") } : {}),
          options,
          allowOther: question.isOther === true || options.length === 0,
          ...(question.isSecret === true ? { secret: true } : {}),
        },
      ];
    });
    if (items.length === 0) {
      this.rpc.respondError(id, -32602, "The question could not be shown to the user.");
      return;
    }
    if (this.unattended) {
      this.rpc.respond(id, {
        answers: Object.fromEntries(items.map((item) => [item.id, { answers: [UNATTENDED_ANSWER] }])),
      });
      return;
    }
    this.cancelPendingQuestion();
    const questionId = `codex-${String(id)}`;
    this.pendingQuestion = { requestId: id, questionId };
    this.live.setQuestion({ id: questionId, items, status: "pending" });
  }

  private handleNotification(
    method: string,
    params: Record<string, unknown>,
  ): ExternalAgentCliOutputUpdate {
    const empty: ExternalAgentCliOutputUpdate = { displayText: [] };
    if (typeof params.threadId === "string" && this.threadId && params.threadId !== this.threadId) {
      return empty;
    }
    switch (method) {
      case "turn/started": {
        const turn = isRecord(params.turn) ? params.turn : {};
        const turnId = readString(turn, "id");
        if (turnId) this.activeTurnId = turnId;
        this.flushQueuedSteers();
        return empty;
      }
      case "turn/plan/updated": {
        const plan = Array.isArray(params.plan) ? params.plan.filter(isRecord) : [];
        this.live.setPlan(
          plan.map((step) => ({
            text: readString(step, "step") ?? "",
            status:
              step.status === "completed"
                ? "completed"
                : step.status === "inProgress"
                  ? "in_progress"
                  : "pending",
          })),
        );
        return empty;
      }
      case "turn/diff/updated": {
        const diff = readString(params, "diff");
        if (diff) this.live.setFileChanges(summarizeUnifiedDiff(diff));
        return empty;
      }
      case "thread/tokenUsage/updated":
        this.applyTokenUsage(params.tokenUsage);
        return empty;
      case "account/rateLimits/updated":
        this.applyRateLimits(params.rateLimits);
        return empty;
      case "model/rerouted":
        this.live.addNotice(
          "info",
          `Codex switched to ${readString(params, "toModel") ?? readString(params, "model") ?? "another model"}.`,
        );
        return empty;
      case "item/started":
        this.trackItem(params.item, "running");
        return empty;
      case "item/completed": {
        const item = isRecord(params.item) ? params.item : undefined;
        if (!item) return empty;
        this.trackItem(item, "done");
        if (item.type === "exitedReviewMode") {
          const review = readString(item, "review");
          return review
            ? this.output.pushEvent({
                type: "item.completed",
                item: { id: readString(item, "id"), type: "agent_message", text: review },
              })
            : empty;
        }
        return this.output.pushEvent({
          type: "item.completed",
          item: { ...item, type: ITEM_TYPES[String(item.type)] ?? item.type },
        });
      }
      case "turn/completed": {
        const turn = isRecord(params.turn) ? params.turn : {};
        // Review turns report different ids in their events; a run holds a
        // single turn, so only prompt turns need the id check.
        if (
          !this.input.review &&
          readString(turn, "id") &&
          readString(turn, "id") !== this.activeTurnId
        ) {
          return empty;
        }
        const status = readString(turn, "status");
        if (status === "failed" || status === "interrupted") {
          const error = isRecord(turn.error) ? turn.error : {};
          return this.fail(
            readString(error, "message") ??
              (status === "interrupted" ? "The turn was interrupted." : "The Codex turn failed."),
          );
        }
        this.terminal = true;
        const update = this.output.pushEvent({ type: "turn.completed" });
        this.closeInput();
        return update;
      }
      case "error":
        if (params.willRetry === true) {
          this.live.addNotice("warning", "Codex is retrying after a temporary error.");
          return empty;
        }
        return this.fail(
          isRecord(params.error)
            ? (readString(params.error, "message") ?? "Codex failed.")
            : "Codex failed.",
        );
      default:
        return empty;
    }
  }

  private trackItem(value: unknown, phase: "running" | "done"): void {
    if (!isRecord(value)) return;
    const id = readString(value, "id");
    const type = readString(value, "type");
    if (!id) return;
    if (type === "commandExecution") {
      const status = readString(value, "status");
      this.live.upsertTask({
        id,
        kind: "shell",
        description: describeShellCommand(readString(value, "command") ?? "Shell command"),
        status:
          phase === "running" || status === "inProgress"
            ? "running"
            : status === "failed" || status === "declined"
              ? "failed"
              : "completed",
        background: false,
        canStop: false,
        ...(phase === "running" ? { startedAt: Date.now() } : {}),
      });
    } else if (type === "collabAgentToolCall" || type === "subAgentActivity") {
      this.live.upsertTask({
        id,
        kind: "agent",
        description:
          readString(value, "prompt") ?? readString(value, "description") ?? "Sub-agent",
        status: phase === "running" ? "running" : "completed",
        background: false,
        canStop: false,
      });
    } else if (type === "fileChange" && phase === "done") {
      const changes = Array.isArray(value.changes) ? value.changes.filter(isRecord) : [];
      this.live.setFileChanges(
        changes.flatMap((change) => {
          const path = this.toWorkspacePath(readString(change, "path"));
          if (!path) return [];
          const kind = isRecord(change.kind)
            ? readString(change.kind, "type")
            : readString(change, "kind");
          return [
            {
              path,
              kind: kind === "add" ? "add" : kind === "delete" ? "delete" : "update",
            } satisfies AgentLiveFileChange,
          ];
        }),
      );
    }
  }

  /** Matches the workspace-relative paths that Codex diffs report. */
  private toWorkspacePath(path: string | undefined): string | undefined {
    if (!path) return undefined;
    const cwd = typeof this.input.thread.cwd === "string" ? this.input.thread.cwd : undefined;
    const relativePath = cwd && isAbsolute(path) ? relative(cwd, path) : path;
    const shown = relativePath && !relativePath.startsWith("..") ? relativePath : path;
    return shown.replace(/\\/gu, "/");
  }

  private applyTokenUsage(value: unknown): void {
    if (!isRecord(value)) return;
    const total = isRecord(value.total) ? value.total : {};
    const last = isRecord(value.last) ? value.last : {};
    const window = readNumber(value, "modelContextWindow");
    const input = readNumber(total, "inputTokens");
    const outputTokens = readNumber(total, "outputTokens");
    const cached = readNumber(total, "cachedInputTokens");
    const reasoning = readNumber(total, "reasoningOutputTokens");
    if (input !== undefined && outputTokens !== undefined) {
      this.usage = {
        inputTokens: input,
        outputTokens,
        totalTokens: readNumber(total, "totalTokens") ?? input + outputTokens,
        ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
        ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
      };
    }
    const contextUsed = readNumber(last, "inputTokens");
    this.live.setUsage({
      ...(input !== undefined ? { inputTokens: input } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
      ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
      ...(contextUsed !== undefined ? { contextUsedTokens: contextUsed } : {}),
      ...(window ? { contextWindowTokens: window } : {}),
    });
  }

  private applyRateLimits(value: unknown): void {
    if (!isRecord(value)) return;
    const limits: AgentLiveLimit[] = [];
    const reached = readString(value, "rateLimitReachedType");
    for (const key of ["primary", "secondary"] as const) {
      const window = isRecord(value[key]) ? value[key] : undefined;
      if (!window) continue;
      const usedPercent = readNumber(window, "usedPercent");
      if (usedPercent === undefined) continue;
      const minutes = readNumber(window, "windowDurationMins");
      const resetsAt = toEpochMs(window.resetsAt);
      limits.push({
        id: `codex-${key}`,
        label: windowLabel(minutes, key === "primary" ? "Short-term limit" : "Weekly limit"),
        usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
        ...(usedPercent >= 100 || reached === key ? { limited: true } : {}),
      });
    }
    if (limits.length > 0) this.live.setLimits(limits);
  }

  private fail(message: string): ExternalAgentCliOutputUpdate {
    if (this.terminal) return { displayText: [] };
    this.terminal = true;
    const update = this.output.pushEvent({ type: "turn.failed", error: { message } });
    this.closeInput();
    return update;
  }

  getFinalOutput(): string {
    return this.output.getFinalOutput();
  }
  getUsage(): AgentModelStreamUsage | undefined {
    return this.usage ?? this.output.getUsage();
  }
  getRetryCount(): undefined {
    return undefined;
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
    return false;
  }
  hasTerminalResult(): boolean {
    return this.terminal;
  }
  getFailureMessage(): string | undefined {
    return this.output.getFailureMessage();
  }
}
