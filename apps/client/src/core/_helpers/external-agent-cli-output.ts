import type { AgentModelStreamUsage } from "../types.js";
import { normalizeAnthropicUsage } from "./provider-adapters/stream-events.js";

const MAX_JSON_LINE_CHARS = 2_000_000;
const MAX_DIAGNOSTIC_LINES = 20;
const MAX_DIAGNOSTIC_LINE_CHARS = 2_000;

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
  isModelCallCountReported(): boolean;
  hasTerminalResult(): boolean;
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
        this.terminal = true;
        update.resultExitCode = 0;
      }
      return;
    }

    if (type === "turn.failed" || type === "error") {
      const error = isRecord(event.error) ? event.error : event;
      const message = getString(error, "message");
      if (message) {
        this.recordDiagnostic(message);
      }
      if (!this.terminal) {
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

  getFinalOutput(): string {
    return this.finalOutput.trim() || this.diagnostics.join("\n").trim();
  }

  getUsage(): AgentModelStreamUsage | undefined {
    return this.usage;
  }

  getRetryCount(): number | undefined {
    return this.retryCount;
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

    if (type === "assistant" && isRecord(event.message)) {
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

    const result = getString(event, "result");
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
      this.modelCallCount = Math.max(1, Math.trunc(numTurns));
      this.modelCallCountReported = true;
    }

    if (!this.terminal) {
      this.terminal = true;
      const isError = event.is_error === true || subtype !== "success";
      update.resultExitCode = isError ? 1 : 0;
    }
  }
}
