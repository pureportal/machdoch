import type { AgentModelStreamUsage } from "@machdoch/model-runtime/types";
import { normalizeAnthropicUsage } from "@machdoch/model-runtime/providers/stream-events";

const MAX_JSON_LINE_CHARS = 2_000_000;
const MAX_DIAGNOSTIC_LINES = 20;
const MAX_DIAGNOSTIC_LINE_CHARS = 2_000;
const BACKGROUND_WAIT_STEP_MS = 10 * 60 * 1_000;
const MAX_BACKGROUND_WAIT_STEPS = 3;
const BACKGROUND_FOLLOW_UP_GRACE_MS = 2 * 60 * 1_000;

const USAGE_COUNTS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "toolUseInputTokens",
  "reasoningTokens",
] as const;

/** Claude reports usage per prompt, so a run of several prompts adds them up. */
export const addUsage = (
  left: AgentModelStreamUsage | undefined,
  right: AgentModelStreamUsage | undefined,
): AgentModelStreamUsage | undefined => {
  if (!left || !right) return left ?? right;
  const sum: AgentModelStreamUsage = {};
  for (const key of USAGE_COUNTS) {
    if (left[key] !== undefined || right[key] !== undefined)
      sum[key] = (left[key] ?? 0) + (right[key] ?? 0);
  }
  return sum;
};

export interface ExternalAgentCliOutputUpdate {
  displayText: string[];
  resultExitCode?: number;
}

export interface ExternalAgentCliOutputDecoder {
  push(chunk: string): ExternalAgentCliOutputUpdate;
  finish(): ExternalAgentCliOutputUpdate;
  getFinalOutput(): string;
  getUsage(): AgentModelStreamUsage | undefined;
  getRetryCount(): number | undefined;
  getModelCallCount(): number;
  getToolCallCount(): number;
  getToolEvidence(): string;
  isModelCallCountReported(): boolean;
  hasTerminalResult(): boolean;
  getFailureMessage?(): string | undefined;
  /** The CLI stopped because it used every turn it was allowed. */
  reachedTurnLimit?(): boolean;
  /** How long to wait for the CLI to exit, when longer than the usual grace. */
  getCompletionGraceMs?(): number | undefined;
  /** Status to show when background jobs may keep the run waiting longer. */
  takeBackgroundWaitNotice?(): string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getString = (
  value: Record<string, unknown>,
  key: string,
): string | undefined =>
  typeof value[key] === "string" && value[key].length > 0
    ? value[key]
    : undefined;

const getNumber = (
  value: Record<string, unknown>,
  key: string,
): number | undefined =>
  typeof value[key] === "number" && Number.isFinite(value[key])
    ? value[key]
    : undefined;

const parseJsonRecord = (line: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const stringifyStructuredOutput = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
};

const formatDisplayText = (value: string): string =>
  value.endsWith("\n") ? value : `${value}\n\n`;

const createCodexUsage = (
  value: unknown,
): AgentModelStreamUsage | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = getNumber(value, "input_tokens");
  const outputTokens = getNumber(value, "output_tokens");
  const cachedInputTokens = getNumber(value, "cached_input_tokens");
  const cacheWriteInputTokens = getNumber(value, "cache_write_input_tokens");
  const reasoningTokens = getNumber(value, "reasoning_output_tokens");

  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputTokens !== undefined && outputTokens !== undefined
      ? { totalTokens: inputTokens + outputTokens }
      : {}),
    ...(cachedInputTokens !== undefined
      ? {
          cachedInputTokens,
          cacheReadInputTokens: cachedInputTokens,
        }
      : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
};

abstract class JsonLineOutputDecoder {
  private readonly toolCalls = new Set<string>();
  private toolEvidence = "";

  constructor(private readonly captureToolEvidence = false) {}

  getToolEvidence(): string {
    return this.toolEvidence;
  }

  private recordToolEvidence(event: unknown): void {
    if (this.captureToolEvidence)
      this.toolEvidence =
        `${this.toolEvidence}\n${JSON.stringify(event).slice(-12_000)}`.slice(
          -32_000,
        );
  }

  getToolCallCount(): number {
    return this.toolCalls.size;
  }

  pushEvent(event: Record<string, unknown>): ExternalAgentCliOutputUpdate {
    const update: ExternalAgentCliOutputUpdate = { displayText: [] };
    this.processRecord(event, update);
    return update;
  }
  private pendingLine = "";
  private discardingOversizedLine = false;
  protected readonly diagnostics: string[] = [];

  push(chunk: string): ExternalAgentCliOutputUpdate {
    const update: ExternalAgentCliOutputUpdate = { displayText: [] };
    let remaining = chunk;

    while (remaining.length > 0) {
      const newlineIndex = remaining.indexOf("\n");
      if (newlineIndex === -1) {
        this.appendLineFragment(remaining);
        break;
      }

      const fragment = remaining.slice(0, newlineIndex);
      remaining = remaining.slice(newlineIndex + 1);

      if (this.discardingOversizedLine) {
        this.discardingOversizedLine = false;
        continue;
      }

      if (this.pendingLine.length + fragment.length > MAX_JSON_LINE_CHARS) {
        this.pendingLine = "";
        continue;
      }

      const line = `${this.pendingLine}${fragment}`.replace(/\r$/u, "");
      this.pendingLine = "";
      this.processLine(line, update);
    }

    return update;
  }

  finish(): ExternalAgentCliOutputUpdate {
    const update: ExternalAgentCliOutputUpdate = { displayText: [] };
    if (!this.discardingOversizedLine && this.pendingLine.length > 0) {
      this.processLine(this.pendingLine.replace(/\r$/u, ""), update);
    }
    this.pendingLine = "";
    this.discardingOversizedLine = false;
    return update;
  }

  protected abstract processEvent(
    event: Record<string, unknown>,
    update: ExternalAgentCliOutputUpdate,
  ): void;

  protected recordDiagnostic(value: string): void {
    if (this.diagnostics.length >= MAX_DIAGNOSTIC_LINES) {
      return;
    }
    this.diagnostics.push(value.slice(0, MAX_DIAGNOSTIC_LINE_CHARS));
  }

  private appendLineFragment(fragment: string): void {
    if (this.discardingOversizedLine) {
      return;
    }

    if (this.pendingLine.length + fragment.length > MAX_JSON_LINE_CHARS) {
      this.pendingLine = "";
      this.discardingOversizedLine = true;
      return;
    }

    this.pendingLine += fragment;
  }

  private processLine(
    line: string,
    update: ExternalAgentCliOutputUpdate,
  ): void {
    if (line.trim().length === 0 || line.length > MAX_JSON_LINE_CHARS) {
      return;
    }

    const event = parseJsonRecord(line);
    if (!event) {
      this.recordDiagnostic(line);
      return;
    }

    this.processRecord(event, update);
  }

  private processRecord(
    event: Record<string, unknown>,
    update: ExternalAgentCliOutputUpdate,
  ): void {
    if (
      event.type === "item.completed" &&
      isRecord(event.item) &&
      [
        "command_execution",
        "file_change",
        "mcp_tool_call",
        "web_search",
      ].includes(String(event.item.type))
    ) {
      this.toolCalls.add(String(event.item.id ?? this.toolCalls.size));
      this.recordToolEvidence(event.item);
    }
    if (
      event.type === "assistant" &&
      isRecord(event.message) &&
      Array.isArray(event.message.content)
    ) {
      for (const block of event.message.content) {
        if (isRecord(block) && block.type === "tool_use")
          this.toolCalls.add(String(block.id ?? this.toolCalls.size));
      }
    }

    if (
      event.type === "user" &&
      isRecord(event.message) &&
      Array.isArray(event.message.content)
    ) {
      for (const block of event.message.content) {
        if (isRecord(block) && block.type === "tool_result")
          this.recordToolEvidence(block);
      }
    }
    this.processEvent(event, update);
  }
}

export class CodexCliOutputDecoder
  extends JsonLineOutputDecoder
  implements ExternalAgentCliOutputDecoder
{
  private finalOutput = "";
  private usage: AgentModelStreamUsage | undefined;
  private terminal = false;
  private modelCallCount = 0;
  private failureMessage: string | undefined;

  getFinalOutput(): string {
    return this.finalOutput.trim() || this.diagnostics.join("\n").trim();
  }

  getUsage(): AgentModelStreamUsage | undefined {
    return this.usage;
  }

  getRetryCount(): number | undefined {
    return undefined;
  }

  getModelCallCount(): number {
    return Math.max(1, this.modelCallCount);
  }

  isModelCallCountReported(): boolean {
    return false;
  }

  hasTerminalResult(): boolean {
    return this.terminal;
  }

  getFailureMessage(): string | undefined {
    return this.failureMessage;
  }

  protected processEvent(
    event: Record<string, unknown>,
    update: ExternalAgentCliOutputUpdate,
  ): void {
    const type = getString(event, "type");

    if (type === "item.completed" && isRecord(event.item)) {
      const itemType = getString(event.item, "type");
      if (itemType === "agent_message") {
        const text = getString(event.item, "text");
        if (text) {
          this.finalOutput = text;
          update.displayText.push(formatDisplayText(text));
        }
      } else if (itemType === "error") {
        const message = getString(event.item, "message");
        if (message) {
          this.recordDiagnostic(message);
        }
      }
      return;
    }

    if (type === "turn.completed") {
      this.modelCallCount += 1;
      this.usage = createCodexUsage(event.usage) ?? this.usage;
      if (!this.terminal) {
        this.failureMessage = undefined;
        this.terminal = true;
        update.resultExitCode = 0;
      }
      return;
    }

    if (type === "turn.failed" || type === "error") {
      const error = isRecord(event.error) ? event.error : event;
      const message = [getString(error, "code"), getString(error, "message")]
        .filter(Boolean)
        .join(": ");
      if (message) {
        this.recordDiagnostic(message);
        this.failureMessage = message;
      }
      if (type === "turn.failed" && !this.terminal) {
        this.terminal = true;
        update.resultExitCode = 1;
      }
    }
  }
}

export class ClaudeCliOutputDecoder
  extends JsonLineOutputDecoder
  implements ExternalAgentCliOutputDecoder
{
  private finalOutput = "";
  private usage: AgentModelStreamUsage | undefined;
  private retryCount = 0;
  private terminal = false;
  private modelCallCount = 1;
  private modelCallCountReported = false;
  private assistantMessageId: string | undefined;
  private turnLimitReached = false;
  private failureMessage: string | undefined;
  private backgroundTasks = 0;
  private waitingForBackgroundTasks = false;
  private backgroundWaitSteps = 0;
  private carriedModelCalls = 0;
  private carriedUsage: AgentModelStreamUsage | undefined;

  /**
   * With `waitForBackgroundTasks`, a result that leaves background jobs running
   * is not final: the CLI starts another turn when they finish.
   */
  constructor(
    captureToolEvidence = false,
    private readonly waitForBackgroundTasks = false,
  ) {
    super(captureToolEvidence);
  }

  getFinalOutput(): string {
    return this.finalOutput.trim() || this.diagnostics.join("\n").trim();
  }

  getUsage(): AgentModelStreamUsage | undefined {
    return addUsage(this.carriedUsage, this.usage);
  }

  getRetryCount(): number | undefined {
    return this.retryCount;
  }

  getCompletionGraceMs(): number | undefined {
    if (!this.waitingForBackgroundTasks) return undefined;
    return this.backgroundTasks > 0
      ? BACKGROUND_WAIT_STEP_MS
      : BACKGROUND_FOLLOW_UP_GRACE_MS;
  }

  takeBackgroundWaitNotice(): string | undefined {
    if (
      !this.waitingForBackgroundTasks ||
      this.backgroundTasks === 0 ||
      this.backgroundWaitSteps >= MAX_BACKGROUND_WAIT_STEPS - 1
    )
      return undefined;
    this.backgroundWaitSteps += 1;
    return this.describeBackgroundWait("Still waiting for");
  }

  private describeBackgroundWait(prefix: string): string {
    return formatDisplayText(
      `${prefix} ${this.backgroundTasks} background job${this.backgroundTasks === 1 ? "" : "s"} to finish.`,
    );
  }

  /** The CLI started another turn, so the last result was not the final one. */
  private startFollowUpTurn(): void {
    if (!this.waitForBackgroundTasks || !this.terminal) return;
    this.terminal = false;
    this.waitingForBackgroundTasks = false;
    this.backgroundWaitSteps = 0;
    this.turnLimitReached = false;
    this.failureMessage = undefined;
    this.carriedUsage = addUsage(this.carriedUsage, this.usage);
    this.usage = undefined;
    if (this.modelCallCountReported)
      this.carriedModelCalls = this.modelCallCount;
  }

  getFailureMessage(): string | undefined {
    return this.failureMessage;
  }

  reachedTurnLimit(): boolean {
    return this.turnLimitReached;
  }

  getModelCallCount(): number {
    return Math.max(1, this.modelCallCount);
  }

  isModelCallCountReported(): boolean {
    return this.modelCallCountReported;
  }

  hasTerminalResult(): boolean {
    return this.terminal;
  }

  protected processEvent(
    event: Record<string, unknown>,
    update: ExternalAgentCliOutputUpdate,
  ): void {
    const type = getString(event, "type");
    const subtype = getString(event, "subtype");

    if (type === "system" && subtype === "api_retry") {
      this.retryCount += 1;
      return;
    }

    if (type === "system" && subtype === "background_tasks_changed") {
      this.backgroundTasks = Array.isArray(event.tasks)
        ? event.tasks.length
        : 0;
      if (this.waitForBackgroundTasks && this.terminal && this.backgroundTasks)
        this.waitingForBackgroundTasks = true;
      return;
    }

    if (type === "assistant" && isRecord(event.message)) {
      if (!getString(event, "parent_tool_use_id")) this.startFollowUpTurn();
      const content = event.message.content;
      if (Array.isArray(content)) {
        const text = content
          .filter(
            (block): block is Record<string, unknown> =>
              isRecord(block) && getString(block, "type") === "text",
          )
          .map((block) => getString(block, "text") ?? "")
          .join("");
        if (text.trim().length > 0) {
          if (getString(event, "parent_tool_use_id")) {
            update.displayText.push(formatDisplayText(text));
            return;
          }
          const messageId = getString(event.message, "id");
          const previousText =
            messageId && messageId === this.assistantMessageId
              ? this.finalOutput
              : "";
          let displayText = text;

          if (previousText && text.startsWith(previousText)) {
            displayText = text.slice(previousText.length);
            this.finalOutput = text;
          } else if (previousText && previousText.startsWith(text)) {
            displayText = "";
          } else {
            this.finalOutput = `${previousText}${text}`;
          }
          this.assistantMessageId = messageId;

          if (displayText.length > 0) {
            update.displayText.push(formatDisplayText(displayText));
          }
        }
      }
      return;
    }

    if (type !== "result") {
      return;
    }

    const result =
      stringifyStructuredOutput(event.structured_output) ??
      getString(event, "result");
    if (result) {
      const assistantOutput = this.finalOutput.trim();
      const normalizedResult = result.trim();

      if (!assistantOutput || !assistantOutput.startsWith(normalizedResult)) {
        const displayText = normalizedResult.startsWith(assistantOutput)
          ? normalizedResult.slice(assistantOutput.length)
          : result;
        this.finalOutput = result;
        if (displayText.length > 0) {
          update.displayText.push(formatDisplayText(displayText));
        }
      }
    }
    this.usage = normalizeAnthropicUsage(event.usage) ?? this.usage;
    const numTurns = getNumber(event, "num_turns");
    if (numTurns !== undefined) {
      this.modelCallCount =
        this.carriedModelCalls + Math.max(1, Math.trunc(numTurns));
      this.modelCallCountReported = true;
    }
    if (this.waitForBackgroundTasks && this.backgroundTasks > 0) {
      this.waitingForBackgroundTasks = true;
      if (!this.terminal)
        update.displayText.push(this.describeBackgroundWait("Waiting for"));
    }

    if (!this.terminal) {
      this.terminal = true;
      const isError = event.is_error === true || subtype !== "success";
      update.resultExitCode = isError ? 1 : 0;
      this.turnLimitReached = subtype === "error_max_turns";
      // Error results list what went wrong; without them only the agent's
      // last message would explain the failure.
      const errors = Array.isArray(event.errors)
        ? event.errors.filter(
            (error): error is string =>
              typeof error === "string" && error.trim().length > 0,
          )
        : [];
      if (isError && !this.turnLimitReached && errors.length > 0) {
        this.failureMessage = errors.join("\n");
      }
    }
  }
}
