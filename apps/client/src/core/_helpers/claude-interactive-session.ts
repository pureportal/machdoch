import type {
  AgentModelImageInput,
  AgentModelStreamUsage,
} from "@machdoch/model-runtime/types";
import { normalizeAnthropicUsage } from "@machdoch/model-runtime/providers/stream-events";
import type { AgentLiveQuestion } from "@machdoch/fleet-protocol/task-thinking";
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
  turnFinishedError,
  type InteractiveAgentSession,
  type InteractiveSessionIo,
} from "./agent-interactive-session.js";
import {
  AgentControlRequestError,
  type AgentTaskControlHandlers,
} from "./agent-task-control-server.js";
import { ClaudeLiveEventReader } from "./claude-live-events.js";
import {
  ClaudeCliOutputDecoder,
  addUsage,
  type ExternalAgentCliOutputUpdate,
} from "./external-agent-cli-output.js";

const FAST_MODE_REASONS: Record<string, string> = {
  extra_usage_disabled: "extra usage is turned off for this Claude account",
  sdk_opt_in_required: "this run did not opt in",
  model_not_supported: "this model has no fast mode",
};
export interface ClaudeInteractiveTurnInput {
  prompt: string;
  imageInputs: readonly AgentModelImageInput[];
  /** Times to resume after `--max-turns` stops the turn; null means no cap. */
  turnLimitContinuations?: number | null;
}

const TURN_LIMIT_CONTINUE_PROMPT =
  "You reached the turn limit for this step before finishing. Continue the task from where you stopped.";

type ClaudeUserContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

interface PendingToolRequest {
  requestId: string;
  input: Record<string, unknown>;
  questionId: string;
  questionTexts: Map<string, string>;
}

/**
 * Drives one Claude Code turn over `--input-format stream-json` with stdin
 * held open, so the host can steer, interrupt, answer AskUserQuestion and
 * stop background tasks while the turn runs.
 */
export class ClaudeInteractiveSession implements InteractiveAgentSession {
  readonly live: AgentLiveTracker;
  readonly controls: AgentTaskControlHandlers;
  private readonly output: ClaudeCliOutputDecoder;
  private readonly events: ClaudeLiveEventReader;
  private readonly lines = new JsonLineSplitter();
  private nextRequest = 1;
  private readonly ownRequests = new Map<string, string>();
  private pendingTool: PendingToolRequest | undefined;
  private turnFinished = false;
  private inputClosed = false;
  private interrupted = false;
  private continuations = 0;
  private carriedModelCalls = 0;
  private carriedUsage: AgentModelStreamUsage | undefined;
  private nextSteer = 1;
  private readonly requestedFastMode: boolean;
  private readonly unattended: boolean;

  constructor(
    private readonly turn: ClaudeInteractiveTurnInput,
    private readonly io: InteractiveSessionIo,
    publish: ConstructorParameters<typeof AgentLiveTracker>[1],
    options: {
      model: string;
      captureEvidence: boolean;
      fastMode?: boolean;
      unattended?: boolean;
    },
  ) {
    this.output = new ClaudeCliOutputDecoder(options.captureEvidence, true);
    this.requestedFastMode = options.fastMode === true;
    this.unattended = options.unattended === true;
    this.live = new AgentLiveTracker(
      {
        provider: "claude-cli",
        transport: "stream-json",
        capabilities: this.unattended
          ? []
          : ["steer", "interrupt", "answer", "stop-task"],
        model: options.model,
        ...(options.fastMode !== undefined
          ? { fastMode: options.fastMode }
          : {}),
      },
      publish,
    );
    this.events = new ClaudeLiveEventReader(this.live);
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
    const { prompt, imageInputs } = this.turn;
    this.sendUser(
      imageInputs.length > 0
        ? [
            ...imageInputs.map(
              (image): ClaudeUserContentBlock => ({
                type: "image",
                source: {
                  type: "base64",
                  media_type: image.mediaType,
                  data: image.data,
                },
              }),
            ),
            { type: "text", text: prompt },
          ]
        : prompt,
    );
    this.live.flush();
  }

  interrupt(): boolean {
    if (this.turnFinished || this.inputClosed) return false;
    this.interrupted = true;
    // Between turns nothing is listening for an interrupt, so just end the run.
    if (this.output.getCompletionGraceMs() !== undefined) {
      this.turnFinished = true;
      this.live.failPendingSteers(
        "The turn ended before Claude read this message.",
      );
      this.closeInput();
      return true;
    }
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
    if (!pending || pending.questionId !== questionId)
      throw staleQuestionError();
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

  private sendUser(
    content: string | ClaudeUserContentBlock[],
    priority?: "next" | "now",
  ): void {
    this.write({
      type: "user",
      message: { role: "user", content },
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

  private processLine(
    line: string,
    update: ExternalAgentCliOutputUpdate,
  ): void {
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
      this.events.rateLimit(event);
      return;
    }
    if (type === "user" && event.isReplay === true) {
      // An echoed steering message: the turn has now read it.
      const message = isRecord(event.message) ? event.message : {};
      if (typeof message.content === "string")
        this.live.confirmSteer(message.content);
      return;
    }
    if (type === "system") this.events.system(event);
    // Once the run has ended, a late follow-up turn must not replace its answer.
    if (this.turnFinished) return;
    if (type === "result" && this.continueAfterTurnLimit(event)) return;
    if (type === "assistant") this.events.assistant(event);
    if (type === "user") this.events.toolResults(event);
    mergeOutputUpdate(update, this.output.pushEvent(event));
    if (type === "result") {
      if (this.awaitsBackgroundJobs(event))
        this.events.result(event, this.getUsage());
      else this.finishTurn(event);
    }
  }

  /**
   * Closing stdin would stop jobs still running after a successful turn. With
   * it open, the CLI starts another turn when they finish.
   */
  private awaitsBackgroundJobs(event: Record<string, unknown>): boolean {
    return (
      !this.interrupted &&
      event.is_error !== true &&
      readString(event, "subtype") === "success" &&
      this.output.getCompletionGraceMs() !== undefined
    );
  }

  private handleProviderRequest(event: Record<string, unknown>): void {
    const requestId = readString(event, "request_id");
    const request = isRecord(event.request) ? event.request : {};
    if (!requestId) return;
    const subtype = readString(request, "subtype");
    if (subtype !== "can_use_tool") {
      this.replyError(
        requestId,
        `machdoch does not handle ${subtype ?? "this"} requests.`,
      );
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
        ...(readString(raw, "header")
          ? { header: readString(raw, "header") }
          : {}),
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
      if (subtype === "stop_task")
        this.live.addNotice("warning", `Could not stop the task: ${error}`);
      else if (subtype === "interrupt")
        this.live.addNotice("warning", `Interrupt failed: ${error}`);
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

  /**
   * `--max-turns` ends a prompt with the work unfinished, but the session
   * keeps its context, so another prompt resumes it with a fresh turn budget.
   */
  private continueAfterTurnLimit(event: Record<string, unknown>): boolean {
    const { turnLimitContinuations: limit = 0 } = this.turn;
    if (
      readString(event, "subtype") !== "error_max_turns" ||
      this.interrupted ||
      this.inputClosed ||
      (limit !== null && this.continuations >= limit)
    )
      return false;
    this.continuations += 1;
    this.carriedModelCalls += readNumber(event, "num_turns") ?? 0;
    this.carriedUsage = addUsage(
      this.carriedUsage,
      normalizeAnthropicUsage(event.usage),
    );
    this.live.addNotice(
      "info",
      `Claude used its turns for this step; continuing where it stopped (${limit === null ? this.continuations : `${this.continuations} of ${limit}`}).`,
    );
    this.sendUser(TURN_LIMIT_CONTINUE_PROMPT);
    return true;
  }

  private finishTurn(event: Record<string, unknown>): void {
    this.turnFinished = true;
    this.events.result(event, this.getUsage());
    this.live.failPendingSteers(
      "The turn ended before Claude read this message.",
    );
    // Closing stdin ends the session; a predicted next prompt, if Claude
    // makes one, still arrives before the process exits.
    this.closeInput();
  }

  getFinalOutput(): string {
    return this.output.getFinalOutput();
  }
  getUsage(): AgentModelStreamUsage | undefined {
    return addUsage(this.carriedUsage, this.output.getUsage());
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
    return this.carriedModelCalls + this.output.getModelCallCount();
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
    return this.output.hasTerminalResult();
  }
  getCompletionGraceMs(): number | undefined {
    return this.turnFinished ? undefined : this.output.getCompletionGraceMs();
  }
  takeBackgroundWaitNotice(): string | undefined {
    return this.turnFinished
      ? undefined
      : this.output.takeBackgroundWaitNotice();
  }
  backgroundWaitExpired(): boolean {
    return !this.turnFinished && this.output.backgroundWaitExpired();
  }
}
