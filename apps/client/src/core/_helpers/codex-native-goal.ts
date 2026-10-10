import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type { AgentModelStreamUsage } from "../types.js";
import {
  CodexGoalProtocolError,
  CodexGoalProtocolReader,
} from "./codex-goal-protocol.js";
import {
  CodexCliOutputDecoder,
  type ExternalAgentCliOutputDecoder,
  type ExternalAgentCliOutputUpdate,
} from "./external-agent-cli-output.js";

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
}

export class CodexNativeGoalDecoder implements ExternalAgentCliOutputDecoder {
  private readonly output: CodexCliOutputDecoder;
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
  private usage: AgentModelStreamUsage | undefined;

  constructor(
    private readonly input: CodexNativeGoalInput,
    private readonly config: RuntimeConfig,
    private readonly write: (message: string) => void,
    private readonly closeInput: () => void,
    captureEvidence: boolean,
  ) {
    this.output = new CodexCliOutputDecoder(captureEvidence);
  }

  start(): void {
    this.request("initialize", {
      clientInfo: { name: "machdoch", version: "1.0.0" },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "thread/started",
          "item/started",
          "item/agentMessage/delta",
          "item/commandExecution/outputDelta",
          "item/fileChange/outputDelta",
          "item/reasoning/textDelta",
          "item/reasoning/summaryTextDelta",
        ],
      },
    });
  }

  interrupt(): void {
    if (!this.threadId || this.terminal) return;
    this.request("thread/goal/set", {
      threadId: this.threadId,
      status: "paused",
    });
    if (this.activeTurnId)
      this.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      });
  }

  private request(method: string, params: Record<string, unknown>): void {
    const id = this.nextId++;
    this.requests.set(id, { method, goalRevision: this.goalRevision });
    this.write(`${JSON.stringify({ id, method, params })}\n`);
  }

  private decode(event: Record<string, unknown>): ExternalAgentCliOutputUpdate {
    const empty: ExternalAgentCliOutputUpdate = { displayText: [] };
    if (this.terminal) return empty;
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
        this.write(
          `${JSON.stringify({ method: "initialized", params: {} })}\n`,
        );
        this.request("thread/start", {
          model: this.config.model,
          cwd: this.config.workspaceRoot,
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
      this.write(
        `${JSON.stringify({ id: event.id, error: { code: -32601, message: "This goal run cannot answer interactive requests." } })}\n`,
      );
      return this.fail(
        "Codex requested user input. Resume after resolving it.",
      );
    }
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
    if (
      event.method === "thread/tokenUsage/updated" &&
      isRecord(params.tokenUsage)
    ) {
      const total = params.tokenUsage.total;
      if (
        isRecord(total) &&
        [
          total.inputTokens,
          total.outputTokens,
          total.totalTokens,
          total.cachedInputTokens,
          total.reasoningOutputTokens,
        ].every(
          (value) =>
            typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value >= 0,
        )
      ) {
        this.usage = {
          inputTokens: Number(total.inputTokens),
          outputTokens: Number(total.outputTokens),
          totalTokens: Number(total.totalTokens),
          cachedInputTokens: Number(total.cachedInputTokens),
          reasoningTokens: Number(total.reasoningOutputTokens),
        };
      }
      return empty;
    }
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
    this.closeInput();
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
    this.closeInput();
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
    return this.usage;
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
