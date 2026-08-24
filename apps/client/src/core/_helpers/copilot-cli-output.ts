const MAX_JSON_LINE_CHARS = 2_000_000;
const MAX_DIAGNOSTIC_LINES = 20;
const MAX_DIAGNOSTIC_LINE_CHARS = 2_000;

interface CopilotCliEvent {
  type: string;
  data?: unknown;
  exitCode?: unknown;
}

interface AssistantMessageChunks {
  count: number;
  parts: Map<number, string>;
  hasToolRequests: boolean;
}

export interface CopilotCliOutputUpdate {
  displayText: string[];
  resultExitCode?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseEvent = (line: string): CopilotCliEvent | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }

  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }

  return {
    type: value.type,
    ...(Object.hasOwn(value, "data") ? { data: value.data } : {}),
    ...(Object.hasOwn(value, "exitCode") ? { exitCode: value.exitCode } : {}),
  };
};

const formatDisplayText = (content: string): string =>
  content.endsWith("\n") ? `${content}\n` : `${content}\n\n`;

export class CopilotCliOutputDecoder {
  private pendingLine = "";
  private discardingOversizedLine = false;
  private readonly incompleteMessages = new Map<
    string,
    AssistantMessageChunks
  >();
  private readonly diagnostics: string[] = [];
  private latestAssistantText = "";
  private latestStandaloneAssistantText = "";
  private taskSummary = "";
  private assistantMessageSequence = 0;
  private latestStandaloneSequence = 0;
  private latestToolRequestSequence = 0;
  private reportedResultExitCode: number | undefined;

  push(chunk: string): CopilotCliOutputUpdate {
    const update: CopilotCliOutputUpdate = { displayText: [] };
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

  finish(): CopilotCliOutputUpdate {
    const update: CopilotCliOutputUpdate = { displayText: [] };
    if (!this.discardingOversizedLine && this.pendingLine.length > 0) {
      this.processLine(this.pendingLine.replace(/\r$/u, ""), update);
    }
    this.pendingLine = "";
    this.discardingOversizedLine = false;
    return update;
  }

  getFinalOutput(): string {
    const finalStandaloneText =
      this.latestStandaloneSequence > this.latestToolRequestSequence
        ? this.latestStandaloneAssistantText.trim()
        : "";
    return (
      finalStandaloneText ||
      this.taskSummary.trim() ||
      this.latestAssistantText.trim() ||
      this.diagnostics.join("\n").trim()
    );
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

  private processLine(line: string, update: CopilotCliOutputUpdate): void {
    if (line.trim().length === 0) {
      return;
    }

    if (line.length > MAX_JSON_LINE_CHARS) {
      return;
    }

    const event = parseEvent(line);
    if (!event) {
      this.recordDiagnostic(line);
      update.displayText.push(formatDisplayText(line));
      return;
    }

    if (event.type === "assistant.message") {
      this.processAssistantMessage(event.data, update);
      return;
    }

    if (event.type === "session.task_complete" && isRecord(event.data)) {
      if (typeof event.data.summary === "string") {
        this.taskSummary = event.data.summary;
      }
      return;
    }

    if (
      event.type === "result" &&
      typeof event.exitCode === "number" &&
      Number.isInteger(event.exitCode)
    ) {
      if (this.reportedResultExitCode === undefined) {
        this.reportedResultExitCode = event.exitCode;
        update.resultExitCode = event.exitCode;
      }
      return;
    }

    if (event.type.endsWith(".error") || event.type === "error") {
      const message = this.extractErrorMessage(event.data);
      if (message) {
        this.recordDiagnostic(message);
      }
    }
  }

  private processAssistantMessage(
    data: unknown,
    update: CopilotCliOutputUpdate,
  ): void {
    if (!isRecord(data) || typeof data.content !== "string") {
      return;
    }

    const messageId =
      typeof data.messageId === "string" ? data.messageId : undefined;
    const chunkIndex =
      typeof data.chunkIndex === "number" && Number.isInteger(data.chunkIndex)
        ? data.chunkIndex
        : undefined;
    const chunkCount =
      typeof data.chunkCount === "number" &&
      Number.isInteger(data.chunkCount) &&
      data.chunkCount > 1
        ? data.chunkCount
        : undefined;
    const hasToolRequests =
      Array.isArray(data.toolRequests) && data.toolRequests.length > 0;

    if (
      messageId === undefined ||
      chunkIndex === undefined ||
      chunkCount === undefined ||
      chunkIndex < 0 ||
      chunkIndex >= chunkCount
    ) {
      this.acceptAssistantText(data.content, hasToolRequests, update);
      return;
    }

    const chunks = this.incompleteMessages.get(messageId) ?? {
      count: chunkCount,
      parts: new Map<number, string>(),
      hasToolRequests,
    };
    if (chunks.count !== chunkCount) {
      this.incompleteMessages.delete(messageId);
      return;
    }

    chunks.parts.set(chunkIndex, data.content);
    chunks.hasToolRequests ||= hasToolRequests;
    this.incompleteMessages.set(messageId, chunks);
    if (chunks.parts.size !== chunkCount) {
      return;
    }

    const content = Array.from({ length: chunkCount }, (_, index) =>
      chunks.parts.get(index),
    );
    this.incompleteMessages.delete(messageId);
    if (content.some((part) => part === undefined)) {
      return;
    }

    this.acceptAssistantText(content.join(""), chunks.hasToolRequests, update);
  }

  private acceptAssistantText(
    content: string,
    hasToolRequests: boolean,
    update: CopilotCliOutputUpdate,
  ): void {
    if (content.trim().length === 0) {
      return;
    }

    this.assistantMessageSequence += 1;
    this.latestAssistantText = content;
    if (hasToolRequests) {
      this.latestToolRequestSequence = this.assistantMessageSequence;
    } else {
      this.latestStandaloneAssistantText = content;
      this.latestStandaloneSequence = this.assistantMessageSequence;
    }
    update.displayText.push(formatDisplayText(content));
  }

  private extractErrorMessage(data: unknown): string | undefined {
    if (typeof data === "string") {
      return data;
    }
    if (!isRecord(data)) {
      return undefined;
    }
    if (typeof data.message === "string") {
      return data.message;
    }
    return typeof data.error === "string" ? data.error : undefined;
  }

  private recordDiagnostic(value: string): void {
    if (this.diagnostics.length >= MAX_DIAGNOSTIC_LINES) {
      return;
    }
    this.diagnostics.push(value.slice(0, MAX_DIAGNOSTIC_LINE_CHARS));
  }
}
