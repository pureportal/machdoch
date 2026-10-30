import type { AgentModelStreamUsage } from "@machdoch/model-runtime/types";
import { AgentLiveTracker } from "./agent-live-tracker.js";
import {
  CodexGoalProtocolError,
  CodexGoalProtocolReader,
} from "./codex-goal-protocol.js";
import { CodexLiveEventReader } from "./codex-live-events.js";
import {
  CodexCliOutputDecoder,
  type ExternalAgentCliOutputUpdate,
} from "./external-agent-cli-output.js";
import {
  UNATTENDED_ANSWER,
  type InteractiveAgentSession,
  type InteractiveSessionIo,
} from "./agent-interactive-session.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type CodexGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

const isGoalStatus = (value: unknown): value is CodexGoalStatus =>
  typeof value === "string" &&
  [
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
  ].includes(value);

export interface CodexNativeGoalInput {
  objective: string;
  prompt: string;
  imagePaths: string[];
  cwd: string;
}

/** Replies to a Codex server request without stopping an unattended goal. */
export const answerUnattendedGoalRequest = (
  method: string,
  params: Record<string, unknown>,
): Record<string, unknown> => {
  switch (method) {
    case "item/tool/requestUserInput": {
      const questions = Array.isArray(params.questions) ? params.questions.filter(isRecord) : [];
      return {
        result: {
          answers: Object.fromEntries(
            questions.map((question, index) => [
              typeof question.id === "string" ? question.id : `q${index + 1}`,
              { answers: [UNATTENDED_ANSWER] },
            ]),
          ),
        },
      };
    }
    // The goal already runs with full access; approvals that still arrive are accepted.
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "execCommandApproval":
    case "applyPatchApproval":
      return { result: { decision: "accept" } };
    case "mcpServer/elicitation/request":
      return { result: { action: "decline", content: null, _meta: null } };
    default:
      return { error: { code: -32601, message: `This goal run does not handle ${method || "this request"}.` } };
  }
};

/**
 * Runs Codex's own goal loop on one thread. Codex continues the goal itself,
 * so the run is observed but not steered.
 */
export class CodexNativeGoalSession implements InteractiveAgentSession {
  readonly live: AgentLiveTracker;
  readonly controls = {};
  private readonly output: CodexCliOutputDecoder;
  private readonly events: CodexLiveEventReader;
  private readonly model: string;
  private readonly protocol = new CodexGoalProtocolReader();
  private nextId = 1;
  private readonly requests = new Map<
    number,
    { method: string; goalRevision: number }
  >();
  private readonly completedTurns = new Set<string>();
  private threadId: string | undefined;
  private activeTurnId: string | undefined;
  private goalStatus: CodexGoalStatus = "paused";
  private goalRevision = 0;
  private goalActivated = false;
  private goalActivationAcknowledged = false;
  private terminal = false;
  private turns = 0;

  constructor(
    private readonly input: CodexNativeGoalInput,
    private readonly io: InteractiveSessionIo,
    publish: ConstructorParameters<typeof AgentLiveTracker>[1],
    options: { model: string; captureEvidence: boolean },
  ) {
    this.output = new CodexCliOutputDecoder(options.captureEvidence);
    this.model = options.model;
    this.live = new AgentLiveTracker(
      {
        provider: "codex-cli",
        transport: "app-server",
        capabilities: [],
        model: options.model,
      },
      publish,
    );
    this.events = new CodexLiveEventReader(this.live, input.cwd);
  }

  start(): void {
    this.request("initialize", {
      clientInfo: { name: "machdoch", version: "1.0.0" },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "thread/started",
          "item/agentMessage/delta",
          "item/commandExecution/outputDelta",
          "item/fileChange/outputDelta",
          "item/reasoning/textDelta",
          "item/reasoning/summaryTextDelta",
        ],
      },
    });
    this.live.flush();
  }

  /** Pauses the goal on the provider. The runner still ends the process right away. */
  interrupt(): boolean {
    if (!this.threadId || this.terminal) return false;
    this.request("thread/goal/set", {
      threadId: this.threadId,
      status: "paused",
    });
    if (this.activeTurnId)
      this.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      });
    return false;
  }

  dispose(): void {
    this.live.close();
  }

  private request(method: string, params: Record<string, unknown>): void {
    const id = this.nextId++;
    this.requests.set(id, { method, goalRevision: this.goalRevision });
    this.io.write(`${JSON.stringify({ id, method, params })}\n`);
  }

  private decode(event: Record<string, unknown>): ExternalAgentCliOutputUpdate {
    const empty: ExternalAgentCliOutputUpdate = { displayText: [] };
    if (this.terminal) return empty;
    if (
      typeof event.id === "number" &&
      !event.method &&
      this.requests.get(event.id)?.method === "account/rateLimits/read"
    ) {
      this.requests.delete(event.id);
      if (isRecord(event.result))
        this.events.applyRateLimits(event.result.rateLimits ?? event.result);
      return empty;
    }
    if (isRecord(event.error))
      return this.fail(
        String(event.error.message ?? "Codex goal request failed."),
      );
    if (typeof event.id === "number" && !event.method) {
      const request = this.requests.get(event.id);
      this.requests.delete(event.id);
      if (!request) return empty;
      const { method } = request;
      const result = isRecord(event.result) ? event.result : {};
      if (method === "initialize") {
        this.io.write(
          `${JSON.stringify({ method: "initialized", params: {} })}\n`,
        );
        this.request("thread/start", {
          model: this.model,
          cwd: this.input.cwd,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: false,
          allowProviderModelFallback: false,
        });
      } else if (method === "thread/start") {
        if (!isRecord(result.thread) || typeof result.thread.id !== "string")
          return this.fail("Codex did not return a goal thread.");
        this.threadId = result.thread.id;
        this.request("thread/goal/set", {
          threadId: this.threadId,
          objective: this.input.objective,
          status: "paused",
        });
      } else if (method === "thread/goal/set" && !this.goalActivated) {
        this.request("turn/start", {
          threadId: this.threadId,
          input: [
            { type: "text", text: this.input.prompt, text_elements: [] },
            ...this.input.imagePaths.map((path) => ({
              type: "localImage",
              path,
            })),
          ],
        });
      } else if (method === "turn/start") {
        if (!isRecord(result.turn) || typeof result.turn.id !== "string")
          return this.fail("Codex did not start the goal turn.");
        if (!this.completedTurns.has(result.turn.id))
          this.activeTurnId = result.turn.id;
        this.goalActivated = true;
        this.request("thread/goal/set", {
          threadId: this.threadId,
          status: "active",
        });
        this.request("account/rateLimits/read", {});
      } else if (method === "thread/goal/set" && this.goalActivated) {
        this.goalActivationAcknowledged = true;
        if (!isRecord(result.goal) || !isGoalStatus(result.goal.status))
          return this.fail("Codex returned an invalid goal status.");
        if (request.goalRevision === this.goalRevision)
          this.goalStatus = result.goal.status;
        return this.finishGoal();
      }
      return empty;
    }
    const params = isRecord(event.params) ? event.params : {};
    if (
      typeof params.threadId === "string" &&
      params.threadId !== this.threadId
    )
      return empty;
    if (typeof event.id === "number" || typeof event.id === "string") {
      // Goals run unattended: answer what Codex can act on and keep going.
      this.io.write(
        `${JSON.stringify({ id: event.id, ...answerUnattendedGoalRequest(String(event.method ?? ""), params) })}\n`,
      );
      return empty;
    }
    if (typeof event.method === "string")
      this.events.notification(event.method, params);
    if (event.method === "thread/goal/updated" && isRecord(params.goal)) {
      if (!isGoalStatus(params.goal.status))
        return this.fail("Codex returned an invalid goal status.");
      this.goalStatus = params.goal.status;
      this.goalRevision += 1;
      if (this.goalStatus === "active") this.goalActivationAcknowledged = true;
      return this.finishGoal();
    }
    if (event.method === "thread/goal/cleared")
      return this.fail(
        "The native Codex goal was cleared before verification.",
      );
    if (event.method === "turn/started" && isRecord(params.turn)) {
      if (typeof params.turn.id !== "string")
        return this.fail("Codex returned an invalid goal turn.");
      if (!this.completedTurns.has(params.turn.id))
        this.activeTurnId = params.turn.id;
      return empty;
    }
    if (event.method === "turn/completed" && isRecord(params.turn)) {
      if (typeof params.turn.id !== "string")
        return this.fail("Codex returned an invalid goal turn.");
      if (this.completedTurns.has(params.turn.id)) return empty;
      this.completedTurns.add(params.turn.id);
      this.turns += 1;
      if (this.activeTurnId === params.turn.id) this.activeTurnId = undefined;
      if (
        params.turn.status === "failed" ||
        params.turn.status === "interrupted"
      ) {
        const error = isRecord(params.turn.error) ? params.turn.error : {};
        return this.fail(
          String(error.message ?? "Codex goal turn was interrupted."),
        );
      }
      return this.finishGoal();
    }
    if (event.method === "item/completed" && isRecord(params.item)) {
      const itemTypes: Record<string, string> = {
        agentMessage: "agent_message",
        commandExecution: "command_execution",
        fileChange: "file_change",
        mcpToolCall: "mcp_tool_call",
        webSearch: "web_search",
      };
      return this.output.pushEvent({
        type: "item.completed",
        item: {
          ...params.item,
          type: itemTypes[String(params.item.type)] ?? params.item.type,
        },
      });
    }
    if (event.method === "error" && params.willRetry !== true)
      return this.fail(
        isRecord(params.error)
          ? String(params.error.message)
          : "Codex goal failed.",
      );
    return empty;
  }

  private finishGoal(): ExternalAgentCliOutputUpdate {
    if (
      !this.goalActivationAcknowledged ||
      this.activeTurnId ||
      this.goalStatus === "active"
    )
      return { displayText: [] };
    this.terminal = true;
    this.protocol.reset();
    this.requests.clear();
    const update = this.output.pushEvent({ type: "turn.completed" });
    this.io.closeInput();
    return update;
  }

  private fail(message: string): ExternalAgentCliOutputUpdate {
    if (this.terminal) return { displayText: [] };
    this.terminal = true;
    this.protocol.reset();
    this.requests.clear();
    const update = this.output.pushEvent({
      type: "turn.failed",
      error: { message },
    });
    this.io.closeInput();
    return update;
  }

  push(chunk: string): ExternalAgentCliOutputUpdate {
    return this.readProtocol(chunk);
  }

  private readProtocol(chunk?: string): ExternalAgentCliOutputUpdate {
    const update: ExternalAgentCliOutputUpdate = { displayText: [] };
    if (this.terminal) return update;
    const onEvent = (event: Record<string, unknown>): boolean => {
      const next = this.decode(event);
      update.displayText.push(...next.displayText);
      if (next.resultExitCode !== undefined)
        update.resultExitCode = next.resultExitCode;
      return !this.terminal;
    };
    try {
      if (chunk === undefined) this.protocol.finish(onEvent);
      else this.protocol.push(chunk, onEvent);
    } catch (error) {
      if (!(error instanceof CodexGoalProtocolError)) throw error;
      const failure = this.fail(
        `Codex returned invalid goal protocol data: ${error.message}`,
      );
      update.displayText.push(...failure.displayText);
      if (failure.resultExitCode !== undefined)
        update.resultExitCode = failure.resultExitCode;
    }
    return update;
  }

  finish(): ExternalAgentCliOutputUpdate {
    const update = this.readProtocol();
    if (update.resultExitCode !== undefined) return update;
    return this.terminal
      ? this.output.finish()
      : this.fail(
          "Codex exited before its native goal reached a stopping condition.",
        );
  }

  getFinalOutput(): string {
    return this.output.getFinalOutput();
  }
  getUsage(): AgentModelStreamUsage | undefined {
    return this.events.getUsage();
  }
  getRetryCount(): undefined {
    return undefined;
  }
  getModelCallCount(): number {
    return Math.max(1, this.turns);
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
